import Link from 'next/link'
import { products } from '../server/services'
import { PlanCard } from '../components/PlanCard'
import { PlanPrice } from '../components/PlanPrice'
import { ProPlanCard } from '../components/ProPlanCard'
import { Support } from '../components/Support'
import { JsonLd } from '../components/JsonLd'
import { pageMetadata, siteOrigin } from '../seo'
export const dynamic = 'force-dynamic'
export const metadata = pageMetadata(
  'ChatGPT Plus / Pro 充值｜套餐价格',
  '查看 ChatGPT 充值套餐与服务说明。为自己的账号充值，游客无需注册，先检查账号和价格，再付款并跟踪订单。',
  '/',
)
export default async function Home() {
  const catalog = await products()
  const proVariants = ['pro5', 'pro20', 'promax'].flatMap((plan) => {
    const product = catalog.find((p) => p.plan === plan)
    return product ? [product] : []
  })
  const proIds = new Set(proVariants.map((p) => p.id))
  const recommended = catalog.find((p) => p.featured) || catalog[0]
  return (
    <main className="storefront">
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'GetCodex Plus',
          url: siteOrigin(),
          inLanguage: 'zh-CN',
          description: '独立 ChatGPT 充值服务，与 OpenAI 无隶属关系。',
        }}
      />
      <section className="hero container">
        <div className="hero-copy">
          <div className="eyebrow">Go、Plus 与 Pro 充值套餐</div>
          <h1>
            更省心的 ChatGPT
            <br />
            <span>账号充值。</span>
          </h1>
          <p>
            学习、创作和编程，选适合自己的套餐。
            <br />
            价格清楚，本站不自动续扣。
          </p>
          <div className="hero-actions">
            <a href="#plans" className="primary-link">
              查看套餐与价格 <span aria-hidden="true">↓</span>
            </a>
            <Link href="/guide" className="text-link">
              第一次购买？查看指南 <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="hero-notes">
            <span>✓ 无需提前注册</span>
            <span>✓ 先验证后付款</span>
            <span>✓ 进度随时可查</span>
          </div>
        </div>
        <aside className="purchase-entry" aria-label="快速选购">
          {recommended ? (
            <div className="entry-plan">
              <div className="entry-heading">
                <span>{recommended.featured ? '推荐选项' : '从这里开始'}</span>
                <span>充值到自己的账号</span>
              </div>
              <h2>选择 {recommended.name}</h2>
              <p className="entry-subtitle">{recommended.subtitle}</p>
              <PlanPrice product={recommended} variant="hero" />
              <Link className="entry-cta" href={`/checkout?product=${recommended.id}`}>
                {recommended.priceStatus === 'pending' ? '查看套餐状态' : '开始充值'}
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          ) : (
            <div className="entry-plan">
              <h2>充值套餐准备中</h2>
              <p className="entry-terms">暂时没有可选的充值套餐，可以先了解购买流程。</p>
              <Link className="entry-cta" href="/guide">
                查看购买指南 <span aria-hidden="true">→</span>
              </Link>
            </div>
          )}
        </aside>
      </section>
      <section id="plans" className="plans-section">
        <div className="container">
          <div className="section-heading">
            <div>
              <div className="eyebrow">套餐与价格</div>
              <h2>找到适合你的使用方式。</h2>
              <p>从轻量使用到高阶模型，再到 10 倍、20 倍、50 倍额度，按需求选择。</p>
            </div>
            <Link href="/compare" className="secondary-link">
              比较全部套餐 <span aria-hidden="true">↗</span>
            </Link>
          </div>
          <div className="catalog-group">
            <div className="plan-grid">
              {catalog
                .filter((p) => !proIds.has(p.id))
                .map((product) => (
                  <PlanCard key={product.id} product={product} />
                ))}
              {proVariants.length > 0 && <ProPlanCard products={proVariants} />}
            </div>
          </div>
        </div>
      </section>
      <section className="container steps-section">
        <div className="section-heading">
          <div>
            <div className="eyebrow">购买流程</div>
            <h2>第一次充值，也能轻松完成。</h2>
          </div>
          <Link href="/guide" className="text-link">
            查看完整指南 →
          </Link>
        </div>
        <div className="how-grid">
          {[
            ['01', '选一个适合的套餐', '按使用需求选择充值档位。'],
            ['02', '检查账号，核对价格', '按指引提交账号信息，检查通过后再决定是否付款。'],
            ['03', '付款后，随时查看进度', '保留订单页；更换设备时，用联系邮箱登录查单。'],
          ].map(([n, title, desc]) => (
            <div className="how-step" key={n}>
              <span>{n}</span>
              <h3>{title}</h3>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="container faq-section">
        <div>
          <div className="eyebrow">购买前，了解清楚</div>
          <h2>ChatGPT 充值常见问题</h2>
          <p className="muted">账号、交付和售后，你关心的事在这里。</p>
          <Link href="/help/payment" className="text-link">
            查看完整售后说明 →
          </Link>
        </div>
        <div className="faq-list">
          {[
            [
              '需要提供账号密码吗？',
              '不需要提供密码。充值需要完整的账号会话信息，它属于敏感登录凭证。请仅在确认服务方与用途后提交，并避免发送给无关人员。',
            ],
            [
              '付款后在哪里查看进度？',
              '游客可保留订单页查看；更换设备后，用联系邮箱登录查看“我的订单”。付款成功与充值完成是两个独立状态，请以“充值完成”为准。',
            ],
            [
              '遇到充值失败怎么办？',
              '保留原订单，不要重复购买。已确认失败的订单经核实后可退回原支付方式或退回本站钱包；涉及钱包退款的游客需用联系邮箱登录认领订单。',
            ],
          ].map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <span>+</span>
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="container purchase-support">
        <Support />
        <Link href="/help/payment" className="text-link">
          付款、到账与退款问题 →
        </Link>
      </section>
      <section className="container referral-section">
        <div className="referral-strip">
          <div>
            <h2>用得满意，再分享给朋友。</h2>
            <p>朋友通过你的链接购买并完成充值，你可以获得邀请返现。</p>
          </div>
          <Link href="/referral" className="secondary-link">
            了解邀请奖励 <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </section>
    </main>
  )
}
