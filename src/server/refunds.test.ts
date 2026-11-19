import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_refunds_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'live'
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
})
import { db } from './db'
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import { accessibleOrder, refundFailedOrder } from './services'
import { encrypt, id } from './crypto'
import { adminOrderView, orderView } from './data'
import { xorpaySignature } from './integrations/signatures'
import { orderStatusLabel } from '../lib'
import type { PaymentProvider } from '../types'

const auto = { destination: 'original', automatic: true, note: '上游确认失败' }
const manual = {
  destination: 'original',
  automatic: false,
  note: '已退回渠道全款，退款单号 fixture',
}
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
const originalSecret = 'original-key'
suite('persistent original-payment refunds', () => {
  let integrationId: string
  beforeAll(async () => {
    await prepareTestDatabase()
    const revision = await db.integration.create({
      data: {
        id: id(),
        provider: 'xorpay',
        public: { appId: 'fixture-app' },
        secret: encrypt(JSON.stringify({ secret: originalSecret }), 'integration:xorpay'),
        active: false,
        enabled: false,
      },
    })
    integrationId = revision.id
    await db.integration.create({
      data: {
        id: id(),
        provider: 'xorpay',
        public: { appId: 'changed-app' },
        secret: encrypt(JSON.stringify({ secret: 'new-key' }), 'integration:xorpay'),
        active: true,
        enabled: true,
      },
    })
  }, 30000)
  afterAll(cleanupTestDatabase)
  afterEach(() => vi.unstubAllGlobals())

  async function fixture(provider: PaymentProvider = 'xorpay', guest = false) {
    const user = guest
      ? null
      : await db.user.create({
          data: { id: id(), email: `${id()}@example.com`, referralCode: id() },
        })
    if (user) await db.wallet.create({ data: { userId: user.id, balance: 0 } })
    const order = await db.order.create({
      data: {
        id: id(),
        userId: user?.id,
        kind: 'purchase',
        status: 'failed',
        email: 'plan@example.com',
        contactEmail: user?.email ?? 'guest@example.com',
        guestBrowserDigest: guest ? 'browser' : null,
        productName: 'Refund fixture',
        listAmount: 6000,
        amount: 6000,
        balanceAmount: guest ? 0 : 4000,
        externalAmount: guest ? 6000 : 2000,
        provider,
        paymentId: id(),
        integrationId: provider === 'xorpay' ? integrationId : null,
        channel: provider === 'gmpay' ? 'crypto' : 'alipay',
        rateBps: 200,
        settlementDays: 7,
        firstOrderOnly: false,
      },
    })
    await db.paymentEvent.create({
      data: { provider, transactionId: order.paymentId!, orderId: order.id },
    })
    return order
  }
  async function balance(userId: string) {
    return (await db.wallet.findUniqueOrThrow({ where: { userId } })).balance
  }

  it('sends one automatic refund under concurrency using the original integration revision', async () => {
    const order = await fixture()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' })))
    vi.stubGlobal('fetch', fetcher)
    await Promise.all(Array.from({ length: 6 }, () => refundFailedOrder(order.id, 'admin', auto)))
    expect(fetcher).toHaveBeenCalledTimes(1)
    const fields = new URLSearchParams(
      String((fetcher.mock.calls as unknown as [string, RequestInit][])[0][1].body),
    )
    expect(fields.get('price')).toBe('20.00')
    expect(fields.get('sign')).toBe(xorpaySignature(['20.00'], originalSecret))
    expect(await balance(order.userId!)).toBe(4000)
    expect(await db.walletEntry.count({ where: { orderId: order.id, kind: 'refund' } })).toBe(1)
    const current = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(current).toMatchObject({
      status: 'refunded',
      refundStatus: 'completed',
      refundAutomatic: true,
    })
    expect(orderStatusLabel(orderView(current)).text).toBe('已退款')
  })

  it.each(['gmpay', 'epay_v1', 'epay_v2'] as const)(
    'rejects forged automatic refunds for %s and requires manual notes',
    async (provider) => {
      const order = await fixture(provider)
      await expect(refundFailedOrder(order.id, 'admin', auto)).rejects.toThrow('不支持自动退款')
      await expect(
        refundFailedOrder(order.id, 'admin', { ...manual, note: '   ' }),
      ).rejects.toThrow('请填写')
      const result = await refundFailedOrder(order.id, 'admin', manual)
      expect(result.refunded).toBe(true)
      expect(await balance(order.userId!)).toBe(4000)
      expect(result.order.refundRecord).toMatchObject({ note: manual.note, actor: 'admin' })
    },
  )

  it('allows manual XorPay refunds and still supports full refunds to the wallet', async () => {
    const first = await fixture()
    await refundFailedOrder(first.id, 'admin', manual)
    expect(await balance(first.userId!)).toBe(4000)
    const second = await fixture()
    await Promise.all([
      refundFailedOrder(second.id, 'admin'),
      refundFailedOrder(second.id, 'admin'),
    ])
    expect(await balance(second.userId!)).toBe(6000)
    expect(
      orderStatusLabel(orderView(await db.order.findUniqueOrThrow({ where: { id: second.id } })))
        .text,
    ).toBe('已退回钱包')
    await expect(refundFailedOrder(second.id, 'admin', manual)).rejects.toThrow('另一方式')
  })

  it('supports guest crypto refunds without a wallet and keeps internal notes private', async () => {
    const order = await fixture('gmpay', true)
    await expect(refundFailedOrder(order.id, 'admin')).rejects.toThrow('联系邮箱登录')
    const result = await refundFailedOrder(order.id, 'admin', {
      ...manual,
      note: 'USDT TRC20 8.50，已确认收款地址，交易哈希 fixture',
    })
    expect(result.refunded).toBe(true)
    expect(await db.walletEntry.count({ where: { orderId: order.id } })).toBe(0)
    const publicOrder = await accessibleOrder(null, 'browser', order.id)
    expect(publicOrder.refund?.destination).toBe('original')
    expect(JSON.stringify(publicOrder)).not.toContain('交易哈希 fixture')
    expect(publicOrder).not.toHaveProperty('refundRecord')
    expect(publicOrder).not.toHaveProperty('refundActor')
  })

  it.each(['timeout', 'invalid', 'rejected'])(
    'retains the claim on %s and reconciles once without resending',
    async (failure) => {
      const order = await fixture()
      const fetcher = vi.fn(async () => {
        if (failure === 'timeout') throw new Error('timeout')
        return new Response(
          failure === 'invalid' ? 'not json' : JSON.stringify({ status: 'alipay_api_error' }),
        )
      })
      vi.stubGlobal('fetch', fetcher)
      const result = await refundFailedOrder(order.id, 'admin', auto)
      expect(result).toMatchObject({ refunded: false, order: { refund: { status: 'review' } } })
      expect(await balance(order.userId!)).toBe(0)
      await refundFailedOrder(order.id, 'admin', auto)
      await expect(refundFailedOrder(order.id, 'admin')).rejects.toThrow('不能切换')
      await expect(
        refundFailedOrder(order.id, 'admin', { ...manual, reconcile: true, note: '' }),
      ).rejects.toThrow('请填写')
      await Promise.all(
        Array.from({ length: 3 }, () =>
          refundFailedOrder(order.id, 'reviewer', { ...manual, reconcile: true }),
        ),
      )
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(await balance(order.userId!)).toBe(4000)
      const current = adminOrderView(await db.order.findUniqueOrThrow({ where: { id: order.id } }))
      expect(current.refundRecord).toMatchObject({
        actor: 'admin',
        note: auto.note,
        resolvedBy: 'reviewer',
        resolutionNote: manual.note,
      })
    },
  )

  it('blocks reconciliation while the channel call is in flight', async () => {
    const order = await fixture()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        entered()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return new Response(JSON.stringify({ status: 'ok' }))
      }),
    )
    const running = refundFailedOrder(order.id, 'admin', auto)
    await started
    try {
      await expect(
        refundFailedOrder(order.id, 'admin', { ...manual, reserveManual: true }),
      ).rejects.toThrow('已发起渠道自动退款')
      await expect(
        refundFailedOrder(order.id, 'reviewer', { ...manual, reconcile: true }),
      ).rejects.toThrow('仍在处理中')
    } finally {
      release()
    }
    await running
    expect(await balance(order.userId!)).toBe(4000)
  })

  it('recovers a stale pending claim only through manual reconciliation', async () => {
    const order = await fixture()
    await db.order.update({
      where: { id: order.id },
      data: {
        refundDestination: 'original',
        refundStatus: 'processing',
        refundAutomatic: true,
        refundActor: 'old-admin',
        refundRequestedAt: new Date(Date.now() - 120000),
      },
    })
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const repeated = await refundFailedOrder(order.id, 'admin', auto)
    expect(repeated.refunded).toBe(false)
    expect(orderStatusLabel(repeated.order).text).toBe('退款待核实')
    await refundFailedOrder(order.id, 'reviewer', { ...manual, reconcile: true })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await balance(order.userId!)).toBe(4000)
  })

  it('rejects missing receipts and original refunds for balance-only orders', async () => {
    const order = await fixture()
    await db.paymentEvent.deleteMany({ where: { orderId: order.id } })
    await expect(refundFailedOrder(order.id, 'admin', manual)).rejects.toThrow('缺少已确认')
    await db.order.update({
      where: { id: order.id },
      data: {
        externalAmount: 0,
        balanceAmount: 6000,
        provider: 'balance',
        channel: 'balance',
        paymentId: null,
      },
    })
    await expect(refundFailedOrder(order.id, 'admin', manual)).rejects.toThrow('纯余额订单')
    await refundFailedOrder(order.id, 'admin')
    expect(await balance(order.userId!)).toBe(6000)
  })
})
