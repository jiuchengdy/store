import { db, transaction } from './db'
import { id } from './crypto'

// Delivery attempts before a paid order is handed to a human. With the existing
// backoff (5s doubling, capped at 300s) 20 attempts span roughly 100 minutes,
// which is long enough for a transient upstream outage to clear and short enough
// that a buyer is not left waiting half a day for the "需要人工协助处理" email.
// Overridable for drills, but the default must never mean "unlimited".
function maxAttempts() {
  const raw = Number(process.env.FULFILLMENT_MAX_ATTEMPTS ?? '')
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 20
}

export function fulfillmentRetryExhausted(attempts: number) {
  return attempts >= maxAttempts()
}

// Terminal hand-off after the retry budget is spent. Deliberately does NOT touch
// money: no wallet refund, no channel refund. The buyer is notified by the
// existing order_email_outbox trigger the moment status becomes 'failed'; this
// function must not send mail itself.
export async function exhaustFulfillment(orderId: string, lastError: string) {
  return transaction(async (client) => {
    const order = await client.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, contactEmail: true },
    })
    // Idempotent: only a still-in-progress order is moved. completed / refunded /
    // cancelled / already failed are left untouched.
    if (!order || order.status !== 'processing') return false

    await client.order.update({
      where: { id: orderId },
      data: {
        status: 'failed',
        failureReason: 'fulfillment_retry_exhausted',
        fulfillmentStatus: 'failed',
      },
    })
    // Keep the job row: it is the evidence trail for why the order failed.
    await client.job.updateMany({
      where: { orderId },
      data: { done: true, lockedUntil: null, lastError },
    })
    await client.audit.create({
      data: {
        id: id('a_'),
        actor: 'worker',
        action: '出货重试达上限，转人工',
        target: orderId,
      },
    })
    // The email trigger silently skips orders without contact_email, so without
    // this line nobody would ever know the buyer was not notified.
    if (!order.contactEmail)
      await client.audit.create({
        data: {
          id: id('a_'),
          actor: 'worker',
          action: '通知未发送：缺少联系邮箱',
          target: orderId,
        },
      })
    return true
  })
}
