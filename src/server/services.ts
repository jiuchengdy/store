import type {
  AccountData,
  AdminData,
  Channel,
  Product,
  Quote,
  Settings,
  User,
  Withdrawal,
  WithdrawalEstimate,
} from '../types'
import {
  db,
  Prisma,
  transaction,
  upstreamTransaction,
  checkoutTransaction,
  uniqueConflict,
  type DbClient,
} from './db'
import {
  productView,
  orderView,
  adminOrderView,
  canOfferRefill,
  paymentOrderView,
  quoteView,
  userView,
  commissionView,
  storedWithdrawalView,
  walletEntryView,
  auditView,
  settingsData,
  jsonInput,
} from './data'
import {
  advisoryLock,
  reserveInventory,
  discountInventoryCountries,
  databaseNow,
  lockRow,
  lockSettings,
  lockCommissions,
  qualifiedInvitesSql,
  readOnlyTransaction,
  savePaymentLocation,
  dailyPurchaseRevenue,
} from './database-sql'
import { ApiError, demo } from './config'
import { adminPageSize, adminQuerySchema, type AdminQuery } from './admin-query'
import { normalizeCouponCode } from '../coupons'
import {
  adminCouponsList,
  affiliateCouponsForUser,
  confirmCouponOrderPaid,
  markCouponOrderRedeemed,
  precheckCouponForOrder,
  releaseCouponOrder,
  reserveCouponInTransaction,
} from './coupons'
import { decrypt, encrypt, hash, id, secretHash } from './crypto'
import { openCredential, sealCredential } from './credential-storage'
import { publicPlan } from './safe-errors'
import { integration, integrationViews } from './integrations/config'
import {
  checkAccount,
  aicdkPlan,
  preflight,
  findRedemption,
  getRedemption,
  updateAccountSession,
  resolveAicdk,
  UpstreamError,
  type AicdkBinding,
} from './integrations/aicdk'
import {
  fulfillmentBusiness,
  validateFulfillment,
  type PricingSnapshot,
} from './fulfillment-policy'
import { reservePlusDiscount } from './plus-discount'
import { createPayment, refundXorpay, type Receipt } from './integrations/payments'
import { refundInputSchema, refundReviewDelayMs } from '../refunds'
import { redemptionRequestId } from '../order-refill'
import { orderResolutionSchema } from '../order-resolution'
import type { Order as OrderRecord } from '../generated/prisma/client'
import { money, parseSession } from '../lib'
import { paymentLimitError, convertedSubscriptionPrice } from '../pricing'
import {
  exchangeRate,
  exchangeRateStatus,
  refreshExchangeRate,
  requestExchangeRefresh,
  type ExchangeRate,
} from './exchange-rates'
import { analyticsVisitor, funnelReport } from './funnel'
import type { FunnelSource } from '../funnel'
import { defaultReferralTiers, referralFunds, referralProgress } from '../referral'
import { withdrawalReviewSchema, withdrawalSchema } from './referral-policy'
import {
  assessRisk,
  checkRiskRate,
  payoutFingerprint,
  riskDigest,
  RiskRejection,
  recordRiskRejection,
} from './risk'
import type { RiskFacts } from './risk-policy'
import {
  withdrawalChannelError,
  withdrawalChannels,
  withdrawalFee,
  withdrawalRule,
  estimateUsdtAmount,
} from '../withdrawals'

export type StoredQuote = Quote & {
  browserDigest: string
  aicdkIntegrationId?: string
  inventoryId?: string
  preflightToken?: string
  preflightExpiresAt?: string
  pricingSnapshot?: PricingSnapshot
}
export async function settings(): Promise<Settings> {
  const result = await db.setting.findUnique({ where: { id: 1 } })
  if (!result) throw new ApiError(503, '请先初始化数据库')
  const conf = settingsData(result.body)
  const referralTiers = conf.referralTiers ?? defaultReferralTiers
  return {
    ...conf,
    referralTiers,
    rateBps: referralTiers[0].rateBps,
    withdrawalChannels: withdrawalChannels(conf),
  }
}
async function qualifiedInvites(userId: string, client: DbClient = db) {
  // Contact email remains stable when a guest order is later claimed by its owner.
  return qualifiedInvitesSql(client, userId)
}
export async function products(all = false): Promise<Product[]> {
  const rank: Record<string, number> = { go: 0, plus: 1, pro5: 2, pro20: 3 }
  const catalog = (
    await db.product.findMany({
      where: { upgrade: false, ...(all ? {} : { enabled: true }) },
      include: { _count: { select: { inventoryBatches: { where: { enabled: true } } } } },
    })
  )
    .map((record) => ({
      ...productView(record),
      ...(all ? { enabledBatchCount: record._count?.inventoryBatches ?? 0 } : {}),
    }))
    .sort((a, b) => (rank[a.plan] ?? 4) - (rank[b.plan] ?? 4) || a.price - b.price)
  if (all) return catalog
  const rate = catalog.some((p) => p.priceCurrency === 'USD') ? await exchangeRate() : undefined
  return catalog.map((product) => {
    if (product.priceCurrency === 'CNY') return product
    let price = 0
    if (rate) {
      try {
        price = convertedSubscriptionPrice(product.price, rate.rateE8, product.roundingStep)
      } catch {
        /* Unusable prices stay unavailable, never fall back to an unconverted amount. */
      }
    }
    return { ...product, price, priceCurrency: 'CNY', priceStatus: price ? 'ready' : 'pending' }
  })
}
export async function audit(actor: string, action: string, target: string, client: DbClient) {
  await client.audit.create({ data: { id: id('a_'), actor, action, target } })
}
export async function quote(
  productId: string,
  sessionText: string,
  browser: string,
  attribution: { source: FunnelSource; analytics: boolean } = {
    source: 'direct',
    analytics: false,
  },
): Promise<Quote> {
  let session: ReturnType<typeof parseSession>
  try {
    session = parseSession(sessionText)
  } catch (error) {
    throw new ApiError(400, (error as Error).message)
  }
  const record = await db.product.findFirst({
    where: { id: productId, enabled: true, upgrade: false },
  })
  if (!record) throw new ApiError(404, '商品已下架')
  const product = productView(record)
  let amount = product.price
  let currentPlan: string | undefined
  let pricingSnapshot: unknown = { mode: 'fixed', price: product.price }
  let rate: ExchangeRate | undefined
  if (product.pricingMode !== 'fixed') throw new ApiError(409, '此商品尚未配置固定售价')
  if (product.priceCurrency === 'USD') {
    rate = await exchangeRate(true)
    if (!rate) throw new ApiError(503, '汇率暂不可用，请稍后重试')
    amount = convertedSubscriptionPrice(product.price, rate.rateE8, product.roundingStep)
    pricingSnapshot = {
      mode: 'fixed',
      currency: 'USD',
      price: product.price,
      roundingStep: product.roundingStep,
      exchangeRate: rate,
    }
  }
  const binding = demo ? undefined : await integration('aicdk')
  if (binding) {
    // Account checks never select, decrypt, reserve or transmit a redemption code.
    const check = await checkAccount(session, binding)
    if (check.account_email.toLowerCase() !== session.user.email.toLowerCase())
      throw new ApiError(409, '检查结果与提交账号不匹配')
    if (check.account_status !== 'active')
      throw new ApiError(409, '此账号当前无法充值，请检查账号状态')
    const group = check.subscription.purchase
    const matches = group.plans.filter((p) => p.id === aicdkPlan(product.plan))
    const target = matches[0]
    const standardEligible =
      group.eligible === true && matches.length === 1 && target.eligible === true
    const offer =
      product.plan === 'plus' ? check.subscription.offers?.plus_50_percent_discount : undefined
    const discountQuotes = offer?.eligible === true ? offer.quotes : undefined
    const discountAvailable =
      discountQuotes &&
      (await discountInventoryCountries(db, productId)).some((country) => discountQuotes[country])
    if (!discountAvailable) {
      if (matches.length !== 1) throw new ApiError(409, '该目标套餐暂不可用，请选择其他套餐')
      if (group.eligible === null || target.eligible === null)
        throw new ApiError(503, '账号适用性暂未确定，请稍后重新检查')
      if (!standardEligible) throw new ApiError(409, '该账号不符合所选套餐的购买条件')
    }
    if (discountQuotes) {
      pricingSnapshot = {
        ...(pricingSnapshot as PricingSnapshot),
        plusDiscount: { quotes: discountQuotes, standardEligible },
      }
    }
    currentPlan = publicPlan(check.current_plan)
  }
  if (rate && Date.parse(rate.expiresAt) <= Date.now())
    throw new ApiError(409, '汇率已过期，请重新验证账号')
  // In live mode this email has now been matched against the upstream account.
  await checkRiskRate('quote-target', { target: session.user.email.trim().toLowerCase() })
  const q = {
    id: id('q_'),
    productId,
    email: session.user.email.toLowerCase(),
    amount,
    currentPlan,
    targetPlan: product.plan,
    expiresAt: new Date(
      Math.min(Date.now() + 9 * 60_000, rate ? Date.parse(rate.expiresAt) : Infinity),
    ).toISOString(),
  }
  await transaction(async (client) => {
    await client.quote.create({
      data: {
        id: q.id,
        browserDigest: browser,
        productId: q.productId,
        email: q.email,
        amount: q.amount,
        expiresAt: q.expiresAt,
        aicdkIntegrationId: binding?.id ?? null,
        pricingSnapshot: pricingSnapshot ? jsonInput(pricingSnapshot as object) : Prisma.DbNull,
        currentPlan: currentPlan ?? null,
        targetPlan: product.plan,
        analyticsVisitor: attribution.analytics ? analyticsVisitor(browser) : null,
        attributionSource: attribution.source,
      },
    })
    if (attribution.analytics)
      await client.funnelEvent.createMany({
        data: [
          {
            id: q.id,
            event: 'quote_ready',
            visitorKey: analyticsVisitor(browser),
            productId,
            source: attribution.source,
          },
        ],
        skipDuplicates: true,
      })
  })
  return q
}
async function walletChange(
  client: DbClient,
  userId: string,
  amount: number,
  kind: string,
  orderId: string,
) {
  await client.wallet.createMany({ data: [{ userId }], skipDuplicates: true })
  await lockRow(client, 'wallets', userId)
  const previous = await client.wallet.findUniqueOrThrow({ where: { userId } })
  const exists = await client.walletEntry.findUnique({ where: { orderId_kind: { orderId, kind } } })
  if (exists) return
  const balance = previous.balance + amount
  if (balance < 0) throw new ApiError(409, '钱包余额不足，请先充值或选择其他支付方式')
  await client.wallet.update({ where: { userId }, data: { balance } })
  await client.walletEntry.create({
    data: { id: id('l_'), userId, amount, balanceAfter: balance, kind, orderId },
  })
}
// GMPay (EPUSDT) rejects an order_id longer than 32 characters, so the id is "o_"
// plus the first 30 hex chars of the request hash (120 bits of collision space).
// Deterministic on purpose: the same user/browser + requestKey yields the same id,
// which is the payment idempotency key. Ids created before this change were 34
// characters; they are never regenerated, so both shapes coexist.
export const orderIdFor = (seed: string) => `o_${hash(seed).slice(0, 30)}`

export async function newOrder(
  user: User | null,
  browser: string,
  input: {
    quoteId?: string
    amount?: number
    channel: Channel
    requestKey: string
    contactEmail?: string
    balanceAmount?: number
    referralCode?: string
    couponCode?: string
    session?: string
  },
  ipAddress?: string,
) {
  if (!user && (!input.quoteId || input.channel === 'balance' || (input.balanceAmount ?? 0) > 0))
    throw new ApiError(401, '钱包功能需要先登录')
  if (!user && !input.contactEmail) throw new ApiError(400, '请填写联系邮箱以接收订单通知')
  const normalizedCouponCode = input.couponCode?.trim()
    ? normalizeCouponCode(input.couponCode)
    : undefined
  if (!input.quoteId && normalizedCouponCode) throw new ApiError(400, '钱包充值不支持使用优惠码')
  const contactEmail = user?.email || input.contactEmail!
  const conf = await settings()
  if (!input.quoteId && (input.channel === 'balance' || (input.balanceAmount ?? 0) > 0))
    throw new ApiError(400, '不能用余额给余额充值')
  const provider =
    input.channel === 'crypto'
      ? 'gmpay'
      : input.channel === 'balance'
        ? 'balance'
        : conf.fiatProvider
  const orderId = orderIdFor(`${user?.id || browser}:${input.requestKey}`)
  const requestHash = hash(
    JSON.stringify({
      quoteId: input.quoteId ?? null,
      amount: input.amount ?? null,
      channel: input.channel,
      contactEmail,
      balanceAmount: input.balanceAmount ?? 0,
      referralCode: input.referralCode ?? null,
      ...(normalizedCouponCode ? { couponCode: normalizedCouponCode } : {}),
    }),
  )
  // Resolve configuration and precheck coupon before acquiring locks or calling preflight.
  let binding: AicdkBinding | undefined
  let precheckedCoupon: Awaited<ReturnType<typeof precheckCouponForOrder>> | undefined
  if (input.quoteId) {
    const existingById = await db.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    })
    if (!demo) {
      const q = await db.quote.findFirst({
        where: { id: input.quoteId, browserDigest: browser },
        select: { aicdkIntegrationId: true },
      })
      if (!q?.aicdkIntegrationId && !existingById)
        throw new ApiError(409, '请重新检查账号后创建订单')
      if (q?.aicdkIntegrationId) binding = await resolveAicdk(q.aicdkIntegrationId)
    }
    if (normalizedCouponCode && !existingById) {
      const storedQuote = await db.quote.findFirst({
        where: { id: input.quoteId, browserDigest: browser },
      })
      const existingByQuote = storedQuote
        ? await db.order.findUnique({ where: { quoteId: storedQuote.id }, select: { id: true } })
        : null
      if (storedQuote && !existingByQuote) {
        const qView = quoteView(storedQuote)
        const prod = await db.product.findFirst({
          where: { id: qView.productId, enabled: true, upgrade: false },
          select: { id: true, upgrade: true },
        })
        if (prod) {
          precheckedCoupon = await precheckCouponForOrder(normalizedCouponCode, {
            user,
            contactEmail,
            targetEmail: qView.email,
            product: prod,
            listAmount: qView.amount,
          })
        }
      }
    }
  }
  const outcome = await transaction(async (client) => {
    if (user) await lockRow(client, 'users', user.id)
    else await advisoryLock(client, `guest:${browser}`)
    const existing = await client.order.findUnique({ where: { id: orderId } })
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ApiError(409, '同一请求标识不能用于不同的订单参数')
      return orderView(existing)
    }
    let quoteRecord: StoredQuote | undefined
    let productRecord: { id: string; name: string; plan: string; upgrade: boolean } | undefined
    let name = '钱包充值'
    if (input.quoteId) {
      await lockRow(client, 'quotes', input.quoteId)
      const stored = await client.quote.findUnique({ where: { id: input.quoteId } })
      quoteRecord = stored ? quoteView(stored) : undefined
      if (!quoteRecord || quoteRecord.browserDigest !== browser)
        throw new ApiError(404, '未找到账号验证结果')
      const old = await client.order.findUnique({ where: { quoteId: quoteRecord.id } })
      if (old) {
        if (
          (user
            ? old.userId !== user.id
            : old.userId !== null || old.guestBrowserDigest !== browser) ||
          old.requestHash !== requestHash
        )
          throw new ApiError(409, '此验证结果已被用于其他订单，请在原订单继续')
        return orderView(old)
      }
      if (Date.parse(quoteRecord.expiresAt) < Date.now())
        throw new ApiError(409, '验证结果已过期，请重新验证账号')
      const product = await client.product.findFirst({
        where: { id: quoteRecord.productId, enabled: true, upgrade: false },
      })
      if (!product || quoteRecord.pricingSnapshot?.mode === 'markup')
        throw new ApiError(409, '商品已下架，请重新选择')
      if (quoteRecord.targetPlan && quoteRecord.targetPlan !== product.plan)
        throw new ApiError(409, '目标套餐已变更，请重新验证账号')
      productRecord = product
      name = product.name
    }
    const baseListAmount = quoteRecord?.amount ?? input.amount!
    const preliminaryAmount = precheckedCoupon
      ? precheckedCoupon.evaluated.finalAmount
      : baseListAmount
    const preliminaryBalance =
      input.channel === 'balance' ? preliminaryAmount : (input.balanceAmount ?? 0)
    if (
      !Number.isSafeInteger(preliminaryBalance) ||
      preliminaryBalance < 0 ||
      preliminaryBalance > preliminaryAmount
    )
      throw new ApiError(400, '余额抵扣金额无效')
    const preliminaryExternal = preliminaryAmount - preliminaryBalance
    if (preliminaryExternal > 0 && input.channel !== 'balance' && !conf[input.channel])
      throw new ApiError(409, '此支付方式暂未开放')
    const preliminaryLimitError = paymentLimitError(conf, input.channel, preliminaryExternal)
    if (preliminaryLimitError) throw new ApiError(409, preliminaryLimitError)
    if (!demo && quoteRecord) {
      if (!input.session) throw new ApiError(400, '账号信息已清除，请重新检查账号')
      let session: ReturnType<typeof parseSession>
      try {
        session = parseSession(input.session)
      } catch {
        throw new ApiError(400, '账号信息格式不正确，请重新检查账号')
      }
      if (session.user.email.toLowerCase() !== quoteRecord.email)
        throw new ApiError(409, '请使用本次报价对应的充值账号')
      if (preliminaryBalance > 0) {
        const wallet = await client.wallet.findUnique({ where: { userId: user!.id } })
        if (!wallet || wallet.balance < preliminaryBalance)
          throw new ApiError(409, '钱包余额不足，请先充值或选择其他支付方式')
      }
      const discounted = await reservePlusDiscount(
        client,
        quoteRecord.productId,
        quoteRecord,
        session,
        binding!,
      )
      if (!discounted && quoteRecord.pricingSnapshot?.plusDiscount?.standardEligible === false)
        throw new ApiError(409, '此套餐暂不可用，请重新检查账号后重试')
      const stock = discounted?.stock ?? (await reserveInventory(client, quoteRecord.productId))
      if (!stock) throw new ApiError(409, '此套餐暂时缺货，请稍后再试')
      if (discounted) quoteRecord.pricingSnapshot = discounted.snapshot
      const checked =
        discounted?.checked ??
        (await preflight(
          openCredential(stock.code, 'inventory', stock.id),
          session,
          binding!,
          fulfillmentBusiness(quoteRecord),
        ))
      if (checked.status !== 'ready')
        throw new UpstreamError('PRICE_REFRESH_PENDING', checked.retry_after ?? 2, false)
      validateFulfillment(checked, quoteRecord)
      if (Date.parse(quoteRecord.expiresAt) <= Date.now())
        throw new ApiError(409, '报价已过期，请重新检查账号')
      await client.quote.update({
        where: { id: quoteRecord.id },
        data: {
          inventoryId: stock.id,
          ...(discounted ? { pricingSnapshot: jsonInput(discounted.snapshot) } : {}),
          preflightToken: sealCredential(checked.preflight_token, 'preflight', quoteRecord.id),
          preflightExpiresAt: new Date((await databaseNow(client)).getTime() + 9 * 60_000),
        },
      })
    }
    let reservedCoupon: Awaited<ReturnType<typeof reserveCouponInTransaction>> | undefined
    if (normalizedCouponCode && quoteRecord && productRecord) {
      const targetCoupon =
        precheckedCoupon?.coupon ??
        (await client.coupon.findUnique({
          where: { code: normalizedCouponCode },
          select: { id: true },
        }))
      if (!targetCoupon) throw new ApiError(409, '优惠码不存在或已停用')
      reservedCoupon = await reserveCouponInTransaction(
        client,
        targetCoupon.id,
        normalizedCouponCode,
        orderId,
        {
          user,
          contactEmail,
          targetEmail: quoteRecord.email,
          product: { id: productRecord.id, upgrade: productRecord.upgrade },
          listAmount: baseListAmount,
        },
      )
    }
    const listAmount = reservedCoupon ? reservedCoupon.listAmount : baseListAmount
    const discountAmount = reservedCoupon ? reservedCoupon.discountAmount : 0
    const amount = reservedCoupon ? reservedCoupon.finalAmount : baseListAmount
    const balanceAmount = input.channel === 'balance' ? amount : (input.balanceAmount ?? 0)
    if (!Number.isSafeInteger(balanceAmount) || balanceAmount < 0 || balanceAmount > amount)
      throw new ApiError(400, '余额抵扣金额无效')
    const externalAmount = amount - balanceAmount
    if (externalAmount > 0 && input.channel !== 'balance' && !conf[input.channel])
      throw new ApiError(409, '此支付方式暂未开放')
    const revision =
      demo || externalAmount === 0 || provider === 'balance'
        ? null
        : (await integration(provider, undefined, client)).id
    const limitError = paymentLimitError(conf, input.channel, externalAmount)
    if (limitError) throw new ApiError(409, limitError)
    const buyerKey = quoteRecord ? hash(`buyer:${quoteRecord.email.toLowerCase()}`) : null
    let inviterId: string | null = null
    let referralRate = conf.rateBps
    if (quoteRecord) {
      if (reservedCoupon?.coupon.affiliateUserId) {
        const affiliate = reservedCoupon.affiliateUser
        if (affiliate && !affiliate.disabled) {
          const decision = await assessRisk(
            'referral-binding',
            {
              kind: 'referral',
              self:
                affiliate.id === user?.id ||
                [contactEmail, quoteRecord.email].includes(affiliate.email),
              firstOrderOnly: false,
              previous: false,
            },
            { user: user?.id, email: contactEmail, target: quoteRecord.email },
            orderId,
            client,
          )
          if (decision.action === 'allow') {
            inviterId = affiliate.id
            referralRate =
              reservedCoupon.coupon.affiliateRateBps !== null
                ? reservedCoupon.coupon.affiliateRateBps
                : referralProgress(
                    await qualifiedInvites(affiliate.id, client),
                    conf,
                    affiliate.referralTierId,
                  ).current.rateBps
          } else {
            referralRate = 0
          }
        } else {
          referralRate = 0
        }
      } else if (reservedCoupon && !reservedCoupon.coupon.allowReferral) {
        inviterId = null
        referralRate = 0
      } else {
        const buyer = await client.user.findUnique({
          where: { email: contactEmail },
          select: { invitedBy: true },
        })
        const inviter =
          buyer?.invitedBy || input.referralCode
            ? await client.user.findFirst({
                where: {
                  disabled: false,
                  ...(buyer?.invitedBy
                    ? { id: buyer.invitedBy }
                    : { referralCode: input.referralCode! }),
                },
                select: { id: true, email: true },
              })
            : null
        if (inviter) {
          const decision = await assessRisk(
            'referral-binding',
            {
              kind: 'referral',
              self:
                inviter.id === user?.id ||
                [contactEmail, quoteRecord.email].includes(inviter.email),
              firstOrderOnly: false,
              previous: false,
            },
            { user: user?.id, email: contactEmail, target: quoteRecord.email },
            orderId,
            client,
          )
          if (decision.action === 'allow') inviterId = inviter.id
        }
        const referralOwner = inviterId
          ? await client.user.findUniqueOrThrow({
              where: { id: inviterId },
              select: { referralTierId: true },
            })
          : null
        referralRate = inviterId
          ? referralProgress(
              await qualifiedInvites(inviterId, client),
              conf,
              referralOwner?.referralTierId,
            ).current.rateBps
          : conf.rateBps
      }
    }
    const order = orderView(
      await client.order.create({
        data: {
          id: orderId,
          userId: user?.id ?? null,
          quoteId: quoteRecord?.id ?? null,
          productId: quoteRecord?.productId ?? null,
          productName: name,
          email: quoteRecord?.email ?? user!.email,
          listAmount,
          discountAmount,
          amount,
          couponId: reservedCoupon?.coupon.id ?? null,
          couponCode: reservedCoupon?.coupon.code ?? null,
          couponSnapshot: reservedCoupon ? reservedCoupon.snapshot : Prisma.DbNull,
          status: externalAmount === 0 ? 'processing' : 'unpaid',
          channel: externalAmount === 0 ? 'balance' : input.channel,
          rateBps: referralRate,
          settlementDays: conf.settlementDays,
          firstOrderOnly: conf.firstOrderOnly,
          provider: externalAmount === 0 ? 'balance' : provider,
          integrationId: externalAmount === 0 ? null : revision,
          kind: quoteRecord ? 'purchase' : 'topup',
          requestHash,
          contactEmail,
          guestBrowserDigest: user ? null : browser,
          ipAddress: ipAddress ?? null,
          aicdkIntegrationId: quoteRecord?.aicdkIntegrationId ?? null,
          balanceAmount,
          externalAmount,
          inviterId,
          buyerKey,
        },
      }),
    )
    if (reservedCoupon) {
      await reservedCoupon.createRedemption(externalAmount > 0)
    }
    // Remote work and order foreign-key locks are finished. Serialize the final
    // check and commit; the new row is still invisible to other transactions.
    // Rejecting here rolls back the order, outbox, inventory and quote together.
    const subjects = { user: user?.id, email: contactEmail, target: quoteRecord?.email }
    for (const key of Object.entries(subjects)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([dimension, value]) => `risk:unpaid:${riskDigest(dimension, value)}`)
      .sort())
      await advisoryLock(client, key)
    const facts: RiskFacts = {
      kind: 'order',
      unpaidOrders: await client.order.count({
        where: {
          id: { not: orderId },
          status: 'unpaid',
          OR: [
            { contactEmail },
            ...(user ? [{ userId: user.id }] : []),
            ...(quoteRecord ? [{ kind: 'purchase', email: quoteRecord.email }] : []),
          ],
        },
      }),
    }
    const orderRisk = await assessRisk('order-assessment', facts, subjects, orderId, client)
    if (orderRisk.mode === 'enforce' && orderRisk.action !== 'allow')
      throw new RiskRejection('order-assessment', orderRisk, facts, subjects, orderId)
    if (balanceAmount > 0)
      await walletChange(client, user!.id, -balanceAmount, 'purchase', order.id)
    if (externalAmount === 0)
      await client.job.createMany({
        data: [{ id: id('job_'), orderId: order.id }],
        skipDuplicates: true,
      })
    return order
  }, checkoutTransaction).catch(recordRiskRejection)
  return outcome
}
export async function accessibleOrder(user: User | null, browser: string, orderId: string) {
  const order = await db.order.findFirst({
    where: {
      id: orderId,
      OR: [...(user ? [{ userId: user.id }] : []), { userId: null, guestBrowserDigest: browser }],
    },
  })
  if (!order) throw new ApiError(404, '未找到订单，请使用联系邮箱登录，或使用下单时的浏览器')
  return paymentOrderView(order)
}
export async function cancelOrder(user: User | null, browser: string, orderId: string) {
  return transaction(async (client) => {
    await lockRow(client, 'orders', orderId)
    const record = await client.order.findFirst({
      where: {
        id: orderId,
        OR: [...(user ? [{ userId: user.id }] : []), { userId: null, guestBrowserDigest: browser }],
      },
    })
    if (!record) throw new ApiError(404, '未找到订单')
    const order = paymentOrderView(record)
    if (order.status === 'cancelled') return { cancelled: true }
    if (order.status !== 'unpaid' || order.paymentAttempted)
      throw new ApiError(409, '支付已发起或订单已付款，请联系支持核对后处理，不能直接取消')
    if (order.balanceAmount > 0)
      await walletChange(client, order.userId!, order.balanceAmount, 'refund', order.id)
    await client.order.update({ where: { id: order.id }, data: { status: 'cancelled' } })
    if (order.quoteId) {
      await client.inventory.updateMany({
        where: {
          status: 'reserved',
          quotes: {
            some: { id: order.quoteId },
            none: { order: { status: { not: 'cancelled' } } },
          },
        },
        data: { status: 'available', reservedUntil: null },
      })
      await client.quote.updateMany({
        where: { id: order.quoteId },
        data: { preflightToken: null },
      })
    }
    await releaseCouponOrder(client, order.id)
    return { cancelled: true }
  })
}
export async function paymentInfo(
  user: User | null,
  orderId: string,
  clientIP: string,
  browser = '',
) {
  const order = await accessibleOrder(user, browser, orderId)
  if (order.status === 'cancelled') throw new ApiError(409, '订单已取消')
  if (order.status !== 'unpaid') return { paid: true }
  if (demo && order.paymentAttempted) return { demo: true }
  if (order.paymentUrl) return { paymentUrl: order.paymentUrl }
  const claimed = await db.order.updateMany({
    where: { id: order.id, paymentAttempted: false, status: 'unpaid' },
    data: { paymentAttempted: true },
  })
  if (!claimed.count)
    throw new ApiError(409, '支付单正在创建或结果待核对，请保留原订单并联系支持，不要重复付款')
  await confirmCouponOrderPaid(db, order.id)
  if (demo) return { demo: true }
  const payment = await createPayment(order, clientIP)
  await savePaymentLocation(order.id, payment.paymentId, payment.paymentUrl)
  return { paymentUrl: payment.paymentUrl }
}
export async function acceptPayment(provider: string, revision: string | null, receipt: Receipt) {
  if (
    !receipt.transactionId ||
    !receipt.orderId ||
    !Number.isSafeInteger(receipt.amount) ||
    receipt.amount <= 0
  )
    throw new ApiError(400, '回调字段不完整')
  return transaction(async (client) => {
    await lockRow(client, 'orders', receipt.orderId)
    const record = await client.order.findUnique({ where: { id: receipt.orderId } })
    if (!record || record.provider !== provider || record.integrationId !== revision)
      throw new ApiError(400, '订单归属不匹配')
    const order = paymentOrderView(record)
    if (
      order.externalAmount !== receipt.amount ||
      (receipt.channel && receipt.channel !== order.channel)
    )
      throw new ApiError(400, '付款信息不匹配')
    if (order.paymentId && order.paymentId !== receipt.transactionId)
      throw new ApiError(400, '支付交易号不匹配')
    if (!receipt.paid) return
    // Serialize a transaction ID even when concurrent notifications name different orders.
    await advisoryLock(client, `payment:${provider}:${receipt.transactionId}`)
    const previous = await client.paymentEvent.findUnique({
      where: { provider_transactionId: { provider, transactionId: receipt.transactionId } },
    })
    if (previous) {
      if (previous.orderId !== order.id) throw new ApiError(409, '交易号已用于其他订单')
      return
    }
    if (order.status !== 'unpaid') throw new ApiError(409, '订单状态不允许收款')
    await client.paymentEvent.create({
      data: { provider, transactionId: receipt.transactionId, orderId: order.id },
    })
    if (order.kind === 'topup') {
      await walletChange(client, order.userId!, order.amount, 'topup', order.id)
      await client.order.update({
        where: { id: order.id },
        data: {
          status: 'completed',
          completedAt: await databaseNow(client),
          paymentId: receipt.transactionId,
        },
      })
    } else {
      await client.order.update({
        where: { id: order.id },
        data: { status: 'processing', paymentId: receipt.transactionId },
      })
      await confirmCouponOrderPaid(client, order.id)
      await client.job.createMany({
        data: [{ id: id('job_'), orderId: order.id }],
        skipDuplicates: true,
      })
    }
  })
}
// Keep buyer, user and order locks in the same order for automatic and manual completion.
export async function lockOrderForCompletion(client: DbClient, orderId: string) {
  const record = await client.order.findUnique({ where: { id: orderId } })
  if (!record) return null
  const initial = paymentOrderView(record)
  for (const key of [
    ...new Set([
      initial.buyerKey || hash(`buyer:${initial.email.toLowerCase()}`),
      hash(`contact:${initial.contactEmail.toLowerCase()}`),
    ]),
  ].sort())
    await advisoryLock(client, key)
  await lockRow(client, 'users', initial.userId)
  await lockRow(client, 'orders', orderId)
  return client.order.findUniqueOrThrow({ where: { id: orderId } })
}

// The caller holds lockOrderForCompletion and commits all related changes together.
export async function completeOrderInTransaction(client: DbClient, record: OrderRecord) {
  const order = paymentOrderView(record)
  if (order.status === 'completed') return
  if (!['processing', 'needs_session'].includes(order.status) || order.kind !== 'purchase')
    throw new ApiError(409, '订单状态不允许完成')
  await client.order.update({
    where: { id: order.id },
    data: { status: 'completed', completedAt: await databaseNow(client) },
  })
  await markCouponOrderRedeemed(client, order.id)
  if (order.quoteId) {
    await client.inventory.updateMany({
      where: { quotes: { some: { id: order.quoteId } } },
      data: { status: 'consumed', reservedUntil: null },
    })
    await client.quote.updateMany({
      where: { id: order.quoteId },
      data: { preflightToken: null },
    })
  }
  const user = order.userId ? await client.user.findUnique({ where: { id: order.userId } }) : null
  const inviterId = order.inviterId || (order.buyerKey ? null : user?.invitedBy)
  if (inviterId && order.rateBps > 0) {
    const previous = await client.order.findFirst({
      where: {
        id: { not: order.id },
        status: 'completed',
        kind: 'purchase',
        OR: [
          { email: order.email },
          ...(order.userId ? [{ userId: order.userId }] : []),
          { contactEmail: order.contactEmail },
        ],
      },
      select: { id: true },
    })
    const decision = await assessRisk(
      'referral-settlement',
      {
        kind: 'referral',
        self: inviterId === order.userId,
        firstOrderOnly: order.firstOrderOnly,
        previous: Boolean(previous),
      },
      { user: order.userId || undefined, email: order.contactEmail, target: order.email },
      order.id,
      client,
    )
    if (decision.action === 'allow') {
      const amount = Math.floor((order.amount * order.rateBps) / 10000)
      if (amount > 0)
        await client.commission.createMany({
          data: [
            {
              id: id('c_'),
              userId: inviterId,
              orderId: order.id,
              amount,
              status: 'pending',
              availableAt: new Date(
                (await databaseNow(client)).getTime() + order.settlementDays * 86400_000,
              ),
            },
          ],
          skipDuplicates: true,
        })
    }
  }
}

export async function completeOrder(orderId: string) {
  await transaction(async (client) => {
    const record = await lockOrderForCompletion(client, orderId)
    if (record) await completeOrderInTransaction(client, record)
  })
}
export async function account(user: User): Promise<AccountData> {
  const conf = await settings()
  return transaction(
    async (client) => {
      await readOnlyTransaction(client)
      const orders = (
        await client.order.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 200,
        })
      ).map(orderView)
      const commissions = (
        await client.commission.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
        })
      ).map(commissionView)
      const withdrawals = (
        await client.withdrawal.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
        })
      ).map(storedWithdrawalView)
      const invitedCount = await client.user.count({ where: { invitedBy: user.id } })
      const ledger = (
        await client.walletEntry.findMany({
          where: { userId: user.id },
          orderBy: { createdAt: 'desc' },
          take: 200,
        })
      ).map(walletEntryView)
      const wallet = await client.wallet.findUnique({ where: { userId: user.id } })
      const qualified = await qualifiedInvites(user.id, client)
      const owner = await client.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { referralTierId: true },
      })
      const affiliateCoupons = await affiliateCouponsForUser(client, user.id)
      return {
        orders,
        commissions,
        withdrawals: withdrawals.map(withdrawalView),
        invitedCount,
        referral: referralProgress(qualified, conf, owner.referralTierId),
        ...referralFunds(commissions, withdrawals),
        balance: wallet?.balance ?? 0,
        ledger,
        affiliateCoupons,
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )
}

function withdrawalView(withdrawal: Withdrawal): Withdrawal {
  // Never expose internal idempotency digests or encrypted payloads in account responses.
  return {
    id: withdrawal.id,
    userId: withdrawal.userId,
    amount: withdrawal.amount,
    method: withdrawal.method,
    account: decrypt(withdrawal.account, `withdrawal:${withdrawal.userId}`),
    recipientName: withdrawal.recipientName
      ? decrypt(withdrawal.recipientName, `withdrawal-name:${withdrawal.userId}`)
      : '',
    network: withdrawal.network,
    feeAmount: withdrawal.feeAmount,
    feeRateBps: withdrawal.feeRateBps,
    fixedFee: withdrawal.fixedFee,
    netAmount: withdrawal.amount - withdrawal.feeAmount,
    status: withdrawal.status,
    note: withdrawal.note,
    payoutReference: withdrawal.payoutReference,
    payoutAmount: withdrawal.payoutAmount,
    reviewerId: withdrawal.reviewerId,
    reviewedAt: withdrawal.reviewedAt,
    createdAt: withdrawal.createdAt,
  }
}

async function lockedReferralFunds(client: DbClient, userId: string) {
  await lockCommissions(client, userId)
  const commissions = (await client.commission.findMany({ where: { userId } })).map(commissionView)
  const withdrawals = (await client.withdrawal.findMany({ where: { userId } })).map(
    storedWithdrawalView,
  )
  return referralFunds(commissions, withdrawals)
}

export async function withdraw(user: User, data: unknown) {
  const input = withdrawalSchema.parse(data)
  const outcome = await transaction(async (client) => {
    await lockRow(client, 'users', user.id)
    const requestKey = hash(`${user.id}:${input.requestKey}`)
    const requestHash = hash(
      JSON.stringify({
        amount: input.amount,
        method: input.method,
        account: input.account,
        recipientName: input.recipientName,
        network: input.network,
        ...(input.expectedFeeAmount ? { expectedFeeAmount: input.expectedFeeAmount } : {}),
      }),
    )
    const stored = await client.withdrawal.findUnique({ where: { requestKey } })
    const existing = stored ? storedWithdrawalView(stored) : null
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ApiError(409, '同一请求标识不能用于不同的提现参数，请重新打开申请表')
      return withdrawalView(existing)
    }
    // Serialize new reservations with settings changes. Existing request retries
    // still resolve after a channel closes without reserving another amount.
    await lockSettings(client, 'share')
    const configuration = await client.setting.findUnique({ where: { id: 1 } })
    if (!configuration) throw new ApiError(503, '请先初始化数据库')
    const conf = settingsData(configuration.body)
    const channelError = withdrawalChannelError(conf, input.method, input.network)
    if (channelError) throw new ApiError(409, channelError)
    const rule = withdrawalRule(conf, input.method, input.network)!
    if (input.amount < rule.minimum)
      throw new ApiError(400, `所选提现渠道最低起提 ${money(rule.minimum)}`)
    const fee = withdrawalFee(input.amount, rule)
    if (fee.netAmount <= 0) throw new ApiError(400, '扣除手续费后的到账金额必须大于 0')
    if (input.expectedFeeAmount !== fee.feeAmount)
      throw new ApiError(409, '提现手续费已调整，请核对新的手续费后重新确认')
    const funds = await lockedReferralFunds(client, user.id)
    if (input.amount > funds.available)
      throw new ApiError(409, '可提现邀请收益不足，请刷新额度；充值和退款余额不可提现')
    const fingerprint = payoutFingerprint(input.method, input.network, input.account)
    await advisoryLock(client, `risk:payout:${fingerprint}`)
    const related = await client.withdrawal.findMany({
      where: { payoutFingerprint: fingerprint },
      distinct: ['userId'],
      select: { userId: true },
    })
    const owner = await client.user.findUniqueOrThrow({ where: { id: user.id } })
    const withdrawalId = id('w_')
    const withdrawalRisk = await assessRisk(
      'withdrawal-assessment',
      {
        kind: 'withdrawal',
        sharedPayoutUsers: new Set([...related.map((row) => row.userId), user.id]).size,
        accountAgeHours: Math.max(
          0,
          ((await databaseNow(client)).getTime() - owner.createdAt.getTime()) / 3600000,
        ),
      },
      { user: user.id },
      withdrawalId,
      client,
    )
    if (withdrawalRisk.mode === 'enforce' && withdrawalRisk.action === 'deny')
      return { riskBlocked: true as const }
    const withdrawal = storedWithdrawalView(
      await client.withdrawal.create({
        data: {
          id: withdrawalId,
          userId: user.id,
          amount: input.amount,
          method: input.method,
          account: encrypt(input.account, `withdrawal:${user.id}`),
          payoutFingerprint: fingerprint,
          requestKey,
          requestHash,
          recipientName: encrypt(input.recipientName, `withdrawal-name:${user.id}`),
          network: input.network,
          feeAmount: fee.feeAmount,
          feeRateBps: fee.feeRateBps,
          fixedFee: fee.fixedFee,
        },
      }),
    )
    return withdrawalView(withdrawal)
  })
  if ('riskBlocked' in outcome) throw new ApiError(403, '此提现申请需要人工核对，请联系支持')
  return outcome
}

export async function withdrawalPayoutEstimate(
  withdrawalId: string,
  refresh = false,
): Promise<WithdrawalEstimate> {
  const record = await db.withdrawal.findUnique({ where: { id: withdrawalId } })
  if (!record) throw new ApiError(404, '提现申请不存在')
  const withdrawal = storedWithdrawalView(record)
  if (withdrawal.method !== 'USDT') throw new ApiError(400, '此申请无需 USDT 折算')
  if (!['pending', 'processing'].includes(withdrawal.status))
    throw new ApiError(409, '此申请已处理，无需估算打款数量')
  let rate = await exchangeRate(false, 'USDT')
  if (refresh || !rate) {
    if (refresh) await requestExchangeRefresh('USDT')
    await refreshExchangeRate('USDT')
    rate = await exchangeRate(false, 'USDT')
  }
  if (!rate) throw new ApiError(503, 'USDT 参考汇率暂不可用，请稍后刷新；仍可按实际打款数量登记')
  const netAmount = withdrawal.amount - withdrawal.feeAmount
  let estimatedUsdt: string
  try {
    estimatedUsdt = estimateUsdtAmount(netAmount, rate.rateE8)
  } catch {
    throw new ApiError(503, '参考转账数量超出支持范围，请核对汇率后重试')
  }
  return {
    withdrawalId,
    netAmount,
    estimatedUsdt,
    rate: rate.rateE8 / 100000000,
    source: rate.source ?? 'Currency API',
    sourceDate: rate.sourceDate,
    fetchedAt: rate.fetchedAt,
    expiresAt: rate.expiresAt,
    refreshFailed: !!(await exchangeRateStatus('USDT')).lastError,
  }
}

export async function reviewWithdrawal(actor: User, data: unknown) {
  const input = withdrawalReviewSchema.parse(data)
  return transaction(async (client) => {
    const owner = await client.withdrawal.findUnique({
      where: { id: input.id },
      select: { userId: true },
    })
    if (!owner) throw new ApiError(404, '提现申请不存在')
    await lockRow(client, 'users', owner.userId)
    await lockRow(client, 'withdrawals', input.id)
    const current = storedWithdrawalView(
      await client.withdrawal.findUniqueOrThrow({ where: { id: input.id } }),
    )
    if (!['pending', 'processing'].includes(current.status))
      throw new ApiError(409, '该提现已处理，请刷新')
    if (current.status === 'processing' && current.reviewerId !== actor.id)
      throw new ApiError(409, '该申请已由其他管理员受理，请由受理人完成处理')
    if (input.status === 'processing' && current.status !== 'pending')
      throw new ApiError(409, '该申请已受理，请刷新')
    if (input.status === 'paid' && current.status !== 'processing')
      throw new ApiError(409, '请先受理申请，核对收款信息后再登记实际打款')
    if (input.status !== 'rejected') {
      const funds = await lockedReferralFunds(client, current.userId)
      if (funds.shortfall > 0)
        throw new ApiError(409, '邀请收益发生冲回，额度不足；请先拒绝超额申请释放冻结额度')
    }
    let payoutAmount: number | null = null
    if (input.status === 'paid') {
      if (current.method === 'USDT' && !input.payoutAmount)
        throw new ApiError(400, '请填写实际到账 USDT 数量')
      payoutAmount =
        current.method === 'USDT' ? input.payoutAmount! : (current.amount - current.feeAmount) / 100
      if (
        payoutAmount < 0.000001 ||
        Math.abs(payoutAmount * 1000000 - Math.round(payoutAmount * 1000000)) > 0.0001
      )
        throw new ApiError(400, 'USDT 数量最多保留 6 位小数')
    }
    await client.withdrawal.update({
      where: { id: input.id },
      data: {
        status: input.status,
        note: input.note,
        reviewerId: actor.id,
        reviewedAt: await databaseNow(client),
        payoutReference: input.status === 'paid' ? input.payoutReference : '',
        payoutAmount: payoutAmount === null ? null : new Prisma.Decimal(payoutAmount.toFixed(6)),
      },
    })
    await audit(
      actor.email,
      {
        processing: '受理提现，待人工打款',
        paid: '登记提现打款',
        rejected: '拒绝提现，释放邀请额度',
      }[input.status],
      input.id,
      client,
    )
    return { saved: true }
  }).catch((error) => {
    if (uniqueConflict(error)) throw new ApiError(409, '此打款流水号已登记，请核对后刷新')
    throw error
  })
}
export async function adminData(
  actor: User,
  query: AdminQuery = adminQuerySchema.parse({}),
): Promise<
  AdminData & { integrations: Awaited<ReturnType<typeof integrationViews>>; roles: unknown[] }
> {
  const can = (permission: string) => actor.permissions.includes(permission)
  const section = query.section
  const permission = section === 'risk' ? 'audit' : section === 'roles' ? 'users' : section
  if (section !== 'overview' && !can(`${permission}:read`))
    throw new ApiError(403, '当前角色没有此记录的查看权限')
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]
  const window = (active: boolean, recent = 500) =>
    active
      ? { take: adminPageSize, skip: (query.page - 1) * adminPageSize }
      : { take: recent, skip: 0 }
  const orderWhere: Prisma.OrderWhereInput = {
    ...(section === 'wallet' || !can('orders:read')
      ? {
          OR: [
            { kind: 'topup' },
            { balanceAmount: { gt: 0 } },
            { status: 'refunded', refundDestination: 'wallet' },
          ],
        }
      : {}),
    ...(['orders', 'wallet'].includes(section) && query.search
      ? {
          AND: [
            {
              OR: ['id', 'email', 'contactEmail', 'productName', 'ipAddress', 'couponCode'].map(
                (field) => ({
                  [field]: { contains: query.search, mode: 'insensitive' },
                }),
              ),
            },
          ],
        }
      : {}),
  }
  const userWhere: Prisma.UserWhereInput =
    ['users', 'roles'].includes(section) && query.search
      ? { email: { contains: query.search, mode: 'insensitive' } }
      : {}
  const couponWindow = window(section === 'coupons', 200)
  const couponResult = can('coupons:read')
    ? await adminCouponsList({
        search: section === 'coupons' ? query.search : '',
        take: couponWindow.take,
        skip: couponWindow.skip,
      })
    : { rows: [], total: 0 }
  const total =
    section === 'orders' || section === 'wallet'
      ? await db.order.count({ where: orderWhere })
      : section === 'coupons'
        ? couponResult.total
        : section === 'users' || section === 'roles'
          ? await db.user.count({ where: userWhere })
          : section === 'referral'
            ? await db.commission.count()
            : section === 'withdrawals'
              ? await db.withdrawal.count()
              : section === 'audit'
                ? await db.audit.count()
                : section === 'risk'
                  ? await db.riskEvent.count()
                  : 0
  const [users, allProducts, orders, commissions, withdrawals, conf, log, stock, integrations] =
    await Promise.all([
      db.user
        .findMany({
          orderBy,
          where: userWhere,
          ...window(['users', 'roles'].includes(section)),
          include: { userRoles: { select: { roleId: true } } },
        })
        .then((records) =>
          records.map((r) =>
            userView(
              r,
              r.userRoles.map((role) => role.roleId),
            ),
          ),
        ),
      products(true),
      db.order
        .findMany({ orderBy, where: orderWhere, ...window(['orders', 'wallet'].includes(section)) })
        .then((records) => records.map(adminOrderView)),
      db.commission
        .findMany({ orderBy, ...window(section === 'referral') })
        .then((records) => records.map(commissionView)),
      db.withdrawal
        .findMany({ orderBy, ...window(section === 'withdrawals') })
        .then((records) => records.map(storedWithdrawalView)),
      settings(),
      db.audit
        .findMany({ orderBy, ...window(section === 'audit', 100) })
        .then((records) => records.map(auditView)),
      db.inventory.groupBy({
        by: ['productId', 'batchId', 'status'],
        where: {
          OR: [
            { status: { in: ['reserved', 'consumed'] } },
            { enabled: true, OR: [{ batchId: null }, { batch: { enabled: true } }] },
          ],
        },
        _count: { _all: true },
      }),
      actor.permissions.includes('integrations:read') ? integrationViews() : Promise.resolve([]),
    ])
  const totals = new Map<string, AdminData['inventory'][number]>()
  for (const item of stock) {
    const total = totals.get(item.productId) ?? {
      productId: item.productId,
      available: 0,
      reserved: 0,
      consumed: 0,
    }
    if (item.status === 'available' || item.status === 'reserved' || item.status === 'consumed')
      total[item.status] += item._count._all
    totals.set(item.productId, total)
  }
  const inventory = [...totals.values()]
  const { upgradePricing: _pricing, ...publicSettings } = conf
  let overview: AdminData['overview']
  if (section === 'overview') {
    const [userCount, paidPurchases, completedPurchaseCount, attentionOrderCount, dailyRevenue] =
      await Promise.all([
        can('users:read') ? db.user.count() : undefined,
        can('orders:read')
          ? db.order.aggregate({
              where: {
                kind: 'purchase',
                status: { in: ['processing', 'completed', 'needs_session', 'failed'] },
              },
              _sum: { amount: true },
            })
          : undefined,
        can('orders:read')
          ? db.order.count({ where: { kind: 'purchase', status: 'completed' } })
          : undefined,
        can('orders:read')
          ? db.order.count({
              where: {
                OR: [
                  { status: { in: ['failed', 'needs_session'] } },
                  { fulfillmentResolution: { path: ['conflict'], not: Prisma.AnyNull } },
                  {
                    status: 'processing',
                    fulfillmentStatus: { in: ['requires_action', 'uncertain'] },
                  },
                ],
              },
            })
          : undefined,
        can('orders:read') ? dailyPurchaseRevenue() : undefined,
      ])
    overview = {
      userCount,
      purchaseAmount: paidPurchases ? (paidPurchases._sum.amount ?? 0) : undefined,
      completedPurchaseCount,
      attentionOrderCount,
      dailyRevenue,
    }
  }
  return {
    overview,
    pagination:
      section === 'overview' ? undefined : { page: query.page, pageSize: adminPageSize, total },
    pendingWithdrawalCount: can('withdrawals:read')
      ? await db.withdrawal.count({ where: { status: { in: ['pending', 'processing'] } } })
      : undefined,
    funnel: can('orders:read') ? await funnelReport() : undefined,
    exchangeRate: can('settings:read') ? await exchangeRateStatus() : undefined,
    users: can('users:read') ? users : [],
    products: can('products:read') ? allProducts : [],
    orders: can('orders:read')
      ? orders
      : can('wallet:read')
        ? orders.filter(
            (o) =>
              o.kind === 'topup' ||
              o.balanceAmount > 0 ||
              (o.status === 'refunded' && o.refund?.destination === 'wallet'),
          )
        : [],
    coupons: can('coupons:read') ? couponResult.rows : [],
    commissions: can('referral:read') ? commissions : [],
    withdrawals: can('withdrawals:read') ? withdrawals.map(withdrawalView) : [],
    settings: can('settings:read') ? conf : publicSettings,
    audit: can('audit:read') ? log : [],
    riskEvents: can('audit:read')
      ? (await db.riskEvent.findMany({ orderBy, ...window(section === 'risk', 100) })).map(
          (event) => ({
            id: event.id,
            scene: event.scene,
            action: event.action,
            effectiveAction: event.effectiveAction,
            mode: event.mode,
            ruleVersion: event.ruleVersion,
            reasonCodes: event.reasonCodes as string[],
            referenceId: event.referenceId,
            createdAt: event.createdAt.toISOString(),
          }),
        )
      : [],
    inventory: can('products:read') ? inventory : [],
    integrations,
    roles: can('roles:read') ? await db.role.findMany({ orderBy: { id: 'asc' } }) : [],
  }
}
async function completeRefund(client: DbClient, order: OrderRecord, actor: string) {
  const walletAmount = order.refundDestination === 'wallet' ? order.amount : order.balanceAmount
  if (walletAmount > 0) {
    if (!order.userId) throw new ApiError(409, '请联系用户先用联系邮箱登录，以接收钱包退款')
    await walletChange(client, order.userId, walletAmount, 'refund', order.id)
  }
  await client.order.update({
    where: { id: order.id },
    data: {
      status: 'refunded',
      refundStatus: 'completed',
      refundCompletedAt: await databaseNow(client),
    },
  })
  if (order.quoteId)
    await client.quote.updateMany({
      where: { id: order.quoteId },
      data: { preflightToken: null },
    })
  await client.job.updateMany({ where: { orderId: order.id }, data: { done: true } })
  await client.commission.updateMany({ where: { orderId: order.id }, data: { status: 'reversed' } })
  await releaseCouponOrder(client, order.id)
  await audit(
    actor,
    order.refundDestination === 'wallet' ? '失败订单退回钱包' : '确认订单原路退款完成',
    order.id,
    client,
  )
}

export async function refundFailedOrder(
  orderId: string,
  actor: string,
  data: unknown = { destination: 'wallet', automatic: false },
) {
  const parsed = refundInputSchema.safeParse(data)
  if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message ?? '请检查退款信息')
  const input = parsed.data
  const attempt = await transaction(async (client) => {
    await lockRow(client, 'orders', orderId)
    const order = await client.order.findUnique({ where: { id: orderId } })
    if (!order) throw new ApiError(404, '订单不存在')
    if (order.status === 'refunded') {
      if ((order.refundDestination ?? 'wallet') !== input.destination)
        throw new ApiError(409, '订单已按另一方式退款，请刷新查看退款记录')
      return null
    }
    if (order.status !== 'failed' || order.kind !== 'purchase')
      throw new ApiError(409, '仅已确认失败的套餐订单可退款')
    if (order.refundStatus) {
      if (input.destination !== order.refundDestination)
        throw new ApiError(409, '退款已发起，不能切换退款去向，请先核实原退款')
      if (input.reserveManual && order.refundAutomatic)
        throw new ApiError(409, '已发起渠道自动退款，不能另行打款')
      if (input.reserveManual && order.refundActor !== actor)
        throw new ApiError(409, '退款已由其他操作人接手，请核对记录，不要重复打款')
      if (!input.reconcile) return null
      const now = await databaseNow(client)
      if (
        order.refundStatus === 'processing' &&
        now.getTime() - order.refundRequestedAt!.getTime() < refundReviewDelayMs
      )
        throw new ApiError(409, '渠道退款仍在处理中，请稍后刷新核实')
      await client.order.update({
        where: { id: order.id },
        data: { refundResolutionNote: input.note, refundResolvedBy: actor },
      })
      await completeRefund(client, order, actor)
      return null
    }
    if (input.reconcile) throw new ApiError(409, '尚无待核实的退款，请刷新订单')
    if (input.round !== orderView(order).refillCount)
      throw new ApiError(409, '补充记录已更新，请刷新订单后重新核对退款')
    if (
      input.destination === 'original' &&
      !input.automatic &&
      !input.reserveManual &&
      canOfferRefill(order)
    )
      throw new ApiError(409, '请先锁定手动退款，再到支付渠道打款')
    if (
      order.fulfillmentResolution &&
      orderResolutionSchema.parse(order.fulfillmentResolution).conflict
    )
      throw new ApiError(409, '兑换结果冲突，请先核对到账情况，不能发起退款')
    if (input.destination === 'original' && order.externalAmount <= 0)
      throw new ApiError(409, '纯余额订单只能退回站内余额')
    if (input.automatic && order.provider !== 'xorpay')
      throw new ApiError(400, '此渠道不支持自动退款，请手动处理并填写备注')
    const walletAmount = input.destination === 'wallet' ? order.amount : order.balanceAmount
    if (walletAmount > 0 && !order.userId)
      throw new ApiError(409, '请联系用户先用联系邮箱登录，以接收钱包退款')
    if (order.externalAmount > 0) {
      const paid = order.paymentId
        ? await client.paymentEvent.findUnique({
            where: {
              provider_transactionId: {
                provider: order.provider,
                transactionId: order.paymentId,
              },
            },
          })
        : null
      if (paid?.orderId !== order.id)
        throw new ApiError(409, '缺少已确认的渠道付款记录，请先核对收款')
    }
    let secret = ''
    if (input.automatic && !demo) {
      if (!order.integrationId) throw new ApiError(409, '缺少原支付配置，请核实后手动退款')
      const config = await integration('xorpay', order.integrationId, client)
      if (!config.secret) throw new ApiError(409, '原支付配置缺少密钥，请核实后手动退款')
      secret = config.secret
    }
    const requestedAt = await databaseNow(client)
    if (input.reserveManual) {
      await client.order.update({
        where: { id: order.id },
        data: {
          refundDestination: 'original',
          refundStatus: 'review',
          refundActor: actor,
          refundRequestedAt: requestedAt,
          refundNote: input.note || '已锁定手动退款，待核实渠道打款记录',
        },
      })
      await audit(actor, '锁定手动原路退款', order.id, client)
      return null
    }
    if (!input.automatic) {
      // Record and complete manual/wallet refunds in one transaction.
      await client.order.update({
        where: { id: order.id },
        data: {
          status: 'refunded',
          refundDestination: input.destination,
          refundStatus: 'completed',
          refundNote: input.note,
          refundActor: actor,
          refundRequestedAt: requestedAt,
          refundCompletedAt: requestedAt,
        },
      })
      await completeRefund(client, { ...order, refundDestination: input.destination }, actor)
      return null
    }
    await client.order.update({
      where: { id: order.id },
      data: {
        refundDestination: 'original',
        refundStatus: 'processing',
        refundAutomatic: true,
        refundNote: input.note,
        refundActor: actor,
        refundRequestedAt: requestedAt,
      },
    })
    await audit(actor, '发起 XorPay 原路退款', order.id, client)
    return { paymentId: order.paymentId!, amount: order.externalAmount, secret, requestedAt }
  })
  if (attempt) {
    let confirmed = false
    try {
      if (Date.now() - attempt.requestedAt.getTime() >= refundReviewDelayMs)
        throw new Error('Refund submission expired')
      if (!demo) await refundXorpay(attempt.paymentId, attempt.amount, attempt.secret)
      confirmed = true
    } catch {
      // A timeout may conceal success. Never release the claim or resend.
    }
    await transaction(async (client) => {
      await lockRow(client, 'orders', orderId)
      const order = await client.order.findUniqueOrThrow({ where: { id: orderId } })
      if (order.refundStatus === 'completed') return
      if (confirmed) await completeRefund(client, order, actor)
      else {
        await client.order.update({ where: { id: orderId }, data: { refundStatus: 'review' } })
        await audit(actor, '原路退款结果待核实，禁止重复发起', orderId, client)
      }
    })
  }
  const order = adminOrderView(await db.order.findUniqueOrThrow({ where: { id: orderId } }))
  return { refunded: order.status === 'refunded', order }
}
export async function confirmSession(
  user: User | null,
  orderId: string,
  sessionText: string,
  browser = '',
) {
  let session: ReturnType<typeof parseSession>
  try {
    session = parseSession(sessionText)
  } catch {
    throw new ApiError(400, '账号信息格式不正确，请重新复制完整信息')
  }
  const initial = await accessibleOrder(user, browser, orderId)
  if (session.user.email.toLowerCase() !== initial.email)
    throw new ApiError(400, '请使用原充值账号的信息')
  // A lost response to a completed refresh does not require another mutation.
  if (initial.status === 'processing') return { resumed: true }
  if (initial.status !== 'needs_session') throw new ApiError(409, '当前订单不需要更新账号信息')
  if (!demo && !initial.aicdkIntegrationId) throw new ApiError(409, '订单配置需由管理员核对')
  const binding = demo ? undefined : await resolveAicdk(initial.aicdkIntegrationId!)
  await transaction(async (client) => {
    await lockRow(client, 'orders', orderId)
    const record = await client.order.findFirst({
      where: {
        id: orderId,
        OR: [...(user ? [{ userId: user.id }] : []), { userId: null, guestBrowserDigest: browser }],
      },
    })
    if (!record) throw new ApiError(404, '未找到订单')
    const order = paymentOrderView(record)
    if (order.status === 'processing') return
    if (order.status !== 'needs_session') throw new ApiError(409, '当前订单不需要更新账号信息')
    if (binding) {
      const quoteId = order.quoteId
      if (!quoteId) throw new ApiError(409, '订单报价需由管理员核对')
      await lockRow(client, 'quotes', quoteId)
      const stored = await client.quote.findUnique({ where: { id: quoteId } })
      if (!stored) throw new ApiError(409, '订单报价需由管理员核对')
      const quote = quoteView(stored)
      const requestId = redemptionRequestId(order.id, order.refillCount)
      let recovered = order.redemptionId
        ? await getRedemption(order.redemptionId, binding)
        : await findRedemption(requestId, binding)
      if (recovered) {
        validateFulfillment(recovered, quote, requestId)
        if (recovered.status === 'needs_session') {
          recovered = await updateAccountSession(
            recovered.id,
            session,
            `${requestId}-session-${secretHash(JSON.stringify(session))}`,
            binding,
          )
          validateFulfillment(recovered, quote, requestId)
        }
        if (recovered.version < order.redemptionVersion)
          throw new ApiError(409, '订单状态正在同步，请稍后重试')
        await client.order.update({
          where: { id: order.id },
          data: {
            redemptionId: recovered.id,
            redemptionVersion: recovered.version,
            fulfillmentStatus: recovered.status,
          },
        })
        await client.quote.update({ where: { id: quote.id }, data: { preflightToken: null } })
      } else {
        if (order.submissionAttempted)
          throw new ApiError(409, '原兑换请求的结果仍待核对，请联系支持，不能重新发起')
        await lockRow(client, 'inventory', quote.inventoryId)
        const stock = quote.inventoryId
          ? await client.inventory.findFirst({
              where: { id: quote.inventoryId, status: 'reserved' },
            })
          : null
        if (!stock) throw new ApiError(409, '订单库存需由管理员核对')
        const checked = await preflight(
          openCredential(stock.code, 'inventory', stock.id),
          session,
          binding,
          fulfillmentBusiness(quote),
          quote.pricingSnapshot?.fulfillment?.country,
        )
        if (checked.status !== 'ready')
          throw new UpstreamError('PRICE_REFRESH_PENDING', checked.retry_after ?? 2, false)
        validateFulfillment(checked, quote)
        await client.order.update({
          where: { id: order.id },
          data: {
            fulfillmentAttempt: { increment: 1 },
            submissionAttempted: false,
          },
        })
        await client.quote.update({
          where: { id: quote.id },
          data: {
            preflightToken: sealCredential(checked.preflight_token, 'preflight', quote.id),
            preflightExpiresAt: new Date((await databaseNow(client)).getTime() + 9 * 60_000),
          },
        })
      }
    }
    await client.order.update({ where: { id: order.id }, data: { status: 'processing' } })
    await client.job.upsert({
      where: { orderId: order.id },
      create: { id: id('job_'), orderId: order.id },
      update: { done: false, runAt: await databaseNow(client), lockedUntil: null },
    })
  }, upstreamTransaction)
  return { resumed: true }
}
