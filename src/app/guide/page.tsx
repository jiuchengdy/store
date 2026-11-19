import Link from 'next/link'
import { Support } from '../../components/Support'
import { pageMetadata } from '../../seo'
export const metadata = pageMetadata(
  'ChatGPT 充值指南｜账号准备、付款与查单',
  '了解 ChatGPT 充值的套餐选择、账号信息准备、付款确认和游客订单查询，以及退款方式。',
  '/guide',
)
export default function Guide() {
  return (
    <main className="container prose-page">
      <div className="eyebrow">GET STARTED</div>
      <h1>ChatGPT 充值指南：账号准备、付款与查单</h1>
      <p className="lead">先确认账号，再付款。每一步都可以在订单中继续。</p>
      <h2>1. 选择套餐</h2>
      <p>
        在<Link href="/compare">套餐对比页</Link>
        查看充值内容、适合的用户与价格。已有订阅时，请先确认账号适用性，不要重复购买。
      </p>
      <h2 id="account-info">2. 准备账号信息</h2>
      <p>
        登录你要充值的 ChatGPT
        账号，先确认当前登录邮箱就是要充值的账号。本站账号检查需要包含邮箱、accessToken 和
        sessionToken 的完整会话 JSON。不同登录方式提供的字段可能不同，普通个人资料或仅含 accessToken
        的内容不能代替完整会话。
      </p>
      <ol>
        <li>
          先阅读下方本站提供的操作指引。尚无指引、字段缺失或步骤与当前页面不符时，请联系支持确认，不要自行拼接字段。
        </li>
        <li>在理解授权用途后，仅将指引要求的完整内容粘贴到本站结算页的“账号会话信息”输入框。</li>
        <li>检查结果显示后核对充值邮箱；邮箱不正确时选择“更换”，不要继续付款。</li>
      </ol>
      <Support guide />
      <p>
        会话信息属于敏感登录凭证，并非普通账号编号。请勿分享到群聊或提交给无关网站。本站不要求你提供账号密码。
      </p>
      <h2>3. 确认邮箱、套餐和金额</h2>
      <p>
        先填写接收订单通知的联系邮箱，再提交需要充值的账号信息。检查通过后，核对套餐、两个邮箱和应付金额。联系邮箱可以与充值账号不同，游客无需先注册。
      </p>
      <h2>4. 付款与查看进度</h2>
      <p>
        支持的支付方式以结算页为准。付款结果由服务端核实，跳回网站并不代表充值已经完成。游客可在下单浏览器中查看原订单；更换设备后，用联系邮箱验证码登录，即可在“我的订单”查看进度。
      </p>
      <h3>怎样确认充值已经完成？</h3>
      <p>
        先查看本站订单是否显示“充值完成”，再登录同一个充值账号，核对账号内显示的套餐和订阅信息。
        付款通知只表示已收款；如果账号内的显示与订单不一致，请保留原订单并联系支持，
        不要重复购买。具体处理方式见<Link href="/help/payment">付款成功但未到账的排查说明</Link>。
      </p>
      <h2>5. 需要更新账号信息时</h2>
      <p>在原订单中提交同一充值账号的新信息。不要重新下单，以免重复购买。</p>
      <h2>6. 异常与退款</h2>
      <p>
        已确认失败的订单经核实后可退回原支付方式或退回本站钱包。余额抵扣部分退回钱包；涉及钱包退款的游客需用联系邮箱登录认领订单。具体退款去向和进度以订单记录为准。
      </p>
      <div className="catalog-links">
        <Link href="/compare" className="primary-link">
          查看套餐与服务说明 →
        </Link>
        <Link href="/help/payment">查看到账与退款问题</Link>
      </div>
    </main>
  )
}
