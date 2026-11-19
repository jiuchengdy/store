import type { Order, OrderStatus } from './types'
import { refundNeedsReview } from './refunds'

export const money = (minor: number) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(minor / 100)
export const dateTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
export const statuses: Record<OrderStatus, { text: string; color: string }> = {
  cancelled: { text: '已取消', color: 'default' },
  unpaid: { text: '待付款', color: 'default' },
  processing: { text: '充值中', color: 'processing' },
  completed: { text: '充值完成', color: 'success' },
  needs_session: { text: '需更新账号信息', color: 'warning' },
  failed: { text: '充值异常', color: 'error' },
  refunded: { text: '退款已完成', color: 'default' },
}
export function orderStatusLabel(order: Order) {
  if (order.refund?.status === 'review' && !order.refund.automatic)
    return { text: '手动退款处理中', color: 'processing' }
  if (order.refund && order.refund.status !== 'completed')
    return refundNeedsReview(order.refund)
      ? { text: '退款待核实', color: 'warning' }
      : { text: '退款处理中', color: 'processing' }
  if (order.status === 'refunded')
    return {
      text: order.refund?.destination === 'original' ? '已退款' : '已退回钱包',
      color: 'default',
    }
  return statuses[order.status]
}
export const channels = {
  alipay: '支付宝',
  wechat: '微信支付',
  crypto: '加密货币',
  balance: '账户余额',
}
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-GetGPT-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok)
    throw new ApiRequestError(result.error || '请求失败，请稍后重试', response.status)
  return result as T
}
export function parseSession(input: string): {
  user: { email: string }
  accessToken: string
  sessionToken: string
} {
  let data
  try {
    data = JSON.parse(input)
  } catch {
    throw new Error('这段信息不是完整的 JSON，请重新复制全部内容')
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !data.user ||
    typeof data.user.email !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.user.email)
  )
    throw new Error('缺少有效的账号邮箱，请复制完整信息')
  if (
    typeof data.accessToken !== 'string' ||
    !data.accessToken ||
    typeof data.sessionToken !== 'string' ||
    !data.sessionToken
  )
    throw new Error('账号信息不完整，需要 accessToken 和 sessionToken')
  if (new TextEncoder().encode(input).length > 100_000)
    throw new Error('账号信息过长，请检查复制内容')
  return data
}

export function demoSession(email = 'demo@example.com') {
  return JSON.stringify({ user: { email }, accessToken: 'demo', sessionToken: 'demo' }, null, 2)
}

export function normalizeDemoSession(input: string) {
  const session = parseSession(input)
  if (session.accessToken !== 'demo' || session.sessionToken !== 'demo')
    throw new Error('演示环境请使用示例 Session，不要填写真实登录凭证')
  // Do not transmit or retain any extra fields pasted into the demo form.
  return demoSession(session.user.email)
}
