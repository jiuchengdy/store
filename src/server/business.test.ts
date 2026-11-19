import { prepareTestDatabase, cleanupTestDatabase, testQuery } from './database-test-support'
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_business_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
  process.env.APP_MODE = 'demo'
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
})
import { db, Prisma } from './db'
import { userView } from './data'
import { updateAdminUser } from './admin-users'
import {
  accessibleOrder,
  acceptPayment,
  completeOrder,
  newOrder,
  withdraw,
  refundFailedOrder,
  cancelOrder,
  paymentInfo,
  quote as createQuote,
  products,
  account,
  reviewWithdrawal,
  withdrawalPayoutEstimate,
  orderIdFor,
} from './services'
import { defaultReferralTiers } from '../referral'
import {
  defaultWithdrawalChannels,
  withdrawalChannels,
  withdrawalDestinations,
  withdrawalFee,
} from '../withdrawals'
import { id } from './crypto'
import { demoSession } from '../lib'
import { analyticsVisitor, recordView } from './funnel'
import { authorize, permissionsFor } from './rbac'
import type { Order, User } from '../types'
import { integration, integrationViews, saveIntegration } from './integrations/config'
import {
  exchangeRate,
  exchangeSources,
  refreshExchangeRate,
  requestExchangeRefresh,
  usdtExchangeSources,
} from './exchange-rates'
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('PostgreSQL payment, wallet and authorization invariants', () => {
  let user: User, inviter: User
  const browser = 'test-browser'
  async function fixtureUser(email: string, invitedBy?: string) {
    return userView(
      await db.user.create({
        data: {
          id: id('u_'),
          email,
          referralCode: id().slice(0, 10),
          invitedBy: invitedBy ?? null,
        },
      }),
    )
  }
  async function quote(email = `${user.id}@recharge.example.com`) {
    const key = id('q_')
    await testQuery(
      Prisma.sql`INSERT INTO quotes(id,browser_digest,product_id,email,amount,expires_at) VALUES(${key},${browser},'test-plus',${email},6000,now()+interval '15 minutes')`,
    )
    return key
  }
  async function topup(amount = 10000) {
    return newOrder(user, browser, { amount, channel: 'alipay', requestKey: id() })
  }
  async function fundedBuyer(amount = 4000) {
    const buyer = await fixtureUser(`${id()}@example.com`)
    const order = await newOrder(buyer, browser, { amount, channel: 'alipay', requestKey: id() })
    await acceptPayment('xorpay', null, {
      orderId: order.id,
      transactionId: id(),
      amount,
      paid: true,
    })
    return buyer
  }
  beforeAll(async () => {
    const db = new URL(process.env.TEST_DATABASE_URL!).pathname
    if (!db.endsWith('_test'))
      throw new Error('Integration tests require a dedicated database ending in _test')
    await prepareTestDatabase()
    await testQuery(
      Prisma.sql`INSERT INTO products(id,name,subtitle,description,price,features,plan) VALUES('test-plus','Test Plus','','',6000,'[]','plus') ON CONFLICT DO NOTHING`,
    )
    await testQuery(
      Prisma.sql`INSERT INTO settings(id,body) VALUES(1,${JSON.stringify({
        rateBps: 300,
        // Explicit custom rates keep payout and fee-rounding fixtures independent of defaults.
        referralTiers: defaultReferralTiers.map((tier, index) => ({
          ...tier,
          rateBps: [300, 500, 700, 900][index],
        })),
        settlementDays: 0,
        withdrawalChannels: {
          ...defaultWithdrawalChannels,
          rules: Object.fromEntries(
            withdrawalDestinations.map(({ key }) => [
              key,
              { minimum: 100, feeRateBps: 0, fixedFee: 0 },
            ]),
          ),
        },
        firstOrderOnly: true,
        supportEmail: '',
        alipay: true,
        wechat: true,
        crypto: true,
        fiatProvider: 'xorpay',
      })}) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,
    )
    inviter = await fixtureUser(`${id()}@example.com`)
    user = await fixtureUser(`${id()}@example.com`, inviter.id)
  }, 30_000)
  afterAll(async () => {
    await cleanupTestDatabase()
  })
  it('records only one authoritative event per order stage', async () => {
    const buyer = await fixtureUser(`${id()}@example.com`)
    const productId = id('metrics_')
    await testQuery(
      Prisma.sql`INSERT INTO products(id,name,subtitle,description,price,features,plan) VALUES(${productId},'Metrics test','','',6000,'[]','plus')`,
    )
    const visitor = id('browser_')
    await recordView(visitor, 'checkout_view', productId, 'google')
    await recordView(visitor, 'checkout_view', productId, 'google')
    const q = await createQuote(productId, demoSession('metrics@example.com'), visitor, {
      source: 'google',
      analytics: true,
    })
    const order = await newOrder(buyer, visitor, {
      quoteId: q.id,
      channel: 'alipay',
      requestKey: id(),
    })
    const receipt = { orderId: order.id, transactionId: id(), amount: order.amount, paid: true }
    await acceptPayment('xorpay', null, receipt)
    await acceptPayment('xorpay', null, receipt)
    await completeOrder(order.id)
    await completeOrder(order.id)
    const events = (
      await testQuery(
        Prisma.sql`SELECT event,source,count(*)::int AS n FROM funnel_events WHERE visitor_key=${analyticsVisitor(visitor)} GROUP BY event,source`,
      )
    ).rows
    expect(events.map((e) => e.event).sort()).toEqual(
      [
        'checkout_view',
        'quote_ready',
        'order_created',
        'payment_succeeded',
        'delivery_completed',
      ].sort(),
    )
    expect(events.every((e) => e.n === 1 && e.source === 'google')).toBe(true)
    const privateQuote = await createQuote(productId, demoSession('private@example.com'), visitor)
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT analytics_visitor FROM quotes WHERE id=${privateQuote.id}`,
        )
      ).rows[0].analytics_visitor,
    ).toBeNull()
  })
  it('isolates guest orders and preserves a separate contact email', async () => {
    const quoteId = await quote('recharge@example.com')
    const input = {
      quoteId,
      channel: 'alipay' as const,
      requestKey: id(),
      contactEmail: `${id()}@example.com`,
    }
    await expect(newOrder(null, browser, { ...input, contactEmail: undefined })).rejects.toThrow(
      '请填写联系邮箱',
    )
    const order = await newOrder(null, browser, input)
    expect(order.userId).toBeNull()
    expect(order.contactEmail).toBe(input.contactEmail)
    expect(order.email).toBe('recharge@example.com')
    expect((await accessibleOrder(null, browser, order.id)).id).toBe(order.id)
    await expect(accessibleOrder(null, 'different-browser', order.id)).rejects.toThrow('未找到订单')
    await expect(
      newOrder(null, browser, { ...input, amount: 10000, quoteId: undefined }),
    ).rejects.toThrow('钱包功能')
    expect((await newOrder(null, browser, input)).id).toBe(order.id)
    await expect(
      newOrder(null, browser, { ...input, contactEmail: 'changed@example.com' }),
    ).rejects.toThrow('参数')
    await acceptPayment('xorpay', null, {
      orderId: order.id,
      transactionId: id(),
      amount: order.amount,
      paid: true,
    })
    await completeOrder(order.id)
    expect((await accessibleOrder(null, browser, order.id)).status).toBe('completed')
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT count(*)::int n FROM email_outbox WHERE order_id=${order.id}`,
        )
      ).rows[0].n,
    ).toBe(3)
  })
  it('rejects amount, provider and revision substitution before changing state', async () => {
    const o = await topup()
    const receipt = { orderId: o.id, transactionId: id(), amount: o.amount, paid: true }
    await expect(acceptPayment('xorpay', null, { ...receipt, amount: 1 })).rejects.toThrow('不匹配')
    await expect(acceptPayment('epay_v1', null, receipt)).rejects.toThrow('归属')
    await expect(acceptPayment('xorpay', 'other-config', receipt)).rejects.toThrow('归属')
    expect(
      (await testQuery(Prisma.sql`SELECT status FROM orders WHERE id=${o.id}`)).rows[0].status,
    ).toBe('unpaid')
  })
  it('credits a recharge only once under 12 concurrent identical callbacks', async () => {
    const o = await topup()
    const receipt = { orderId: o.id, transactionId: id(), amount: o.amount, paid: true }
    await Promise.all(Array.from({ length: 12 }, () => acceptPayment('xorpay', null, receipt)))
    expect(
      (await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${user.id}`)).rows[0]
        .balance,
    ).toBe(10000)
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT count(*)::int n FROM wallet_ledger WHERE order_id=${o.id}`,
        )
      ).rows[0].n,
    ).toBe(1)
    expect(
      (await testQuery(Prisma.sql`SELECT count(*)::int n FROM commissions WHERE order_id=${o.id}`))
        .rows[0].n,
    ).toBe(0)
    const other = await topup()
    await expect(acceptPayment('xorpay', null, { ...receipt, orderId: other.id })).rejects.toThrow(
      '交易号已用于',
    )
  })
  it('serializes concurrent wallet spending and rolls back insufficient purchases', async () => {
    const q1 = await quote(),
      q2 = await quote()
    const results = await Promise.allSettled([
      newOrder(user, browser, { quoteId: q1, channel: 'balance', requestKey: id() }),
      newOrder(user, browser, { quoteId: q2, channel: 'balance', requestKey: id() }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(
      (await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${user.id}`)).rows[0]
        .balance,
    ).toBe(4000)
    const success = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Order>
    await Promise.all(Array.from({ length: 8 }, () => completeOrder(success.value.id)))
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT count(*)::int n FROM commissions WHERE order_id=${success.value.id}`,
        )
      ).rows[0].n,
    ).toBe(1)
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT amount FROM commissions WHERE order_id=${success.value.id}`,
        )
      ).rows[0].amount,
    ).toBe(180)
  })
  it('never reuses an idempotency key for different monetary parameters', async () => {
    const requestKey = id()
    const first = await newOrder(user, browser, { amount: 100, channel: 'alipay', requestKey })
    const repeat = await newOrder(user, browser, { amount: 100, channel: 'alipay', requestKey })
    expect(first.id).toBe(repeat.id)
    await expect(
      newOrder(user, browser, { amount: 200, channel: 'alipay', requestKey }),
    ).rejects.toThrow('不同的订单参数')
  })
  it('prevents concurrent withdrawals from spending the same commission', async () => {
    await testQuery(
      Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${inviter.id}`,
    )
    const request = {
      amount: 180,
      method: '支付宝',
      account: 'private-payout-account',
      recipientName: '测试收款人',
      confirmed: true,
    }
    const results = await Promise.allSettled([
      withdraw(inviter, { ...request, requestKey: id() }),
      withdraw(inviter, { ...request, requestKey: id() }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const stored = (
      await testQuery(Prisma.sql`SELECT account FROM withdrawals WHERE user_id=${inviter.id}`)
    ).rows[0]
    expect(stored.account).not.toContain(request.account)
  })
  it('refunds confirmed failed purchases once, never arbitrary unpaid orders', async () => {
    const o = await newOrder(user, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      requestKey: id(),
    })
    await expect(refundFailedOrder(o.id, 'test')).rejects.toThrow('仅已确认失败')
    await acceptPayment('xorpay', null, {
      orderId: o.id,
      transactionId: id(),
      amount: o.amount,
      paid: true,
    })
    await testQuery(Prisma.sql`UPDATE orders SET status='failed' WHERE id=${o.id}`)
    await Promise.all([refundFailedOrder(o.id, 'test'), refundFailedOrder(o.id, 'test')])
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT count(*)::int n FROM wallet_ledger WHERE order_id=${o.id} AND kind='refund'`,
        )
      ).rows[0].n,
    ).toBe(1)
  })
  it('enforces roles on the server and changes permissions immediately', async () => {
    const roleId = id('role_')
    await testQuery(
      Prisma.sql`INSERT INTO roles(id,name,permissions) VALUES(${roleId},${'Support'},${JSON.stringify(['admin:access', 'orders:read'])})`,
    )
    await testQuery(
      Prisma.sql`INSERT INTO user_roles(user_id,role_id) VALUES(${user.id},${roleId})`,
    )
    const permissions = await permissionsFor(user)
    expect(() => authorize({ ...user, permissions }, 'orders:read')).not.toThrow()
    expect(() => authorize({ ...user, permissions }, 'integrations:write')).toThrow()
    await testQuery(Prisma.sql`DELETE FROM user_roles WHERE user_id=${user.id}`)
    expect(await permissionsFor(user)).toEqual([])
  })
  it('hides legacy upgrade rows and rejects new quotes for them even when enabled', async () => {
    await testQuery(
      Prisma.sql`INSERT INTO products(id,name,subtitle,description,price,features,plan,upgrade,pricing_mode) VALUES('test-upgrade','Upgrade','','',1,'[]','promax',true,'markup') ON CONFLICT DO NOTHING`,
    )
    for (const all of [true, false])
      expect((await products(all)).some((item) => item.upgrade)).toBe(false)
    await expect(createQuote('test-upgrade', demoSession(), browser)).rejects.toThrow('已下架')
    const stale = await quote()
    await testQuery(
      Prisma.sql`UPDATE quotes SET expires_at=now()-interval '1 minute' WHERE id=${stale}`,
    )
    await expect(
      newOrder(user, browser, { quoteId: stale, channel: 'alipay', requestKey: id() }),
    ).rejects.toThrow('已过期')
  })
  it('uses exact fixed subscription prices and preserves confirmed quotes after price changes', async () => {
    const productId = id('p_')
    await testQuery(
      Prisma.sql`INSERT INTO products(id,name,subtitle,description,price,features,plan,pricing_mode) VALUES(${productId},'Recharge','','',4937,'[]','go','fixed')`,
    )
    const session = JSON.stringify({
      user: { email: `${id()}@example.com` },
      accessToken: 'demo',
      sessionToken: 'demo',
    })
    const fixed = await createQuote(productId, session, browser)
    expect(fixed.amount).toBe(4937)
    expect((await products()).find((p) => p.id === productId)?.price).toBe(4937)
    const snapshot = (
      await testQuery(Prisma.sql`SELECT pricing_snapshot FROM quotes WHERE id=${fixed.id}`)
    ).rows[0].pricing_snapshot
    expect(snapshot).toEqual({ mode: 'fixed', price: 4937 })
    await testQuery(Prisma.sql`UPDATE products SET price=5279 WHERE id=${productId}`)
    expect((await createQuote(productId, session, browser)).amount).toBe(5279)
    const order = await newOrder(user, browser, {
      quoteId: fixed.id,
      channel: 'alipay',
      requestKey: id(),
    })
    expect(order.amount).toBe(4937)
    await expect(
      testQuery(Prisma.sql`UPDATE products SET pricing_mode='markup' WHERE id=${productId}`),
    ).rejects.toThrow()
    await expect(
      testQuery(Prisma.sql`UPDATE products SET upgrade=true WHERE id=${productId}`),
    ).rejects.toThrow()
  })
  it('refreshes FX once in the background, serves cached retail prices and preserves locked quote amounts', async () => {
    const productId = id('usd_')
    await testQuery(
      Prisma.sql`INSERT INTO products(id,name,subtitle,description,price,features,plan,price_currency,rounding_step) VALUES(${productId},'USD','','',2000,'[]','plus','USD',100)`,
    )
    await testQuery(
      Prisma.sql`UPDATE exchange_rates SET rate_e8=null,source_date=null,fetched_at=null,expires_at=null,locked_until=null,refresh_after=now()`,
    )
    const session = JSON.stringify({
      user: { email: `${id()}@example.com` },
      accessToken: 'demo',
      sessionToken: 'demo',
    })
    const sourceDate = new Date().toISOString().slice(0, 10)
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ date: sourceDate, usd: { cny: 7.12345678 } })),
    )
    vi.stubGlobal('fetch', fetcher)
    try {
      await expect(createQuote(productId, session, browser)).rejects.toThrow('汇率正在更新')
      expect(fetcher).not.toHaveBeenCalled()
      await Promise.all(Array.from({ length: 8 }, () => refreshExchangeRate()))
      expect(fetcher).toHaveBeenCalledTimes(1)
      const before = await exchangeRate(true)
      const locked = await createQuote(productId, session, browser)
      expect(locked.amount).toBe(14300)
      const catalog = (await products()).find((p) => p.id === productId)!
      expect(catalog.price).toBe(14300)
      expect(catalog.priceCurrency).toBe('CNY')
      expect((await products(true)).find((p) => p.id === productId)?.price).toBe(2000)
      await Promise.all(
        Array.from({ length: 5 }, () =>
          createQuote(productId, demoSession(`${id()}@example.com`), browser),
        ),
      )
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(await exchangeRate(true)).toEqual(before)
      fetcher.mockRejectedValue(new Error('private transport failure'))
      await requestExchangeRefresh()
      await refreshExchangeRate()
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(await exchangeRate(true)).toEqual(before)
      expect((await createQuote(productId, session, browser)).amount).toBe(14300)
      await testQuery(Prisma.sql`UPDATE exchange_rates SET expires_at=now()-interval '1 second'`)
      await expect(createQuote(productId, session, browser)).rejects.toThrow('汇率正在更新')
      expect((await products()).find((p) => p.id === productId)?.priceStatus).toBe('pending')
      fetcher.mockReset()
      fetcher.mockResolvedValueOnce(new Response('', { status: 503 }))
      fetcher.mockResolvedValueOnce(
        new Response(JSON.stringify({ date: sourceDate, usd: { cny: 8 } })),
      )
      await requestExchangeRefresh()
      await refreshExchangeRate()
      expect(fetcher.mock.calls.map((args) => (args as unknown[])[0])).toEqual([...exchangeSources])
      expect((await createQuote(productId, session, browser)).amount).toBe(16000)
      const buyer = await fixtureUser(`${id()}@example.com`)
      const order = await newOrder(buyer, browser, {
        quoteId: locked.id,
        channel: 'alipay',
        requestKey: id(),
      })
      expect(order.amount).toBe(14300)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('stores Sendflare credentials privately and preserves the key on blank updates', async () => {
    const input = {
      provider: 'sendflare' as const,
      enabled: true,
      public: { from: 'hello@example.com' },
      secrets: {},
    }
    await expect(saveIntegration(input, user.id)).rejects.toThrow('请先填写完整配置再启用')
    await saveIntegration({ ...input, secrets: { apiKey: 'sendflare-test-key' } }, user.id)
    const first = await integration('sendflare')
    const stored = await db.integration.findUniqueOrThrow({ where: { id: first.id } })
    expect(stored.secret).not.toContain('sendflare-test-key')
    const view = (await integrationViews()).find((entry) => entry.provider === 'sendflare')
    expect(view).toMatchObject({ public: input.public, secrets: ['apiKey'], enabled: true })
    expect(JSON.stringify(view)).not.toContain('sendflare-test-key')
    await saveIntegration({ ...input, secrets: { apiKey: '' } }, user.id)
    const updated = await integration('sendflare')
    expect(updated.id).not.toBe(first.id)
    expect(updated.apiKey).toBe('sendflare-test-key')
    await saveIntegration({ ...input, enabled: false }, user.id)
    await expect(integration('sendflare')).rejects.toThrow('该服务尚未启用')
  })

  it('selects EPay protocol atomically while preserving historical configuration and isolating secrets', async () => {
    const previous = (await testQuery(Prisma.sql`SELECT body FROM settings WHERE id=1`)).rows[0]
      .body
    try {
      await testQuery(
        Prisma.sql`UPDATE settings SET body=body||'{"fiatProvider":"epay_v1"}'::jsonb WHERE id=1`,
      )
      await saveIntegration(
        {
          provider: 'epay_v1',
          enabled: true,
          public: { url: 'https://pay.example.com', pid: '123' },
          secrets: { key: 'test-md5-key' },
        },
        user.email,
      )
      const v1 = await integration('epay_v1')
      await expect(
        saveIntegration(
          {
            provider: 'epay_v2',
            enabled: true,
            public: { url: 'https://pay.example.com', pid: '123' },
            secrets: {},
          },
          user.email,
        ),
      ).rejects.toThrow('完整配置')
      expect(
        (await testQuery(Prisma.sql`SELECT body FROM settings WHERE id=1`)).rows[0].body
          .epayVersion,
      ).toBe('epay_v1')
      await saveIntegration(
        {
          provider: 'epay_v2',
          enabled: false,
          public: { url: 'https://pay-v2.example.com', pid: '456' },
          secrets: {},
        },
        user.email,
      )
      const switched = (await testQuery(Prisma.sql`SELECT body FROM settings WHERE id=1`)).rows[0]
        .body
      expect(switched.epayVersion).toBe('epay_v2')
      expect(switched.fiatProvider).toBe('epay_v2')
      expect(await integration('epay_v1', v1.id)).toEqual(v1)
      const v2 = (
        await testQuery(
          Prisma.sql`SELECT id FROM integrations WHERE provider='epay_v2' AND active=true`,
        )
      ).rows[0].id
      expect((await integration('epay_v2', v2)).key).toBeUndefined()
      await saveIntegration(
        {
          provider: 'epay_v1',
          enabled: true,
          public: { url: 'https://pay.example.com', pid: '123' },
          secrets: {},
        },
        user.email,
      )
      expect((await integration('epay_v1')).key).toBe('test-md5-key')
      expect(await integration('epay_v1', v1.id)).toEqual(v1)
    } finally {
      await testQuery(Prisma.sql`UPDATE settings SET body=${JSON.stringify(previous)} WHERE id=1`)
    }
  })
  it('splits payment atomically and accepts only the external amount, then refunds the total once', async () => {
    const buyer = await fundedBuyer()
    const input = {
      quoteId: await quote(`${id()}@recharge.example.com`),
      channel: 'alipay' as const,
      balanceAmount: 4000,
      requestKey: id(),
    }
    const orders = await Promise.all(
      Array.from({ length: 6 }, () => newOrder(buyer, browser, input)),
    )
    const order = orders[0]
    expect(new Set(orders.map((o) => o.id)).size).toBe(1)
    expect(order.balanceAmount).toBe(4000)
    expect(order.externalAmount).toBe(2000)
    expect(
      (await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${buyer.id}`)).rows[0]
        .balance,
    ).toBe(0)
    const receipt = { orderId: order.id, transactionId: id(), amount: 2000, paid: true }
    await expect(acceptPayment('xorpay', null, { ...receipt, amount: 6000 })).rejects.toThrow(
      '不匹配',
    )
    await Promise.all(Array.from({ length: 6 }, () => acceptPayment('xorpay', null, receipt)))
    expect(
      (await testQuery(Prisma.sql`SELECT count(*)::int n FROM jobs WHERE order_id=${order.id}`))
        .rows[0].n,
    ).toBe(1)
    await testQuery(Prisma.sql`UPDATE orders SET status='failed' WHERE id=${order.id}`)
    await Promise.all([refundFailedOrder(order.id, 'test'), refundFailedOrder(order.id, 'test')])
    expect(
      (await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${buyer.id}`)).rows[0]
        .balance,
    ).toBe(6000)
  })
  it('cancels unattempted split payments once and rejects late callbacks or unsafe cancellation', async () => {
    const buyer = await fundedBuyer()
    const order = await newOrder(buyer, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      balanceAmount: 3000,
      requestKey: id(),
    })
    await expect(cancelOrder(null, 'other-browser', order.id)).rejects.toThrow('未找到')
    await Promise.all([
      cancelOrder(buyer, browser, order.id),
      cancelOrder(buyer, browser, order.id),
    ])
    expect(
      (await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${buyer.id}`)).rows[0]
        .balance,
    ).toBe(4000)
    await expect(
      acceptPayment('xorpay', null, {
        orderId: order.id,
        transactionId: id(),
        amount: 3000,
        paid: true,
      }),
    ).rejects.toThrow('状态')
    await expect(paymentInfo(buyer, order.id, '127.0.0.1', browser)).rejects.toThrow('已取消')
    const attempted = await newOrder(buyer, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      balanceAmount: 3000,
      requestKey: id(),
    })
    await paymentInfo(buyer, attempted.id, '127.0.0.1', browser)
    await expect(cancelOrder(buyer, browser, attempted.id)).rejects.toThrow('不能直接取消')
  })
  it('enforces external payment limits before any wallet debit or order insertion', async () => {
    const buyer = await fundedBuyer()
    await testQuery(
      Prisma.sql`UPDATE settings SET body=body||'{"paymentLimits":{"alipay":{"min":1000,"max":3000}}}'::jsonb WHERE id=1`,
    )
    try {
      const quoteId = await quote()
      await expect(
        newOrder(buyer, browser, {
          quoteId,
          channel: 'alipay',
          balanceAmount: 2000,
          requestKey: id(),
        }),
      ).rejects.toThrow('单笔支付范围')
      expect(
        (await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${buyer.id}`)).rows[0]
          .balance,
      ).toBe(4000)
      const order = await newOrder(buyer, browser, {
        quoteId,
        channel: 'alipay',
        balanceAmount: 4000,
        requestKey: id(),
      })
      expect(order.externalAmount).toBe(2000)
      await expect(
        newOrder(buyer, browser, { amount: 500, channel: 'alipay', requestKey: id() }),
      ).rejects.toThrow('单笔支付范围')
    } finally {
      await testQuery(Prisma.sql`UPDATE settings SET body=body-'paymentLimits' WHERE id=1`)
    }
  })
  it('prevents concurrent split orders from overspending and supports full balance offsets', async () => {
    const buyer = await fundedBuyer()
    const results = await Promise.allSettled(
      [await quote(), await quote()].map((quoteId) =>
        newOrder(buyer, browser, {
          quoteId,
          channel: 'wechat',
          balanceAmount: 3000,
          requestKey: id(),
        }),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      (await testQuery(Prisma.sql`SELECT balance FROM wallets WHERE user_id=${buyer.id}`)).rows[0]
        .balance,
    ).toBe(1000)
    const fullyFunded = await fundedBuyer(6000)
    const full = await newOrder(fullyFunded, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      balanceAmount: 6000,
      requestKey: id(),
    })
    expect(full.externalAmount).toBe(0)
    expect(full.channel).toBe('balance')
    expect(full.status).toBe('processing')
    await expect(
      newOrder(null, browser, {
        quoteId: await quote(),
        channel: 'alipay',
        balanceAmount: 1,
        requestKey: id(),
        contactEmail: 'guest@example.com',
      }),
    ).rejects.toThrow('钱包功能')
  })
  it('rewards a guest without registration and preserves first-order attribution across concurrent orders and claim', async () => {
    const referralOwner = await fixtureUser(`${id()}@example.com`)
    const guestEmail = `${id()}@guest.example.com`
    const guestRecharge = `${id()}@recharge.example.com`
    const orders = await Promise.all(
      [await quote(guestRecharge), await quote(guestRecharge)].map((quoteId) =>
        newOrder(null, browser, {
          quoteId,
          channel: 'alipay',
          requestKey: id(),
          contactEmail: guestEmail,
          referralCode: referralOwner.referralCode,
        }),
      ),
    )
    for (const order of orders)
      await acceptPayment('xorpay', null, {
        orderId: order.id,
        transactionId: id(),
        amount: 6000,
        paid: true,
      })
    await Promise.all(orders.map((o) => completeOrder(o.id)))
    const commissions = await testQuery(
      Prisma.sql`SELECT * FROM commissions WHERE user_id=${referralOwner.id}`,
    )
    expect(commissions.rows).toHaveLength(1)
    expect(commissions.rows[0].amount).toBe(180)
    const claimed = await fixtureUser(guestEmail)
    await testQuery(
      Prisma.sql`UPDATE orders SET user_id=${claimed.id},guest_browser_digest=null WHERE contact_email=${guestEmail}`,
    )
    await Promise.all(orders.map((o) => completeOrder(o.id)))
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT count(*)::int n FROM commissions WHERE user_id=${referralOwner.id}`,
        )
      ).rows[0].n,
    ).toBe(1)
    await expect(accessibleOrder(null, browser, orders[0].id)).rejects.toThrow('未找到')
    const self = await newOrder(null, browser, {
      quoteId: await quote(referralOwner.email),
      channel: 'alipay',
      requestKey: id(),
      contactEmail: `${id()}@guest.example.com`,
      referralCode: referralOwner.referralCode,
    })
    await acceptPayment('xorpay', null, {
      orderId: self.id,
      transactionId: id(),
      amount: 6000,
      paid: true,
    })
    await completeOrder(self.id)
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT count(*)::int n FROM commissions WHERE order_id=${self.id}`,
        )
      ).rows[0].n,
    ).toBe(0)
  })
  it.each(['guest', 'registered'] as const)(
    'rewards every repeat %s order once using its saved policy without inflating invite counts',
    async (kind) => {
      const owner = await fixtureUser(`${id()}@example.com`)
      const contactEmail = `${id()}@guest.example.com`
      const rechargeEmail = `${id()}@recharge.example.com`
      const buyer = kind === 'registered' ? await fixtureUser(contactEmail, owner.id) : null
      const previous = (await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body
      try {
        await testQuery(
          Prisma.sql`UPDATE settings SET body=jsonb_set(body,'{firstOrderOnly}','false') WHERE id=1`,
        )
        const orders = []
        for (let i = 0; i < 2; i++) {
          const order = await newOrder(buyer, browser, {
            quoteId: await quote(rechargeEmail),
            channel: 'alipay',
            requestKey: id(),
            contactEmail,
            ...(buyer ? {} : { referralCode: owner.referralCode }),
          })
          expect(order.firstOrderOnly).toBe(false)
          await acceptPayment('xorpay', null, {
            orderId: order.id,
            transactionId: id(),
            amount: order.amount,
            paid: true,
          })
          orders.push(order)
        }
        // A subsequent settings change must not alter these orders' eligibility.
        await testQuery(
          Prisma.sql`UPDATE settings SET body=jsonb_set(body,'{firstOrderOnly}','true') WHERE id=1`,
        )
        await Promise.all(
          orders.flatMap((order) => [completeOrder(order.id), completeOrder(order.id)]),
        )
        const commissions = await db.commission.findMany({ where: { userId: owner.id } })
        expect(commissions).toHaveLength(2)
        expect(new Set(commissions.map((entry) => entry.orderId))).toEqual(
          new Set(orders.map((order) => order.id)),
        )
        expect(commissions.every((entry) => entry.amount === 180)).toBe(true)
        await db.commission.updateMany({
          where: { userId: owner.id },
          data: { status: 'available' },
        })
        expect((await account(owner)).referral.qualifiedInvites).toBe(1)
      } finally {
        await testQuery(Prisma.sql`UPDATE settings SET body=${JSON.stringify(previous)} WHERE id=1`)
      }
    },
  )
  async function referralOrder(owner: User, contactEmail = `${id()}@guest.example.com`) {
    const order = await newOrder(null, browser, {
      quoteId: await quote(`${id()}@recharge.example.com`),
      channel: 'alipay',
      requestKey: id(),
      contactEmail,
      referralCode: owner.referralCode,
    })
    await acceptPayment('xorpay', null, {
      orderId: order.id,
      transactionId: id(),
      amount: order.amount,
      paid: true,
    })
    await completeOrder(order.id)
    return order
  }
  it('applies the new default rate to purchases and their commissions', async () => {
    const previous = (await db.setting.findUniqueOrThrow({ where: { id: 1 } })).body
    try {
      await testQuery(
        Prisma.sql`UPDATE settings SET body=body||${JSON.stringify({
          rateBps: defaultReferralTiers[0].rateBps,
          referralTiers: defaultReferralTiers,
        })}::jsonb WHERE id=1`,
      )
      const owner = await fixtureUser(`${id()}@example.com`)
      const order = await referralOrder(owner)
      expect(order.rateBps).toBe(300)
      expect(await db.commission.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject(
        { amount: 180, status: 'pending' },
      )
    } finally {
      await testQuery(Prisma.sql`UPDATE settings SET body=${JSON.stringify(previous)} WHERE id=1`)
    }
  })
  it('persists admin-assigned tiers for account views and new orders while preserving existing commissions', async () => {
    const admin = { ...(await fixtureUser(`${id()}@example.com`)), permissions: ['users:write'] }
    const owner = await fixtureUser(`${id()}@example.com`)
    const oldOrder = await referralOrder(owner)
    await updateAdminUser(admin, { id: owner.id, referralTierId: 'partner' })
    expect(
      userView(await db.user.findUniqueOrThrow({ where: { id: owner.id } })).referralTierId,
    ).toBe('partner')
    // Account reads must reflect edits even when the caller holds an older user object.
    expect((await account(owner)).referral).toMatchObject({
      manual: true,
      qualifiedInvites: 0,
      current: { id: 'partner', rateBps: 900 },
    })
    const assignedOrder = await referralOrder(owner)
    expect(assignedOrder.rateBps).toBe(900)
    expect(
      await db.commission.findUniqueOrThrow({ where: { orderId: assignedOrder.id } }),
    ).toMatchObject({ amount: 540 })
    const invitedBuyer = await fixtureUser(`${id()}@example.com`, owner.id)
    const registeredOrder = await newOrder(invitedBuyer, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      requestKey: id(),
    })
    expect(registeredOrder.rateBps).toBe(900)
    await updateAdminUser(admin, { id: owner.id, referralTierId: null })
    expect((await account(owner)).referral).toMatchObject({
      manual: false,
      current: { id: 'starter', rateBps: 300 },
    })
    expect((await referralOrder(owner)).rateBps).toBe(300)
    expect(await db.order.findUniqueOrThrow({ where: { id: oldOrder.id } })).toMatchObject({
      rateBps: 300,
    })
    expect(
      await db.commission.findUniqueOrThrow({ where: { orderId: oldOrder.id } }),
    ).toMatchObject({ amount: 180 })
    expect(await db.order.findUniqueOrThrow({ where: { id: assignedOrder.id } })).toMatchObject({
      rateBps: 900,
    })
    expect(
      await db.audit.findMany({ where: { target: owner.id }, orderBy: { createdAt: 'asc' } }),
    ).toMatchObject([
      { actor: admin.email, action: '修改返佣等级：邀请合伙人' },
      { actor: admin.email, action: '修改返佣等级：自动计算' },
    ])
  })
  it('validates user edits, enforces write permission and retains account protections', async () => {
    const owner = await fixtureUser(`${id()}@example.com`)
    const admin = {
      ...(await fixtureUser(`${id()}@example.com`)),
      role: 'admin' as const,
      permissions: ['users:write'],
    }
    await db.user.update({ where: { id: admin.id }, data: { role: 'admin' } })
    await expect(
      updateAdminUser(owner, { id: owner.id, referralTierId: 'partner' }),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      updateAdminUser(admin, { id: owner.id, referralTierId: 'missing', disabled: true }),
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      updateAdminUser(admin, { id: 'missing', referralTierId: 'partner' }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(updateAdminUser(admin, { id: admin.id, disabled: true })).rejects.toMatchObject({
      status: 400,
    })
    await expect(updateAdminUser(admin, { id: owner.id })).rejects.toThrow()
    expect(await db.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
      disabled: false,
      referralTierId: null,
    })
    expect(await db.audit.count({ where: { target: owner.id } })).toBe(0)
    await updateAdminUser(admin, { id: admin.id, referralTierId: 'sharer' })
    await updateAdminUser(admin, { id: owner.id, referralTierId: 'partner' })
    await db.authSession.create({
      data: {
        id: id(),
        userId: owner.id,
        token: id(),
        expiresAt: new Date(Date.now() + 3600_000),
        updatedAt: new Date(),
      },
    })
    await updateAdminUser(admin, { id: owner.id, disabled: true })
    expect(await db.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({
      disabled: true,
      referralTierId: 'partner',
    })
    expect(await db.authSession.count({ where: { userId: owner.id } })).toBe(0)
    await updateAdminUser(admin, { id: owner.id, disabled: false })
  })
  it('counts settled guest referrals, locks tier rates on creation and recalculates after reversals', async () => {
    const owner = await fixtureUser(`${id()}@example.com`)
    const delivered = []
    for (let i = 0; i < 5; i++) delivered.push(await referralOrder(owner))
    expect((await account(owner)).referral).toMatchObject({
      qualifiedInvites: 0,
      current: { rateBps: 300 },
    })
    const oldRateOrder = await newOrder(null, browser, {
      quoteId: await quote(`${id()}@recharge.example.com`),
      channel: 'alipay',
      requestKey: id(),
      contactEmail: `${id()}@guest.example.com`,
      referralCode: owner.referralCode,
    })
    await testQuery(Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id}`)
    expect((await account(owner)).referral).toMatchObject({
      qualifiedInvites: 5,
      current: { rateBps: 500 },
    })
    const nextOrder = await referralOrder(owner)
    expect(nextOrder.rateBps).toBe(500)
    await acceptPayment('xorpay', null, {
      orderId: oldRateOrder.id,
      transactionId: id(),
      amount: oldRateOrder.amount,
      paid: true,
    })
    await completeOrder(oldRateOrder.id)
    expect(
      (
        await testQuery(
          Prisma.sql`SELECT amount FROM commissions WHERE order_id=${oldRateOrder.id}`,
        )
      ).rows[0].amount,
    ).toBe(180)
    // Claiming a guest order does not change the identity counted for the tier.
    const contact = (
      await testQuery(Prisma.sql`SELECT contact_email FROM orders WHERE id=${delivered[0].id}`)
    ).rows[0].contact_email
    const claimed = await fixtureUser(contact)
    await testQuery(Prisma.sql`UPDATE orders SET user_id=${claimed.id} WHERE id=${delivered[0].id}`)
    const previous = (await testQuery(Prisma.sql`SELECT body FROM settings WHERE id=1`)).rows[0]
      .body
    try {
      await testQuery(
        Prisma.sql`UPDATE settings SET body=jsonb_set(body,'{firstOrderOnly}','false') WHERE id=1`,
      )
      const repeat = await referralOrder(owner, contact)
      await testQuery(
        Prisma.sql`UPDATE commissions SET status='available' WHERE order_id=${repeat.id}`,
      )
      expect((await account(owner)).referral.qualifiedInvites).toBe(5)
    } finally {
      await testQuery(Prisma.sql`UPDATE settings SET body=${JSON.stringify(previous)} WHERE id=1`)
    }
    await testQuery(
      Prisma.sql`UPDATE commissions SET status='reversed' WHERE order_id=${delivered[1].id}`,
    )
    expect((await account(owner)).referral).toMatchObject({
      qualifiedInvites: 4,
      current: { rateBps: 300 },
    })
  })

  it('never withdraws topups, refunds or unsettled rewards; retries reserve funds exactly once', async () => {
    const owner = await fundedBuyer(50000)
    const input = {
      amount: 100,
      method: '支付宝',
      account: 'pay@example.com',
      recipientName: '测试收款人',
      confirmed: true,
      requestKey: id(),
    }
    await expect(withdraw(owner, input)).rejects.toThrow('邀请收益不足')
    const failed = await newOrder(owner, browser, {
      quoteId: await quote(),
      channel: 'alipay',
      requestKey: id(),
    })
    await acceptPayment('xorpay', null, {
      orderId: failed.id,
      transactionId: id(),
      amount: failed.amount,
      paid: true,
    })
    await testQuery(Prisma.sql`UPDATE orders SET status='failed' WHERE id=${failed.id}`)
    await refundFailedOrder(failed.id, 'test')
    await expect(withdraw(owner, input)).rejects.toThrow('邀请收益不足')
    await referralOrder(owner)
    await expect(withdraw(owner, input)).rejects.toThrow('邀请收益不足')
    await testQuery(Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id}`)
    await expect(withdraw(owner, { ...input, amount: 181 })).rejects.toThrow('邀请收益不足')
    const requests = await Promise.all(Array.from({ length: 8 }, () => withdraw(owner, input)))
    expect(new Set(requests.map((w) => w.id)).size).toBe(1)
    expect(
      await db.riskEvent.count({
        where: { scene: 'withdrawal-assessment', referenceId: requests[0].id },
      }),
    ).toBe(1)
    await expect(withdraw(owner, { ...input, amount: 120 })).rejects.toThrow('不同的提现参数')
    await expect(withdraw(owner, { ...input, account: 'different@example.com' })).rejects.toThrow(
      '不同的提现参数',
    )
    const view = await account(owner)
    expect(view).toMatchObject({
      balance: 56000,
      settled: 180,
      frozen: 100,
      available: 80,
      withdrawn: 0,
    })
    expect(view.withdrawals[0].recipientName).toBe(input.recipientName)
    expect(view.withdrawals[0]).not.toHaveProperty('requestHash')
    const stored = (
      await testQuery(
        Prisma.sql`SELECT recipient_name,account FROM withdrawals WHERE id=${requests[0].id}`,
      )
    ).rows[0]
    expect(stored.recipient_name).not.toContain(input.recipientName)
    expect(stored.account).not.toContain(input.account)
  })

  it('routes shared payout accounts and new users to enforced manual review', async () => {
    const owners = await Promise.all(
      Array.from({ length: 3 }, () => fixtureUser(`${id()}@example.com`)),
    )
    for (const owner of owners) {
      await referralOrder(owner)
      await db.commission.updateMany({ where: { userId: owner.id }, data: { status: 'available' } })
    }
    const payoutAccount = `${id()}@payout.example.com`
    const requests = await Promise.all(
      owners.map((owner) =>
        withdraw(owner, {
          amount: 100,
          method: '支付宝',
          account: payoutAccount,
          recipientName: '测试收款人',
          confirmed: true,
          requestKey: id(),
        }),
      ),
    )
    expect(requests.every((request) => request.status === 'pending')).toBe(true)
    const events = await db.riskEvent.findMany({
      where: { referenceId: { in: requests.map((request) => request.id) } },
    })
    expect(events).toHaveLength(3)
    expect(
      events.filter((event) => (event.reasonCodes as string[]).includes('SHARED_PAYOUT_ACCOUNT')),
    ).toHaveLength(1)
    expect(
      events.every((event) => event.mode === 'enforce' && event.effectiveAction === 'review'),
    ).toBe(true)
    expect(JSON.stringify(events)).not.toContain(payoutAccount)
    const fingerprints = await db.withdrawal.findMany({
      where: { id: { in: requests.map((request) => request.id) } },
      select: { payoutFingerprint: true },
    })
    expect(new Set(fingerprints.map((row) => row.payoutFingerprint)).size).toBe(1)
  })

  it('blocks unpaid order accumulation, preserves retries and releases capacity on cancellation', async () => {
    const owner = await fixtureUser(`${id()}@example.com`)
    const input = { amount: 1000, channel: 'alipay' as const, requestKey: id() }
    const accepted = await newOrder(owner, id(), input)
    for (let i = 0; i < 4; i++) await newOrder(owner, id(), { ...input, requestKey: id() })
    expect((await newOrder(owner, id(), input)).id).toBe(accepted.id)
    const blocked = { ...input, requestKey: id() }
    await expect(newOrder(owner, id(), blocked)).rejects.toMatchObject({ status: 403 })
    const blockedId = orderIdFor(`${owner.id}:${blocked.requestKey}`)
    expect(await db.order.findUnique({ where: { id: blockedId } })).toBeNull()
    const events = await db.riskEvent.findMany({ where: { referenceId: blockedId } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      scene: 'order-assessment',
      action: 'review',
      mode: 'enforce',
      effectiveAction: 'review',
      reasonCodes: ['UNPAID_ORDER_ACCUMULATION'],
    })
    await cancelOrder(owner, id(), accepted.id)
    await expect(newOrder(owner, id(), blocked)).resolves.toHaveProperty('id', blockedId)
  })

  it('caps concurrent unpaid orders for a shared target across different users', async () => {
    const target = `${id()}@recharge.example.com`
    const requests = await Promise.all(
      Array.from({ length: 8 }, async () => ({
        owner: await fixtureUser(`${id()}@example.com`),
        quoteId: await quote(target),
      })),
    )
    const outcomes = await Promise.allSettled(
      requests.map(({ owner, quoteId }) =>
        newOrder(owner, browser, { quoteId, channel: 'alipay', requestKey: id() }),
      ),
    )
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(5)
    expect(
      outcomes
        .filter((result) => result.status === 'rejected')
        .every((result) => result.reason.status === 403),
    ).toBe(true)
    expect(await db.order.count({ where: { email: target, status: 'unpaid' } })).toBe(5)
  })

  it('serializes reviewers, releases rejection holds and records payout proof only after acceptance', async () => {
    const owner = await fixtureUser(`${id()}@example.com`)
    const reviewers = [
      await fixtureUser(`${id()}@example.com`),
      await fixtureUser(`${id()}@example.com`),
    ]
    await referralOrder(owner)
    await testQuery(Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id}`)
    const request = {
      amount: 180,
      method: '支付宝',
      account: 'pay@example.com',
      recipientName: '测试收款人',
      confirmed: true,
    }
    const w = await withdraw(owner, { ...request, requestKey: id() })
    await expect(
      reviewWithdrawal(reviewers[0], { id: w.id, status: 'paid', payoutReference: id() }),
    ).rejects.toThrow('请先受理')
    const results = await Promise.allSettled(
      reviewers.map((reviewer) => reviewWithdrawal(reviewer, { id: w.id, status: 'processing' })),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const winner = reviewers[results.findIndex((result) => result.status === 'fulfilled')]
    const loser = reviewers.find((reviewer) => reviewer.id !== winner.id)!
    await expect(
      reviewWithdrawal(loser, { id: w.id, status: 'rejected', note: '账号有误' }),
    ).rejects.toThrow('其他管理员')
    await reviewWithdrawal(winner, { id: w.id, status: 'rejected', note: '账号有误请重新申请' })
    expect(await account(owner)).toMatchObject({ available: 180, frozen: 0, withdrawn: 0 })
    const retry = await withdraw(owner, { ...request, requestKey: id() })
    await reviewWithdrawal(winner, { id: retry.id, status: 'processing' })
    const reference = id('transfer_')
    await reviewWithdrawal(winner, { id: retry.id, status: 'paid', payoutReference: reference })
    expect(await account(owner)).toMatchObject({ available: 0, frozen: 0, withdrawn: 180 })
    const paid = (await account(owner)).withdrawals.find((entry) => entry.id === retry.id)!
    expect(paid.payoutReference).toBe(reference)
    expect(Number(paid.payoutAmount)).toBe(1.8)
    await expect(
      reviewWithdrawal(winner, { id: retry.id, status: 'rejected', note: '不能重复' }),
    ).rejects.toThrow('已处理')
    await referralOrder(owner)
    await testQuery(Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id}`)
    const duplicate = await withdraw(owner, { ...request, requestKey: id() })
    await reviewWithdrawal(winner, { id: duplicate.id, status: 'processing' })
    await expect(
      reviewWithdrawal(winner, {
        id: duplicate.id,
        status: 'paid',
        payoutReference: reference,
      }),
    ).rejects.toThrow('流水号已登记')
    expect(
      (await account(owner)).withdrawals.find((entry) => entry.id === duplicate.id)?.status,
    ).toBe('processing')
  })

  it('blocks payouts after reward reversals and requires actual USDT quantity', async () => {
    const owner = await fixtureUser(`${id()}@example.com`)
    const reviewer = await fixtureUser(`${id()}@example.com`)
    const order = await referralOrder(owner)
    await testQuery(Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id}`)
    const w = await withdraw(owner, {
      amount: 180,
      method: 'USDT',
      network: 'ERC20',
      account: `0x${'a'.repeat(40)}`,
      recipientName: '测试收款人',
      confirmed: true,
      requestKey: id(),
    })
    await reviewWithdrawal(reviewer, { id: w.id, status: 'processing' })
    await expect(
      reviewWithdrawal(reviewer, { id: w.id, status: 'paid', payoutReference: id() }),
    ).rejects.toThrow('USDT 数量')
    await testQuery(Prisma.sql`UPDATE commissions SET status='reversed' WHERE order_id=${order.id}`)
    await expect(
      reviewWithdrawal(reviewer, {
        id: w.id,
        status: 'paid',
        payoutReference: id(),
        payoutAmount: 0.25,
      }),
    ).rejects.toThrow('发生冲回')
    expect(await account(owner)).toMatchObject({ available: 0, shortfall: 180 })
    await reviewWithdrawal(reviewer, { id: w.id, status: 'rejected', note: '收益已冲回' })
    expect(await account(owner)).toMatchObject({ available: 0, shortfall: 0, frozen: 0 })
    await referralOrder(owner)
    await testQuery(
      Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id} AND status='pending'`,
    )
    const retry = await withdraw(owner, {
      amount: 180,
      method: 'USDT',
      network: 'ERC20',
      account: `0x${'a'.repeat(40)}`,
      recipientName: '测试收款人',
      confirmed: true,
      requestKey: id(),
    })
    await reviewWithdrawal(reviewer, { id: retry.id, status: 'processing' })
    await reviewWithdrawal(reviewer, {
      id: retry.id,
      status: 'paid',
      payoutReference: id(),
      payoutAmount: 0.250001,
    })
    expect(
      (await account(owner)).withdrawals.find((entry) => entry.id === retry.id)?.payoutAmount,
    ).toBe('0.250001')
  })

  it('enforces each destination minimum and fee, and rejection releases the entire reservation', async () => {
    const owner = await fixtureUser(`${id()}@example.com`)
    const reviewer = await fixtureUser(`${id()}@example.com`)
    await referralOrder(owner)
    await testQuery(Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id}`)
    const previous = (await testQuery(Prisma.sql`SELECT body FROM settings WHERE id=1`)).rows[0]
      .body
    const configured = withdrawalChannels(previous)
    withdrawalDestinations.forEach(({ key }, index) => {
      configured.rules[key] = {
        minimum: 100 + index * 10,
        feeRateBps: (index + 1) * 100,
        fixedFee: index + 1,
      }
    })
    try {
      await testQuery(
        Prisma.sql`UPDATE settings SET body=${JSON.stringify({ ...previous, withdrawalChannels: configured })} WHERE id=1`,
      )
      for (const { key, method, network } of withdrawalDestinations) {
        const rule = configured.rules[key]
        const fee = withdrawalFee(rule.minimum, rule)
        const input = {
          amount: rule.minimum,
          method,
          network,
          account:
            method === 'USDT'
              ? network === 'TRC20'
                ? `T${'a'.repeat(33)}`
                : `0x${'a'.repeat(40)}`
              : 'pay@example.com',
          recipientName: '测试收款人',
          confirmed: true,
          requestKey: id(),
          expectedFeeAmount: fee.feeAmount,
        }
        await expect(withdraw(owner, { ...input, amount: rule.minimum - 1 })).rejects.toThrow(
          '最低起提',
        )
        await expect(withdraw(owner, { ...input, expectedFeeAmount: 0 })).rejects.toThrow(
          '手续费已调整',
        )
        expect((await account(owner)).frozen).toBe(0)
        const saved = await withdraw(owner, { ...input, feeAmount: 0, netAmount: 100000 })
        expect(saved).toMatchObject({ amount: rule.minimum, network, ...fee })
        expect((await account(owner)).frozen).toBe(rule.minimum)
        await expect(
          withdraw(owner, { ...input, expectedFeeAmount: fee.feeAmount + 1 }),
        ).rejects.toThrow('不同的提现参数')
        await reviewWithdrawal(reviewer, {
          id: saved.id,
          status: 'rejected',
          note: '测试释放全部额度',
        })
        expect(await account(owner)).toMatchObject({ frozen: 0, available: 180, withdrawn: 0 })
      }
    } finally {
      await testQuery(Prisma.sql`UPDATE settings SET body=${JSON.stringify(previous)} WHERE id=1`)
    }
  })

  it('blocks closed channels and networks but preserves retries and review of existing USDT requests', async () => {
    const owner = await fixtureUser(`${id()}@example.com`)
    const reviewer = await fixtureUser(`${id()}@example.com`)
    await referralOrder(owner)
    await testQuery(Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id}`)
    const previous = (await testQuery(Prisma.sql`SELECT body FROM settings WHERE id=1`)).rows[0]
      .body
    const configured = withdrawalChannels(previous)
    configured.alipay = false
    configured.wechat = false
    configured.networks = { ERC20: false, TRC20: false, BSC: true, Polygon: true }
    const saveConfig = () =>
      testQuery(
        Prisma.sql`UPDATE settings SET body=${JSON.stringify({
          ...previous,
          alipay: false,
          wechat: false,
          crypto: false,
          withdrawalChannels: configured,
        })} WHERE id=1`,
      )
    const input = {
      amount: 180,
      method: 'USDT',
      account: `0x${'a'.repeat(40)}`,
      recipientName: '测试收款人',
      confirmed: true,
      requestKey: id(),
    }
    try {
      await saveConfig()
      for (const method of ['支付宝', '微信'])
        await expect(withdraw(owner, { ...input, method })).rejects.toThrow('渠道暂未开放')
      await expect(withdraw(owner, { ...input, network: 'ERC20' })).rejects.toThrow('网络暂未开放')
      expect((await account(owner)).frozen).toBe(0)
      for (const network of ['BSC', 'Polygon'] as const) {
        configured.usdt = true
        await saveConfig()
        const request = { ...input, network, requestKey: id() }
        const saved = await withdraw(owner, request)
        expect(saved.network).toBe(network)
        configured.usdt = false
        await saveConfig()
        expect((await withdraw(owner, request)).id).toBe(saved.id)
        await expect(withdraw(owner, { ...request, requestKey: id() })).rejects.toThrow(
          '渠道暂未开放',
        )
        await reviewWithdrawal(reviewer, { id: saved.id, status: 'processing' })
        if (network === 'BSC')
          await reviewWithdrawal(reviewer, {
            id: saved.id,
            status: 'rejected',
            note: '测试释放额度',
          })
        else
          await reviewWithdrawal(reviewer, {
            id: saved.id,
            status: 'paid',
            payoutReference: id(),
            payoutAmount: 0.25,
          })
      }
      expect(await account(owner)).toMatchObject({ frozen: 0, available: 0, withdrawn: 180 })
    } finally {
      await testQuery(Prisma.sql`UPDATE settings SET body=${JSON.stringify(previous)} WHERE id=1`)
    }
  })

  it('snapshots fees before settings change and pays the saved net amount in CNY', async () => {
    const owner = await fixtureUser(`${id()}@example.com`)
    const reviewer = await fixtureUser(`${id()}@example.com`)
    await referralOrder(owner)
    await testQuery(Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id}`)
    const previous = (await testQuery(Prisma.sql`SELECT body FROM settings WHERE id=1`)).rows[0]
      .body
    const configured = withdrawalChannels(previous)
    configured.rules.alipay = { minimum: 100, feeRateBps: 250, fixedFee: 15 }
    const saveConfig = () =>
      testQuery(
        Prisma.sql`UPDATE settings SET body=${JSON.stringify({ ...previous, withdrawalChannels: configured })} WHERE id=1`,
      )
    try {
      await saveConfig()
      const request = {
        amount: 180,
        method: '支付宝',
        account: 'pay@example.com',
        recipientName: '测试收款人',
        confirmed: true,
        requestKey: id(),
        expectedFeeAmount: 20,
      }
      const saved = await withdraw(owner, request)
      expect(saved).toMatchObject({ feeAmount: 20, netAmount: 160, feeRateBps: 250, fixedFee: 15 })
      configured.rules.alipay = { minimum: 500, feeRateBps: 500, fixedFee: 30 }
      await saveConfig()
      expect(await withdraw(owner, request)).toEqual(saved)
      await reviewWithdrawal(reviewer, { id: saved.id, status: 'processing' })
      await reviewWithdrawal(reviewer, { id: saved.id, status: 'paid', payoutReference: id() })
      const view = await account(owner)
      expect(view).toMatchObject({ available: 0, withdrawn: 180, frozen: 0 })
      expect(view.withdrawals[0]).toMatchObject({
        feeAmount: 20,
        netAmount: 160,
        payoutAmount: '1.600000',
      })
    } finally {
      await testQuery(Prisma.sql`UPDATE settings SET body=${JSON.stringify(previous)} WHERE id=1`)
    }
  })

  it('estimates USDT from the saved net amount, isolates FX caches and refuses expired rates', async () => {
    const owner = await fixtureUser(`${id()}@example.com`)
    await referralOrder(owner)
    await testQuery(Prisma.sql`UPDATE commissions SET status='available' WHERE user_id=${owner.id}`)
    const previous = (await testQuery(Prisma.sql`SELECT body FROM settings WHERE id=1`)).rows[0]
      .body
    const usdBefore = (await testQuery(Prisma.sql`SELECT * FROM exchange_rates WHERE id='USD_CNY'`))
      .rows[0]
    const configured = withdrawalChannels(previous)
    configured.rules.BSC = { minimum: 100, feeRateBps: 250, fixedFee: 15 }
    const sourceDate = new Date().toISOString().slice(0, 10)
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ date: sourceDate, usdt: { cny: 8 }, usd: { cny: 7 } })),
    )
    try {
      await testQuery(
        Prisma.sql`UPDATE settings SET body=${JSON.stringify({ ...previous, withdrawalChannels: configured })} WHERE id=1`,
      )
      await testQuery(
        Prisma.sql`UPDATE exchange_rates SET rate_e8=null,expires_at=null,refresh_after=now(),locked_until=null WHERE id='USDT_CNY'`,
      )
      const saved = await withdraw(owner, {
        amount: 180,
        method: 'USDT',
        network: 'BSC',
        account: `0x${'a'.repeat(40)}`,
        recipientName: '测试收款人',
        confirmed: true,
        requestKey: id(),
        expectedFeeAmount: 20,
      })
      vi.stubGlobal('fetch', fetcher)
      const estimates = await Promise.allSettled(
        Array.from({ length: 8 }, () => withdrawalPayoutEstimate(saved.id)),
      )
      expect(fetcher).toHaveBeenCalledTimes(1)
      const first = estimates.find((result) => result.status === 'fulfilled')
      expect(first?.status).toBe('fulfilled')
      if (first?.status !== 'fulfilled') throw new Error('No estimate returned')
      expect(first.value).toMatchObject({
        withdrawalId: saved.id,
        netAmount: 160,
        estimatedUsdt: '0.200000',
        rate: 8,
        sourceDate,
        refreshFailed: false,
      })
      expect(await withdrawalPayoutEstimate(saved.id)).toEqual(first.value)
      expect(fetcher).toHaveBeenCalledTimes(1)
      fetcher.mockResolvedValue(
        new Response(JSON.stringify({ date: sourceDate, usdt: { cny: 5 } })),
      )
      const refreshed = await withdrawalPayoutEstimate(saved.id, true)
      expect(refreshed).toMatchObject({ rate: 5, estimatedUsdt: '0.320000' })
      expect(fetcher.mock.calls.map((args) => (args as unknown[])[0])).toEqual([
        usdtExchangeSources[0],
        usdtExchangeSources[0],
      ])
      fetcher.mockRejectedValue(new Error('private network error'))
      expect(await withdrawalPayoutEstimate(saved.id, true)).toMatchObject({
        rate: 5,
        estimatedUsdt: '0.320000',
        refreshFailed: true,
      })
      await testQuery(
        Prisma.sql`UPDATE exchange_rates SET expires_at=now()-interval '1 second' WHERE id='USDT_CNY'`,
      )
      await expect(withdrawalPayoutEstimate(saved.id, true)).rejects.toThrow('参考汇率暂不可用')
      expect(
        (await testQuery(Prisma.sql`SELECT * FROM exchange_rates WHERE id='USD_CNY'`)).rows[0],
      ).toEqual(usdBefore)
      expect((await account(owner)).withdrawals[0]).toMatchObject({
        status: 'pending',
        payoutAmount: null,
        feeAmount: 20,
      })
    } finally {
      vi.unstubAllGlobals()
      await testQuery(Prisma.sql`UPDATE settings SET body=${JSON.stringify(previous)} WHERE id=1`)
    }
  })

  it('keeps generated order ids within the gateway 32 character limit and deterministic', () => {
    const seed = `${id()}@example.com:${id()}`
    expect(orderIdFor(seed)).toBe(orderIdFor(seed))
    expect(orderIdFor(seed).length).toBeLessThanOrEqual(32)
    expect(orderIdFor(seed)).toMatch(/^o_[0-9a-f]{30}$/)
  })

})
