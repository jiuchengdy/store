import { NextRequest } from 'next/server'
import { afterEach, expect, it, vi } from 'vitest'
import { gmpaySignature } from './integrations/signatures'

// demo=false so the callback route does not 404 itself; appUrl stays a stable
// origin. The real ApiError/validateRuntime are kept from the actual module.
vi.mock('./config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config')>()
  return { ...actual, demo: false, appUrl: 'https://shop.example' }
})
vi.mock('./integrations/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integrations/config')>()
  return {
    ...actual,
    integration: vi.fn(async () => ({
      id: 'revision',
      url: 'https://gateway.example',
      pid: 'test-merchant',
      secret: 'test-only',
    })),
  }
})
const acceptPayment = vi.fn(async () => undefined)
vi.mock('./services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services')>()
  return { ...actual, acceptPayment }
})
const recordPaymentAnomaly = vi.fn(
  async (_kind: string, _facts: object, _orderId?: string) => undefined,
)
vi.mock('./risk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./risk')>()
  return { ...actual, recordPaymentAnomaly }
})

const { POST } = await import('../app/api/payments/notify/[provider]/[revision]/route')

afterEach(() => {
  vi.unstubAllGlobals()
  acceptPayment.mockClear()
  recordPaymentAnomaly.mockClear()
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function gmpayCallback(fields: Record<string, string | number>) {
  const signed: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields)) signed[key] = String(value)
  signed.signature = gmpaySignature(signed, 'test-only')
  return new NextRequest('https://shop.example/api/payments/notify/gmpay/revision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
  })
}

const context = { params: Promise.resolve({ provider: 'gmpay', revision: 'revision' }) }
const PAID = {
  pid: 'test-merchant',
  trade_id: 'trade-1',
  order_id: 'o_abc',
  amount: 48,
  actual_amount: 7.05,
  receive_address: 'TXYZ',
  token: 'USDT',
  block_transaction_id: 'hash',
  status: 2,
}

it('acknowledges but never credits when the gateway reports a different trade_id', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ status_code: 200, data: { trade_id: 'trade-OTHER', status: 2 } })),
  )
  const response = await POST(gmpayCallback(PAID), context)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('ok')
  expect(acceptPayment).not.toHaveBeenCalled()
  expect(recordPaymentAnomaly).toHaveBeenCalledTimes(1)
  expect(recordPaymentAnomaly.mock.calls[0][0]).toBe('trade_id_mismatch')
})

it('acknowledges but never credits a status=4 placeholder', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ status_code: 200, data: { trade_id: 'trade-1', status: 4 } })),
  )
  const response = await POST(gmpayCallback(PAID), context)
  expect(response.status).toBe(200)
  expect(acceptPayment).not.toHaveBeenCalled()
  expect(recordPaymentAnomaly.mock.calls[0][0]).toBe('awaiting_selection')
})

it('acknowledges but never credits when the cashier reports a different amount', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('check-status')
        ? json({ status_code: 200, data: { trade_id: 'trade-1', status: 2 } })
        : json({ status_code: 200, data: { trade_id: 'trade-1', amount: 0.01, currency: 'CNY' } }),
    ),
  )
  const response = await POST(gmpayCallback(PAID), context)
  expect(response.status).toBe(200)
  expect(acceptPayment).not.toHaveBeenCalled()
  expect(recordPaymentAnomaly.mock.calls[0][0]).toBe('amount_mismatch')
})

it('credits exactly once when the gateway agrees on trade_id and amount', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('check-status')
        ? json({ status_code: 200, data: { trade_id: 'trade-1', status: 2 } })
        : json({ status_code: 200, data: { trade_id: 'trade-1', amount: 48, currency: 'CNY' } }),
    ),
  )
  const response = await POST(gmpayCallback(PAID), context)
  expect(response.status).toBe(200)
  expect(acceptPayment).toHaveBeenCalledTimes(1)
  expect(recordPaymentAnomaly).not.toHaveBeenCalled()
})

it('still credits when the status endpoint is down, because the signature already proves the source', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('ECONNRESET')
    }),
  )
  const response = await POST(gmpayCallback(PAID), context)
  expect(response.status).toBe(200)
  expect(acceptPayment).toHaveBeenCalledTimes(1)
  expect(recordPaymentAnomaly).not.toHaveBeenCalled()
})
