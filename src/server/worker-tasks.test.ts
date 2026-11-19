import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupTestDatabase, prepareTestDatabase, testQuery } from './database-test-support'

vi.mock('./fulfillment', () => ({ fulfillOrder: vi.fn() }))
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_worker_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'demo'
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
})

import { db, Prisma } from './db'
import { id } from './crypto'
import { tick } from './worker-tasks'
import { fulfillOrder } from './fulfillment'
import { UpstreamError } from './integrations/aicdk'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
const mockedFulfill = vi.mocked(fulfillOrder)

async function createJob(status: string, contactEmail: string | null = 'buyer@example.com') {
  const orderId = id('o_')
  await db.order.create({
    data: {
      id: orderId,
      kind: 'purchase',
      productName: 'Test product',
      email: contactEmail ?? 'guest@example.com',
      listAmount: 1000,
      discountAmount: 0,
      amount: 1000,
      status,
      channel: 'crypto',
      rateBps: 0,
      settlementDays: 0,
      firstOrderOnly: false,
      provider: 'gmpay',
      externalAmount: 1000,
      contactEmail,
    },
  })
  const jobId = id('j_')
  await db.job.create({ data: { id: jobId, orderId, attempts: 0, runAt: new Date(0), done: false } })
  return { orderId, jobId }
}

// Every tick claims at most one job whose run_at is due; push it back into the
// past so the loop measures attempts, not the backoff clock.
async function runTicks(jobId: string, times: number) {
  // tick() claims the oldest due job in the whole schema, and earlier cases leave
  // their own jobs queued. Close them so this loop only ever measures our job.
  await testQuery(Prisma.sql`UPDATE jobs SET done = true WHERE done = false AND id <> ${jobId}`)
  for (let i = 0; i < times; i += 1) {
    await testQuery(Prisma.sql`UPDATE jobs SET run_at = now() - interval '1 second', locked_until = NULL WHERE id = ${jobId}`)
    await tick()
  }
}

suite('fulfillment retry budget', () => {
  beforeAll(async () => {
    await prepareTestDatabase()
  })
  afterAll(async () => {
    await cleanupTestDatabase()
  })
  beforeEach(() => {
    mockedFulfill.mockReset()
  })
  afterEach(() => {
    mockedFulfill.mockReset()
  })

  it('hands the order to a human after the retry budget and stops claiming the job', async () => {
    mockedFulfill.mockRejectedValue(new UpstreamError('PRODUCT_DISABLED', 1, false))
    const { orderId, jobId } = await createJob('processing')

    await runTicks(jobId, 20)

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('failed')
    expect(order.failureReason).toBe('fulfillment_retry_exhausted')
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.done).toBe(true)
    expect(job.lockedUntil).toBeNull()
    expect(job.lastError).toBe('PRODUCT_DISABLED')

    // The buyer email is enqueued by the order_email_outbox trigger. The insert
    // itself already queued the 'processing' mail, so the point here is that the
    // hand-off adds exactly one 'failed' mail (the "需要人工协助处理" one).
    const mails = await db.emailOutbox.findMany({ where: { orderId } })
    expect(mails.filter((mail) => mail.status === 'failed')).toHaveLength(1)
    const auditRows = await db.audit.findMany({ where: { target: orderId } })
    expect(auditRows.map((row) => row.action)).toContain('出货重试达上限，转人工')

    const callsBefore = mockedFulfill.mock.calls.length
    await runTicks(jobId, 1)
    expect(mockedFulfill.mock.calls.length).toBe(callsBefore)
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('failed')
    expect(await db.emailOutbox.count({ where: { orderId, status: 'failed' } })).toBe(1)
  })

  it('never turns a completed, refunded or cancelled order into failed', async () => {
    mockedFulfill.mockRejectedValue(new UpstreamError('PRODUCT_DISABLED', 1, false))
    const cases = ['completed', 'refunded', 'cancelled'] as const
    const created = []
    for (const status of cases) created.push({ status, ...(await createJob(status)) })

    for (const entry of created) await runTicks(entry.jobId, 25)

    for (const entry of created) {
      expect((await db.order.findUniqueOrThrow({ where: { id: entry.orderId } })).status).toBe(
        entry.status,
      )
    }
  })

  it('treats waiting for the buyer as a pause, not as a failed attempt', async () => {
    mockedFulfill.mockResolvedValue(false)
    const { orderId, jobId } = await createJob('needs_session')

    await runTicks(jobId, 25)

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order.status).toBe('needs_session')
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } })
    expect(job.done).toBe(false)
    expect(job.attempts).toBe(0)
  })

  it('notifies the buyer again when the order fails a second time', async () => {
    mockedFulfill.mockRejectedValue(new UpstreamError('PRODUCT_DISABLED', 1, false))
    const { orderId, jobId } = await createJob('processing')

    await runTicks(jobId, 20)
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('failed')

    // Manual retry: the operator puts the order back into processing and reopens
    // the job. A second failure must reach the buyer, not be swallowed as a
    // duplicate of the first one.
    await db.order.update({ where: { id: orderId }, data: { status: 'processing' } })
    await db.job.update({
      where: { id: jobId },
      data: { done: false, attempts: 0, runAt: new Date(0), lockedUntil: null },
    })
    await runTicks(jobId, 20)

    const mails = await db.emailOutbox.findMany({
      where: { orderId, status: 'failed' },
      orderBy: { episode: 'asc' },
    })
    expect(mails.map((mail) => mail.episode)).toEqual([1, 2])
  })

  it('records that no email could be sent when the order has no contact address', async () => {
    mockedFulfill.mockRejectedValue(new UpstreamError('PRODUCT_DISABLED', 1, false))
    const { orderId, jobId } = await createJob('processing', null)

    await runTicks(jobId, 20)

    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('failed')
    expect(await db.emailOutbox.count({ where: { orderId } })).toBe(0)
    const auditRows = await db.audit.findMany({ where: { target: orderId } })
    expect(auditRows.map((row) => row.action)).toContain('通知未发送：缺少联系邮箱')
  })
})
