import { openAdminPage } from './admin-helpers'
import { expect, test } from '@playwright/test'
import { db, Prisma } from '../src/server/db'
import { id } from '../src/server/crypto'
import type { AdminOrder } from '../src/types'

test.afterAll(async () => {
  await db.$disconnect()
})

test('admin refunds enforce channel capabilities, required notes and split amounts', async ({
  page,
}) => {
  await page.goto('/')
  await page
    .getByRole('button', { name: /登录 \/ 注册/ })
    .first()
    .click()
  await page.getByPlaceholder('you@example.com').fill('admin@example.com')
  await page.getByRole('button', { name: '获取验证码', exact: true }).click()
  const code = page.getByText(/本地演示验证码：/)
  await expect(code).toBeVisible()
  await page
    .getByPlaceholder('6 位验证码', { exact: true })
    .fill((await code.textContent())!.match(/\d{6}/)![0])
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /登录 \/ 注册/ })
    .click()
  await expect(page.getByRole('dialog')).toBeHidden()
  const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } })
  const orders = []
  for (const provider of ['xorpay', 'epay_v1', 'gmpay']) {
    const order = await db.order.create({
      data: {
        id: id(),
        userId: admin.id,
        kind: 'purchase',
        status: 'failed',
        provider,
        productName: `退款 UI ${provider}`,
        email: 'refund@example.com',
        contactEmail: admin.email,
        listAmount: 10000,
        amount: 10000,
        balanceAmount: 4000,
        externalAmount: 6000,
        channel: provider === 'gmpay' ? 'crypto' : provider === 'xorpay' ? 'alipay' : 'wechat',
        paymentId: id(),
        rateBps: 200,
        settlementDays: 7,
        firstOrderOnly: false,
      },
    })
    await db.paymentEvent.create({
      data: { orderId: order.id, provider, transactionId: order.paymentId! },
    })
    orders.push(order)
  }
  const stale = await db.order.create({
    data: {
      ...orders[0],
      refillHistory: [],
      fulfillmentResolution: orders[0].fulfillmentResolution ?? Prisma.DbNull,
      couponSnapshot: orders[0].couponSnapshot ?? Prisma.DbNull,
      id: id(),
      paymentId: id(),
      productName: '退款 UI 待核实',
      refundDestination: 'original',
      refundStatus: 'processing',
      refundAutomatic: true,
      refundRequestedAt: new Date(Date.now() - 120000),
      refundActor: 'original-admin@example.com',
      refundNote: '原申请备注',
    },
  })
  const manualOrderId = orders[1].id
  await page.route('**/api/admin?*', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    const eligible = data.orders?.find((order: AdminOrder) => order.id === manualOrderId)
    if (eligible && !eligible.refund) eligible.canRefill = true
    await route.fulfill({ response, json: data })
  })
  await page.goto('/admin')
  await openAdminPage(page, '订单管理')
  const dialog = page.getByRole('dialog')
  const row = (provider: string) => page.getByRole('row').filter({ hasText: `退款 UI ${provider}` })
  await row('xorpay').getByRole('button', { name: '处理退款' }).click()
  const automatic = dialog.getByRole('checkbox', { name: '自动完成退款' })
  await expect(automatic).toBeEnabled()
  await expect(automatic).toBeChecked()
  await automatic.uncheck()
  await expect(dialog.getByRole('button', { name: '确认已退款并登记' })).toBeDisabled()
  await automatic.check()
  await expect(dialog.locator('.refund-breakdown')).toContainText('¥60.00')
  await expect(dialog.locator('.refund-breakdown')).toContainText('¥40.00')
  await dialog.getByRole('button', { name: '确认退款 ¥100.00' }).click()
  await expect(dialog).toBeHidden()
  await expect(row('xorpay')).toContainText('已退款')

  await row('epay_v1').getByRole('button', { name: '处理退款' }).click()
  await expect(automatic).toBeDisabled()
  await expect(automatic).not.toBeChecked()
  await dialog.getByRole('button', { name: '先锁定手动退款' }).click()
  await expect(dialog).toContainText('手动退款已锁定，本单不能再补充')
  const reconcileManual = dialog.getByRole('button', { name: '确认渠道已退款并登记' })
  await expect(reconcileManual).toBeDisabled()
  await dialog.getByRole('textbox', { name: '核实备注' }).fill('   ')
  await expect(reconcileManual).toBeDisabled()
  const confirm = dialog.getByRole('button', { name: '确认已退款并登记' })
  const note = '已在微信商户后台退回 ¥60.00，退款单号 UI-fixture'
  await dialog.getByRole('textbox', { name: '核实备注' }).fill(note)
  await reconcileManual.click()
  await expect(dialog).toBeHidden()
  await row('epay_v1').getByRole('button', { name: '退款记录' }).click()
  await expect(dialog).toContainText(note)
  await expect(dialog).toContainText('手动退款登记')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  await row('gmpay').getByRole('button', { name: '处理退款' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(automatic).toBeDisabled()
  await expect(automatic).not.toBeChecked()
  await expect(dialog).toContainText('交易哈希')
  await expect(confirm).toBeDisabled()
  await dialog
    .getByRole('textbox', { name: '退款备注' })
    .fill('已按原支付记录退回 USDT，TRC20，收款地址 fixture，交易哈希 fixture')
  await expect(confirm).toBeEnabled()
  // Ant Design animates the opening scale around the clicked table row.
  // Measure the settled modal, rather than a transient animation frame.
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
  await expect
    .poll(() => dialog.evaluate((element) => getComputedStyle(element).transform))
    .toBe('none')
  await expect
    .poll(async () => {
      const bounds = (await dialog.boundingBox())!
      return bounds.x >= 0 && bounds.x + bounds.width <= 390
    })
    .toBe(true)
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const choices = await dialog
    .locator('.refund-destinations .ant-radio-wrapper')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width))
  expect(Math.abs(choices[0] - choices[1])).toBeLessThan(1)
  await page.screenshot({ path: 'test-results/refund-manual-mobile.png', animations: 'disabled' })
  await confirm.click()
  await expect(dialog).toBeHidden()
  for (const order of orders) {
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'refunded',
      refundDestination: 'original',
      refundStatus: 'completed',
      refundAutomatic: order.provider === 'xorpay',
    })
    const ledger = await db.walletEntry.findUniqueOrThrow({
      where: { orderId_kind: { orderId: order.id, kind: 'refund' } },
    })
    expect(ledger.amount).toBe(4000)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await row('待核实').getByRole('button', { name: '核实退款' }).click()
  await expect(automatic).toBeDisabled()
  await expect(automatic).toBeChecked()
  await expect(dialog.getByRole('radio', { name: /退回原支付方式/ })).toBeDisabled()
  await expect(dialog.getByRole('radio', { name: /退回站内余额/ })).toBeDisabled()
  const reconcile = dialog.getByRole('button', { name: '确认渠道已退款并登记' })
  await expect(reconcile).toBeDisabled()
  await dialog
    .getByRole('textbox', { name: '核实备注' })
    .fill('渠道后台核实已全额退款，退款单号 fixture-reviewed')
  await reconcile.click()
  await expect(dialog).toBeHidden()
  expect(await db.order.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({
    refundStatus: 'completed',
    refundActor: 'original-admin@example.com',
    refundResolvedBy: 'admin@example.com',
    refundResolutionNote: '渠道后台核实已全额退款，退款单号 fixture-reviewed',
  })
})
