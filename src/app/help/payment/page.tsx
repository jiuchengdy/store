import Link from 'next/link'
import { pageMetadata } from '../../../seo'
import { refundSummary } from '../../../product-copy'
import { Support } from '../../../components/Support'
import { publicSupport } from '../../../server/public-support'

export const metadata = pageMetadata(
  'ChatGPT 充值未到账怎么办｜付款、查单与退款',
  '付款成功但 ChatGPT 尚未到账、订单需要更新账号信息、游客如何查单，以及原路退款和钱包退款说明。',
  '/help/payment',
)
export default async function PaymentHelp() {
  const support = await publicSupport()
  return (
    <main className="container prose-page">
      <h1>ChatGPT 充值未到账：付款、查单与退款说明</h1>
      <p className="lead">先查看原订单状态，避免重复下单或重复付款。</p>
      <h2>付款成功，为什么还没有到账？</h2>
      <p>
        收到付款与完成充值是两个步骤。订单显示“正在充值”时，表示收款已确认、交付尚在处理；只有“充值完成”表示已确认交付。支付后跳回本站不等于已到账。
      </p>
      <ol>
        <li>回到原订单，核对充值账号、套餐和当前状态，不要重新付款。</li>
        <li>仍显示未付款但支付账户已经扣款时，联系支持核对收款结果。</li>
        <li>显示正在充值时，在原订单跟踪进度；提示更新账号信息时按原订单指引处理。</li>
        <li>显示充值完成后，登录同一充值账号核对订阅信息；不一致时保留订单并联系支持。</li>
      </ol>
      <h2>订单提示需要更新账号信息</h2>
      <p>
        请在原订单中提交同一充值账号的新信息。原订单金额保持不变，不需要另买一个套餐；账号邮箱不一致时无法继续。
      </p>
      <h2>游客怎样找回订单？</h2>
      <p>
        在下单浏览器中保留订单页。更换设备或浏览器后，用下单时填写的联系邮箱登录，再打开“我的订单”。联系邮箱可以与充值账号邮箱不同。
      </p>
      <h2>失败订单的钱退到哪里？</h2>
      <p>{refundSummary}</p>
      <p>
        站内钱包余额可用于本站消费。钱包退款不等于支付宝、微信或加密货币账户到账，也不等于邀请收益提现。退款需先核实付款与交付结果。
      </p>
      <h2>可以取消未付款订单吗？</h2>
      <p>
        尚未发起渠道支付的订单可在订单页申请取消，已抵扣余额会退回钱包。已发起支付或付款结果尚未确认时，需要先核对状态，不能直接取消。
      </p>
      {support.cryptoEnabled && (
        <>
          <h2>用加密货币（USDT 等）付款</h2>
          <p>
            加密货币由第三方网关收款，收银台会让您自行选择链和币种。选择后才会生成收款地址；
            如果只看到「待付款」而没有地址，说明还没有选链，此时并未产生任何付款。
          </p>
          <p>
            转账金额以链上实际到账数量为准。到账后订单状态才会更新，链上确认时间可能从几分钟到几十分钟不等。
            如长时间未更新，请提供交易哈希（txid），我们据此核对。
          </p>
          <h2>加密货币订单的退款</h2>
          <p>
            网关不提供自动退款，退款由我们通过钱包人工转回您付款时使用的<strong>同一条链、同一个地址</strong>。
            退回数量按您<strong>实际到账的数量原数退回</strong>，
            <strong>不按人民币金额折算，汇率波动不影响退回数量</strong>。
          </p>
          <p>
            申请退款时请回信确认链与收款地址；打款完成后我们会提供交易哈希供您在链上核对。
            请注意：地址或链填错会造成无法找回的损失。
          </p>
        </>
      )}
      <h2>联系客服时需要提供什么？</h2>
      <p>
        提供订单号、当前状态和问题描述即可。请勿在邮件或聊天中发送密码、验证码及完整会话信息；截图请遮挡这些内容。
      </p>
      <div className="catalog-links">
        <Link href="/account" className="primary-link">
          登录查看我的订单 →
        </Link>
        <Link href="/terms">阅读完整服务说明</Link>
      </div>
      <Support />
    </main>
  )
}
