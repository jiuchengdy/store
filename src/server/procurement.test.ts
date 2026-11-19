import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  process.env.APP_MODE = 'live'
  process.env.ENCRYPTION_KEY = 'ca'.repeat(32)
  if (process.env.TEST_DATABASE_URL) {
    const url = new URL(process.env.TEST_DATABASE_URL)
    url.searchParams.set('schema', `test_stock_${crypto.randomUUID().replaceAll('-', '')}`)
    process.env.DATABASE_URL = url.toString()
  }
})
import { prepareTestDatabase, cleanupTestDatabase } from './database-test-support'
import { db } from './db'
import { saveIntegration, integration } from './integrations/config'
import {
  procurementOverview,
  queueStockPurchase,
  saveStockMapping,
  syncStockPurchase,
} from './procurement'
import { importInventory, openCredential } from './credential-storage'

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip
suite('downstream stock purchases', () => {
  const actor = 'stock-operator'
  const mapping = { productId: 'local-plus', upstreamProductId: 20, skuId: 34, integrationId: '' }
  const upstreamProduct = {
    id: 20,
    is_active: true,
    fulfillment_type: 'auto',
    title: { 'zh-CN': 'Plus' },
    skus: [
      { id: 34, is_active: true, sku_code: 'PLUS', price_amount: '10.00', stock_quantity: -1 },
    ],
  }
  const created = () => Response.json({ ok: true, order_id: 92, status: 'paid' })
  const delivered = (payload: string, type = 'auto', status = 'delivered') =>
    Response.json({
      ok: true,
      status,
      order_id: 92,
      fulfillment: { type, status: 'delivered', payload },
      items: [{ product_id: 20, sku_id: 34, quantity: 2 }],
    })
  const immediately = (id: string) =>
    db.stockPurchase.update({ where: { id }, data: { nextRunAt: new Date(0) } })
  beforeAll(async () => {
    await prepareTestDatabase()
    await db.product.create({
      data: {
        id: mapping.productId,
        name: 'Local Plus',
        subtitle: '',
        description: '',
        features: [],
        price: 99,
        plan: 'plus',
      },
    })
    await expect(integration('dujiao-next')).rejects.toThrow('尚未启用')
    await saveIntegration(
      {
        provider: 'dujiao-next',
        enabled: true,
        public: { url: 'https://supplier.example' },
        secrets: { apiKey: crypto.randomUUID(), apiSecret: crypto.randomUUID() },
      },
      actor,
    )
    mapping.integrationId = (await integration('dujiao-next')).id
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, product: upstreamProduct })),
    )
    await expect(saveStockMapping({ ...mapping, skuId: 35 }, actor)).rejects.toThrow('SKU')
    await saveStockMapping(mapping, actor)
  })
  afterEach(() => vi.unstubAllGlobals())
  afterAll(cleanupTestDatabase)
  it('pins the mapping, recovers an ambiguous submission and imports encrypted codes exactly once without callbacks', async () => {
    const request = { ...mapping, requestKey: crypto.randomUUID(), quantity: 2 }
    const [{ id }, duplicate] = await Promise.all([
      queueStockPurchase(request, actor),
      queueStockPurchase(request, actor),
    ])
    expect(duplicate.id).toBe(id)
    await expect(queueStockPurchase({ ...request, quantity: 3 }, actor)).rejects.toThrow(
      '不能更改参数',
    )
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(created())
      .mockResolvedValueOnce(Response.json({ ok: true, order_id: 92, status: 'paid' }))
      .mockResolvedValueOnce(delivered('PROC-ALPHA001\nPROC-BETA0002'))
      // The two calls below run concurrently and both need a response. One-shot
      // responses starve whichever loses the race, which then writes retry_pending
      // and races the winner's state='received' — that is what made this file flaky.
      .mockResolvedValue(delivered('PROC-ALPHA001\nPROC-BETA0002'))
    vi.stubGlobal('fetch', fetcher)
    await syncStockPurchase()
    await immediately(id)
    await syncStockPurchase()
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).not.toHaveProperty('callback_url')
    await syncStockPurchase()
    expect(await db.inventory.count()).toBe(0)
    await immediately(id)
    await Promise.all([syncStockPurchase(), syncStockPurchase()])
    const record = await db.stockPurchase.findUniqueOrThrow({ where: { id } })
    expect(record).toMatchObject({ state: 'received', upstreamOrderId: 92 })
    const stock = await db.inventory.findMany({ where: { batchId: record.batchId } })
    expect(stock.map((item) => openCredential(item.code, 'inventory', item.id)).sort()).toEqual([
      'PROC-ALPHA001',
      'PROC-BETA0002',
    ])
    expect(await syncStockPurchase()).toBe(false)
    expect(JSON.stringify(await procurementOverview())).not.toContain('PROC-ALPHA001')
    expect(await db.product.findUniqueOrThrow({ where: { id: mapping.productId } })).toMatchObject({
      price: 99,
    })
  })
  it('accepts a mapped automatic SKU fulfilled through a second Dujiao supplier', async () => {
    const { id } = await queueStockPurchase(
      { ...mapping, requestKey: crypto.randomUUID(), quantity: 2 },
      actor,
    )
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(created())
        .mockResolvedValueOnce(delivered('RELAY-CARD-01\nRELAY-CARD-02', 'upstream', 'fulfilled')),
    )
    await syncStockPurchase()
    await syncStockPurchase()
    expect(await db.stockPurchase.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: 'received',
    })
  })
  it.each(['DUPLICATE-FIXTURE\nNEW-UNUSED01', 'SHORT'])(
    'quarantines the entire delivery on duplicate or invalid stock (%s)',
    async (payload) => {
      const request = { ...mapping, requestKey: crypto.randomUUID(), quantity: 2 }
      const { id } = await queueStockPurchase(request, actor)
      await importInventory(mapping.productId, ['DUPLICATE-FIXTURE'], actor)
      const count = await db.inventory.count()
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(created()).mockResolvedValueOnce(delivered(payload)),
      )
      await syncStockPurchase()
      await syncStockPurchase()
      expect(await db.stockPurchase.findUniqueOrThrow({ where: { id } })).toMatchObject({
        state: 'review',
        batchId: null,
      })
      expect(await db.inventory.count()).toBe(count)
    },
  )
  it('does not retry a definitive wallet rejection and requires rebinding after credential rotation', async () => {
    const request = { ...mapping, requestKey: crypto.randomUUID(), quantity: 1 }
    await queueStockPurchase(request, actor)
    const fail = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ ok: false, order_id: 95, error_code: 'payment_failed' }),
      )
    vi.stubGlobal('fetch', fail)
    await expect(
      saveIntegration(
        {
          provider: 'dujiao-next',
          enabled: true,
          public: { url: 'https://new-supplier.example' },
          secrets: {},
        },
        actor,
      ),
    ).rejects.toThrow('重新填写')
    await saveIntegration(
      {
        provider: 'dujiao-next',
        enabled: true,
        public: { url: 'https://new-supplier.example' },
        secrets: { apiKey: crypto.randomUUID(), apiSecret: crypto.randomUUID() },
      },
      actor,
    )
    await syncStockPurchase()
    expect(fail.mock.calls[0][0]).toContain('https://supplier.example/')
    expect(
      await db.stockPurchase.findUniqueOrThrow({ where: { id: request.requestKey } }),
    ).toMatchObject({ state: 'rejected', lastError: 'payment_failed' })
    expect(await syncStockPurchase()).toBe(false)
    await expect(
      queueStockPurchase({ ...request, requestKey: crypto.randomUUID() }, actor),
    ).rejects.toThrow('重新确认')
  })
})
