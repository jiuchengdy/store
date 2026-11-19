'use client'
import { useEffect, useState } from 'react'
import { Alert, App, Button, Checkbox, Form, Input, Modal, Radio, Tag } from 'antd'
import type { AdminOrder } from '../types'
import { api, channels, dateTime, money, orderStatusLabel } from '../lib'
import { refundNeedsReview, supportsAutomaticRefund } from '../refunds'

const providers = {
  xorpay: 'XorPay',
  epay_v1: '易支付 v1',
  epay_v2: '易支付 v2',
  gmpay: 'GMPay',
  balance: '站内钱包',
}

export function RefundDialog({
  order,
  onClose,
  onRefresh,
}: {
  order: AdminOrder
  onClose: () => void
  onRefresh: () => Promise<void>
}) {
  const { message } = App.useApp()
  const [draftDestination, setDestination] = useState<'original' | 'wallet'>(
    order.refund?.destination ??
      (order.status === 'refunded' || order.externalAmount === 0 ? 'wallet' : 'original'),
  )
  const supported = supportsAutomaticRefund(order)
  const [automatic, setAutomatic] = useState(supported && !order.refund)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (order.refund?.status !== 'processing') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [order.refund?.status])
  const completed = order.status === 'refunded'
  const destination = order.refund?.destination ?? (completed ? 'wallet' : draftDestination)
  const started = !!order.refund
  const reconcile = !!order.refund && refundNeedsReview(order.refund, now)
  const waiting = started && !completed && !reconcile
  const original = destination === 'original'
  const auto = original && supported && automatic && !started
  const manual = original && !auto
  const reserveManual = manual && !started && !!order.canRefill
  const manualHold = order.refund?.status === 'review' && !order.refund.automatic
  const needsNote = (manual && !reserveManual) || reconcile
  const conflict = !!order.fulfillmentResolution?.conflict && !started
  const walletAmount = original ? order.balanceAmount : order.amount
  const needsOwner = walletAmount > 0 && !order.userId
  const status = orderStatusLabel(order)
  const submitText = reconcile
    ? '确认渠道已退款并登记'
    : reserveManual
      ? '先锁定手动退款'
      : manual
        ? '确认已退款并登记'
        : original
          ? `确认退款 ${money(order.amount)}`
          : `确认退回余额 ${money(order.amount)}`
  async function submit() {
    if (busy || waiting || completed || conflict || needsOwner || (needsNote && !note.trim()))
      return
    setBusy(true)
    setError('')
    try {
      const result = await api<{ refunded: boolean }>('/admin/orders/refund', {
        id: order.id,
        destination,
        automatic: auto,
        note,
        reconcile,
        reserveManual,
        round: order.refillCount ?? 0,
      })
      if (reserveManual) setNote('')
      await onRefresh()
      if (result.refunded) {
        message.success(original ? '已退回原支付方式，记录已保存' : '订单金额已退回站内余额')
        onClose()
      }
    } catch (e) {
      setError((e as Error).message)
      await onRefresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={completed ? '退款记录' : reconcile ? '核实原支付方式退款' : '处理退款'}
      open
      width={600}
      onCancel={busy ? undefined : onClose}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
      footer={
        <div className="refund-footer">
          <span className="muted">合计退款 {money(order.amount)}</span>
          <div className="refund-actions">
            <Button onClick={onClose} disabled={busy}>
              {completed ? '关闭' : '取消'}
            </Button>
            {!completed && (
              <Button
                type="primary"
                loading={busy}
                disabled={waiting || conflict || needsOwner || (needsNote && !note.trim())}
                onClick={submit}
              >
                {waiting ? '等待渠道退款结果' : submitText}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="refund-summary">
        <div>
          <strong>{order.productName}</strong>
          <Tag color={status.color}>{status.text}</Tag>
        </div>
        <span className="tiny muted mono">{order.id}</span>
        <span>{order.contactEmail}</span>
      </div>
      {error && <Alert className="mb-24" type="error" showIcon title={error} />}
      {order.fulfillmentResolution?.conflict && (
        <Alert
          className="mb-24"
          type="error"
          showIcon
          title="兑换结果存在冲突，请先查看人工处理记录"
          description="上游结果与人工结论不同，退款前需再次核对账号到账情况和上游记录。"
        />
      )}
      {started && !completed && (
        <Alert
          className="mb-24"
          type={reconcile ? 'warning' : 'info'}
          showIcon
          title={
            manualHold
              ? '手动退款已锁定，本单不能再补充'
              : reconcile
                ? '退款结果待核实，请勿重复打款'
                : '正在确认渠道退款结果'
          }
          description={
            manualHold
              ? `请由 ${order.refundRecord?.actor ?? '原处理人'} 核对渠道流水后打款，其他人不要重复操作。确认渠道款已退回后，填写退款单号或转账凭证并登记。`
              : reconcile
                ? '先在 XorPay 后台核对。已退款则登记结果；确认未退款后才可手动处理。全额退回渠道款后，填写备注完成登记。'
                : '请保留原订单。渠道确认成功后退回原抵扣余额；结果不明确时转为人工核实。'
          }
        />
      )}
      <Form layout="vertical" onFinish={submit}>
        <Form.Item label="退款去向">
          <Radio.Group
            aria-label="退款去向"
            className="refund-destinations"
            value={destination}
            disabled={busy || started || completed}
            onChange={(e) => {
              setDestination(e.target.value)
              setError('')
            }}
          >
            <Radio
              value="original"
              disabled={busy || started || completed || order.externalAmount === 0}
            >
              <strong>退回原支付方式</strong>
              <span className="refund-choice-help">
                {order.externalAmount > 0
                  ? order.channel === 'crypto'
                    ? '加密货币由支持人员人工转回同一链、同一地址，按实收数量原数退回；完成时须登记币种、数量、链与 txid'
                    : '渠道款退回原支付方式，余额抵扣退钱包'
                  : '纯余额订单无渠道款可退'}
              </span>
            </Radio>
            <Radio value="wallet" disabled={busy || started || completed || !order.userId}>
              <strong>退回站内余额</strong>
              <span className="refund-choice-help">
                {order.userId ? '全额退至站内钱包，仅用于本站消费' : '需先用联系邮箱登录认领订单'}
              </span>
            </Radio>
          </Radio.Group>
        </Form.Item>
        <div className="refund-breakdown">
          {original && (
            <div>
              <span>
                {channels[order.channel]} · {providers[order.provider]}
              </span>
              <strong>{money(order.externalAmount)}</strong>
            </div>
          )}
          {walletAmount > 0 && (
            <div>
              <span>{original ? '站内钱包 · 原余额抵扣' : '站内钱包'}</span>
              <strong>{money(walletAmount)}</strong>
            </div>
          )}
          {original && order.channel === 'crypto' && (
            <p className="muted">
              渠道金额以人民币记账。请按原支付记录核对币种、网络和实际退款数量，并确认收款地址；在备注中记录转账详情和交易哈希。
            </p>
          )}
        </div>
        {needsOwner && (
          <Alert
            className="mb-24"
            type="warning"
            showIcon
            title="请联系用户先用联系邮箱登录认领订单，以接收钱包退款。"
          />
        )}
        {original && !completed && (
          <Form.Item
            extra={
              reserveManual
                ? '此订单可免费补充。先在本站锁定手动退款，收到锁定确认后再去支付渠道操作。'
                : manualHold
                  ? '本单已锁定手动退款，请勿重复打款。'
                  : !supported
                    ? '此渠道不支持自动退款，请先手动退款，再填写备注登记。'
                    : started
                      ? '原退款已经发起，不能再次自动退款。'
                      : auto
                        ? '提交后由 XorPay 完成渠道退款，成功后退回原抵扣余额。'
                        : '请先在支付渠道完成退款，再填写备注登记。'
            }
          >
            <Checkbox
              checked={supported && (order.refund?.automatic ?? automatic)}
              disabled={!supported || started || busy}
              onChange={(e) => setAutomatic(e.target.checked)}
            >
              自动完成退款
            </Checkbox>
          </Form.Item>
        )}
        {order.refundRecord && (
          <div className="refund-record">
            <p>
              处理方式：
              {order.refund?.automatic
                ? 'XorPay 自动退款'
                : original
                  ? '手动退款登记'
                  : '退回站内余额'}
            </p>
            <p>
              操作人：{order.refundRecord.actor} · {dateTime(order.refund!.requestedAt)}
            </p>
            {order.refundRecord.note && (
              <p className="refund-note">退款备注：{order.refundRecord.note}</p>
            )}
            {order.refundRecord.resolutionNote && (
              <p className="refund-note">核实备注：{order.refundRecord.resolutionNote}</p>
            )}
            {order.refundRecord.resolvedBy && <p>核实人：{order.refundRecord.resolvedBy}</p>}
            {order.refund?.completedAt && <p>完成时间：{dateTime(order.refund.completedAt)}</p>}
          </div>
        )}
        {!completed && !waiting && (
          <Form.Item
            htmlFor="refund-note"
            label={reconcile ? '核实备注' : '退款备注'}
            required={needsNote}
            extra={
              needsNote
                ? '手动处理必须填写备注；备注仅后台可见，与操作人、退款方式一同保留。'
                : '备注仅后台可见，与操作人、退款方式一同保留。'
            }
          >
            <Input.TextArea
              id="refund-note"
              aria-label={reconcile ? '核实备注' : '退款备注'}
              aria-required={needsNote}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              maxLength={1000}
              showCount
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder={
                needsNote
                  ? order.channel === 'crypto'
                    ? '例如：已退回 8.50 USDT，TRC20，收款地址…，交易哈希…'
                    : '例如：已在渠道后台退回全额渠道款，退款时间…，退款单号…'
                  : '选填，例如：上游确认充值失败，按所选方式全额退款'
              }
            />
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}
