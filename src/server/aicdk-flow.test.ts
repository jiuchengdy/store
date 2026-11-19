import { prepareTestDatabase, cleanupTestDatabase, testQuery } from './database-test-support'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.APP_MODE = 'live'
  process.env.ENCRYPTION_KEY = 'cd'.repeat(32)
  const schema = `test_aicdk_${crypto.randomUUID().replaceAll('-', '')}`
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', schema)
    process.env.DATABASE_URL = url.toString()
  }
})
import { db, Prisma, transaction } from './db'
import { userView, paymentOrderView, adminOrderView, orderView } from './data'
import { id } from './crypto'
import {
  importInventory,
  inventoryFingerprint,
  openCredential,
  sealCredential,
} from './credential-storage'
import {
  quote,
  newOrder,
  cancelOrder,
  confirmSession,
  adminData,
  account,
  acceptPayment,
  refundFailedOrder,
  orderIdFor,
} from './services'
import { lockRow, reserveInventory } from './database-sql'
import { fulfillOrder } from './fulfillment'
import { resolveOrder } from './order-resolution'
import { refillOrder } from './order-refill'
import { saveIntegration } from './integrations/config'
import { permissions } from './rbac'
import type { User } from '../types'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
const email = 'recharge@example.com'
const session = JSON.stringify({
  user: { email },
  accessToken: 'synthetic-access-secret',
  sessionToken: 'synthetic-session-secret',
  extra: { account: 'preserved' },
})
const providerQuote = {
  amount_minor: 1000,
  currency: 'USD',
  currency_decimals: 2,
  business: 'recharge',
  target_plan: 'pro_200',
}
const ready = {
  status: 'ready',
  preflight_token: 'synthetic-preflight-secret',
  account_email: email,
  quote: providerQuote,
}
const accountResult = {
  account_email: email,
  current_plan: 'plus',
  account_status: 'active',
  subscription: {
    purchase: {
      eligible: true,
      plans: [
        { id: 'pro_200', eligible: true },
        { id: 'plus', eligible: true },
      ],
    },
  },
}
const ok = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: true, data }), { status })

suite('AICDK v2 end-to-end business invariants in isolated PostgreSQL schema', () => {
  let user: User
  const browser = 'contract-test-browser'
  let stockCounter = 0
  beforeAll(async () => {
    if (!new URL(process.env.TEST_DATABASE_URL!).pathname.endsWith('_test'))
      throw new Error('Dedicated _test database required')
    await prepareTestDatabase()
    await testQuery(Prisma.sql`INSERT INTO products(id,name,subtitle,description,price,features,plan,upgrade,pricing_mode)
      VALUES('pro200','Pro 200','','',8800,'[]','pro20',false,'fixed'),('plus','Plus','','',12900,'[]','plus',false,'fixed')`)
    await testQuery(
      Prisma.sql`INSERT INTO settings(id,body) VALUES(1,${JSON.stringify({
        rateBps: 300,
        settlementDays: 7,
        firstOrderOnly: true,
        alipay: true,
        wechat: true,
        crypto: true,
        fiatProvider: 'xorpay',
      })})`,
    )
    await saveIntegration(
      {
        provider: 'aicdk',
        enabled: true,
        public: { url: 'http://aicdk.internal:8080' },
        secrets: { apiKey: 'synthetic-api-secret' },
      },
      'test',
    )
    user = userView(
      await db.user.create({
        data: { id: id('u_'), email: 'buyer@example.com', referralCode: id().slice(0, 12) },
      }),
    )
    user.permissions = [...permissions]
    await testQuery(Prisma.sql`INSERT INTO wallets(user_id,balance) VALUES(${user.id},1000000)`)
  }, 30_000)
  // Each scenario starts a fresh frequency window; policy enforcement has its own
  // cross-request tests. Inventory fixtures must not inherit prior test traffic.
  beforeEach(() => db.rateLimit.deleteMany())
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => {
    await cleanupTestDatabase()
  })
  function stub(check: unknown = accountResult, preflight: unknown = ready) {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/account-checks')) return ok(check)
      if (url.endsWith('/redemptions/previews'))
        return ok({
          redemption_token: 'preview-ticket',
          credential_type: 'chatgpt_session',
          business: 'recharge',
        })
      if (url.endsWith('/redemptions/preflights')) return ok(preflight)
      if (url.includes('/redemptions?')) return ok([])
      throw new Error('Unexpected test request')
    })
    vi.stubGlobal('fetch', fetcher)
    return fetcher
  }
  async function stockedQuote() {
    stub()
    await importInventory('pro200', [`synthetic-card-${++stockCounter}-${id()}`], user.email)
    return quote('pro200', session, browser)
  }
  async function purchase() {
    const q = await stockedQuote()
    const order = await newOrder(user, browser, {
      quoteId: q.id,
      channel: 'balance',
      requestKey: id(),
      session,
    })
    return { order, q }
  }
  const remote = (orderId: string, status = 'queued', version = 1) => ({
    id: `ord_${orderId}`,
    client_request_id: orderId,
    account_email: email,
    quote: providerQuote,
    version,
    status,
  })
  async function internal(orderId: string) {
    return paymentOrderView(await db.order.findUniqueOrThrow({ where: { id: orderId } }))
  }
  async function discountScenario(
    options: {
      eligible?: boolean | null
      standardEligible?: boolean
      countries?: string[]
      rejectDiscount?: boolean
    } = {},
  ) {
    const productId = id('p_')
    await db.product.create({
      data: {
        id: productId,
        name: 'Plus',
        subtitle: '',
        description: '',
        price: 12900,
        features: [],
        plan: 'plus',
      },
    })
    const quotes = {
      tr: { amount_minor: 100, currency: 'USD' }, // Cheapest, but no card by default.
      us: { amount_minor: 1000, currency: 'USD' },
      jp: { amount_minor: 900, currency: 'USD' },
    }
    const cards = new Map<string, string>()
    for (const country of options.countries ?? ['us', 'jp']) {
      const code = id('discount_card_')
      cards.set(code, country)
      await importInventory(productId, [code], user.email, { discountCountry: country })
    }
    const normalCode = id('normal_card_')
    cards.set(normalCode, '')
    await importInventory(productId, [normalCode], user.email)
    const standardEligible = options.standardEligible ?? true
    const check = {
      ...accountResult,
      subscription: {
        ...accountResult.subscription,
        purchase: {
          eligible: standardEligible,
          plans: [{ id: 'plus', eligible: standardEligible }],
        },
        offers: {
          plus_50_percent_discount: {
            eligible: options.eligible === undefined ? true : options.eligible,
            percent_off: 50,
            quotes,
          },
        },
      },
    }
    const preflights: string[] = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (url.endsWith('/account-checks')) return ok(check)
      if (url.endsWith('/redemptions/previews')) {
        if (!cards.has(body.code)) throw new Error('Unexpected card')
        const country = cards.get(body.code)!
        return ok({
          redemption_token: country || 'normal',
          credential_type: 'chatgpt_session',
          business: country ? 'plus_50_percent_discount' : 'recharge',
          payment_country: country,
        })
      }
      if (url.endsWith('/redemptions/preflights')) {
        const country = body.redemption_token === 'normal' ? '' : body.redemption_token
        preflights.push(country)
        if (country && options.rejectDiscount)
          return new Response(
            JSON.stringify({
              ok: false,
              error: { code: 'OPERATION_NOT_READY', uncertain: false },
            }),
            { status: 422 },
          )
        return ok({
          ...ready,
          preflight_token: `approved-${country || 'normal'}`,
          quote: country
            ? {
                ...quotes[country as keyof typeof quotes],
                business: 'plus_50_percent_discount',
                target_plan: 'plus',
              }
            : { amount_minor: 2000, currency: 'USD', business: 'recharge', target_plan: 'plus' },
        })
      }
      if (url.includes('/redemptions?')) return ok([])
      if (url.endsWith('/redemptions')) {
        const country = body.preflight_token.slice('approved-'.length)
        return ok({
          id: `remote_${body.client_request_id}`,
          client_request_id: body.client_request_id,
          account_email: email,
          version: 1,
          status: 'completed',
          quote: {
            ...quotes[country as keyof typeof quotes],
            business: 'plus_50_percent_discount',
            target_plan: 'plus',
          },
        })
      }
      throw new Error('Unexpected test request')
    })
    vi.stubGlobal('fetch', fetcher)
    const q = await quote(productId, session, browser)
    const buy = () =>
      newOrder(user, browser, {
        quoteId: q.id,
        channel: 'balance',
        requestKey: id(),
        session,
      })
    return { q, buy, preflights, fetcher, productId }
  }

  it('uses the cheapest stocked discount country at the original public price and fulfills it', async () => {
    const { q, buy, preflights, fetcher } = await discountScenario()
    expect(q.amount).toBe(12900)
    expect(Object.keys(q).sort()).toEqual(
      ['id', 'productId', 'email', 'amount', 'currentPlan', 'targetPlan', 'expiresAt'].sort(),
    )
    const order = await buy()
    expect(order.amount).toBe(q.amount)
    expect(preflights).toEqual(['jp'])
    const { discountAmount, ...orderWithoutCouponFields } = order
    expect(discountAmount).toBe(0)
    expect(JSON.stringify(orderWithoutCouponFields)).not.toMatch(
      /discount|billing_country|approved-/i,
    )
    const stored = await db.quote.findUniqueOrThrow({
      where: { id: q.id },
      include: { inventory: true },
    })
    expect(stored.inventory?.discountCountry).toBe('jp')
    expect(stored.pricingSnapshot).toMatchObject({
      fulfillment: { business: 'plus_50_percent_discount', country: 'jp' },
    })
    expect(await fulfillOrder(order.id)).toBe(true)
    expect((await internal(order.id)).status).toBe('completed')
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/redemptions'))).toHaveLength(1)
    expect(
      (await db.inventory.findUniqueOrThrow({ where: { id: stored.inventoryId! } })).status,
    ).toBe('consumed')
  })

  it.each([false, null])(
    'uses only normal inventory when discount eligibility is %s',
    async (eligible) => {
      const { q, buy, preflights } = await discountScenario({ eligible })
      await buy()
      expect(preflights).toEqual([''])
      expect(
        (await db.quote.findUniqueOrThrow({ where: { id: q.id }, include: { inventory: true } }))
          .inventory?.discountCountry,
      ).toBeNull()
    },
  )

  it('falls back when discount stock disappears after the account check', async () => {
    const { q, buy, productId, preflights } = await discountScenario()
    await db.inventoryBatch.updateMany({
      where: { productId, discountCountry: { not: null } },
      data: { enabled: false },
    })
    await buy()
    expect(preflights).toEqual([''])
    expect(
      (await db.quote.findUniqueOrThrow({ where: { id: q.id } })).pricingSnapshot,
    ).not.toHaveProperty('fulfillment')
  })

  it('releases the optional card and keeps the public price after a definitive discount rejection', async () => {
    const { q, buy, productId, preflights } = await discountScenario({ rejectDiscount: true })
    const order = await buy()
    expect(order.amount).toBe(q.amount)
    expect(preflights).toEqual(['jp', ''])
    expect(
      await db.inventory.count({
        where: { productId, discountCountry: { not: null }, status: 'available' },
      }),
    ).toBe(2)
    expect(
      (await db.quote.findUniqueOrThrow({ where: { id: q.id } })).pricingSnapshot,
    ).not.toHaveProperty('fulfillment')
  })

  it('supports discount-only eligibility without authorizing the normal channel', async () => {
    const valid = await discountScenario({ standardEligible: false })
    await valid.buy()
    expect(valid.preflights).toEqual(['jp'])
    const expired = await discountScenario({ standardEligible: false, rejectDiscount: true })
    await expect(expired.buy()).rejects.toThrow('暂不可用')
    expect(expired.preflights).toEqual(['jp'])
    expect(await db.order.count({ where: { quoteId: expired.q.id } })).toBe(0)
    expect(
      await db.inventory.count({ where: { productId: expired.productId, status: 'reserved' } }),
    ).toBe(0)
  })

  it('reuses the selected country and card when refreshing an expired preflight', async () => {
    const { q, buy, preflights } = await discountScenario()
    const order = await buy()
    const stored = await db.quote.findUniqueOrThrow({ where: { id: q.id } })
    await db.quote.update({ where: { id: q.id }, data: { preflightExpiresAt: new Date(0) } })
    expect(await fulfillOrder(order.id)).toBe(true)
    expect((await internal(order.id)).status).toBe('needs_session')
    await confirmSession(user, order.id, session, browser)
    expect(preflights).toEqual(['jp', 'jp'])
    expect((await db.quote.findUniqueOrThrow({ where: { id: q.id } })).inventoryId).toBe(
      stored.inventoryId,
    )
    expect((await internal(order.id)).amount).toBe(12900)
    expect(await fulfillOrder(order.id)).toBe(true)
  })

  it('skips a locked cheapest card and uses the next stocked discount country', async () => {
    const { q, buy, productId, preflights } = await discountScenario()
    let unlock!: () => void
    let locked!: () => void
    const acquired = new Promise<void>((resolve) => {
      locked = resolve
    })
    const gate = new Promise<void>((resolve) => {
      unlock = resolve
    })
    const holding = transaction(async (client) => {
      expect(await reserveInventory(client, productId, 'jp')).not.toBeNull()
      locked()
      await gate
    })
    await acquired
    try {
      await buy()
      expect(preflights).toEqual(['us'])
      expect(
        (await db.quote.findUniqueOrThrow({ where: { id: q.id }, include: { inventory: true } }))
          .inventory?.discountCountry,
      ).toBe('us')
    } finally {
      unlock()
      await holding
    }
  })

  // Each contention scenario has its own product, stock and buyers, so unrelated
  // fixtures and the per-user lock cannot hide a double-allocation bug.
  async function competingBuyers(cards: number, buyers = 2) {
    stub()
    const productId = id('product_')
    await db.product.create({
      data: {
        id: productId,
        name: 'Concurrent recharge',
        subtitle: '',
        description: '',
        price: 100,
        features: [],
        plan: 'pro20',
        upgrade: false,
        pricingMode: 'fixed',
      },
    })
    await importInventory(
      productId,
      Array.from({ length: cards }, () => `synthetic-card-${id()}`),
      user.email,
    )
    // Reuse a verified fixture snapshot to exercise inventory contention, without
    // generating twelve live account checks for the same target in one minute.
    const template = buyers
      ? await db.quote.findUniqueOrThrow({
          where: { id: (await quote(productId, session, id())).id },
        })
      : null
    const requests = await Promise.all(
      Array.from({ length: buyers }, async () => {
        const buyer = userView(
          await db.user.create({
            data: { id: id('u_'), email: `${id()}@example.com`, referralCode: id() },
          }),
        )
        await db.wallet.create({ data: { userId: buyer.id, balance: 100000 } })
        const browser = id('browser_')
        const q = await db.quote.create({
          data: {
            ...template!,
            id: id('q_'),
            browserDigest: browser,
            pricingSnapshot: template!.pricingSnapshot as Prisma.InputJsonValue,
          },
        })
        const input = { quoteId: q.id, channel: 'balance' as const, requestKey: id(), session }
        return { buyer, browser, q, input }
      }),
    )
    return { productId, requests }
  }
  function gate() {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    return { promise, release }
  }
  describe('free refills on the paid order', () => {
    const request = { session, confirmedNotReceived: true, round: 0 }
    async function fixture(cards: number, guest = false) {
      const {
        productId,
        requests: [buyer],
      } = await competingBuyers(cards, 1)
      if (guest)
        await saveIntegration(
          {
            provider: 'xorpay',
            enabled: true,
            public: { appId: 'refill' },
            secrets: { secret: id() },
          },
          'test',
        )
      const owner = guest ? null : buyer.buyer
      const order = await newOrder(
        owner,
        buyer.browser,
        guest
          ? { ...buyer.input, channel: 'alipay', contactEmail: 'guest@example.com' }
          : buyer.input,
      )
      if (guest) {
        const payment = await internal(order.id)
        await acceptPayment(payment.provider, payment.integrationId!, {
          orderId: order.id,
          transactionId: id(),
          amount: order.externalAmount,
          paid: true,
        })
      }
      const stored = await db.order.update({
        where: { id: order.id },
        data: {
          status: 'failed',
          fulfillmentStatus: 'failed',
          redemptionId: `ord_${order.id}`,
          redemptionVersion: 4,
          submissionAttempted: true,
        },
      })
      const originalId = (await db.quote.findUniqueOrThrow({ where: { id: buyer.q.id } }))
        .inventoryId!
      const apply = () => refillOrder(owner, buyer.browser, order.id, request)
      return { apply, owner, browser: buyer.browser, order, originalId, productId, stored }
    }

    function upstream(orderId: string, available = true) {
      const fetcher = stub()
      const base = fetcher.getMockImplementation()!
      fetcher.mockImplementation(async (url) => {
        if (url.endsWith(`/redemptions/ord_${orderId}`)) return ok(remote(orderId, 'failed', 4))
        if (url.endsWith('/replacements/previews'))
          return available
            ? ok({ product_id: 'p200', product_name: 'Pro', plan: 'pro_200', expires_at: null })
            : new Response(JSON.stringify({ ok: false, error: { code: 'CDK_LOCKED' } }), {
                status: 409,
              })
        return base(url)
      })
      return fetcher
    }

    it('replays concurrent clicks without another debit, releases only verified stock, and fulfills the new round once', async () => {
      const { apply, order, originalId, productId, stored } = await fixture(2)
      const fetcher = upstream(order.id)
      await Promise.all([apply(), apply(), apply()])
      expect(fetcher.mock.calls).toHaveLength(4)
      const current = await db.order.findUniqueOrThrow({ where: { id: order.id } })
      expect(current).toMatchObject({
        status: 'processing',
        amount: stored.amount,
        quoteId: stored.quoteId,
        balanceAmount: stored.balanceAmount,
        redemptionId: null,
        submissionAttempted: false,
      })
      expect(adminOrderView(current).refillHistory).toMatchObject([
        { disposition: 'returned', inventoryId: originalId, redemptionId: stored.redemptionId },
      ])
      expect(orderView(current)).not.toHaveProperty('refillHistory')
      expect(await db.inventory.findUniqueOrThrow({ where: { id: originalId } })).toMatchObject({
        status: 'available',
      })
      expect(await transaction((client) => reserveInventory(client, productId))).toMatchObject({
        id: originalId,
      })
      const key = `${order.id}-r1`
      const submit = vi
        .fn()
        .mockResolvedValueOnce(ok([]))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(ok([]))
        .mockResolvedValueOnce(ok(remote(key), 202))
        .mockResolvedValueOnce(ok(remote(key, 'completed', 2)))
      vi.stubGlobal('fetch', submit)
      await expect(fulfillOrder(order.id)).rejects.toMatchObject({ uncertain: true })
      expect(await fulfillOrder(order.id)).toBe(false)
      expect(await fulfillOrder(order.id)).toBe(true)
      expect(submit.mock.calls[0][0]).toContain(`client_request_id=${key}`)
      expect(JSON.parse(submit.mock.calls[1][1].body).client_request_id).toBe(key)
      expect(submit.mock.calls[3][1].body).toBe(submit.mock.calls[1][1].body)
      expect(submit.mock.calls[3][1].headers['Idempotency-Key']).toBe(`${key}-v1`)
      expect(await apply()).toEqual({ accepted: true })
      expect(await internal(order.id)).toMatchObject({ refillCount: 1, status: 'completed' })
      expect(await db.walletEntry.count({ where: { orderId: order.id } })).toBe(1)
      expect(await db.order.count({ where: { productId } })).toBe(1)
      expect(await db.inventory.count({ where: { productId, status: 'consumed' } })).toBe(1)
      expect(
        await db.emailOutbox.count({ where: { orderId: order.id, status: 'completed' } }),
      ).toBe(1)
    })

    it('holds an unverified old card and resumes a renewed session under the refill request ID', async () => {
      const { apply, owner, browser, order, originalId, productId } = await fixture(2)
      upstream(order.id, false)
      await apply()
      expect(await db.inventory.findUniqueOrThrow({ where: { id: originalId } })).toMatchObject({
        status: 'reserved',
        reservedUntil: null,
      })
      expect(await transaction((client) => reserveInventory(client, productId))).toBe(null)
      const key = `${order.id}-r1`
      await db.quote.update({
        where: { id: (await internal(order.id)).quoteId! },
        data: { preflightExpiresAt: new Date(0) },
      })
      const refresh = stub()
      expect(await fulfillOrder(order.id)).toBe(true)
      await confirmSession(owner, order.id, session, browser)
      expect(
        refresh.mock.calls.filter(([url]) => url.includes(`client_request_id=${key}`)),
      ).toHaveLength(2)
      expect(await internal(order.id)).toMatchObject({
        status: 'processing',
        refillCount: 1,
        fulfillmentAttempt: 2,
      })
    })

    it('rolls back on shortage or a mismatched preflight, and reuses a verified original if no spare exists', async () => {
      const { apply, order, originalId } = await fixture(1)
      upstream(order.id, false)
      await expect(apply()).rejects.toThrow('库存')
      const mocked = upstream(order.id)
      const base = mocked.getMockImplementation()!
      mocked.mockImplementation((url) =>
        url.endsWith('/redemptions/preflights')
          ? Promise.resolve(ok({ ...ready, account_email: 'other@example.com' }))
          : base(url),
      )
      await expect(apply()).rejects.toThrow('不匹配')
      expect(await internal(order.id)).toMatchObject({ status: 'failed', refillCount: 0 })
      upstream(order.id)
      await apply()
      const row = await db.order.findUniqueOrThrow({ where: { id: order.id } })
      expect(adminOrderView(row).refillHistory).toMatchObject([
        { disposition: 'reused', inventoryId: originalId, nextInventoryId: originalId },
      ])
    })

    it('requires the original guest, confirmation, matching account and actual payment; rejects pending or conflicting remote outcomes', async () => {
      const { apply, order, browser, stored } = await fixture(2, true)
      const fetcher = upstream(order.id)
      await expect(refillOrder(null, 'other-browser', order.id, request)).rejects.toMatchObject({
        status: 404,
      })
      await expect(
        refillOrder(null, browser, order.id, { ...request, confirmedNotReceived: false }),
      ).rejects.toThrow()
      await expect(refillOrder(null, browser, order.id, { ...request, round: 1 })).rejects.toThrow(
        '不能补充',
      )
      await expect(
        refillOrder(null, browser, order.id, {
          ...request,
          session: JSON.stringify({ ...JSON.parse(session), user: { email: 'other@example.com' } }),
        }),
      ).rejects.toThrow('原充值账号')
      expect(fetcher).not.toHaveBeenCalled()
      for (const result of [
        remote(order.id, 'failed', 3),
        { ...remote(order.id, 'failed', 5), account_email: 'other@example.com' },
      ]) {
        fetcher.mockResolvedValueOnce(ok(result))
        await expect(apply()).rejects.toThrow()
      }
      expect(
        fetcher.mock.calls.every(([url]) => url.endsWith(`/redemptions/${stored.redemptionId}`)),
      ).toBe(true)
      await apply()
      expect(await db.paymentEvent.count({ where: { orderId: order.id } })).toBe(1)
      await db.order.update({
        where: { id: order.id },
        data: { status: 'failed', fulfillmentStatus: 'failed' },
      })
      expect(await apply()).toEqual({ accepted: true })
      expect((await internal(order.id)).refillCount).toBe(1)
      await db.paymentEvent.deleteMany({ where: { orderId: order.id } })
      fetcher.mockClear()
      await expect(refillOrder(null, browser, order.id, { ...request, round: 1 })).rejects.toThrow(
        '收款记录',
      )
      expect(fetcher).not.toHaveBeenCalled()
    })

    it.each(['queued', 'uncertain', 'completed'])(
      'only resumes polling the original when the upstream now reports %s',
      async (status) => {
        const { apply, order, originalId } = await fixture(2)
        const fetcher = upstream(order.id)
        fetcher.mockResolvedValueOnce(ok(remote(order.id, status, 5)))
        await expect(apply()).rejects.toThrow('上游未确认')
        expect(await internal(order.id)).toMatchObject({
          status: 'processing',
          refillCount: 0,
          redemptionId: `ord_${order.id}`,
        })
        await expect(refundFailedOrder(order.id, 'finance')).rejects.toThrow('仅已确认失败')
        fetcher.mockResolvedValueOnce(ok(remote(order.id, 'completed', 6)))
        expect(await fulfillOrder(order.id)).toBe(true)
        expect(
          fetcher.mock.calls.every(([url]) => url.endsWith(`/redemptions/ord_${order.id}`)),
        ).toBe(true)
        expect(await db.inventory.findUniqueOrThrow({ where: { id: originalId } })).toMatchObject({
          status: 'consumed',
        })
      },
    )

    it('allows a verified never-submitted failure, but blocks a conflicting manual decision and refund', async () => {
      for (const wasSubmitted of [false, true]) {
        const { order, apply } = await fixture(2)
        const before = await db.order.update({
          where: { id: order.id },
          data: {
            status: 'processing',
            redemptionId: null,
            redemptionVersion: 0,
            submissionAttempted: wasSubmitted,
            fulfillmentStatus: null,
          },
        })
        await resolveOrder(order.id, 'support', {
          outcome: 'failed',
          note: '核对原订单',
          confirmed: true,
          expectedRevision: adminOrderView(before).resolutionRevision,
        })
        const fetcher = upstream(order.id)
        if (wasSubmitted) {
          fetcher.mockResolvedValueOnce(ok([remote(order.id, 'completed', 3)]))
          await expect(apply()).rejects.toThrow('上游未确认')
          await expect(apply()).rejects.toThrow('不能补充')
          await expect(refundFailedOrder(order.id, 'finance')).rejects.toThrow('冲突')
          expect(fetcher).toHaveBeenCalledTimes(1)
        } else {
          await apply()
          expect(
            adminOrderView(await db.order.findUniqueOrThrow({ where: { id: order.id } }))
              .refillHistory,
          ).toMatchObject([{ outcome: 'not_submitted' }])
        }
      }
    })

    it('requires a durable claim before a manual transfer for a refillable order', async () => {
      const { order, apply } = await fixture(2, true)
      const fetcher = upstream(order.id)
      const manual = { destination: 'original', automatic: false, note: '渠道退款凭证 123' }
      await expect(refundFailedOrder(order.id, 'finance', manual)).rejects.toThrow('先锁定')
      const claim = { ...manual, reserveManual: true, note: '' }
      const claimed = await refundFailedOrder(order.id, 'finance', claim)
      expect(claimed.order).toMatchObject({
        status: 'failed',
        canRefill: false,
        refund: { status: 'review', automatic: false },
      })
      await expect(refundFailedOrder(order.id, 'another-admin', claim)).rejects.toThrow(
        '其他操作人',
      )
      await expect(apply()).rejects.toThrow('不能补充')
      await refundFailedOrder(order.id, 'finance', { ...manual, reconcile: true })
      expect(await internal(order.id)).toMatchObject({ status: 'refunded', refillCount: 0 })
      expect(fetcher).not.toHaveBeenCalled()
    })

    it('archives manual evidence, refuses untraced submissions, and isolates late results from the next attempt', async () => {
      const { apply, order } = await fixture(2)
      const before = await db.order.update({
        where: { id: order.id },
        data: {
          status: 'processing',
          redemptionId: null,
          fulfillmentStatus: 'uncertain',
          redemptionVersion: 0,
        },
      })
      const started = gate()
      const finish = gate()
      const fetcher = upstream(order.id)
      fetcher.mockImplementationOnce(async () => {
        started.release()
        await finish.promise
        return ok([remote(order.id, 'failed', 1)])
      })
      const running = fulfillOrder(order.id)
      await started.promise
      try {
        await resolveOrder(order.id, 'operator', {
          outcome: 'failed',
          note: 'verified ticket',
          confirmed: true,
          expectedRevision: adminOrderView(before).resolutionRevision,
        })
        await expect(apply()).rejects.toThrow('原兑换已终止')
        fetcher.mockResolvedValueOnce(ok([remote(order.id, 'cancelled', 3)]))
        await apply()
      } finally {
        finish.release()
      }
      await running
      const row = await db.order.findUniqueOrThrow({ where: { id: order.id } })
      expect(row).toMatchObject({
        status: 'processing',
        redemptionVersion: 0,
        redemptionId: null,
        fulfillmentResolution: null,
      })
      expect(adminOrderView(row).refillHistory).toMatchObject([
        { outcome: 'cancelled', resolution: { note: 'verified ticket' } },
      ])
      expect(JSON.stringify(orderView(row))).not.toContain('verified ticket')
    })

    it('serializes a refund against a refill and blocks a refunded order', async () => {
      const { apply, order } = await fixture(2)
      const fetcher = upstream(order.id)
      const started = gate()
      const finish = gate()
      fetcher.mockImplementationOnce(async () => {
        started.release()
        await finish.promise
        return ok(remote(order.id, 'failed', 4))
      })
      const running = apply()
      await started.promise
      const refund = expect(refundFailedOrder(order.id, 'finance')).rejects.toThrow('仅已确认失败')
      finish.release()
      await Promise.all([running, refund])
      expect(await db.walletEntry.count({ where: { orderId: order.id, kind: 'refund' } })).toBe(0)
      const other = await fixture(2)
      await refundFailedOrder(other.order.id, 'finance')
      const unused = upstream(other.order.id)
      await expect(other.apply()).rejects.toThrow('不能补充')
      expect(unused).not.toHaveBeenCalled()
    })
    it('requires a new buyer decision for another failed round and rejects stale refund forms', async () => {
      const { order, owner, browser, apply } = await fixture(1)
      const first = upstream(order.id)
      await apply()
      first.mockResolvedValueOnce(ok([remote(`${order.id}-r1`, 'failed', 1)]))
      expect(await fulfillOrder(order.id)).toBe(true)
      await apply()
      expect(await internal(order.id)).toMatchObject({ status: 'failed', refillCount: 1 })
      await expect(refundFailedOrder(order.id, 'finance')).rejects.toThrow('补充记录已更新')
      first.mockResolvedValueOnce(ok(remote(`${order.id}-r1`, 'failed', 1)))
      await refillOrder(owner, browser, order.id, { ...request, round: 1 })
      const polling = vi.fn().mockResolvedValueOnce(ok([remote(`${order.id}-r2`, 'completed', 1)]))
      vi.stubGlobal('fetch', polling)
      expect(await fulfillOrder(order.id)).toBe(true)
      expect(polling.mock.calls[0][0]).toContain(`client_request_id=${order.id}-r2`)
      expect(await internal(order.id)).toMatchObject({ status: 'completed', refillCount: 2 })
      expect(await db.walletEntry.count({ where: { orderId: order.id } })).toBe(1)
    })
  })
  it('lets only one of two different buyers reserve the last card while preflight is in flight', async () => {
    const {
      productId,
      requests: [a, b],
    } = await competingBuyers(1)
    const entered = gate()
    const finish = gate()
    const fetcher = stub()
    const response = fetcher.getMockImplementation()!
    fetcher.mockImplementation(async (url) => {
      if (url.endsWith('/redemptions/preflights')) {
        entered.release()
        await finish.promise
      }
      return response(url)
    })
    const first = newOrder(a.buyer, a.browser, a.input)
    try {
      await entered.promise
      await expect(newOrder(b.buyer, b.browser, b.input)).rejects.toThrow('缺货')
      expect((await db.quote.findUniqueOrThrow({ where: { id: b.q.id } })).inventoryId).toBeNull()
      expect(await db.walletEntry.count({ where: { userId: b.buyer.id } })).toBe(0)
    } finally {
      finish.release()
      await first
    }
    expect(await db.order.count({ where: { productId } })).toBe(1)
    expect(
      await db.inventory.count({ where: { productId, status: 'reserved', reservedUntil: null } }),
    ).toBe(1)
    expect(
      fetcher.mock.calls.filter(([url]) => url.endsWith('/redemptions/preflights')),
    ).toHaveLength(1)
  })
  it('assigns distinct cards to competing buyers and never oversells a limited pool', async () => {
    const { productId, requests } = await competingBuyers(3, 12)
    const results = await Promise.allSettled(
      requests.map(({ buyer, browser, input }) => newOrder(buyer, browser, input)),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3)
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason.message).toContain('缺货')
    const allocated = await db.quote.findMany({ where: { productId, inventoryId: { not: null } } })
    expect(allocated).toHaveLength(3)
    expect(new Set(allocated.map((q) => q.inventoryId)).size).toBe(3)
    expect(await db.order.count({ where: { productId } })).toBe(3)
  })
  it('rolls back preflight inventory on risk rejection and retains denial evidence', async () => {
    const {
      productId,
      requests: [request],
    } = await competingBuyers(1, 1)
    const fixtures = Array.from({ length: 5 }, () => id('o_'))
    await db.order.createMany({
      data: fixtures.map((key) => ({
        id: key,
        userId: request.buyer.id,
        email: request.buyer.email,
        contactEmail: request.buyer.email,
        listAmount: 1000,
        amount: 1000,
        externalAmount: 1000,
        status: 'unpaid',
        channel: 'alipay',
        provider: 'xorpay',
        kind: 'topup',
        productName: 'Risk fixture',
        rateBps: 0,
        settlementDays: 0,
        firstOrderOnly: true,
      })),
    })
    const orderId = orderIdFor(`${request.buyer.id}:${request.input.requestKey}`)
    try {
      await expect(newOrder(request.buyer, request.browser, request.input)).rejects.toMatchObject({
        status: 403,
      })
      expect(await db.order.findUnique({ where: { id: orderId } })).toBeNull()
      expect(await db.inventory.count({ where: { productId, status: 'available' } })).toBe(1)
      expect(await db.quote.findUniqueOrThrow({ where: { id: request.q.id } })).toMatchObject({
        inventoryId: null,
        preflightToken: null,
      })
      expect(await db.walletEntry.count({ where: { userId: request.buyer.id } })).toBe(0)
      expect(
        await db.riskEvent.findFirstOrThrow({ where: { referenceId: orderId } }),
      ).toMatchObject({
        mode: 'enforce',
        effectiveAction: 'review',
        reasonCodes: ['UNPAID_ORDER_ACCUMULATION'],
      })
    } finally {
      await db.order.updateMany({ where: { id: { in: fixtures } }, data: { status: 'cancelled' } })
    }
  })
  it('skips locked expired cards and does not wait on expiry cleanup for another product', async () => {
    const { productId } = await competingBuyers(2, 0)
    const { productId: otherProductId } = await competingBuyers(1, 0)
    const expired = new Date(Date.now() - 60_000)
    await db.inventory.updateMany({
      where: { productId: { in: [productId, otherProductId] } },
      data: { status: 'reserved', reservedUntil: expired },
    })
    const cards = await db.inventory.findMany({ where: { productId }, orderBy: { id: 'asc' } })
    const other = await db.inventory.findFirstOrThrow({ where: { productId: otherProductId } })
    const entered = gate()
    const finish = gate()
    const holder = transaction(async (client) => {
      await lockRow(client, 'inventory', cards[0].id)
      await lockRow(client, 'inventory', other.id)
      entered.release()
      await finish.promise
    })
    try {
      await entered.promise
      const reserved = await transaction(async (client) => {
        await client.$executeRaw`SET LOCAL lock_timeout = '500ms'`
        return reserveInventory(client, productId)
      })
      expect(reserved?.id).toBe(cards[1].id)
      expect(reserved?.status).toBe('reserved')
      expect(reserved?.reservedUntil).toBeNull()
    } finally {
      finish.release()
      await holder
    }
    expect(
      (await db.inventory.findUniqueOrThrow({ where: { id: other.id } })).reservedUntil,
    ).toEqual(expired)
  })
  it('never reclaims a card bound to a non-cancelled order even with stale expiry or status', async () => {
    const {
      productId,
      requests: [a, b],
    } = await competingBuyers(1)
    const first = await newOrder(a.buyer, a.browser, a.input)
    const card = await db.inventory.findFirstOrThrow({ where: { productId } })
    for (const status of [
      'unpaid',
      'processing',
      'needs_session',
      'completed',
      'failed',
      'refunded',
    ]) {
      await db.order.update({ where: { id: first.id }, data: { status } })
      for (const inventoryStatus of ['reserved', 'available']) {
        await db.inventory.update({
          where: { id: card.id },
          data: { status: inventoryStatus, reservedUntil: new Date(Date.now() - 60_000) },
        })
        await expect(newOrder(b.buyer, b.browser, b.input)).rejects.toThrow('缺货')
      }
    }
    expect(await db.order.count({ where: { productId } })).toBe(1)
  })
  it('rolls back a failed preflight and lets the next buyer reserve the same card', async () => {
    const {
      productId,
      requests: [a, b],
    } = await competingBuyers(1)
    stub(accountResult, { ...ready, quote: { ...providerQuote, business: 'upgrade' } })
    await expect(newOrder(a.buyer, a.browser, a.input)).rejects.toThrow('业务类型')
    expect(await db.inventory.count({ where: { productId, status: 'available' } })).toBe(1)
    expect(await db.walletEntry.count({ where: { userId: a.buyer.id } })).toBe(0)
    stub()
    await newOrder(b.buyer, b.browser, b.input)
    expect(await db.inventory.count({ where: { productId, status: 'reserved' } })).toBe(1)
    expect(await db.order.count({ where: { productId } })).toBe(1)
  })
  it('reuses a safely cancelled guest card without letting cancellation retries release its new owner', async () => {
    await saveIntegration(
      {
        provider: 'xorpay',
        enabled: true,
        public: { appId: 'test' },
        secrets: { secret: 'synthetic-test-key' },
      },
      'test',
    )
    const {
      productId,
      requests: [a, b],
    } = await competingBuyers(1)
    const guestInput = {
      ...a.input,
      channel: 'alipay' as const,
      contactEmail: 'guest@example.com',
    }
    const order = await newOrder(null, a.browser, guestInput)
    await Promise.all(Array.from({ length: 4 }, () => cancelOrder(null, a.browser, order.id)))
    const next = await newOrder(b.buyer, b.browser, b.input)
    await cancelOrder(null, a.browser, order.id)
    expect((await newOrder(null, a.browser, guestInput)).status).toBe('cancelled')
    const originalQuote = await db.quote.findUniqueOrThrow({ where: { id: a.q.id } })
    const nextQuote = await db.quote.findUniqueOrThrow({ where: { id: b.q.id } })
    expect(nextQuote.inventoryId).toBe(originalQuote.inventoryId)
    expect(await db.inventory.count({ where: { productId, status: 'reserved' } })).toBe(1)
    expect((await internal(next.id)).status).toBe('processing')
  })
  it('does not release another live order when cancelling a conflicting inventory binding', async () => {
    const {
      productId,
      requests: [a, b],
    } = await competingBuyers(1)
    const order = await newOrder(a.buyer, a.browser, a.input)
    const card = await db.inventory.findFirstOrThrow({ where: { productId } })
    // Simulate inconsistent data to verify that cancellation preserves the active order.
    await db.quote.update({ where: { id: b.q.id }, data: { inventoryId: card.id } })
    const original = await db.order.findUniqueOrThrow({ where: { id: order.id } })
    const conflicting = await db.order.create({
      data: {
        ...original,
        refillHistory: [],
        fulfillmentResolution: original.fulfillmentResolution ?? Prisma.DbNull,
        couponSnapshot: original.couponSnapshot ?? Prisma.DbNull,
        id: id('o_'),
        userId: b.buyer.id,
        quoteId: b.q.id,
        status: 'unpaid',
        balanceAmount: 0,
        externalAmount: original.amount,
      },
    })
    await cancelOrder(b.buyer, b.browser, conflicting.id)
    expect((await db.inventory.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'reserved',
    )
    expect((await internal(order.id)).status).toBe('processing')
  })
  it('keeps the order transaction alive during a slow upstream preflight', async () => {
    const q = await stockedQuote()
    const fetcher = stub()
    const response = fetcher.getMockImplementation()!
    fetcher.mockImplementationOnce(async (url: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10_500))
      return response(url)
    })
    const order = await newOrder(user, browser, {
      quoteId: q.id,
      channel: 'balance',
      requestKey: id(),
      session,
    })
    expect(order.status).toBe('processing')
    expect(await db.walletEntry.count({ where: { orderId: order.id, kind: 'purchase' } })).toBe(1)
    expect((await db.quote.findUniqueOrThrow({ where: { id: q.id } })).inventoryId).toBeTruthy()
  }, 20_000)
  it('checks and quotes without inventory, and persists no Session or redemption authorization', async () => {
    const fetcher = stub()
    const result = await quote('pro200', session, browser)
    expect(result.amount).toBe(8800)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toContain('/account-checks')
    const stored = (await testQuery(Prisma.sql`SELECT * FROM quotes WHERE id=${result.id}`)).rows[0]
    expect(stored.inventory_id).toBeNull()
    expect(stored.preflight_token).toBeNull()
    expect(JSON.stringify(stored)).not.toContain('synthetic-session-secret')
    expect(JSON.stringify(result)).not.toContain('providerQuote')
  })
  it('fails closed for unknown, ineligible, ambiguous and mismatched account results', async () => {
    for (const eligible of [false, null]) {
      stub({
        ...accountResult,
        subscription: {
          ...accountResult.subscription,
          purchase: {
            eligible: true,
            plans: [
              { id: 'pro_200', eligible },
              { id: 'pro_100', eligible: true },
            ],
          },
        },
      })
      await expect(quote('pro200', session, browser)).rejects.toThrow()
    }
    stub({ ...accountResult, account_email: 'other@example.com' })
    await expect(quote('pro200', session, browser)).rejects.toThrow('不匹配')
    stub({
      ...accountResult,
      subscription: {
        ...accountResult.subscription,
        purchase: {
          eligible: true,
          plans: [
            accountResult.subscription.purchase.plans[0],
            accountResult.subscription.purchase.plans[0],
          ],
        },
      },
    })
    await expect(quote('pro200', session, browser)).rejects.toThrow('暂不可用')
  })
  it('keeps the fixed recharge price when the provider includes a cost quote', async () => {
    stub({
      ...accountResult,
      subscription: {
        ...accountResult.subscription,
        purchase: {
          eligible: true,
          plans: [
            {
              id: 'pro_200',
              eligible: true,
              quote: { amount_minor: 1000, currency: 'JPY', currency_decimals: 0 },
            },
          ],
        },
      },
    })
    expect((await quote('pro200', session, browser)).amount).toBe(8800)
  })
  it('allocates only at order confirmation, serializes concurrent retries and returns no secrets', async () => {
    const q = await stockedQuote()
    const fetcher = stub()
    const input = { quoteId: q.id, channel: 'balance' as const, requestKey: id(), session }
    const [a, b] = await Promise.all([
      newOrder(user, browser, input),
      newOrder(user, browser, input),
    ])
    expect(a.id).toBe(b.id)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const stored = (await testQuery(Prisma.sql`SELECT * FROM quotes WHERE id=${q.id}`)).rows[0]
    expect(stored.inventory_id).toBeTruthy()
    expect(openCredential(stored.preflight_token, 'preflight', q.id)).toBe(ready.preflight_token)
    expect(JSON.stringify(a)).not.toContain('synthetic')
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT count(*)::int AS n FROM wallet_ledger WHERE order_id=${a.id}`,
        )
      ).rows[0].n,
    ).toBe(1)
    const admin = await adminData(user)
    expect(JSON.stringify(admin)).not.toContain('synthetic')
    expect(JSON.stringify(await account(user))).not.toContain('synthetic')
  })
  it('rolls back allocation and balance for a mismatched card plan', async () => {
    const q = await stockedQuote()
    stub(accountResult, { ...ready, quote: { ...providerQuote, target_plan: 'plus' } })
    const before = (
      await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${user.id}`)
    ).rows[0].balance
    await expect(
      newOrder(user, browser, { quoteId: q.id, channel: 'balance', requestKey: id(), session }),
    ).rejects.toThrow('不匹配')
    expect(
      (await testQuery(Prisma.sql`SELECT inventory_id FROM quotes WHERE id=${q.id}`)).rows[0]
        .inventory_id,
    ).toBeNull()
    expect(
      (await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${user.id}`)).rows[0]
        .balance,
    ).toBe(before)
  })
  it('does not touch the upstream card APIs for missing or mismatched confirmation credentials', async () => {
    const q = await stockedQuote()
    const fetcher = stub()
    await expect(
      newOrder(user, browser, {
        quoteId: q.id,
        channel: 'balance',
        requestKey: id(),
      }),
    ).rejects.toThrow('重新检查')
    await expect(
      newOrder(user, browser, {
        quoteId: q.id,
        channel: 'balance',
        requestKey: id(),
        session: JSON.stringify({ ...JSON.parse(session), user: { email: 'other@example.com' } }),
      }),
    ).rejects.toThrow('对应的充值账号')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('recovers, submits once, polls the known id and completes only on completed', async () => {
    const { order, q } = await purchase()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok(remote(order.id), 202))
      .mockResolvedValueOnce(ok(remote(order.id, 'completed', 2)))
    vi.stubGlobal('fetch', fetcher)
    expect(await fulfillOrder(order.id)).toBe(false)
    expect((await internal(order.id)).status).toBe('processing')
    expect(
      (await testQuery(Prisma.sql`SELECT preflight_token FROM quotes WHERE id=${q.id}`)).rows[0]
        .preflight_token,
    ).toBeNull()
    expect(await fulfillOrder(order.id)).toBe(true)
    expect((await internal(order.id)).status).toBe('completed')
    expect(fetcher.mock.calls.filter((call) => call[1].method === 'POST')).toHaveLength(1)
    expect(fetcher.mock.calls[1][1].headers['Idempotency-Key']).toBe(`${order.id}-v0`)
  })
  it('preserves the submission body and key after a timeout, even when the token later expires', async () => {
    const { order, q } = await purchase()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok([]))
      .mockRejectedValueOnce(new Error('network lost'))
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok(remote(order.id), 202))
    vi.stubGlobal('fetch', fetcher)
    await expect(fulfillOrder(order.id)).rejects.toMatchObject({ uncertain: true })
    expect((await internal(order.id)).submissionAttempted).toBe(true)
    await testQuery(
      Prisma.sql`UPDATE quotes SET preflight_expires_at=now()-interval '1 minute' WHERE id=${q.id}`,
    )
    expect(await fulfillOrder(order.id)).toBe(false)
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[3][1].body)
    expect(fetcher.mock.calls[1][1].headers['Idempotency-Key']).toBe(
      fetcher.mock.calls[3][1].headers['Idempotency-Key'],
    )
  })
  it('asks for a fresh Session on a definitively rejected preflight, with no second redemption', async () => {
    const { order } = await purchase()
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'OPERATION_NOT_READY', uncertain: false },
          }),
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(ok([]))
    vi.stubGlobal('fetch', fetcher)
    expect(await fulfillOrder(order.id)).toBe(true)
    expect(await internal(order.id)).toMatchObject({
      status: 'needs_session',
      submissionAttempted: false,
      fulfillmentAttempt: 0,
    })
    const resume = stub()
    await confirmSession(user, order.id, session, browser)
    expect(await internal(order.id)).toMatchObject({ status: 'processing', fulfillmentAttempt: 1 })
    expect(resume.mock.calls.some(([url]) => url.endsWith('/redemptions'))).toBe(false)
  })
  it('refreshes an existing order with PUT and never selects a replacement card', async () => {
    const { order } = await purchase()
    await testQuery(
      Prisma.sql`UPDATE orders SET status='needs_session',redemption_id=${`ord_${order.id}`},redemption_version=1 WHERE id=${order.id}`,
    )
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(ok(remote(order.id, 'needs_session', 2)))
      .mockResolvedValueOnce(ok(remote(order.id, 'queued', 3)))
    vi.stubGlobal('fetch', fetcher)
    await confirmSession(user, order.id, session, browser)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toMatch(/\/account-session$/)
    expect(fetcher.mock.calls[1][1].method).toBe('PUT')
    expect((await internal(order.id)).fulfillmentAttempt).toBe(0)
    expect((await internal(order.id)).redemptionVersion).toBe(3)
  })
  it('does not submit an unattempted expired ticket or refresh an uncertain submission', async () => {
    const { order, q } = await purchase()
    await testQuery(
      Prisma.sql`UPDATE quotes SET preflight_expires_at=now()-interval '1 minute' WHERE id=${q.id}`,
    )
    const fetcher = stub()
    expect(await fulfillOrder(order.id)).toBe(true)
    expect((await internal(order.id)).status).toBe('needs_session')
    expect(fetcher.mock.calls.every(([url]) => url.includes('/redemptions?'))).toBe(true)
    await testQuery(Prisma.sql`UPDATE orders SET submission_attempted=true WHERE id=${order.id}`)
    fetcher.mockClear()
    await expect(confirmSession(user, order.id, session, browser)).rejects.toThrow('仍待核对')
    expect(fetcher.mock.calls.every(([url]) => url.includes('/redemptions?'))).toBe(true)
  })
  it('rejects a foreign or stale recovery response without completing or replacing the local order', async () => {
    const { order } = await purchase()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok([{ ...remote(order.id), account_email: 'other@example.com' }])),
    )
    await expect(fulfillOrder(order.id)).rejects.toThrow('不匹配')
    expect((await internal(order.id)).redemptionId).toBeNull()
    await testQuery(
      Prisma.sql`UPDATE orders SET redemption_id=${`ord_${order.id}`},redemption_version=4 WHERE id=${order.id}`,
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(remote(order.id, 'completed', 3))))
    await expect(fulfillOrder(order.id)).rejects.toMatchObject({
      code: 'UPSTREAM_INVALID_RESPONSE',
    })
    expect((await internal(order.id)).status).toBe('processing')
  })
  it.each(['completed', 'failed'] as const)(
    'preserves manual %s and records an opposite terminal response already in flight',
    async (outcome) => {
      const { order } = await purchase()
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
          return ok([remote(order.id, outcome === 'completed' ? 'failed' : 'completed', 2)])
        }),
      )
      const running = fulfillOrder(order.id)
      await started
      try {
        const current = adminOrderView(
          await db.order.findUniqueOrThrow({ where: { id: order.id } }),
        )
        await resolveOrder(order.id, 'operator', {
          outcome,
          note: '已核实上游和账号',
          confirmed: true,
          expectedRevision: current.resolutionRevision,
        })
      } finally {
        release()
      }
      expect(await running).toBe(true)
      const stored = adminOrderView(await db.order.findUniqueOrThrow({ where: { id: order.id } }))
      expect(stored.status).toBe(outcome)
      expect(stored.fulfillmentResolution?.conflict?.status).toBe(
        outcome === 'completed' ? 'failed' : 'completed',
      )
      expect(
        await db.audit.count({
          where: { target: order.id, action: '上游结果与人工结论冲突，待核对' },
        }),
      ).toBe(1)
      expect(await fulfillOrder(order.id)).toBe(true)
    },
  )
  it('never submits after a manual decision wins while recovery is in flight', async () => {
    const { order } = await purchase()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const fetcher = vi.fn(async () => {
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return ok([])
    })
    vi.stubGlobal('fetch', fetcher)
    const running = fulfillOrder(order.id)
    await started
    try {
      const current = adminOrderView(await db.order.findUniqueOrThrow({ where: { id: order.id } }))
      await resolveOrder(order.id, 'operator', {
        outcome: 'failed',
        note: '上游确认未受理且已停用',
        confirmed: true,
        expectedRevision: current.resolutionRevision,
      })
    } finally {
      release()
    }
    await running
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await internal(order.id)).status).toBe('failed')
    expect(await db.job.findUnique({ where: { orderId: order.id } })).toMatchObject({
      done: true,
      lease: null,
    })
  })
  it('serializes a manual decision with an in-flight submission and rejects a stale decision', async () => {
    const { order } = await purchase()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/redemptions?')) return ok([])
      entered()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return ok(remote(order.id, 'completed', 1))
    })
    vi.stubGlobal('fetch', fetcher)
    const running = fulfillOrder(order.id)
    await started
    const current = adminOrderView(await db.order.findUniqueOrThrow({ where: { id: order.id } }))
    const resolving = resolveOrder(order.id, 'operator', {
      outcome: 'failed',
      note: '原状态尚未确认',
      confirmed: true,
      expectedRevision: current.resolutionRevision,
    })
    const rejected = expect(resolving).rejects.toThrow('仅处理中')
    release()
    await running
    await rejected
    expect((await internal(order.id)).status).toBe('completed')
    expect(
      (await db.order.findUniqueOrThrow({ where: { id: order.id } })).fulfillmentResolution,
    ).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('binds credentials to their row and purpose and keeps imports idempotent', async () => {
    const code = 'ABCDEF0123456789ABCD'
    await importInventory('pro200', [code], user.email)
    const row = await db.inventory.findUniqueOrThrow({
      where: { fingerprint: inventoryFingerprint(code) },
    })
    expect(openCredential(row.code, 'inventory', row.id)).toBe(code)
    expect(() => openCredential(row.code, 'preflight', row.id)).toThrow()
    expect(() => openCredential(row.code, 'inventory', 'another-row')).toThrow()
    expect(() => openCredential('invalid', 'inventory', row.id)).toThrow('凭据格式无效')
    const token = sealCredential('synthetic-ticket', 'preflight', 'quote-id')
    expect(openCredential(token, 'preflight', 'quote-id')).toBe('synthetic-ticket')
    await importInventory('pro200', [code, code], user.email)
    expect(await db.inventory.count({ where: { fingerprint: row.fingerprint } })).toBe(1)
    expect(sealCredential(code, 'inventory', row.id)).not.toBe(row.code)
  })
})
