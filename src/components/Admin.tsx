'use client'
import Link from 'next/link'
import { authClient, authResult } from '../auth-client'
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  App,
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Menu,
  Modal,
  Popconfirm,
  Result,
  Select,
  Skeleton,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
} from 'antd'
import {
  DashboardOutlined,
  ShoppingOutlined,
  UnorderedListOutlined,
  TeamOutlined,
  GiftOutlined,
  WalletOutlined,
  SettingOutlined,
  SafetyCertificateOutlined,
  DatabaseOutlined,
  ArrowLeftOutlined,
  PlusOutlined,
  ReloadOutlined,
  MenuOutlined,
  LogoutOutlined,
  FileSearchOutlined,
  TagOutlined,
} from '@ant-design/icons'
import { Brand } from './Site'
import { UserAvatar } from './UserAvatar'
import { WithdrawalEstimate } from './WithdrawalEstimate'
import { RefundDialog } from './RefundDialog'
import { OrderResolutionDialog } from './OrderResolutionDialog'
import { canResolveOrder } from '../order-resolution'
import { InventoryImportDialog } from './InventoryImportDialog'
import { InventoryManager } from './InventoryManager'
import { StockProcurement } from './StockProcurement'
import { CouponManager } from './CouponManager'
import { ReferralTierEditor } from './ReferralTierEditor'
import { useSite } from './Providers'
import { api, channels, dateTime, money, orderStatusLabel } from '../lib'
import { refundNeedsReview } from '../refunds'
import { defaultPaymentLimits, roundingOptions } from '../pricing'
import type {
  AdminData,
  AdminOrder,
  Order,
  Product,
  User,
  Withdrawal,
  WithdrawalChannels,
} from '../types'
import { riskReasonLabels, riskSceneLabels } from '../risk-labels'
import type { IntegrationView, IntegrationKind } from '../server/integrations/config'
import { funnelLabels, sourceLabels } from '../funnel'
import { defaultReferralTiers, withdrawalStatuses } from '../referral'
import {
  withdrawalChannels,
  withdrawalDestinations,
  withdrawalFee,
  usdtNetworkLabels,
} from '../withdrawals'

type Role = { id: string; name: string; permissions: string[]; protected: boolean }
type Data = AdminData & { integrations: IntegrationView[]; roles: Role[] }
const pages = [
  { key: 'overview', label: '运营概览', icon: <DashboardOutlined /> },
  { key: 'orders', label: '订单管理', icon: <UnorderedListOutlined /> },
  { key: 'products', label: '商品管理', icon: <ShoppingOutlined /> },
  { key: 'coupons', label: '优惠码管理', icon: <TagOutlined /> },
  { key: 'inventory', label: '兑换码管理', icon: <DatabaseOutlined /> },
  { key: 'batches', label: '导入批次', icon: <DatabaseOutlined /> },
  { key: 'users', label: '用户管理', icon: <TeamOutlined /> },
  { key: 'wallet', label: '用户钱包', icon: <WalletOutlined /> },
  { key: 'referral', label: '邀请与返现', icon: <GiftOutlined /> },
  { key: 'withdrawals', label: '提现审核', icon: <SafetyCertificateOutlined /> },
  { key: 'integrations', label: '支付与服务', icon: <DatabaseOutlined /> },
  { key: 'settings', label: '网站设置', icon: <SettingOutlined /> },
  { key: 'roles', label: '角色与权限', icon: <SafetyCertificateOutlined /> },
  { key: 'audit', label: '操作日志', icon: <FileSearchOutlined /> },
  { key: 'risk', label: '风控记录', icon: <SafetyCertificateOutlined /> },
]
const navigationGroups = [
  {
    key: 'commerce',
    label: '商品与兑换',
    icon: <ShoppingOutlined />,
    pages: ['products', 'coupons', 'inventory', 'batches', 'orders'],
  },
  {
    key: 'funds',
    label: '资金与返现',
    icon: <WalletOutlined />,
    pages: ['wallet', 'referral', 'withdrawals'],
  },
  { key: 'access', label: '用户与权限', icon: <TeamOutlined />, pages: ['users', 'roles'] },
  {
    key: 'system',
    label: '系统管理',
    icon: <SettingOutlined />,
    pages: ['integrations', 'settings', 'audit', 'risk'],
  },
]
const providerNames: Record<IntegrationKind, string> = {
  xorpay: 'XorPay',
  gmpay: 'GMPay',
  epay_v1: '易支付 v1',
  epay_v2: '易支付 v2',
  aicdk: 'AICDK 兑换服务',
  'dujiao-next': 'Dujiao-Next 进货',
  smtp: 'SMTP 邮件',
  resend: 'Resend 邮件',
  sendflare: 'Sendflare 邮件',
  turnstile: 'Cloudflare Turnstile',
}
const providerDetails: Record<IntegrationKind, { icon: string; description: string }> = {
  xorpay: { icon: 'X', description: '支付宝和微信收款。' },
  gmpay: { icon: '₮', description: '加密货币收款。' },
  epay_v1: { icon: '易', description: '支付宝和微信收款。当前协议 v1（MD5）。' },
  epay_v2: { icon: '易', description: '支付宝和微信收款。当前协议 v2（RSA-SHA256）。' },
  aicdk: { icon: 'A', description: '账号检查与充值。订单进度由 worker 主动查询。' },
  'dujiao-next': { icon: 'D', description: '连接 getcodex.plus，按上游 SKU 采购充值码。' },
  smtp: { icon: '@', description: '发送登录验证码和订单通知。' },
  resend: { icon: '@', description: '发送登录验证码和订单通知。' },
  sendflare: { icon: '@', description: '发送登录验证码和订单通知。' },
  turnstile: { icon: '盾', description: '可选安全验证，覆盖登录、验证码发送与购买。' },
}
const publicFields: Record<IntegrationKind, [string, string, string][]> = {
  xorpay: [['appId', 'App ID', '商户应用 ID']],
  gmpay: [
    ['url', '网关地址', 'https://pay.example.com'],
    ['pid', '商户 PID', '数字商户号'],
  ],
  epay_v1: [
    ['url', '网关地址', 'https://pay.example.com'],
    ['pid', '商户 PID', '商户号'],
  ],
  epay_v2: [
    ['url', '网关地址', 'https://pay.example.com'],
    ['pid', '商户 PID', '商户号'],
  ],
  aicdk: [['url', 'AICDK 地址', 'http://aicdk:8080']],
  'dujiao-next': [['url', '上游站点地址', 'https://getcodex.plus']],
  smtp: [
    ['host', 'SMTP 主机', 'smtp.example.com'],
    ['port', 'SMTP 端口', '465'],
    ['user', 'SMTP 用户名', '账号'],
    ['from', '发件地址', 'GetCodex Plus <hello@example.com>'],
  ],
  resend: [['from', '发件地址', 'GetCodex Plus <hello@example.com>']],
  sendflare: [['from', '发件地址', 'hello@example.com']],
  turnstile: [['siteKey', 'Site Key', 'Cloudflare 站点密钥']],
}
const secretFields: Record<IntegrationKind, [string, string][]> = {
  xorpay: [['secret', 'App Secret']],
  gmpay: [['secret', 'API Secret']],
  epay_v1: [['key', '商户密钥（MD5）']],
  epay_v2: [
    ['privateKey', '商户私钥（PEM）'],
    ['publicKey', '平台公钥（PEM）'],
  ],
  aicdk: [['apiKey', '开放 API Key']],
  'dujiao-next': [
    ['apiKey', 'API Key'],
    ['apiSecret', 'API Secret'],
  ],
  smtp: [['password', 'SMTP 密码 / 授权码']],
  resend: [['apiKey', 'Resend API Key']],
  sendflare: [['apiKey', 'Sendflare API Key']],
  turnstile: [['secret', 'Secret Key']],
}

export function Admin() {
  const { data } = useSite()
  const identity = `${data?.user?.id ?? 'guest'}:${data?.user?.permissions.slice().sort().join(',') ?? ''}`
  return <AdminContent key={identity} />
}

function AdminContent() {
  const { data: site, openLogin, refresh } = useSite()
  const { message } = App.useApp()
  const [data, setData] = useState<Data | null>(null)
  const [page, setPage] = useState('overview')
  const [openGroups, setOpenGroups] = useState<string[]>(['commerce'])
  const [refreshKey, setRefreshKey] = useState(0)
  const [batchFilter, setBatchFilter] = useState<{ id: string; name: string } | null>(null)
  const [mobile, setMobile] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [listPage, setListPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const requestVersion = useRef(0)
  const settingsDirty = useRef(false)
  const [busy, setBusy] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [userForm] = Form.useForm()
  const [editProduct, setEditProduct] = useState<Product | null>(null)
  const [productOpen, setProductOpen] = useState(false)
  const [stockOpen, setStockOpen] = useState(false)
  const [couponCreateSignal, setCouponCreateSignal] = useState(0)
  const [editIntegration, setEditIntegration] = useState<IntegrationKind | null>(null)
  const [withdrawal, setWithdrawal] = useState<Withdrawal | null>(null)
  const [refundOrderId, setRefundOrderId] = useState<string | null>(null)
  const [resolutionOrderId, setResolutionOrderId] = useState<string | null>(null)
  const [refillOrderId, setRefillOrderId] = useState<string | null>(null)
  const [roleOpen, setRoleOpen] = useState(false)
  const [roleForm] = Form.useForm()
  const [productForm] = Form.useForm(),
    [integrationForm] = Form.useForm(),
    [settingsForm] = Form.useForm(),
    [withdrawalForm] = Form.useForm()
  const productCurrency = Form.useWatch('priceCurrency', productForm)
  const usdtWithdrawalEnabled = Form.useWatch(['withdrawalChannels', 'usdt'], settingsForm)
  const withdrawalResult = Form.useWatch('status', withdrawalForm)
  const epayVersion: 'epay_v1' | 'epay_v2' =
    data?.settings.epayVersion ??
    (data?.settings.fiatProvider === 'epay_v2'
      ? 'epay_v2'
      : data?.settings.fiatProvider === 'epay_v1'
        ? 'epay_v1'
        : ((data?.integrations
            .filter((i) => i.provider.startsWith('epay_'))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.provider as
            'epay_v1' | 'epay_v2') ?? 'epay_v1'))
  const recordSection = [
    'orders',
    'coupons',
    'wallet',
    'users',
    'referral',
    'withdrawals',
    'audit',
    'risk',
  ].includes(page)
    ? page
    : page === 'roles' && site?.user?.permissions.includes('users:read')
      ? 'roles'
      : 'overview'
  const load = useCallback(async () => {
    const version = ++requestVersion.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ section: recordSection, page: String(listPage), search })
      const result = await api<Data>(`/admin?${params}`)
      if (version !== requestVersion.current) return
      setData(result)
      setRefreshKey((value) => value + 1)
      setError('')
    } catch (e) {
      if (version === requestVersion.current) setError((e as Error).message)
    } finally {
      if (version === requestVersion.current) setLoading(false)
    }
  }, [recordSection, listPage, search])
  useEffect(() => {
    if (!site?.user?.permissions.includes('admin:access')) return
    setLoading(true)
    const timer = setTimeout(() => void load(), 200)
    return () => {
      clearTimeout(timer)
      requestVersion.current++
    }
  }, [site?.user, load])
  const pendingRefund = data?.orders.some((order) => order.refund?.status === 'processing')
  useEffect(() => {
    if (!pendingRefund) return
    const timer = setInterval(() => void load(), 8000)
    return () => clearInterval(timer)
  }, [pendingRefund, load])
  useEffect(() => {
    if (data && page === 'settings' && !settingsDirty.current)
      settingsForm.setFieldsValue({
        ...data.settings,
        withdrawalChannels: withdrawalChannels(data.settings),
        fiatProvider: data.settings.fiatProvider.startsWith('epay_') ? 'epay' : 'xorpay',
        tierRules: (data.settings.referralTiers ?? defaultReferralTiers).map((tier) => ({
          ...tier,
          ratePercent: tier.rateBps / 100,
        })),
        withdrawalRules: Object.fromEntries(
          Object.entries(withdrawalChannels(data.settings).rules).map(([key, rule]) => [
            key,
            {
              minimumYuan: rule.minimum / 100,
              feePercent: rule.feeRateBps / 100,
              fixedYuan: rule.fixedFee / 100,
            },
          ]),
        ),
        channelLimits: Object.fromEntries(
          ['alipay', 'wechat', 'crypto'].map((channel) => {
            const limit =
              data.settings.paymentLimits?.[channel as 'alipay'] ??
              defaultPaymentLimits[channel as keyof typeof defaultPaymentLimits]
            return [channel, { min: limit.min / 100, max: limit.max / 100 }]
          }),
        ),
      })
  }, [data, settingsForm, page])
  async function mutate(path: string, body: unknown, done?: () => void) {
    setBusy(true)
    try {
      await api(`/admin/${path}`, body)
      if (path === 'settings') settingsDirty.current = false
      await load()
      await refresh()
      message.success('已保存')
      done?.()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function openProduct(product?: Product) {
    setEditProduct(product || null)
    productForm.resetFields()
    productForm.setFieldsValue({
      enabled: true,
      featured: false,
      upgrade: false,
      plan: 'plus',
      pricingMode: 'fixed',
      ...product,
      priceYuan: (product?.price ?? 100) / 100,
      priceCurrency: product?.priceCurrency ?? 'CNY',
      roundingStep: product?.roundingStep ?? 100,
      featureText: product?.features.join('\n') ?? '',
    })
    setProductOpen(true)
  }
  function openIntegration(provider: IntegrationKind) {
    const shared =
      editIntegration?.startsWith('epay_') && provider.startsWith('epay_')
        ? integrationForm.getFieldValue('public')
        : undefined
    integrationForm.resetFields()
    const current = data?.integrations.find((i) => i.provider === provider)
    integrationForm.setFieldsValue({
      enabled: current?.enabled ?? false,
      public:
        current?.public ??
        shared ??
        (provider === 'dujiao-next' ? { url: 'https://getcodex.plus' } : {}),
      secrets: {},
    })
    setEditIntegration(provider)
  }
  const can = (permission: string) => site?.user?.permissions.includes(permission) ?? false
  const allowedPages = pages.filter(
    (p) =>
      p.key === 'overview' ||
      can(
        `${['inventory', 'batches'].includes(p.key) ? 'products' : p.key === 'risk' ? 'audit' : p.key}:read`,
      ),
  )
  const activeGroup = navigationGroups.find((group) => group.pages.includes(page))
  const navigate = useCallback((key: string) => {
    setPage(key)
    setSearch('')
    setListPage(1)
    setMobile(false)
    const group = navigationGroups.find((group) => group.pages.includes(key))
    if (group) setOpenGroups((current) => [...new Set([...current, group.key])])
    window.history.pushState(null, '', `#${key}`)
  }, [])
  useEffect(() => {
    const restore = () => {
      const key = window.location.hash.slice(1)
      const target = pages.find((item) => item.key === key)
      const resource = ['inventory', 'batches'].includes(key)
        ? 'products'
        : key === 'risk'
          ? 'audit'
          : key
      const permitted = key === 'overview' || site?.user?.permissions.includes(`${resource}:read`)
      setPage(target && permitted ? key : 'overview')
      setSearch('')
      setListPage(1)
      const group = navigationGroups.find((group) => group.pages.includes(key))
      if (group && permitted) setOpenGroups((current) => [...new Set([...current, group.key])])
    }
    restore()
    window.addEventListener('hashchange', restore)
    window.addEventListener('popstate', restore)
    return () => {
      window.removeEventListener('hashchange', restore)
      window.removeEventListener('popstate', restore)
    }
  }, [site?.user])
  const menuItems = [
    ...allowedPages.filter((item) => item.key === 'overview'),
    ...navigationGroups
      .map((group) => ({
        key: group.key,
        label: group.label,
        icon: group.icon,
        children: group.pages.flatMap((key) =>
          allowedPages.filter((item) => item.key === key).map(({ icon: _icon, ...item }) => item),
        ),
      }))
      .filter((group) => group.children.length),
  ]
  const nav = (
    <>
      <Brand />
      <div className="admin-workspace">
        <span>工作空间</span>
        <strong>GetCodex Plus 控制台</strong>
      </div>
      <Menu
        theme="light"
        mode="inline"
        style={{ borderInlineEnd: 'none' }}
        selectedKeys={[page]}
        openKeys={openGroups}
        onOpenChange={setOpenGroups}
        items={menuItems}
        onClick={(e) => {
          setBatchFilter(null)
          navigate(e.key)
        }}
      />
      <div className="admin-sidebar-footer">
        <Link href="/">
          <ArrowLeftOutlined /> 返回网站
        </Link>
        <span>服务管理 · 交易运营</span>
      </div>
    </>
  )
  if (!site)
    return (
      <main className="container page-content">
        <Skeleton active />
      </main>
    )
  if (!site.user)
    return (
      <main className="container page-content">
        <Result
          icon={<SafetyCertificateOutlined />}
          title="登录管理后台"
          subTitle="使用管理员邮箱登录。"
          extra={
            <Button type="primary" onClick={() => openLogin(true)}>
              管理员登录
            </Button>
          }
        />
      </main>
    )
  if (!can('admin:access'))
    return <Result status="403" title="无权访问管理后台" extra={<Link href="/">返回网站</Link>} />
  const pendingCount = data?.pendingWithdrawalCount ?? 0
  const email = (id: string) => data?.users.find((u) => u.id === id)?.email || id
  const referralTiers = data?.settings.referralTiers ?? defaultReferralTiers
  const pagination = {
    current: listPage,
    pageSize: data?.pagination?.pageSize ?? 12,
    total: data?.pagination?.total ?? 0,
    showSizeChanger: false,
    showTotal: (total: number) => `共 ${total} 条`,
    onChange: setListPage,
  }
  const updateSearch = (value: string) => {
    setSearch(value)
    setListPage(1)
  }
  const orderColumns = [
    {
      title: '订单',
      width: 210,
      dataIndex: 'productName',
      render: (_: unknown, o: Order) => (
        <div>
          <strong>{o.productName}</strong>
          <div className="tiny muted mono admin-record-id">{o.id}</div>
        </div>
      ),
    },
    { title: '充值账号', dataIndex: 'email', width: 230, ellipsis: true },
    {
      title: '下单 IP',
      dataIndex: 'ipAddress',
      width: 190,
      render: (value: string | null) => (
        <span className="mono wrap-anywhere">{value || '未记录'}</span>
      ),
    },
    {
      title: '订单金额',
      dataIndex: 'amount',
      width: 150,
      render: (amount: number, o: Order) => (
        <div>
          <div>{money(amount)}</div>
          {(o.discountAmount ?? 0) > 0 && (
            <div className="tiny muted">
              <del>{money(o.listAmount ?? amount + (o.discountAmount ?? 0))}</del> · -
              {money(o.discountAmount ?? 0)}
              {o.couponCode ? ` (${o.couponCode})` : ''}
            </div>
          )}
        </div>
      ),
    },
    { title: '余额抵扣', dataIndex: 'balanceAmount', width: 110, render: money },
    { title: '渠道金额', dataIndex: 'externalAmount', width: 110, render: money },
    {
      title: '支付方式',
      dataIndex: 'channel',
      width: 110,
      render: (v: Order['channel']) => channels[v],
    },
    {
      title: '状态',
      width: 120,
      dataIndex: 'status',
      render: (_: Order['status'], order: AdminOrder) => {
        const status = orderStatusLabel(order)
        return (
          <Space orientation="vertical" size={4}>
            <Tag color={status.color}>{status.text}</Tag>
            {order.fulfillmentResolution && (
              <Tag color={order.fulfillmentResolution.conflict ? 'error' : 'default'}>
                {order.fulfillmentResolution.conflict ? '结果冲突待核对' : '人工确认'}
              </Tag>
            )}
          </Space>
        )
      },
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 130, render: dateTime },
    {
      title: '操作',
      width: 220,
      key: 'action',
      render: (_: unknown, o: AdminOrder) => (
        <Space wrap size={0}>
          {o.status === 'refunded' ? (
            <Button type="link" onClick={() => setRefundOrderId(o.id)}>
              退款记录
            </Button>
          ) : !can('orders:write') ? (
            <span className="muted">只读</span>
          ) : o.status === 'processing' ? (
            <Button type="link" onClick={() => mutate('orders/retry', { id: o.id })}>
              重新同步
            </Button>
          ) : o.status === 'failed' && o.kind === 'purchase' ? (
            <Button type="link" onClick={() => setRefundOrderId(o.id)}>
              {o.refund ? (refundNeedsReview(o.refund) ? '核实退款' : '查看退款进度') : '处理退款'}
            </Button>
          ) : !o.fulfillmentResolution && !canResolveOrder(o) ? (
            <span className="muted">—</span>
          ) : null}
          {(o.fulfillmentResolution || (can('orders:write') && canResolveOrder(o))) && (
            <Button type="link" onClick={() => setResolutionOrderId(o.id)}>
              {o.fulfillmentResolution ? '处理记录' : '人工处理'}
            </Button>
          )}
          {!!o.refillCount && (
            <Button type="link" onClick={() => setRefillOrderId(o.id)}>
              补充记录（{o.refillCount}）
            </Button>
          )}
        </Space>
      ),
    },
  ]
  return (
    <div className="admin-shell">
      {refillOrderId && (
        <Modal open title="原单免费补充记录" footer={null} onCancel={() => setRefillOrderId(null)}>
          <p>订单号：{refillOrderId}</p>
          {data?.orders
            .find((order) => order.id === refillOrderId)
            ?.refillHistory?.map((entry, index) => (
              <div className="refund-record" key={entry.requestId}>
                <strong>
                  第 {index + 1} 次免费补充 · {dateTime(entry.createdAt)}
                </strong>
                <p>
                  上一笔兑换：
                  {entry.outcome === 'not_submitted'
                    ? '未提交'
                    : entry.outcome === 'cancelled'
                      ? '已取消'
                      : '已失败'}
                  {entry.redemptionId && `（${entry.redemptionId}）`}
                </p>
                <p>
                  原卡：
                  {entry.disposition === 'held'
                    ? '保持锁定，需核对'
                    : entry.disposition === 'returned'
                      ? '已核实可用，退回库存'
                      : '已核实可用，继续用于本单'}
                  （{entry.inventoryId}）
                </p>
                {entry.resolution && (
                  <p className="refund-note">
                    原人工结论：{entry.resolution.actor} · {entry.resolution.note}
                  </p>
                )}
              </div>
            ))}
        </Modal>
      )}
      {resolutionOrderId && data?.orders.find((order) => order.id === resolutionOrderId) && (
        <OrderResolutionDialog
          key={resolutionOrderId}
          order={data.orders.find((order) => order.id === resolutionOrderId)!}
          canWrite={can('orders:write')}
          onClose={() => setResolutionOrderId(null)}
          onRefresh={async () => {
            await load()
            await refresh()
          }}
        />
      )}
      {refundOrderId &&
        data?.orders.some(
          (order) => order.id === refundOrderId && ['failed', 'refunded'].includes(order.status),
        ) && (
          <RefundDialog
            key={refundOrderId}
            order={data.orders.find((order) => order.id === refundOrderId)!}
            onClose={() => setRefundOrderId(null)}
            onRefresh={async () => {
              await load()
              await refresh()
            }}
          />
        )}
      <aside className="admin-sidebar">{nav}</aside>
      <Drawer
        open={mobile}
        onClose={() => setMobile(false)}
        placement="left"
        size={250}
        rootClassName="admin-navigation-drawer"
        styles={{ body: { padding: 0, background: 'var(--surface)' } }}
      >
        <div className="admin-mobile-navigation">{nav}</div>
      </Drawer>
      <div className="admin-main">
        <header className="admin-topbar">
          <div>
            <Button
              className="mobile-menu"
              icon={<MenuOutlined />}
              onClick={() => setMobile(true)}
              aria-label="打开导航"
            />
            <span className="muted">{activeGroup?.label ?? '工作空间'}</span>
            <span className="crumb-slash">/</span>
            <strong>{pages.find((p) => p.key === page)?.label}</strong>
          </div>
          <Space>
            <Tag color={site.mode === 'demo' ? 'warning' : 'default'}>
              {site.mode === 'demo' ? '本地演示' : '正式环境'}
            </Tag>
            <UserAvatar user={site.user} />
            <span className="admin-email">{site.user.email}</span>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              aria-label="退出登录"
              onClick={async () => {
                authResult(await authClient.signOut())
                await refresh()
              }}
            />
          </Space>
        </header>
        <div className="admin-content">
          <div className="admin-heading">
            <div>
              <h1>{pages.find((p) => p.key === page)?.label}</h1>
              <p>
                {page === 'overview'
                  ? '看看网站的经营情况，以及需要处理的事情。'
                  : page === 'coupons'
                    ? '管理立减与折扣优惠码、推广员专属券、名额锁与分享链接。'
                    : page === 'batches'
                      ? '各批次独立启用或停用，可同时供货；已有订单保留原库存关系。'
                      : page === 'inventory'
                        ? '按商品和批次管理兑换码；已占用或已使用的码保留原订单关系。'
                        : page === 'integrations'
                          ? '集中管理收款渠道、兑换服务和邮件服务。'
                          : '管理记录与配置，所有关键操作均保留审计记录。'}
              </p>
            </div>
            <Space>
              <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
                刷新
              </Button>
              {page === 'products' && can('products:write') && (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => openProduct()}>
                  新增商品
                </Button>
              )}
              {page === 'coupons' && can('coupons:write') && (
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setCouponCreateSignal((v) => v + 1)}
                >
                  新增优惠码
                </Button>
              )}
              {['inventory', 'batches'].includes(page) && can('products:write') && (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setStockOpen(true)}>
                  导入兑换库存
                </Button>
              )}
            </Space>
          </div>
          {error && (
            <Alert
              type="error"
              title={error}
              description="请重试；若登录已过期，请重新登录后继续。"
              action={
                <Button onClick={load} loading={loading}>
                  重试
                </Button>
              }
              className="mb-24"
            />
          )}
          {site.mode === 'demo' && (
            <Alert
              className="mb-24"
              type="info"
              showIcon
              title="当前为本地演示环境"
              description="订单、钱包与返现用于功能验证。支付渠道即使已配置，也不会被用于真实扣款。"
            />
          )}
          {!['integrations', 'settings'].includes(page) && (
            <p className="admin-table-hint muted">表格可横向滚动，查看更多信息与操作。</p>
          )}
          {!data ? (
            <Skeleton active />
          ) : (
            <>
              {page === 'overview' && (
                <>
                  <div className="admin-stats">
                    <Card>
                      <div className="stat-icon">
                        <WalletOutlined />
                      </div>
                      <Statistic
                        title="套餐成交金额"
                        value={
                          data.overview?.purchaseAmount === undefined
                            ? '—'
                            : data.overview.purchaseAmount / 100
                        }
                        precision={2}
                        prefix="¥"
                      />
                      <span className="tiny muted">全部已付款套餐 · 不含钱包充值与已退款订单</span>
                    </Card>
                    <Card>
                      <div className="stat-icon">
                        <ShoppingOutlined />
                      </div>
                      <Statistic
                        title="成功交付"
                        value={data.overview?.completedPurchaseCount ?? '—'}
                        suffix="笔"
                      />
                      <span className="tiny muted">仅计充值完成的套餐订单</span>
                    </Card>
                    <Card>
                      <div className="stat-icon">
                        <TeamOutlined />
                      </div>
                      <Statistic title="用户数" value={data.overview?.userCount ?? '—'} />
                      <span className="tiny muted">全部注册用户</span>
                    </Card>
                    <Card>
                      <div className="stat-icon amber">
                        <SafetyCertificateOutlined />
                      </div>
                      <Statistic title="待处理提现" value={pendingCount} suffix="笔" />
                      <Button
                        type="link"
                        size="small"
                        disabled={!can('withdrawals:read')}
                        onClick={() => navigate('withdrawals')}
                      >
                        去处理 →
                      </Button>
                    </Card>
                  </div>
                  <div className="admin-overview-grid">
                    <Card
                      title="近 7 天套餐成交"
                      extra={<span className="tiny muted">按订单创建日期 · UTC</span>}
                    >
                      {data.overview?.dailyRevenue ? (
                        <RevenueChart days={data.overview.dailyRevenue} />
                      ) : (
                        <Empty
                          description={
                            can('orders:read') ? '正在加载统计' : '当前角色无订单统计权限'
                          }
                        />
                      )}
                    </Card>
                    <Card title="需要关注">
                      <div className="attention-row">
                        <span>
                          <i className="status-dot" /> 待处理提现
                        </span>
                        <strong>{pendingCount}</strong>
                        <Button
                          type="text"
                          aria-label="查看待处理提现"
                          disabled={!can('withdrawals:read')}
                          onClick={() => navigate('withdrawals')}
                        >
                          →
                        </Button>
                      </div>
                      <div className="attention-row">
                        <span>
                          <i className="status-dot amber" /> 充值异常
                        </span>
                        <strong>{data.overview?.attentionOrderCount ?? '—'}</strong>
                        <Button
                          type="text"
                          aria-label="查看异常订单"
                          disabled={!can('orders:read')}
                          onClick={() => navigate('orders')}
                        >
                          →
                        </Button>
                      </div>
                      <div className="attention-row">
                        <span>启用的收款渠道</span>
                        <strong>
                          {
                            data.integrations.filter(
                              (i) =>
                                i.enabled && ['xorpay', 'gmpay', epayVersion].includes(i.provider),
                            ).length
                          }
                        </strong>
                        <Button
                          type="text"
                          aria-label="管理收款渠道"
                          disabled={!can('integrations:read')}
                          onClick={() => navigate('integrations')}
                        >
                          →
                        </Button>
                      </div>
                      <div className="admin-tip">
                        <SafetyCertificateOutlined />
                        <p>充值完成后，邀请返现才会计入收益。</p>
                      </div>
                    </Card>
                  </div>
                  {data.funnel && (
                    <Card title="最近 30 天购买阶段与来源" className="mt-24">
                      <p className="tiny muted">
                        浏览阶段按浏览器、商品、UTC
                        日期去重；报价按报价数，交易阶段按订单去重。来源为本次浏览会话首次来源。各阶段独立统计，不代表同一批访客的转化率；直接购买可能不经过详情页。付款、交付与退款仅由服务端确认。
                      </p>
                      <Table
                        rowKey={(record) => `${record.event}:${record.source}`}
                        dataSource={data.funnel}
                        pagination={{ pageSize: 8 }}
                        scroll={{ x: 520 }}
                        locale={{ emptyText: '尚无统计记录，开始访问套餐与购买后会显示数据。' }}
                        columns={[
                          {
                            title: '阶段',
                            dataIndex: 'event',
                            render: (value: string) => funnelLabels[value] || value,
                          },
                          {
                            title: '来源',
                            dataIndex: 'source',
                            render: (value: keyof typeof sourceLabels) => sourceLabels[value],
                          },
                          { title: '事件数', dataIndex: 'events' },
                          { title: '浏览器数', dataIndex: 'visitors' },
                        ]}
                      />
                    </Card>
                  )}
                  <Card
                    title="最近订单"
                    className={data.funnel ? 'mt-24' : undefined}
                    extra={
                      <Button
                        type="link"
                        disabled={!can('orders:read')}
                        onClick={() => navigate('orders')}
                      >
                        查看全部 →
                      </Button>
                    }
                  >
                    <Table
                      rowKey="id"
                      scroll={{ x: 1320 }}
                      columns={orderColumns}
                      dataSource={data.orders.slice(0, 5)}
                      pagination={false}
                    />
                  </Card>
                </>
              )}
              {page === 'orders' && (
                <Card>
                  <div className="table-toolbar">
                    <h3>全部订单</h3>
                    <Input.Search
                      placeholder="搜索订单 / 邮箱 / 套餐 / 优惠码 / IP"
                      value={search}
                      aria-label="搜索订单、联系邮箱、充值账号、套餐或 IP"
                      onChange={(e) => updateSearch(e.target.value)}
                      style={{ maxWidth: 320 }}
                      allowClear
                    />
                  </div>
                  <Table
                    rowKey="id"
                    columns={orderColumns}
                    dataSource={data.orders}
                    loading={loading}
                    scroll={{ x: 1320 }}
                    pagination={pagination}
                  />
                </Card>
              )}
              {page === 'coupons' && (
                <CouponManager
                  coupons={data.coupons ?? []}
                  products={data.products}
                  canWrite={can('coupons:write')}
                  loading={loading}
                  search={search}
                  onSearchChange={updateSearch}
                  pagination={pagination}
                  createSignal={couponCreateSignal}
                  onChanged={async () => {
                    await load()
                    await refresh()
                  }}
                />
              )}
              {page === 'products' && (
                <>
                  <Card
                    title="套餐目录"
                    extra={
                      <Space>
                        <Button
                          disabled={!can('products:write')}
                          icon={<DatabaseOutlined />}
                          onClick={() => {
                            setStockOpen(true)
                          }}
                        >
                          导入兑换库存
                        </Button>
                      </Space>
                    }
                  >
                    <Table<Product>
                      rowKey="id"
                      dataSource={data.products}
                      scroll={{ x: 820 }}
                      pagination={false}
                      columns={[
                        {
                          title: '商品',
                          dataIndex: 'name',
                          render: (_, p) => (
                            <div>
                              <strong>{p.name}</strong>
                              <div className="tiny muted">{p.subtitle}</div>
                            </div>
                          ),
                        },
                        {
                          title: '定价',
                          dataIndex: 'price',
                          render: (_: number, p: Product) =>
                            p.priceCurrency === 'USD'
                              ? `$${(p.price / 100).toFixed(2)} · 自动换算人民币`
                              : money(p.price),
                        },
                        {
                          title: '可用库存',
                          key: 'stock',
                          render: (_, p) =>
                            data.inventory.find((i) => i.productId === p.id)?.available || 0,
                        },
                        {
                          title: '供货批次',
                          key: 'supply',
                          render: (_, p) => (
                            <div>
                              <span>{p.enabledBatchCount ?? 0} 个已启用</span>
                              <Button type="link" onClick={() => navigate('batches')}>
                                管理批次
                              </Button>
                            </div>
                          ),
                        },
                        {
                          title: '状态',
                          dataIndex: 'enabled',
                          render: (v: boolean) => (
                            <Tag color={v ? 'success' : 'default'}>{v ? '已上架' : '已下架'}</Tag>
                          ),
                        },
                        {
                          title: '操作',
                          key: 'action',
                          render: (_, p) => (
                            <Button
                              disabled={!can('products:write')}
                              type="link"
                              onClick={() => openProduct(p)}
                            >
                              编辑商品
                            </Button>
                          ),
                        },
                      ]}
                    />
                  </Card>
                  <p className="tiny muted">
                    价格按人民币分存储。每笔订单保存购买时的价格与返现规则，后续修改不影响已有订单。
                  </p>
                  {can('integrations:read') && (
                    <StockProcurement
                      products={data.products}
                      demo={site?.mode === 'demo'}
                      canWrite={can('products:write') && can('integrations:write')}
                    />
                  )}
                </>
              )}
              {(page === 'inventory' || page === 'batches') && (
                <InventoryManager
                  key={page}
                  view={page}
                  products={data.products}
                  canWrite={can('products:write')}
                  refreshKey={refreshKey}
                  batchFilter={batchFilter}
                  onBatchFilter={(batch) => {
                    setBatchFilter(batch)
                    if (batch) navigate('inventory')
                  }}
                  onChanged={async () => {
                    await load()
                    await refresh()
                  }}
                />
              )}
              {page === 'users' && (
                <Card>
                  <div className="table-toolbar">
                    <h3>用户列表</h3>
                    <Input.Search
                      value={search}
                      onChange={(e) => updateSearch(e.target.value)}
                      aria-label="搜索用户邮箱"
                      placeholder="搜索邮箱"
                      style={{ maxWidth: 280 }}
                    />
                  </div>
                  <Table
                    rowKey="id"
                    scroll={{ x: 800 }}
                    dataSource={data.users}
                    loading={loading}
                    pagination={pagination}
                    columns={[
                      { title: '邮箱', dataIndex: 'email' },
                      {
                        title: '角色',
                        dataIndex: 'role',
                        render: (v: string) => <Tag>{v === 'admin' ? '管理员' : '用户'}</Tag>,
                      },
                      {
                        title: '返佣等级',
                        dataIndex: 'referralTierId',
                        render: (value: string | null) => {
                          const tier = referralTiers.find((entry) => entry.id === value)
                          return tier ? `${tier.name} · ${tier.rateBps / 100}%（指定）` : '自动计算'
                        },
                      },
                      {
                        title: '邀请人',
                        dataIndex: 'invitedBy',
                        render: (v: string) => (v ? email(v) : '—'),
                      },
                      { title: '注册时间', dataIndex: 'createdAt', render: dateTime },
                      {
                        title: '状态',
                        dataIndex: 'disabled',
                        render: (v: boolean) => (
                          <Tag color={v ? 'error' : 'success'}>{v ? '已停用' : '正常'}</Tag>
                        ),
                      },
                      {
                        title: '操作',
                        key: 'actions',
                        render: (_, u) =>
                          !can('users:write') ? (
                            <span className="muted">只读</span>
                          ) : (
                            <Space>
                              <Button
                                type="link"
                                onClick={() => {
                                  userForm.resetFields()
                                  userForm.setFieldsValue({
                                    referralTierId: referralTiers.some(
                                      (tier) => tier.id === u.referralTierId,
                                    )
                                      ? u.referralTierId
                                      : '',
                                  })
                                  setEditUser(u)
                                }}
                              >
                                编辑
                              </Button>
                              {u.role === 'admin' || u.id === site.user?.id ? (
                                <span className="muted">受保护</span>
                              ) : (
                                <Popconfirm
                                  title={u.disabled ? '启用此用户？' : '停用此用户并注销其会话？'}
                                  onConfirm={() =>
                                    mutate('users', { id: u.id, disabled: !u.disabled })
                                  }
                                >
                                  <Button type="link" danger={!u.disabled}>
                                    {u.disabled ? '启用' : '停用'}
                                  </Button>
                                </Popconfirm>
                              )}
                            </Space>
                          ),
                      },
                    ]}
                  />
                </Card>
              )}
              {page === 'wallet' && (
                <Card title="钱包相关订单">
                  <Alert
                    className="mb-24"
                    type="info"
                    showIcon
                    title="充值与余额支付"
                    description="查看钱包充值、余额抵扣及退回钱包的订单，退款状态可在订单详情中核对。"
                  />
                  <Table
                    rowKey="id"
                    scroll={{ x: 1320 }}
                    columns={orderColumns}
                    dataSource={data.orders}
                    loading={loading}
                    pagination={pagination}
                  />
                </Card>
              )}
              {page === 'referral' && (
                <Card title="邀请收益账本">
                  <Table
                    rowKey="id"
                    scroll={{ x: 800 }}
                    dataSource={data.commissions}
                    loading={loading}
                    pagination={pagination}
                    columns={[
                      { title: '收益用户', dataIndex: 'userId', render: email },
                      {
                        title: '订单',
                        dataIndex: 'orderId',
                        render: (v: string) => (
                          <span className="mono tiny admin-record-id">{v}</span>
                        ),
                      },
                      { title: '金额', dataIndex: 'amount', width: 110, render: money },
                      {
                        title: '状态',
                        dataIndex: 'status',
                        render: (s: string) => (
                          <Tag color={s === 'available' ? 'success' : 'default'}>
                            {{ available: '已结算', pending: '待结算', reversed: '已冲回' }[s]}
                          </Tag>
                        ),
                      },
                      { title: '结算时间', dataIndex: 'availableAt', render: dateTime },
                    ]}
                  />
                </Card>
              )}
              {page === 'withdrawals' && (
                <Card title="提现申请">
                  <Alert
                    className="mb-24"
                    type="info"
                    showIcon
                    title="仅使用已结算邀请收益打款"
                    description="先受理申请，再核对收款信息并人工打款。受理后仅受理人可以登记结果；拒绝申请会释放冻结额度。登记结果不会自动转账。"
                  />
                  <Table
                    rowKey="id"
                    scroll={{ x: 900 }}
                    dataSource={data.withdrawals}
                    loading={loading}
                    pagination={pagination}
                    columns={[
                      { title: '申请人', dataIndex: 'userId', render: email },
                      { title: '申请金额', dataIndex: 'amount', width: 110, render: money },
                      { title: '手续费', dataIndex: 'feeAmount', render: money },
                      { title: '净额（元）', dataIndex: 'netAmount', render: money },
                      { title: '方式', dataIndex: 'method' },
                      {
                        title: '收款人',
                        dataIndex: 'recipientName',
                        render: (value: string) => value || '历史申请未填写',
                      },
                      {
                        title: '网络',
                        dataIndex: 'network',
                        render: (value: Withdrawal['network']) =>
                          value ? usdtNetworkLabels[value] : '—',
                      },
                      { title: '收款信息', dataIndex: 'account', ellipsis: true },
                      {
                        title: '状态',
                        dataIndex: 'status',
                        render: (s: Withdrawal['status']) => (
                          <Tag color={withdrawalStatuses[s].color}>
                            {withdrawalStatuses[s].text}
                          </Tag>
                        ),
                      },
                      { title: '打款流水号', dataIndex: 'payoutReference', ellipsis: true },
                      {
                        title: '实际打款',
                        key: 'paidAmount',
                        render: (_, w) =>
                          w.payoutAmount
                            ? `${w.payoutAmount} ${w.method === 'USDT' ? 'USDT' : 'CNY'}`
                            : '—',
                      },
                      { title: '申请时间', dataIndex: 'createdAt', render: dateTime },
                      {
                        title: '操作',
                        key: 'action',
                        render: (_, w) =>
                          ['pending', 'processing'].includes(w.status) &&
                          can('withdrawals:write') ? (
                            <Button
                              type="link"
                              disabled={w.status === 'processing' && w.reviewerId !== site.user?.id}
                              onClick={() => {
                                withdrawalForm.resetFields()
                                setWithdrawal(w)
                              }}
                            >
                              {w.status === 'processing' ? '登记打款结果' : '审核处理'}
                            </Button>
                          ) : (
                            <span className="tiny muted">{w.note}</span>
                          ),
                      },
                    ]}
                  />
                </Card>
              )}
              {page === 'integrations' && (
                <>
                  <div className="integration-grid">
                    {(Object.keys(providerNames) as IntegrationKind[])
                      .filter((p) => p !== 'epay_v2')
                      .map((entry) => {
                        const provider = entry === 'epay_v1' ? epayVersion : entry
                        const config = data.integrations.find((i) => i.provider === provider)
                        return (
                          <Card key={provider}>
                            <div className="integration-card-head">
                              <span className={`provider-icon ${provider}`}>
                                {providerDetails[provider].icon}
                              </span>
                              <Tag color={config?.enabled ? 'success' : 'default'}>
                                {config?.enabled ? '已配置并启用' : '未启用'}
                              </Tag>
                            </div>
                            <h3>
                              {provider.startsWith('epay_') ? '易支付' : providerNames[provider]}
                            </h3>
                            <p>{providerDetails[provider].description}</p>
                            <div className="integration-meta">
                              {config ? (
                                <span>更新于 {dateTime(config.createdAt)}</span>
                              ) : (
                                <span>等待配置</span>
                              )}
                              <Button
                                disabled={!can('integrations:write')}
                                onClick={() => openIntegration(provider)}
                              >
                                {config ? '编辑配置' : '配置服务'}
                              </Button>
                            </div>
                          </Card>
                        )
                      })}
                  </div>
                  <Alert
                    className="mt-24"
                    type="info"
                    title="启用前测试收款"
                    description="请使用所选渠道完成一笔测试订单。"
                  />
                </>
              )}
              {page === 'settings' && (
                <Card className="settings-card">
                  <Form
                    disabled={!can('settings:write')}
                    form={settingsForm}
                    layout="vertical"
                    onValuesChange={() => {
                      settingsDirty.current = true
                    }}
                    onFinish={(values) => {
                      if (
                        values.withdrawalChannels.usdt &&
                        !Object.values(values.withdrawalChannels.networks).some(Boolean)
                      ) {
                        message.error('开启 USDT 提现时，请至少开启一个收款网络')
                        return
                      }
                      const { tierRules, withdrawalRules, channelLimits, ...rest } = values
                      const rules = Object.fromEntries(
                        Object.entries(withdrawalRules).map(([key, value]) => {
                          const rule = value as {
                            minimumYuan: number
                            feePercent: number
                            fixedYuan: number
                          }
                          return [
                            key,
                            {
                              minimum: Math.round(rule.minimumYuan * 100),
                              feeRateBps: Math.round(rule.feePercent * 100),
                              fixedFee: Math.round(rule.fixedYuan * 100),
                            },
                          ]
                        }),
                      ) as WithdrawalChannels['rules']
                      for (const { key, label } of withdrawalDestinations) {
                        if (withdrawalFee(rules[key].minimum, rules[key]).netAmount <= 0) {
                          message.error(`${label}最低起提金额必须高于该金额对应的手续费`)
                          return
                        }
                      }
                      void mutate('settings', {
                        ...rest,
                        withdrawalChannels: { ...values.withdrawalChannels, rules },
                        paymentLimits: Object.fromEntries(
                          Object.entries(channelLimits).map(([key, value]) => {
                            const limit = value as { min: number; max: number }
                            return [
                              key,
                              {
                                min: Math.round(limit.min * 100),
                                max: Math.round(limit.max * 100),
                              },
                            ]
                          }),
                        ),
                        referralTiers: tierRules.map(
                          (tier: {
                            id: string
                            name: string
                            minimumInvites: number
                            ratePercent: number
                          }) => ({
                            id: tier.id,
                            name: tier.name,
                            minimumInvites: tier.minimumInvites,
                            rateBps: Math.round(tier.ratePercent * 100),
                          }),
                        ),
                        rateBps: Math.round(tierRules[0].ratePercent * 100),
                      })
                    }}
                  >
                    <h3>邀请返现</h3>
                    <p className="muted">
                      按已结算订单的联系邮箱去重统计有效邀请，游客也计入。可新增或删除等级，并设置名称、邀请门槛与返现比例（最高
                      9%）。 至少保留一级，第一级门槛为 0
                      人，后续门槛逐级提高，返现比例不低于前一级。保存后对新订单生效，已有订单保留原比例。
                    </p>
                    <p className="muted">
                      删除第一级后，下一级门槛自动归零。原先被指定到已删除等级的用户，将恢复按有效邀请人数自动计算等级。
                    </p>
                    <ReferralTierEditor disabled={!can('settings:write')} />
                    <div className="form-two">
                      <Form.Item
                        name="settlementDays"
                        label="结算期（天）"
                        rules={[{ required: true }]}
                      >
                        <InputNumber min={0} max={180} style={{ width: '100%' }} />
                      </Form.Item>
                      <Form.Item
                        name="firstOrderOnly"
                        label="仅首笔成功交付订单返现"
                        extra="默认关闭，好友每笔符合条件的订单均返现；修改仅影响新订单。"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                    </div>
                    <h3>提现渠道</h3>
                    <p className="muted">
                      独立控制邀请收益的提现方式，与下方购买付款方式分别设置。关闭后停止接收新申请，已有申请仍可审核处理。
                    </p>
                    <p className="muted">
                      每个渠道和 USDT 网络单独设置起提金额与手续费。手续费 = 申请金额 × 比例 +
                      固定金额，比例部分四舍五入到分，从申请金额内扣除。 金额均以人民币元计；USDT
                      按扣费后的净额确认折算数量。新规则只影响新申请。
                    </p>
                    <Form.Item
                      name={['withdrawalChannels', 'usdt']}
                      label="USDT 提现总开关"
                      valuePropName="checked"
                    >
                      <Switch aria-label="USDT提现" />
                    </Form.Item>
                    <div className="form-two withdrawal-channel-grid">
                      {withdrawalDestinations.map(({ key, label, network }) => (
                        <Card
                          key={key}
                          size="small"
                          title={network ? `USDT · ${label}` : label}
                          extra={
                            <Form.Item
                              noStyle
                              name={
                                network
                                  ? ['withdrawalChannels', 'networks', network]
                                  : ['withdrawalChannels', key]
                              }
                              valuePropName="checked"
                            >
                              <Switch
                                aria-label={`${label}提现`}
                                disabled={
                                  !can('settings:write') || (!!network && !usdtWithdrawalEnabled)
                                }
                              />
                            </Form.Item>
                          }
                        >
                          <Form.Item
                            name={['withdrawalRules', key, 'minimumYuan']}
                            label={`${label}最低起提（元）`}
                            rules={[{ required: true, type: 'number', min: 1, max: 1000000 }]}
                          >
                            <InputNumber
                              min={1}
                              max={1000000}
                              precision={2}
                              style={{ width: '100%' }}
                            />
                          </Form.Item>
                          <div className="form-two">
                            <Form.Item
                              name={['withdrawalRules', key, 'feePercent']}
                              label={`${label}手续费（%）`}
                              rules={[{ required: true, type: 'number', min: 0, max: 99.99 }]}
                            >
                              <InputNumber
                                min={0}
                                max={99.99}
                                precision={2}
                                style={{ width: '100%' }}
                              />
                            </Form.Item>
                            <Form.Item
                              name={['withdrawalRules', key, 'fixedYuan']}
                              label={`${label}固定手续费（元）`}
                              rules={[{ required: true, type: 'number', min: 0, max: 1000000 }]}
                            >
                              <InputNumber
                                min={0}
                                max={1000000}
                                precision={2}
                                style={{ width: '100%' }}
                              />
                            </Form.Item>
                          </div>
                        </Card>
                      ))}
                    </div>
                    <p className="muted">
                      开启 USDT
                      提现后，至少启用一个网络。前台仅展示已启用的网络，打款时须按申请记录核对链与资产。
                    </p>
                    <h3>付款方式</h3>
                    <Form.Item name="emailProvider" label="邮件服务（验证码与订单通知）">
                      <Select
                        options={[
                          { value: 'resend', label: 'Resend' },
                          { value: 'sendflare', label: 'Sendflare' },
                          { value: 'smtp', label: 'SMTP' },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item name="fiatProvider" label="支付宝 / 微信默认渠道">
                      <Select
                        options={[
                          { value: 'xorpay', label: 'XorPay' },
                          { value: 'epay', label: '易支付' },
                        ]}
                      />
                    </Form.Item>
                    <div className="form-three">
                      {(['alipay', 'wechat', 'crypto'] as const).map((key) => (
                        <Form.Item
                          key={key}
                          name={key}
                          label={channels[key]}
                          valuePropName="checked"
                        >
                          <Switch />
                        </Form.Item>
                      ))}
                    </div>
                    <h3>支付金额范围</h3>
                    <p className="muted">
                      按余额抵扣后渠道实际收款金额校验，单位为人民币元，也适用于钱包充值。
                    </p>
                    {(['alipay', 'wechat', 'crypto'] as const).map((key) => (
                      <div className="form-two" key={key}>
                        <Form.Item
                          name={['channelLimits', key, 'min']}
                          label={`${channels[key]}最低金额（元）`}
                          rules={[{ required: true }]}
                        >
                          <InputNumber
                            min={0.01}
                            max={1000000}
                            precision={2}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                        <Form.Item
                          name={['channelLimits', key, 'max']}
                          label={`${channels[key]}最高金额（元）`}
                          rules={[
                            { required: true },
                            ({ getFieldValue }) => ({
                              validator(_, value) {
                                return value >= getFieldValue(['channelLimits', key, 'min'])
                                  ? Promise.resolve()
                                  : Promise.reject(new Error('最高金额不能低于最低金额'))
                              },
                            }),
                          ]}
                        >
                          <InputNumber
                            min={0.01}
                            max={1000000}
                            precision={2}
                            style={{ width: '100%' }}
                          />
                        </Form.Item>
                      </div>
                    ))}
                    <h3>自动汇率</h3>
                    <p>
                      {data.exchangeRate?.available
                        ? `1 USD = ${data.exchangeRate.rate} CNY`
                        : '暂无有效汇率，美元计价商品暂不能下单'}
                    </p>
                    {data.exchangeRate?.sourceDate && (
                      <p className="tiny muted">
                        数据日期：{data.exchangeRate.sourceDate} · 上次获取：
                        {new Date(data.exchangeRate.fetchedAt!).toLocaleString()}
                        {' · '}有效至：{new Date(data.exchangeRate.expiresAt!).toLocaleString()}
                      </p>
                    )}
                    {data.exchangeRate?.lastError && (
                      <Alert
                        className="mb-24"
                        type="warning"
                        title="汇率刷新失败"
                        description="有效期内继续使用缓存汇率，后台会自动重试。"
                      />
                    )}
                    <Button loading={busy} onClick={() => mutate('exchange-rates/refresh', {})}>
                      请求刷新汇率
                    </Button>
                    <p className="tiny muted">后台每小时获取汇率，订单以确认时的人民币价格为准。</p>
                    <h3>服务联系</h3>
                    <Form.Item
                      name="supportEmail"
                      label="支持邮箱"
                      extra="部署者自配置项：下游代理商自托管时请改为自己的邮箱；留空将导致站点提示买家暂停购买。"
                    >
                      <Input type="email" placeholder="support@example.com" />
                    </Form.Item>
                    <Form.Item
                      name={['tawk', 'enabled']}
                      label="Tawk.to 在线客服"
                      valuePropName="checked"
                      extra="开启后，全站右下角显示聊天组件。保存后刷新网页生效。"
                    >
                      <Switch />
                    </Form.Item>
                    <Form.Item
                      name={['tawk', 'propertyId']}
                      label="Tawk.to Property ID"
                      dependencies={[['tawk', 'enabled']]}
                      rules={[
                        ({ getFieldValue }) => ({
                          required: !!getFieldValue(['tawk', 'enabled']),
                          whitespace: true,
                          message: '启用在线客服前请填写 Property ID',
                        }),
                        {
                          pattern: /^[a-f\d]{24}$/,
                          message: '请输入 24 位小写十六进制 Property ID',
                          transform: (value: string) => value?.trim(),
                        },
                      ]}
                      extra="在 Tawk.to 后台 Administration → Channels → Chat Widget 的嵌入地址中，复制第一段 ID。"
                    >
                      <Input autoComplete="off" maxLength={24} placeholder="Property ID" />
                    </Form.Item>
                    <Form.Item
                      name={['tawk', 'widgetId']}
                      label="Tawk.to Widget ID"
                      dependencies={[['tawk', 'enabled']]}
                      rules={[
                        ({ getFieldValue }) => ({
                          required: !!getFieldValue(['tawk', 'enabled']),
                          whitespace: true,
                          message: '启用在线客服前请填写 Widget ID',
                        }),
                        {
                          pattern: /^[a-zA-Z\d]{1,64}$/,
                          message: 'Widget ID 只能包含字母和数字，最长 64 位',
                          transform: (value: string) => value?.trim(),
                        },
                      ]}
                      extra="复制嵌入地址的第二段 ID（有些组件为 default）；无需填写 API 密钥或粘贴整段脚本。"
                    >
                      <Input autoComplete="off" maxLength={64} placeholder="Widget ID" />
                    </Form.Item>
                    <Form.Item
                      name="sessionGuideUrl"
                      label="账号信息操作指引"
                      extra="支持 HTTP 和 HTTPS 地址，将展示在新手指南与结算页。请勿填写包含账号信息或访问凭据的地址。"
                    >
                      <Input type="url" placeholder="http:// 或 https://…" maxLength={2048} />
                    </Form.Item>
                    <Button htmlType="submit" type="primary" loading={busy}>
                      保存设置
                    </Button>
                  </Form>
                </Card>
              )}
              {page === 'risk' && (
                <Card title="风控决策记录">
                  <p className="muted">
                    当前规则全部执行：超限请求会被拒绝，异常提现需人工审核。
                    历史观察记录保留原模式。记录保留 30 天。
                  </p>
                  <Table
                    rowKey="id"
                    dataSource={data.riskEvents ?? []}
                    loading={loading}
                    pagination={pagination}
                    scroll={{ x: 1100 }}
                    columns={[
                      {
                        title: '场景',
                        dataIndex: 'scene',
                        render: (value: string) => riskSceneLabels[value] || value,
                      },
                      {
                        title: '模式',
                        dataIndex: 'mode',
                        render: (value: string) => (value === 'observe' ? '观察' : '执行'),
                      },
                      {
                        title: '建议',
                        dataIndex: 'action',
                        render: (value: string) =>
                          ({
                            allow: '放行',
                            deny: '拒绝',
                            review: '人工核对',
                            challenge: '安全验证',
                          })[value] || value,
                      },
                      {
                        title: '实际处理',
                        dataIndex: 'effectiveAction',
                        render: (value: string) =>
                          ({
                            allow: '放行',
                            deny: '拒绝',
                            review: '人工核对',
                            challenge: '安全验证',
                          })[value] || value,
                      },
                      {
                        title: '命中原因',
                        dataIndex: 'reasonCodes',
                        render: (codes: string[]) =>
                          codes.map((code) => riskReasonLabels[code] || code).join('、') ||
                          '未命中限制',
                      },
                      { title: '关联订单／提现', dataIndex: 'referenceId', ellipsis: true },
                      { title: '规则版本', dataIndex: 'ruleVersion', ellipsis: true },
                      { title: '时间', dataIndex: 'createdAt', render: dateTime },
                    ]}
                  />
                </Card>
              )}
              {page === 'audit' && (
                <Card title="关键操作审计">
                  <Table
                    rowKey="id"
                    dataSource={data.audit}
                    loading={loading}
                    pagination={pagination}
                    scroll={{ x: 700 }}
                    columns={[
                      { title: '操作人', dataIndex: 'actor' },
                      { title: '操作', dataIndex: 'action' },
                      { title: '对象', dataIndex: 'target', ellipsis: true },
                      { title: '时间', dataIndex: 'createdAt', render: dateTime },
                    ]}
                  />
                </Card>
              )}
              {page === 'roles' && (
                <>
                  <Card
                    title="角色权限"
                    extra={
                      can('roles:write') && (
                        <Button
                          type="primary"
                          onClick={() => {
                            roleForm.resetFields()
                            setRoleOpen(true)
                          }}
                        >
                          新增角色
                        </Button>
                      )
                    }
                  >
                    <Table
                      rowKey="id"
                      dataSource={data.roles}
                      scroll={{ x: 640 }}
                      pagination={false}
                      columns={[
                        { title: '角色', dataIndex: 'name', width: 140 },
                        {
                          title: '权限',
                          dataIndex: 'permissions',
                          render: (list: string[]) => (
                            <Space wrap>
                              {list.map((p) => (
                                <Tag key={p}>{p}</Tag>
                              ))}
                            </Space>
                          ),
                        },
                        {
                          title: '操作',
                          key: 'action',
                          width: 110,
                          render: (_, role) =>
                            can('roles:write') && !role.protected ? (
                              <Button
                                type="link"
                                onClick={() => {
                                  roleForm.setFieldsValue(role)
                                  setRoleOpen(true)
                                }}
                              >
                                编辑
                              </Button>
                            ) : (
                              <span>只读</span>
                            ),
                        },
                      ]}
                    />
                  </Card>
                  <Card title="分配用户角色" className="mt-24">
                    {!can('users:read') && (
                      <Alert
                        type="info"
                        showIcon
                        title="查看和选择用户需要用户查看权限，请联系管理员开通。"
                      />
                    )}
                    <Table
                      rowKey="id"
                      dataSource={data.users}
                      loading={loading}
                      pagination={pagination}
                      scroll={{ x: 640 }}
                      columns={[
                        { title: '用户', dataIndex: 'email', width: 280 },
                        {
                          title: '角色',
                          key: 'roles',
                          render: (_, user) =>
                            user.role === 'admin' ? (
                              <Tag color="default">所有者 · 全部权限</Tag>
                            ) : (
                              <Select
                                mode="multiple"
                                style={{ minWidth: 240 }}
                                disabled={!can('roles:write') || busy}
                                value={user.roleIds || []}
                                options={data.roles.map((r) => ({ value: r.id, label: r.name }))}
                                onChange={(roleIds) =>
                                  mutate('user-roles', { userId: user.id, roleIds })
                                }
                              />
                            ),
                        },
                      ]}
                    />
                    <p className="tiny muted">
                      角色变更会注销该用户的登录会话。只能授予当前操作人拥有的权限；所有者角色受保护。
                    </p>
                  </Card>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <Modal
        forceRender
        title="编辑用户"
        open={!!editUser}
        onCancel={() => setEditUser(null)}
        footer={null}
      >
        <p>{editUser?.email}</p>
        <Form
          form={userForm}
          layout="vertical"
          onFinish={(values) => {
            if (editUser)
              void mutate(
                'users',
                {
                  id: editUser.id,
                  referralTierId: values.referralTierId || null,
                },
                () => setEditUser(null),
              )
          }}
        >
          <Form.Item
            name="referralTierId"
            label="返佣等级"
            extra="自动计算按有效邀请人数升级；指定等级后固定使用该等级，仅影响新订单。"
          >
            <Select
              virtual={false}
              options={[
                { value: '', label: '自动计算（按有效邀请人数）' },
                ...referralTiers.map((tier) => ({
                  value: tier.id,
                  label: `${tier.name} · ${tier.rateBps / 100}%`,
                })),
              ]}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>
            保存
          </Button>
        </Form>
      </Modal>
      <Modal
        forceRender
        title={editProduct ? '编辑商品' : '新增商品'}
        open={productOpen}
        onCancel={() => setProductOpen(false)}
        footer={null}
        width={620}
      >
        <Form
          form={productForm}
          layout="vertical"
          onFinish={(values) => {
            const { priceYuan, featureText, ...rest } = values
            void mutate(
              'products',
              {
                ...rest,
                price: Math.round(priceYuan * 100),
                features: featureText
                  .split('\n')
                  .map((s: string) => s.trim())
                  .filter(Boolean),
              },
              () => setProductOpen(false),
            )
          }}
        >
          <div className="form-two">
            <Form.Item
              name="id"
              label="商品标识"
              rules={[{ required: true, pattern: /^[a-z\d_-]+$/ }]}
            >
              <Input disabled={!!editProduct} placeholder="plus-monthly" />
            </Form.Item>
            <Form.Item name="name" label="商品名称" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
          </div>
          <Form.Item name="subtitle" label="简短介绍" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="详情说明" rules={[{ required: true }]}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <div className="form-two">
            <Form.Item
              name="priceYuan"
              label={productCurrency === 'USD' ? '固定售价（美元）' : '固定售价（元）'}
              rules={[{ required: true }]}
            >
              <InputNumber min={0.01} max={1000000} precision={2} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="priceCurrency" label="基础售价币种" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'CNY', label: '人民币（固定售价）' },
                  { value: 'USD', label: '美元（自动换算人民币）' },
                ]}
              />
            </Form.Item>
            {productCurrency === 'USD' && (
              <Form.Item name="roundingStep" label="人民币售价取整" rules={[{ required: true }]}>
                <Select options={roundingOptions} />
              </Form.Item>
            )}
            <Form.Item name="plan" label="兑换目标套餐" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'go', label: 'Go（仅充值）' },
                  { value: 'plus', label: 'Plus' },
                  { value: 'pro5', label: 'Pro 100' },
                  { value: 'pro20', label: 'Pro 200' },
                  { value: 'promax', label: 'Pro 500' },
                ]}
              />
            </Form.Item>
          </div>
          <Form.Item name="featureText" label="套餐说明（每行一条）" rules={[{ required: true }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <div className="form-three">
            <Form.Item name="enabled" label="上架" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="featured" label="首页推荐" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>
          <Button type="primary" htmlType="submit" loading={busy} block>
            保存商品
          </Button>
        </Form>
      </Modal>
      {stockOpen && (
        <InventoryImportDialog
          products={data?.products ?? []}
          onClose={() => setStockOpen(false)}
          onSaved={async () => {
            await load()
            await refresh()
          }}
        />
      )}
      <Modal
        forceRender
        title={
          editIntegration
            ? `配置 ${editIntegration.startsWith('epay_') ? '易支付' : providerNames[editIntegration]}`
            : ''
        }
        open={!!editIntegration}
        onCancel={() => {
          setEditIntegration(null)
          integrationForm.resetFields()
        }}
        footer={null}
        destroyOnHidden
      >
        <Form
          form={integrationForm}
          layout="vertical"
          onFinish={(values) =>
            mutate('integrations', { ...values, provider: editIntegration }, () => {
              setEditIntegration(null)
              integrationForm.resetFields()
            })
          }
        >
          {editIntegration && (
            <>
              {editIntegration.startsWith('epay_') && (
                <Form.Item label="协议版本">
                  <Select
                    aria-label="协议版本"
                    value={editIntegration}
                    options={[
                      { value: 'epay_v1', label: 'v1（MD5）' },
                      { value: 'epay_v2', label: 'v2（RSA-SHA256）' },
                    ]}
                    onChange={(version) => openIntegration(version)}
                  />
                </Form.Item>
              )}
              <Alert
                className="mb-24"
                type="info"
                showIcon
                title="已保存的密钥不会回显"
                description="留空保留原密钥，填写新值即可替换。"
              />
              {publicFields[editIntegration].map(([key, label, placeholder]) => (
                <Form.Item
                  key={key}
                  name={['public', key]}
                  label={label}
                  rules={[{ required: true }]}
                >
                  <Input placeholder={placeholder} autoComplete="off" />
                </Form.Item>
              ))}
              {editIntegration === 'turnstile' && (
                <>
                  <Form.Item
                    name={['public', 'login']}
                    label="登录与邮箱验证码"
                    initialValue="true"
                  >
                    <Select
                      options={[
                        { value: 'true', label: '开启' },
                        { value: 'false', label: '关闭' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    name={['public', 'purchase']}
                    label="购买与钱包充值"
                    initialValue="true"
                  >
                    <Select
                      options={[
                        { value: 'true', label: '开启' },
                        { value: 'false', label: '关闭' },
                      ]}
                    />
                  </Form.Item>
                  <Alert
                    className="mb-24"
                    type="info"
                    title="请先配置网站域名"
                    description="在 Cloudflare 添加本站域名并获取密钥后启用。验证服务不可用时，相关操作将暂时无法完成。"
                  />
                </>
              )}
              {secretFields[editIntegration].map(([key, label]) => (
                <Form.Item key={key} name={['secrets', key]} label={label}>
                  <Input.Password
                    autoComplete="new-password"
                    placeholder={
                      data?.integrations
                        .find((i) => i.provider === editIntegration)
                        ?.secrets.includes(key)
                        ? '已保存，留空保持不变'
                        : '填写密钥'
                    }
                  />
                </Form.Item>
              ))}
              <Form.Item name="enabled" label="启用此服务" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={busy} block>
                加密保存配置
              </Button>
            </>
          )}
        </Form>
      </Modal>
      <Modal
        forceRender
        title="处理提现申请"
        open={!!withdrawal}
        onCancel={() => setWithdrawal(null)}
        footer={null}
      >
        <p>
          申请人：{withdrawal && email(withdrawal.userId)}
          <br />
          申请金额：{money(withdrawal?.amount || 0)}
          <br />
          手续费：{money(withdrawal?.feeAmount || 0)}
          {withdrawal ? `（${withdrawal.feeRateBps / 100}% + ${money(withdrawal.fixedFee)}）` : ''}
          <br />
          {withdrawal?.method === 'USDT' ? '待折算净额' : '应打款金额'}：
          {money(withdrawal?.netAmount || 0)}
          <br />
          收款方式：{withdrawal?.method}
          {withdrawal?.network ? ` · ${usdtNetworkLabels[withdrawal.network]}` : ''}
          <br />
          收款人：{withdrawal?.recipientName || '历史申请未填写，请先核实'}
        </p>
        <Card size="small">
          <span className="wrap-anywhere">{withdrawal?.account}</span>
        </Card>
        {withdrawal?.method === 'USDT' && (
          <WithdrawalEstimate
            key={withdrawal.id}
            withdrawalId={withdrawal.id}
            canFill={withdrawalResult === 'paid'}
            onUse={(amount) => withdrawalForm.setFieldValue('payoutAmount', amount)}
          />
        )}
        <Alert
          className="mt-24"
          type="info"
          showIcon
          title={
            withdrawal?.status === 'processing'
              ? '已由你受理，等待实际打款'
              : '受理后再进行人工打款'
          }
          description="请先核对邀请收益与收款信息。只有实际转账成功后，才登记已打款；拒绝前请确认未打款。"
        />
        <Form
          className="mt-24"
          form={withdrawalForm}
          layout="vertical"
          onFinish={(values) =>
            mutate('withdrawals', { ...values, id: withdrawal?.id }, () => setWithdrawal(null))
          }
        >
          <Form.Item name="status" label="处理结果" rules={[{ required: true }]}>
            <Select
              options={[
                ...(withdrawal?.status === 'pending'
                  ? [{ value: 'processing', label: '受理申请，由我核对并打款' }]
                  : [{ value: 'paid', label: '已完成实际打款，登记结果' }]),
                { value: 'rejected', label: '拒绝申请，释放冻结收益' },
              ]}
            />
          </Form.Item>
          {withdrawalResult === 'paid' && (
            <>
              <Form.Item
                name="payoutReference"
                label="打款流水号 / 链上交易哈希"
                preserve={false}
                rules={[{ required: true, whitespace: true, min: 3, max: 160 }]}
              >
                <Input maxLength={160} />
              </Form.Item>
              {withdrawal?.method === 'USDT' && (
                <Form.Item
                  name="payoutAmount"
                  label="实际到账 USDT 数量"
                  preserve={false}
                  extra="按本单扣除手续费后的人民币净额与申请人确认折算数量，再打款并登记实际到账数量。"
                  rules={[{ required: true, type: 'number', min: 0.000001, max: 1000000 }]}
                >
                  <InputNumber
                    min={0.000001}
                    max={1000000}
                    precision={6}
                    style={{ width: '100%' }}
                  />
                </Form.Item>
              )}
            </>
          )}
          <Form.Item
            name="note"
            label={
              withdrawalResult === 'rejected' ? '拒绝原因（向申请人展示）' : '处理说明（选填）'
            }
            rules={[
              {
                required: withdrawalResult === 'rejected',
                whitespace: true,
                min: withdrawalResult === 'rejected' ? 3 : 0,
                max: 300,
              },
            ]}
          >
            <Input.TextArea rows={2} maxLength={300} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy} block>
            确认记录处理结果
          </Button>
        </Form>
      </Modal>
      <Modal title="角色权限" open={roleOpen} onCancel={() => setRoleOpen(false)} footer={null}>
        <Form
          form={roleForm}
          layout="vertical"
          onFinish={(values) => mutate('roles', values, () => setRoleOpen(false))}
        >
          <Form.Item
            name="id"
            label="角色标识"
            rules={[{ required: true, pattern: /^[a-z\d_-]+$/ }]}
          >
            <Input placeholder="support" />
          </Form.Item>
          <Form.Item name="name" label="显示名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="permissions" label="权限" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              options={site.user.permissions.map((p) => ({ value: p, label: p }))}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy} block>
            保存角色
          </Button>
        </Form>
      </Modal>
    </div>
  )
}
function RevenueChart({ days }: { days: { date: string; amount: number }[] }) {
  const values = days.map((day) => day.amount)
  const max = Math.max(...values, 10000)
  const points = values.map((v, i) => `${45 + i * 80},${170 - (v / max) * 135}`).join(' ')
  return (
    <div className="revenue-chart">
      <div className="chart-summary">
        <strong>{money(values.reduce((s, v) => s + v, 0))}</strong>
        <span className="muted">最近 7 天</span>
      </div>
      <svg
        viewBox="0 0 570 180"
        role="img"
        aria-label={`近七天每日成交额：${values.map(money).join('、')}`}
      >
        <defs>
          <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity=".18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity=".01" />
          </linearGradient>
        </defs>
        {[35, 80, 125, 170].map((y) => (
          <line key={y} x1={35} x2={550} y1={y} y2={y} stroke="var(--line)" strokeDasharray="4 4" />
        ))}
        <polygon points={`45,170 ${points} 525,170`} fill="url(#chart-fill)" />
        <polyline
          points={points}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {values.map((v, i) => (
          <circle key={i} cx={45 + i * 80} cy={170 - (v / max) * 135} r={4} fill="var(--accent)" />
        ))}
      </svg>
      <div className="chart-days muted">
        {days.map((day) => (
          <span key={day.date}>
            {Number(day.date.slice(5, 7))}/{Number(day.date.slice(8, 10))}
          </span>
        ))}
      </div>
    </div>
  )
}
