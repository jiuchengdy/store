# 部署者自配置项清单（Deployer-owned settings）

> 本项目**会提供给下游代理商自托管**。凡是「每个部署应该不一样」的东西，都必须能在后台配置或部署时改掉，**不能写死在代码里**。
> 这份清单是我按代码实际搜索结果整理的（不是凭印象），每一条都带 `文件:行号`，方便部署时逐条过。
> 最后核对时间：2026-11-19，仓库 `c34caca` + 审计后改动。

## 一、已经在后台配置、不需要改代码

| 项 | 位置 | 备注 |
|---|---|---|
| 支持邮箱 `supportEmail` | 后台 → 网站设置 → 支持邮箱（`settings.body.supportEmail`） | **留空时站点会显示「支持联系方式尚未公布……请先暂停购买」**，等于劝买家别买。上线前必填 |
| 账号操作指引 `sessionGuideUrl` | 同上 | 为空则不渲染入口 |
| 在线客服 Tawk `tawk.enabled/propertyId` | 同上 | 开开关 + 填 Property ID |
| 支付渠道（XorPay / GMPay / 易支付） | 后台 → 集成 | 每家一个 integration，含密钥 |
| 上游采购（Dujiao-Next）/ 兑换（AICDK） | 后台 → 集成 | 含 API Key / Secret |
| 邮件服务（SMTP / Resend / Sendflare） | 后台 → 集成 | |
| 商品、价格、库存批次、优惠码 | 后台 | |
| 站点地址 `APP_URL` | 部署环境变量 | 支付回调地址由它拼出来，**填错会导致回调 404** |

## 二、品牌名写死在代码里（代理商自托管时必须改，否则会带着本仓库的品牌上线）

共 **10 个文件 / 14 处**，全部是字符串字面量 `GetCodex Plus`：

| 文件:行 | 用途 | 改动影响 |
|---|---|---|
| `src/app/layout.tsx:15` | 页面 `<title>` 默认值与模板 | 影响所有页面标题、SEO |
| `src/app/layout.tsx:17` | `applicationName` | 浏览器/系统展示名 |
| `src/app/page.tsx:29` | 首页结构化数据（JSON-LD Organization） | 影响搜索结果展示 |
| `src/app/plans/[id]/page.tsx:50` | 套餐页结构化数据 provider | 同上 |
| `src/app/opengraph-image.tsx:4,27` | 分享卡片 alt 与图内文字 | 影响社交分享外观 |
| `src/app/privacy/page.tsx:4` | 隐私页 meta 描述 | 文案 |
| `src/app/terms/page.tsx:6,14` | 条款页 meta 描述与正文「独立充值服务」声明 | **正文涉及法律表述，改品牌时不要动这句话的语义** |
| `src/server/notifications.ts:38` | 订单通知邮件主题 | 买家收到的邮件抬头 |
| `src/server/integrations/email.ts:10` | 登录验证码邮件主题 | 同上 |
| `src/server/better-auth.ts:42` | `issuer`（TOTP 验证器里显示的名字） | **只影响显示名**，校验依据是密钥 |
| `src/server/better-auth.ts:267` | `appName` | 只影响展示 |
| `src/server/better-auth.ts:409` | WebAuthn `rpName` | **只影响显示名**；校验依据是 `rpID`/baseURL，改名不会让已注册的 passkey 失效 |
| `src/server/worker.ts:15` | worker 启动日志 | 仅运维可见 |

**建议**：代理商分支里改成自己的名字即可；如果要做成「改配置就换品牌」，需要把上面这些改成读 `settings.brandName`（代码改动，非本清单范围）。
改之前请在测试环境验一次 passkey 登录，别只信这段说明。

## 三、部署时必做（漏了会静默出事）

1. 支持邮箱必填，且用 `/help/payment` 断言过（正文含真实邮箱、不含「尚未公布」）。
2. `APP_URL` 与实际域名一致（支付回调、订单链接、邮件链接全靠它）。
3. `ENCRYPTION_KEY` 生成后**独立离线保存第二份**：它丢了 = 全部卡密与买家凭据永久解不开。
4. 备份加密的私钥与 `ENCRYPTION_KEY` **都不要与数据库 dump 同机**。
5. 数据库迁移顺序：**先迁移库，再滚动部署镜像**；看到 `42703 / column ... does not exist` 先查迁移，别查镜像和网络。

## 四、维护禁区

- **禁止手改 `inventory.id`**：卡密密文的 AAD 绑定了 `inventory:<id>`，改 id 会让那批卡密永久解不开，且不会报警。需要重建时先解密导出、再重新封存。
- 不要随手改订单 `status`：数据库触发器会在状态变化时自动给买家发信（`prisma/init.sql:40-48`），改错状态买家立刻收到一封错的。

## 五、补遗（小D 独立复核，2026-11-19）

按 `grep -rn 'GetCodex Plus' src` 独立复算，**第二节的「10 个文件 / 14 处」是低估的**：

- 生产代码（不含 `*.test.*`）：**26 处 / 14 个文件**；另有 1 处写成拆行形式 `GetCodex <span>Plus</span>`（`Site.tsx:33`），普通 grep 抓不到。
- 第二节表格覆盖 15 处；**漏掉 11 处 / 4 个文件**，其中三处是最显眼的：

| 文件:行 | 用途 | 为什么不能漏 |
|---|---|---|
| `src/components/Site.tsx:33` | **页头品牌字样**（拆行写法） | 买家第一眼看到的就是它；不改等于顶着本仓库品牌卖货 |
| `src/components/Site.tsx:626` | 页脚版权署名 | 每个页面都有 |
| `src/components/Site.tsx:228` | 登录欢迎语 | 买家登录即见 |
| `src/seo.ts:24,25,28,32` | **页面标题模板与站点名** | 比 `layout.tsx` 的默认值更关键：实际拼出来的 `<title>` 来自这里，影响全部页面的浏览器标签与搜索结果 |
| `src/google-analytics.ts:40` | GA 上报的 `page_title` | 代理商自己的 GA 报表里会长期出现本仓库品牌 |
| `src/components/Admin.tsx:164,166` | 邮件「发件地址」示例值 | 容易被照抄成真实发件名 |
| `src/components/Admin.tsx:425` | 后台控制台标题 | 仅内部可见，优先级最低 |

**建议做法**：先跑一次 `grep -rn 'GetCodex' src --include=*.ts --include=*.tsx | grep -v '\.test\.'` 拿到当前全量清单再改（本次已有 27 处），改完再跑一次确认只剩 0，别对着任何一份静态清单逐条勾——清单会随代码演进过期。

