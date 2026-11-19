import { ApiError, appUrl, demo } from '../config'
import { integration, isDisallowedPaymentHost } from './config'
import {
  decimalToMinor,
  epayV1Signature,
  epayV2Signature,
  epayV2Verify,
  gmpaySignature,
  safeEqual,
  xorpaySignature,
} from './signatures'
import type { Order } from '../../types'

export type Provider = 'xorpay' | 'gmpay' | 'epay_v1' | 'epay_v2'
export interface PaymentOrder extends Order {
  provider: Provider | 'balance'
  integrationId?: string | null
  paymentId?: string | null
  paymentUrl?: string | null
  paymentAttempted: boolean
  redemptionId?: string | null
  quoteId?: string | null
  fulfillmentAttempt: number
  aicdkIntegrationId?: string | null
  redemptionVersion: number
  submissionAttempted: boolean
}
export interface Receipt {
  orderId: string
  transactionId: string
  amount: number
  paid: boolean
  channel?: string
}
const origin = (value: string) => {
  const trimmed = value.replace(/\/$/, '')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ApiError(503, '支付网关地址格式不正确')
  }
  const live = process.env.APP_MODE === 'live' || !demo
  const allowedProtocols = live ? ['https:'] : ['http:', 'https:']
  if (
    !allowedProtocols.includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ApiError(
      503,
      live ? '正式环境支付网关必须使用 HTTPS' : '支付网关地址需使用 HTTP 或 HTTPS',
    )
  }
  if (live && isDisallowedPaymentHost(parsed.hostname)) {
    throw new ApiError(503, '正式环境支付网关地址不允许指向本地或内网地址')
  }
  return trimmed
}
export async function precheckPaymentGateway(order: PaymentOrder) {
  if (order.provider === 'balance') throw new ApiError(409, '余额订单无需创建渠道付款')
  const config = await integration(order.provider, order.integrationId ?? undefined)
  if (order.provider !== 'xorpay') origin(config.url)
  return config
}
async function post(url: string, fields: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
    cache: 'no-store',
  })
  if (!response.ok) {
    // Gateways answer business errors with 4xx *and* a JSON body. 10002 (EPUSDT:
    // this order_id already exists) must reach the buyer as "do not pay twice",
    // not as a generic "gateway did not respond", otherwise support has no clue.
    const errorBody = await response.json().catch(() => null)
    const code =
      errorBody && typeof errorBody === 'object'
        ? (errorBody as { status_code?: number }).status_code
        : undefined
    if (code === 10002)
      throw new ApiError(502, '该订单在网关已存在，请勿重复支付；请联系支持核对原订单')
    throw new ApiError(502, '支付渠道暂未响应，请在原订单中联系支持')
  }
  const body = await response.json()
  return typeof body === 'string' ? JSON.parse(body) : body
}
export async function createPayment(
  order: PaymentOrder,
  clientIP: string,
  resolvedConfig?: Record<string, string>,
) {
  if (order.provider === 'balance') throw new ApiError(409, '余额订单无需创建渠道付款')
  const config =
    resolvedConfig ?? (await integration(order.provider, order.integrationId ?? undefined))
  const amount = (order.externalAmount / 100).toFixed(2)
  const notify = `${appUrl}/api/payments/notify/${order.provider}/${config.id}`
  if (order.provider === 'xorpay') {
    const fields: Record<string, string> = {
      name: order.productName,
      pay_type: order.channel === 'wechat' ? 'native' : 'alipay',
      price: amount,
      order_id: order.id,
      notify_url: notify,
      expire: '1800',
    }
    fields.sign = xorpaySignature(
      [fields.name, fields.pay_type, amount, order.id, notify],
      config.secret,
    )
    const response = await post(
      `https://xorpay.com/api/pay/${encodeURIComponent(config.appId)}`,
      fields,
    )
    if (response.status !== 'ok' || !response.aoid || !response.info?.qr)
      throw new ApiError(502, '支付渠道未返回收款信息，请联系支持核对原订单')
    return { paymentId: String(response.aoid), paymentUrl: String(response.info.qr) }
  }
  if (order.provider === 'gmpay') {
    const fields: Record<string, string> = {
      pid: config.pid,
      order_id: order.id,
      currency: 'CNY',
      amount,
      notify_url: notify,
      redirect_url: `${appUrl}/orders/${order.id}`,
      name: order.productName,
    }
    fields.signature = gmpaySignature(fields, config.secret)
    const response = await post(
      `${origin(config.url)}/payments/gmpay/v1/order/create-transaction`,
      fields,
    )
    // 10002 = the gateway already has an order with this order_id. We cannot
    // recover its trade_id through the merchant API, so never retry blindly:
    // tell the buyer not to pay twice and route to manual reconciliation.
    if (response.status_code === 10002)
      throw new ApiError(502, '该订单在网关已存在，请勿重复支付；请联系支持核对原订单')
    if (!response.data?.trade_id || !response.data?.payment_url)
      throw new ApiError(502, 'GMPay 未返回收款信息，请联系支持核对原订单')
    return {
      paymentId: String(response.data.trade_id),
      paymentUrl: String(response.data.payment_url),
    }
  }
  const v2 = order.provider === 'epay_v2'
  const fields: Record<string, string> = {
    pid: config.pid,
    type: order.channel === 'wechat' ? 'wxpay' : 'alipay',
    out_trade_no: order.id,
    notify_url: notify,
    return_url: `${appUrl}/orders/${order.id}`,
    name: order.productName,
    money: amount,
    clientip: clientIP,
    ...(v2
      ? { method: 'web', timestamp: String(Math.floor(Date.now() / 1000)) }
      : { device: 'pc' }),
  }
  fields.sign = v2
    ? epayV2Signature(fields, config.privateKey)
    : epayV1Signature(fields, config.key)
  fields.sign_type = v2 ? 'RSA' : 'MD5'
  const response = await post(
    `${origin(config.url)}${v2 ? '/api/pay/create' : '/mapi.php'}`,
    fields,
  )
  if (response.code !== (v2 ? 0 : 1))
    throw new ApiError(502, '易支付暂未返回收款信息，请联系支持核对原订单')
  if (
    v2 &&
    ((response.sign_type && response.sign_type !== 'RSA') ||
      !epayV2Verify(response, config.publicKey))
  )
    throw new ApiError(502, '易支付返回签名校验失败，请联系管理员')
  const url = v2 ? response.pay_info : response.payurl || response.qrcode || response.urlscheme
  if (v2 && !['qrcode', 'jump', 'url'].includes(response.pay_type))
    throw new ApiError(502, '此易支付交互类型暂不支持，请联系管理员')
  if (!response.trade_no || typeof url !== 'string')
    throw new ApiError(502, '易支付返回的信息不完整')
  return { paymentId: String(response.trade_no), paymentUrl: url }
}
// XorPay does not expose a refund idempotency key. The caller must durably claim
// the refund before invoking this function and must never retry an unknown result.
export async function refundXorpay(paymentId: string, amount: number, secret: string) {
  if (!paymentId || !secret || !Number.isSafeInteger(amount) || amount <= 0)
    throw new ApiError(400, '退款信息不完整，请核对原支付记录')
  const price = (amount / 100).toFixed(2)
  const response = await post(`https://xorpay.com/api/refund/${encodeURIComponent(paymentId)}`, {
    price,
    sign: xorpaySignature([price], secret),
  })
  if (response?.status !== 'ok')
    throw new ApiError(502, 'XorPay 未确认退款成功，请在渠道后台核实后登记')
}

export function verifyReceipt(
  provider: Provider,
  fields: Record<string, string>,
  config: Record<string, string>,
): Receipt {
  if (provider === 'xorpay') {
    const expected = xorpaySignature(
      [fields.aoid, fields.order_id, fields.pay_price, fields.pay_time],
      config.secret,
    )
    if (!fields.sign || !safeEqual(expected, fields.sign)) throw new ApiError(400, '签名无效')
    return {
      orderId: fields.order_id,
      transactionId: fields.aoid,
      amount: decimalToMinor(fields.pay_price),
      paid: true,
    }
  }
  if (provider === 'gmpay') {
    if (
      fields.pid !== config.pid ||
      !safeEqual(gmpaySignature(fields, config.secret), fields.signature || '')
    )
      throw new ApiError(400, '签名无效')
    if (fields.currency && fields.currency !== 'CNY') throw new ApiError(400, '币种不匹配')
    return {
      orderId: fields.order_id,
      transactionId: fields.trade_id,
      amount: decimalToMinor(fields.amount),
      paid: fields.status === '2',
    }
  }
  const v2 = provider === 'epay_v2'
  if (fields.pid !== config.pid) throw new ApiError(400, '商户不匹配')
  if (fields.sign_type !== (v2 ? 'RSA' : 'MD5')) throw new ApiError(400, '签名协议不匹配')
  const valid = v2
    ? epayV2Verify(fields, config.publicKey)
    : safeEqual(epayV1Signature(fields, config.key), fields.sign || '')
  if (!valid) throw new ApiError(400, '签名无效')
  return {
    orderId: fields.out_trade_no,
    transactionId: fields.trade_no,
    amount: decimalToMinor(fields.money),
    paid: fields.trade_status === 'TRADE_SUCCESS',
    channel: fields.type === 'wxpay' ? 'wechat' : fields.type,
  }
}
export type GmpayVerdict = 'credited' | 'unreachable' | 'mismatch' | 'manual'
export interface GmpayCheck {
  verdict: GmpayVerdict
  reason: string
  facts: Record<string, unknown>
}

// EPUSDT v2 exposes GET /pay/check-status/{trade_id} (no signature) and returns
// only {trade_id, status}. The amount/currency cross-check therefore uses the
// cashier endpoint /pay/checkout-counter-resp/{trade_id}.
//
// The verdicts are deliberately distinct, because the caller treats them
// differently (only credited/unreachable may credit an order):
//   unreachable — we could not ask (network, timeout, 5xx, 404 route)
//   manual      — we asked and the answers contradict the callback
//                 (10008 order not found, status != 2, placeholder status 4)
//   mismatch    — we asked and got a different order or a different amount
// Order matters: trade_id is checked BEFORE the amount, otherwise a switched
// order could pass on a coincidentally equal amount.
export async function confirmGmpayReceipt(
  receipt: Receipt,
  config: Record<string, string>,
): Promise<GmpayCheck> {
  const base = origin(config.url)
  const statusUrl = `${base}/pay/check-status/${encodeURIComponent(receipt.transactionId)}`
  let response: Response
  try {
    response = await fetch(statusUrl, {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
      cache: 'no-store',
    })
  } catch (error) {
    return { verdict: 'unreachable', reason: 'check_status_unreachable', facts: { error: String(error) } }
  }
  // A 404 here means the route is missing (wrong gateway/version), which is a
  // configuration failure, not evidence about the payment.
  if (!response.ok)
    return { verdict: 'unreachable', reason: `check_status_http_${response.status}`, facts: {} }

  let raw: unknown
  try {
    raw = await response.json()
  } catch {
    return { verdict: 'manual', reason: 'check_status_malformed', facts: {} }
  }
  if (!raw || typeof raw !== 'object')
    return { verdict: 'manual', reason: 'check_status_malformed', facts: {} }
  const body = raw as { status_code?: number; data?: Record<string, unknown> }
  if (body.status_code === 10008)
    return { verdict: 'manual', reason: 'order_not_found', facts: { statusCode: body.status_code } }
  const data = body.data
  if (!data) return { verdict: 'manual', reason: 'check_status_no_data', facts: { statusCode: body.status_code ?? null } }

  const tradeId = String(data.trade_id ?? '')
  if (tradeId !== receipt.transactionId)
    return {
      verdict: 'mismatch',
      reason: 'trade_id_mismatch',
      facts: { expected: receipt.transactionId, actual: tradeId || null },
    }
  const status = Number(data.status)
  if (status !== 2)
    return {
      verdict: 'manual',
      reason: status === 4 ? 'awaiting_selection' : `status_${Number.isFinite(status) ? status : 'unknown'}`,
      facts: { status: Number.isFinite(status) ? status : null },
    }
  return verifyGmpayAmount(receipt, base)
}

// Second opinion on money. An unreachable cashier endpoint must NOT block
// crediting — the callback signature already proves the source — but a reachable
// endpoint that disagrees about amount or currency must block it.
async function verifyGmpayAmount(receipt: Receipt, base: string): Promise<GmpayCheck> {
  const url = `${base}/pay/checkout-counter-resp/${encodeURIComponent(receipt.transactionId)}`
  let response: Response
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
      cache: 'no-store',
    })
  } catch (error) {
    return { verdict: 'credited', reason: 'amount_check_unreachable', facts: { error: String(error) } }
  }
  if (!response.ok)
    return { verdict: 'credited', reason: `amount_check_http_${response.status}`, facts: {} }
  let data: Record<string, unknown> | null = null
  try {
    const body = (await response.json()) as { data?: Record<string, unknown> } | null
    data = body?.data ?? null
  } catch {
    return { verdict: 'credited', reason: 'amount_check_malformed', facts: {} }
  }
  if (!data) return { verdict: 'credited', reason: 'amount_check_no_data', facts: {} }

  let amount: number
  try {
    amount = decimalToMinor(String(data.amount ?? ''))
  } catch {
    return { verdict: 'mismatch', reason: 'amount_unparsable', facts: { raw: data.amount ?? null } }
  }
  const currency = String(data.currency ?? '').toUpperCase()
  if (amount !== receipt.amount || (currency !== '' && currency !== 'CNY'))
    return {
      verdict: 'mismatch',
      reason: 'amount_mismatch',
      facts: { expectedMinor: receipt.amount, actualMinor: amount, currency: currency || null },
    }
  return { verdict: 'credited', reason: 'verified', facts: { amountMinor: amount, currency: currency || null } }
}
