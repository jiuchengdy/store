import { db, transaction } from './db'
import { id } from './crypto'
import { safeUpstreamError } from './safe-errors'
import { UpstreamError } from './integrations/aicdk'
import { fulfillOrder } from './fulfillment'
import { deliverOrderEmail } from './notifications'
import { releaseExpiredCouponOrders } from './coupons'
import { claimJob, databaseNow } from './database-sql'
import { exhaustFulfillment, fulfillmentRetryExhausted } from './fulfillment-exhaustion'

let lastAnalyticsCleanup = 0
export async function tick() {
  const now = await databaseNow()
  if (Date.now() - lastAnalyticsCleanup > 3600000) {
    const cutoff = new Date(now.getTime() - 90 * 86400_000)
    await db.funnelEvent.deleteMany({ where: { createdAt: { lt: cutoff } } })
    await db.riskEvent.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - 30 * 86400_000) } },
    })
    await db.quote.updateMany({
      where: { analyticsVisitor: { not: null }, expiresAt: { lt: cutoff } },
      data: { analyticsVisitor: null },
    })
    lastAnalyticsCleanup = Date.now()
  }
  await deliverOrderEmail()
  await releaseExpiredCouponOrders()
  await db.commission.updateMany({
    where: { status: 'pending', availableAt: { lte: now } },
    data: { status: 'available' },
  })
  await db.authSession.deleteMany({ where: { expiresAt: { lt: now } } })
  await db.authVerification.deleteMany({ where: { expiresAt: { lt: now } } })
  await db.demoMailbox.deleteMany({ where: { expiresAt: { lt: now } } })
  await db.rateLimit.deleteMany({ where: { expiresAt: { lt: now } } })
  await db.quote.updateMany({
    where: {
      expiresAt: { lt: now },
      preflightToken: { not: null },
      OR: [{ order: null }, { order: { status: { in: ['completed', 'failed', 'refunded'] } } }],
    },
    data: { preflightToken: null },
  })
  const lease = id('lease_')
  const job = await transaction((client) => claimJob(client, lease))
  if (!job) return false
  try {
    if (!(await fulfillOrder(job.orderId))) {
      // Waiting for the buyer (needs_session) is not a delivery attempt: it must
      // neither burn the retry budget nor be turned into a failure. Reset the
      // counter and check back slowly instead of every 5 seconds.
      const waiting = await db.order.findUnique({
        where: { id: job.orderId },
        select: { status: true },
      })
      const paused = waiting?.status === 'needs_session'
      await db.job.updateMany({
        where: { id: job.id, lease },
        data: {
          runAt: new Date((await databaseNow()).getTime() + (paused ? 60_000 : 5000)),
          lockedUntil: null,
          lastError: null,
          ...(paused ? { attempts: 0 } : {}),
        },
      })
      return true
    }
    await db.job.updateMany({
      where: { id: job.id, lease, order: { status: { not: 'processing' } } },
      data: { done: true, lockedUntil: null },
    })
  } catch (error) {
    const safe = error instanceof UpstreamError ? safeUpstreamError(error) : null
    const code = safe?.code ?? 'RETRY_PENDING'
    // Budget is per order, not per attempt type: a permanent upstream error
    // (deactivated account, delisted product, bad parameters) must eventually
    // become a human task instead of retrying every 5 minutes forever.
    const state = await db.order.findUnique({
      where: { id: job.orderId },
      select: { status: true },
    })
    if (state?.status === 'processing' && fulfillmentRetryExhausted(job.attempts + 1)) {
      await exhaustFulfillment(job.orderId, code)
      return true
    }
    const wait = safe?.retryAfter ?? Math.min(300, 5 * 2 ** Math.min(job.attempts, 6))
    await db.job.updateMany({
      where: { id: job.id, lease },
      data: {
        runAt: new Date((await databaseNow()).getTime() + wait * 1000),
        lockedUntil: null,
        lastError: code,
      },
    })
  }
  return true
}
