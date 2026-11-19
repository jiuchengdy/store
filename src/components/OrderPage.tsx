'use client'
import Link from 'next/link'
import {
  App,
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Input,
  QRCode,
  Popconfirm,
  Result,
  Skeleton,
  Steps,
  Tag,
} from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSite } from './Providers'
import { api, ApiRequestError, channels, dateTime, money, orderStatusLabel } from '../lib'
import type { Order } from '../types'
export function OrderPage({ id }: { id: string }) {
  const { data } = useSite()
  return <OrderContent key={`${id}:${data?.user?.id ?? 'guest'}`} id={id} />
}

function RefillForm({ order, reload }: { order: Order; reload: () => Promise<void> }) {
  const [session, setSession] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit() {
    if (busy || !confirmed || !session.trim()) return
    setBusy(true)
    setError('')
    try {
      await api(`/orders/${order.id}/refill`, {
        round: order.refillCount ?? 0,
        confirmedNotReceived: confirmed,
        session,
      })
      setSession('')
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      await reload()
      setBusy(false)
    }
  }
  return (
    <div className="mt-24">
      <p>
        如果 {order.email}{' '}
        没有到账，可以在这笔订单上免费补充，无需再付款。如果不想继续，请联系支持办理退款。
      </p>
      <label className="session-recovery-label" htmlFor="refill-session">
        原充值账号的最新会话信息（Session）
      </label>
      <Input.TextArea
        id="refill-session"
        rows={6}
        autoComplete="off"
        disabled={busy}
        value={session}
        onChange={(event) => setSession(event.target.value)}
      />
      <p>
        <Checkbox
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
        >
          我已核对原账号，确认本单未到账，选择免费补充
        </Checkbox>
      </p>
      {error && <Alert type="error" showIcon title={error} />}
      <Button
        type="primary"
        loading={busy}
        disabled={!confirmed || !session.trim()}
        onClick={submit}
      >
        在原订单免费补充
      </Button>
    </div>
  )
}

function OrderContent({ id }: { id: string }) {
  const { data, openLogin } = useSite()
  const { message } = App.useApp()
  const [order, setOrder] = useState<Order | null>(null)
  const [error, setError] = useState('')
  const [payment, setPayment] = useState<{ demo?: boolean; paymentUrl?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState('')
  const requestVersion = useRef(0)
  const load = useCallback(async () => {
    const version = ++requestVersion.current
    try {
      const latest = await api<Order>(`/orders/${id}`)
      if (version !== requestVersion.current) return
      setOrder(latest)
      if (latest.status !== 'unpaid') setPayment(null)
      setError('')
    } catch (e) {
      if (version !== requestVersion.current) return
      if (e instanceof ApiRequestError && [401, 403, 404].includes(e.status)) {
        setOrder(null)
        setPayment(null)
        setSession('')
      }
      setError((e as Error).message)
    }
  }, [id])
  useEffect(() => {
    if (!data) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      await load()
      if (active) timer = setTimeout(() => void poll(), 8000)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
      requestVersion.current++
    }
  }, [data, load])
  async function pay() {
    setBusy(true)
    try {
      const result = await api<{ paid?: boolean; demo?: boolean; paymentUrl?: string }>(
        `/orders/${id}/pay`,
        {},
      )
      if (result.paid) {
        setPayment(null)
        await load()
      } else setPayment(result)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function demoPay() {
    setBusy(true)
    try {
      await api(`/orders/${id}/demo-pay`, {})
      await load()
      setPayment(null)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function resume() {
    setBusy(true)
    try {
      await api(`/orders/${id}/session`, { session })
      setSession('')
      await load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function cancel() {
    setBusy(true)
    try {
      await api(`/orders/${id}/cancel`, {})
      setPayment(null)
      await load()
      message.success('订单已取消，抵扣余额已退回')
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (error && !order)
    return (
      <main className="container page-content">
        <Alert type="error" title={error} action={<Button onClick={load}>重试</Button>} />
        {!data?.user && (
          <Button className="mt-24" onClick={() => openLogin(true)}>
            用联系邮箱登录查单
          </Button>
        )}
      </main>
    )
  if (!order)
    return (
      <main className="container page-content">
        <Skeleton active />
      </main>
    )
  const st = orderStatusLabel(order)
  const originalRefund = order.refund?.destination === 'original'
  const refundPending = order.refund && order.refund.status !== 'completed'
  const titles = {
    cancelled: '订单已取消，抵扣余额已退回。',
    unpaid: '订单已准备好，完成付款即可继续。',
    processing: order.refillCount
      ? '正在原订单免费补充，无需再付款。'
      : '已收到付款，正在为你充值。',
    completed: order.kind === 'topup' ? '充值余额已到账。' : '充值完成，开始使用吧。',
    needs_session: '需要更新账号信息，继续原订单。',
    failed: '这笔订单需要进一步处理。',
    refunded: originalRefund ? '已退回原支付方式。' : '订单金额已退回本站钱包。',
  }
  const safeUrl =
    payment?.paymentUrl && /^(https?:|alipays:|weixin:)/i.test(payment.paymentUrl)
      ? payment.paymentUrl
      : undefined
  return (
    <main className="container order-page">
      {error && (
        <Alert
          className="mb-24"
          type="warning"
          showIcon
          title="订单状态暂未更新"
          description="正在显示上次获取的状态。请重试或等待自动刷新，已填写的账号信息会保留。"
          action={<Button onClick={load}>重试</Button>}
        />
      )}
      {order.status === 'refunded' && (
        <p className="support-note">
          {originalRefund
            ? `渠道款 ${money(order.externalAmount)} 已按原支付方式退款，请核对原支付账户。${order.balanceAmount > 0 ? `原余额抵扣 ${money(order.balanceAmount)} 已退回站内钱包。` : ''}`
            : '退款已计入本站钱包，可用于本站消费。'}
          {(!originalRefund || order.balanceAmount > 0) && (
            <Link href="/wallet">查看钱包余额 →</Link>
          )}
        </p>
      )}
      <Link href="/account" className="text-link">
        ← 我的订单
      </Link>
      <div className="page-title">
        <Tag color={st.color}>{st.text}</Tag>
        <h1>{refundPending ? st.text : titles[order.status]}</h1>
        <p>订单 {order.id}</p>
      </div>
      {refundPending && (
        <Alert
          className="mb-24"
          showIcon
          type="info"
          title="退款正在处理"
          description="渠道退款结果仍在确认中，请保留原订单；确认完成后会更新退款状态。"
        />
      )}
      {!data?.user && (
        <Alert
          className="mb-24"
          type="info"
          showIcon
          title={`订单联系邮箱：${order.contactEmail}`}
          description="请保留此页面。在当前浏览器可直接查看进度；更换设备后，可用联系邮箱验证码登录查看订单。"
        />
      )}
      <div className="checkout-layout">
        <Card>
          {!['failed', 'refunded', 'cancelled'].includes(order.status) && (
            <Steps
              size="small"
              current={order.status === 'completed' ? 3 : order.status === 'unpaid' ? 0 : 1}
              status={order.status === 'needs_session' ? 'error' : 'process'}
              items={[
                { title: '完成付款' },
                {
                  title:
                    order.status === 'needs_session'
                      ? '等待更新账号'
                      : order.kind === 'topup'
                        ? '余额入账'
                        : '正在充值',
                },
                { title: '完成' },
              ]}
            />
          )}
          {order.status === 'unpaid' && (
            <div className="payment-area">
              <h2>应付 {money(order.externalAmount)}</h2>
              <p className="muted">已选择 {channels[order.channel]}</p>
              {(order.discountAmount ?? 0) > 0 && (
                <p className="muted">
                  原价 {money(order.listAmount ?? order.amount + (order.discountAmount ?? 0))} ·
                  优惠码 {order.couponCode || ''} 已减 {money(order.discountAmount ?? 0)}
                </p>
              )}
              {order.balanceAmount > 0 && (
                <p className="muted">
                  订单总价 {money(order.amount)}，已抵扣余额 {money(order.balanceAmount)}
                </p>
              )}
              {!payment ? (
                <Button type="primary" size="large" onClick={pay} loading={busy}>
                  获取支付信息
                </Button>
              ) : payment.demo ? (
                <>
                  <Alert showIcon type="info" title="演示付款，不会产生真实费用" />
                  <Button className="mt-24" type="primary" onClick={demoPay} loading={busy}>
                    模拟付款成功
                  </Button>
                </>
              ) : (
                <>
                  {payment.paymentUrl && <QRCode value={payment.paymentUrl} size={220} />}
                  <p>使用对应支付方式扫描二维码</p>
                  {safeUrl && (
                    <a
                      className="primary-link"
                      href={safeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      打开支付页面 ↗
                    </a>
                  )}
                  <Button className="mt-24" onClick={load}>
                    刷新付款状态
                  </Button>
                </>
              )}
              <Popconfirm
                title="取消订单并退回已抵扣余额？"
                description="仅未发起渠道支付的订单可取消。"
                okText="取消订单"
                cancelText="保留订单"
                onConfirm={cancel}
              >
                <Button type="text" disabled={busy}>
                  取消订单
                </Button>
              </Popconfirm>
              <p className="tiny muted">
                发起渠道支付后，如支付失败或状态不明，请联系支持核对，避免重复付款。
              </p>
            </div>
          )}
          {order.status === 'processing' && (
            <Result
              status="info"
              title="充值处理中"
              subTitle="此页面会自动刷新。无需再次付款，也可以稍后在订单列表查看。"
            />
          )}
          {order.status === 'completed' && (
            <Result
              status="success"
              title={order.kind === 'topup' ? '钱包余额已更新' : '已确认充值完成'}
              extra={
                <Link
                  className="primary-link"
                  href={order.kind === 'topup' ? '/wallet' : '/account'}
                >
                  返回{order.kind === 'topup' ? '钱包' : '订单列表'} →
                </Link>
              }
            />
          )}
          {order.status === 'needs_session' && (
            <div className="mt-32">
              <Alert type="warning" title={`请提供 ${order.email} 的最新会话信息`} />
              <label className="session-recovery-label" htmlFor="order-session">
                账号会话信息（Session）
              </label>
              <Input.TextArea
                id="order-session"
                rows={6}
                value={session}
                onChange={(e) => setSession(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="在此粘贴该账号最新的完整会话 JSON"
              />
              <p className="tiny muted mt-20">
                请使用原充值账号的信息，无需重新付款。
                <Link href="/guide" target="_blank">
                  查看账号信息获取说明 ↗
                </Link>
              </p>
              <Button type="primary" onClick={resume} loading={busy} className="mt-24">
                更新账号信息并继续
              </Button>
            </div>
          )}
          {order.status === 'processing' &&
            ['requires_action', 'uncertain'].includes(order.fulfillmentStatus || '') && (
              <Alert
                className="mt-24"
                type="warning"
                showIcon
                title={
                  order.fulfillmentStatus === 'requires_action'
                    ? '本次充值需要进一步处理'
                    : '正在核对本次充值结果'
                }
                description="请保留原订单并联系支持，不要重复下单或付款。"
              />
            )}
          {['failed', 'refunded', 'cancelled'].includes(order.status) && (
            <Result
              status={order.status === 'refunded' ? 'success' : refundPending ? 'info' : 'warning'}
              title={st.text}
              subTitle={
                order.status === 'refunded'
                  ? originalRefund
                    ? '请核对原支付账户及站内钱包的退款记录。'
                    : '退款已入账，可在本站钱包查看。'
                  : order.canRefill
                    ? '可核对原订单后继续充值，也可联系支持退款。'
                    : '请保留原订单号，联系支持核对处理结果。'
              }
            />
          )}
          {order.status === 'failed' && order.canRefill && !order.refund && (
            <RefillForm key={order.refillCount} order={order} reload={load} />
          )}
        </Card>
        <Card title="订单详情">
          <Descriptions
            column={1}
            items={[
              { key: 'p', label: '服务', children: order.productName },
              { key: 'e', label: '充值账号', children: order.email },
              { key: 'contact', label: '联系邮箱', children: order.contactEmail },
              ...(order.refillCount
                ? [
                    {
                      key: 'refills',
                      label: '免费补充',
                      children: `${order.refillCount} 次，未额外收费`,
                    },
                  ]
                : []),
              ...((order.discountAmount ?? 0) > 0
                ? [
                    {
                      key: 'list',
                      label: '套餐原价',
                      children: money(
                        order.listAmount ?? order.amount + (order.discountAmount ?? 0),
                      ),
                    },
                    {
                      key: 'discount',
                      label: '优惠减免',
                      children: (
                        <span className="coupon-saving-text">
                          −{money(order.discountAmount ?? 0)}
                          {order.couponCode ? `（${order.couponCode}）` : ''}
                        </span>
                      ),
                    },
                  ]
                : []),
              {
                key: 'm',
                label: (order.discountAmount ?? 0) > 0 ? '折后总价' : '金额',
                children: money(order.amount),
              },
              { key: 'balance', label: '余额抵扣', children: money(order.balanceAmount) },
              { key: 'external', label: '渠道金额', children: money(order.externalAmount) },
              { key: 't', label: '创建时间', children: dateTime(order.createdAt) },
            ]}
          />
          {data?.settings.supportEmail && (
            <p className="muted">
              需要帮助？
              <a href={`mailto:${data.settings.supportEmail}`}>{data.settings.supportEmail}</a>
            </p>
          )}
        </Card>
      </div>
    </main>
  )
}
