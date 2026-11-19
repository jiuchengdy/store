import { afterEach, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
vi.mock('./config', () => ({
  integration: async (_provider: string, revision?: string) => ({
    id: 'revision',
    url: revision === 'http-revision' ? 'http://gateway.example' : 'https://gateway.example',
    appId: 'test-app',
    pid: 'test-merchant',
    secret: 'test-only',
    key: 'test-only',
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  }),
}))
import {
  confirmGmpayReceipt,
  createPayment,
  refundXorpay,
  type PaymentOrder,
  type Receipt,
} from './payments'
import { epayV2Signature, xorpaySignature } from './signatures'
afterEach(() => vi.unstubAllGlobals())
it.each(['http', 'https'])(
  'sends only the external payment amount through %s gateways',
  async (protocol) => {
    for (const provider of ['xorpay', 'gmpay', 'epay_v1', 'epay_v2'] as const) {
      const signedResponse: Record<string, string | number> = {
        code: 0,
        trade_no: 'tx',
        pay_type: 'jump',
        pay_info: 'https://pay.example',
        sign_type: 'RSA',
      }
      signedResponse.sign = epayV2Signature(signedResponse, keys.privateKey)
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              provider === 'epay_v2'
                ? signedResponse
                : {
                    status: 'ok',
                    aoid: 'tx',
                    info: { qr: 'https://pay.example' },
                    data: { trade_id: 'tx', payment_url: 'https://pay.example' },
                    code: 1,
                    trade_no: 'tx',
                    payurl: 'https://pay.example',
                    pay_type: 'jump',
                    pay_info: 'https://pay.example',
                  },
            ),
          ),
      )
      vi.stubGlobal('fetch', fetcher)
      await createPayment(
        {
          id: 'o_test',
          provider,
          integrationId: protocol === 'http' ? 'http-revision' : 'revision',
          amount: 12900,
          balanceAmount: 3000,
          externalAmount: 9900,
          channel: provider === 'gmpay' ? 'crypto' : 'alipay',
          productName: 'Test',
        } as PaymentOrder,
        '127.0.0.1',
      )
      const [url, options] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]
      if (provider !== 'xorpay')
        expect(url).toMatch(new RegExp(`^${protocol}://gateway\\.example/`))
      const fields = new URLSearchParams(String(options.body))
      expect(
        fields.get(provider === 'xorpay' ? 'price' : provider === 'gmpay' ? 'amount' : 'money'),
      ).toBe('99.00')
      expect(options.redirect).toBe('error')
    }
  },
)
it('refunds the exact external amount with the XorPay refund signature and no redirects', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' })))
  vi.stubGlobal('fetch', fetcher)
  await refundXorpay('aoid/fixture', 2001, 'refund-fixture-key')
  const [url, options] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]
  expect(url).toBe('https://xorpay.com/api/refund/aoid%2Ffixture')
  const fields = new URLSearchParams(String(options.body))
  expect(Object.fromEntries(fields)).toEqual({
    price: '20.01',
    sign: xorpaySignature(['20.01'], 'refund-fixture-key'),
  })
  expect(options.method).toBe('POST')
  expect(options.redirect).toBe('error')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it.each(['order_error', 'price_error', 'sign_error', 'alipay_api_error', 'unknown'])(
  'does not treat XorPay %s as success or retry',
  async (status) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status, info: 'private' })))
    vi.stubGlobal('fetch', fetcher)
    await expect(refundXorpay('tx', 2000, 'refund-fixture-key')).rejects.toThrow('核实后登记')
    expect(fetcher).toHaveBeenCalledTimes(1)
  },
)
it('does not retry timeouts or accept invalid refund amounts', async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error('timeout'))
  vi.stubGlobal('fetch', fetcher)
  await expect(refundXorpay('tx', 2000, 'fixture')).rejects.toThrow('timeout')
  expect(fetcher).toHaveBeenCalledTimes(1)
  await expect(refundXorpay('tx', 0, 'fixture')).rejects.toThrow('退款信息不完整')
  await expect(refundXorpay('tx', 1.5, 'fixture')).rejects.toThrow('退款信息不完整')
  expect(fetcher).toHaveBeenCalledTimes(1)
})


const gmpayConfig = { url: 'https://gateway.example', pid: 'test-merchant', secret: 'test-only' }
const gmpayReceipt: Receipt = { orderId: 'o_abc', transactionId: 'trade-1', amount: 4800, paid: true }
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function stubGmpay(responses: Array<Response | Error>) {
  const queue = [...responses]
  const fetcher = vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('unexpected extra request')
    if (next instanceof Error) throw next
    return next
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

it('classifies an unreachable status check as unreachable, never as paid', async () => {
  stubGmpay([new Error('ECONNRESET')])
  await expect(confirmGmpayReceipt(gmpayReceipt, gmpayConfig)).resolves.toMatchObject({
    verdict: 'unreachable',
  })
})

it('treats a missing check-status route as unreachable (configuration, not evidence)', async () => {
  stubGmpay([jsonResponse({ status_code: 404, message: 'Not Found' }, 404)])
  await expect(confirmGmpayReceipt(gmpayReceipt, gmpayConfig)).resolves.toMatchObject({
    verdict: 'unreachable',
    reason: 'check_status_http_404',
  })
})

it('treats 10008 order-not-found as manual: callback says paid, gateway says no such order', async () => {
  stubGmpay([jsonResponse({ status_code: 10008, message: 'order does not exist', data: null })])
  await expect(confirmGmpayReceipt(gmpayReceipt, gmpayConfig)).resolves.toMatchObject({
    verdict: 'manual',
    reason: 'order_not_found',
  })
})

it('rejects a different trade_id even when the amount matches, before comparing money', async () => {
  const fetcher = stubGmpay([
    jsonResponse({ status_code: 200, data: { trade_id: 'trade-OTHER', status: 2 } }),
  ])
  await expect(confirmGmpayReceipt(gmpayReceipt, gmpayConfig)).resolves.toMatchObject({
    verdict: 'mismatch',
    reason: 'trade_id_mismatch',
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('treats a status=4 placeholder as manual, not as paid', async () => {
  stubGmpay([jsonResponse({ status_code: 200, data: { trade_id: 'trade-1', status: 4 } })])
  await expect(confirmGmpayReceipt(gmpayReceipt, gmpayConfig)).resolves.toMatchObject({
    verdict: 'manual',
    reason: 'awaiting_selection',
  })
})

it('credits when status is paid and the cashier amount matches', async () => {
  stubGmpay([
    jsonResponse({ status_code: 200, data: { trade_id: 'trade-1', status: 2 } }),
    jsonResponse({ status_code: 200, data: { trade_id: 'trade-1', amount: 48, currency: 'CNY' } }),
  ])
  await expect(confirmGmpayReceipt(gmpayReceipt, gmpayConfig)).resolves.toMatchObject({
    verdict: 'credited',
    reason: 'verified',
  })
})

it('still credits when only the cashier endpoint is unreachable', async () => {
  stubGmpay([
    jsonResponse({ status_code: 200, data: { trade_id: 'trade-1', status: 2 } }),
    new Error('timeout'),
  ])
  await expect(confirmGmpayReceipt(gmpayReceipt, gmpayConfig)).resolves.toMatchObject({
    verdict: 'credited',
    reason: 'amount_check_unreachable',
  })
})

it('refuses to credit when the cashier reports a different amount', async () => {
  stubGmpay([
    jsonResponse({ status_code: 200, data: { trade_id: 'trade-1', status: 2 } }),
    jsonResponse({ status_code: 200, data: { trade_id: 'trade-1', amount: 0.01, currency: 'CNY' } }),
  ])
  await expect(confirmGmpayReceipt(gmpayReceipt, gmpayConfig)).resolves.toMatchObject({
    verdict: 'mismatch',
    reason: 'amount_mismatch',
  })
})

it('surfaces 10002 as "do not pay twice" instead of silently retrying', async () => {
  stubGmpay([jsonResponse({ status_code: 10002, message: 'order already exists', data: null }, 400)])
  const order = {
    id: 'o_0123456789abcdef0123456789abcd',
    kind: 'purchase',
    channel: 'crypto',
    productName: 'Test',
    amount: 4800,
    externalAmount: 4800,
    balanceAmount: 0,
    provider: 'gmpay',
    integrationId: 'revision',
  } as unknown as PaymentOrder
  await expect(createPayment(order, '127.0.0.1')).rejects.toMatchObject({
    status: 502,
    message: expect.stringContaining('请勿重复支付'),
  })
})
