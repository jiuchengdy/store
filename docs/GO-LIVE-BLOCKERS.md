# 上线阻塞清单（Go-Live Blockers）

> 汇总自团队 2026-11-19 的五线并行审计（测试 / 涉钱代码 / 运维 / 文档客服 / 上游协议）。
> 结论先行：**代码是健康的（基线 check/db:verify/test 326/build 全绿、e2e 56 过 4 跳过），卡点全在"上线后钱货别出事、出事有人知道、能查、能救"。**
> 每条标注：负责人 + 验收判据。未全部做完前，`APP_MODE` 不得转 live。

## 一、上线阻塞（P0，做完才准上线）

**0. GMPay 实现分叉（挂起，等用户注册新号回报）** — 用户决定自行注册支付新号（不依赖原作者），注册后回报商户域名/平台类型即可。@u5c0f-i 用两条 curl 30 秒判定，**不用翻后台/登录**：
   - `GET /pay/check-status/x`：Epusdt 回 200/`status_code:10008`，gmpay-edge 回 404；
   - `GET /payments/gmpay/v1/order/query`：Epusdt 404，edge 401（缺签名）。
   判定后：**Epusdt** 改 URL + 重写响应结构（只回 `{trade_id,status}`，现代码期望的 currency/amount/order_id 全无）；**edge** 维持现状。
   证据（@u5c0f-i 核实 + @u5c0f-q 复读代码确认）：`confirmGmpayReceipt` 请求 `order/query`（`payments.ts:236`），挂在主回调路径（`route.ts:43`），接 Epusdt 时每笔回调 404 → `ApiError(503)` → 厂商重试耗尽 → **GMPay 全部收入进不了账**。mock 测不出这个 404，沙箱真发一笔。

1. **XorPay 主动查询兜底（sweeper）+ 能力矩阵** — 实现 @u5c0f-r，**验收 @u5c0f-q**。任务单 `docs/prompts/P0-1-xorpay-query-sweeper.md` + 附录 `APPENDIX-payment-status-mapping.md`（7 个统一语义，渠道差异压映射层，厂商原始状态不外报）。
   判据：`status ∈ {payed, success}` 且金额一致才补入账；`fee_error` 落人工；复用 `acceptPayment`，`(provider, transactionId)` 唯一键防双记。
   **能力开关存独立字段 + 默认 false，不塞 `publicKeys`**（否则①被 `saveIntegration` 白名单静默吞掉 ②触发"所有字段非空才能启用"）。sweeper 按开关跑，**无查询能力渠道跳过 + 静态警示**，不每 10 分钟打 404 制造噪音。
   **三档"不该动作"归一不报警**：`not_exist`（XorPay `not_exist` / Epusdt `10008` / edge 400 业务码）、`expire`、**`AWAITING_SELECTION`（占位单，买家没选链没转过钱，不是死单）**——三家各喂一条都进同一条告警，占位单不计死单。
   **并发**：sweeper 与真回调撞车时 `acceptPayment` 抛 409，必须当"已入账"吞掉，否则每 10 分钟假警一次。

2. **上游错误码补全 + 资金滞留人工路径 + AICDK 重复检测停发** — 实现 @u5c0f-r，**验收 @u5c0f-q**；runbook 7.2 人工分支 @u5c0f-o 已写。任务单 `P0-2-upstream-error-codes.md`。
   Dujiao：补 `invalid_order_key`、`stock_unavailable`；未知 4xx 不再无限重试（Epusdt 配置类 400：`10016/10017/10018/10019` → `MANUAL_REVIEW` + 配置告警，不是买家问题）。
   **AICDK 重复检测停发（新 P0，@u5c0f-r）**：`aicdk.ts:270` 回读 `limit=2` 拿到两条以上时抛 `UPSTREAM_INVALID_RESPONSE`(uncertain=true) → 下一轮复用同一幂等键**再投**，等于上游已产生第二笔、还在发第三笔（重复交付=白送一单，且买家看到"充了两份"）。修法：改抛错为**写 `conflict` + 停发 + job done**（`fulfillmentResolution.conflict` 现成），让单进人工列表、不再打上游。验收：喂「回读返两条」mock，订单进 conflict 且**之后零次上游请求**。

3. **数据库迁移基线化（排最前，所有改表 P0 的前置）** — @u5c0f-o 出方案。根因坐实：**真正 schema 源头是 `prisma/init.sql`（触发器/约束都在里面）**，`prisma/migrations` 为空（`e7dcd59` 主动移除历史），"以前怎么升库"永久无解，只能新建 `schema_version` 账本。最小版：`schema_version` 表 + 编号 SQL + 记账脚本，契约同步已由 `scripts/ops/gen-contract.ts` 自动化（干净库 exit 0、加列 exit 1，不再手改 335 条 JSON）。改表走 expand-contract 两步；P0#1 能力开关、P0#4 job 上限都要加列，都在等它。

4. **Worker 业务心跳 + 出货 job 最大重试上限** — @u5c0f-o 做 `ops_heartbeat`，@u5c0f-r 补 job 上限，**验收 @u5c0f-q**。任务单 `P0-4-job-retry-cap.md`。
   判据：job 达上限转 `failed` 并发通知。**注意发信是数据库触发器**（`init.sql:759`，状态一变自动入队 `email_outbox`），误改状态也会发信；`email_outbox` 唯一键 `ON CONFLICT DO NOTHING` 会吞掉第二封（@u5c0f-q 实测成立）。**两封信走 a：P0#3 落地后改触发器实现，不绕触发器、不记已知限制。** 另加判据：①两次不同时段进 `failed` 必须收两封；②`contact_email` 为空转 `failed` 后台必须有可见提示（触发器 `IF NEW.contact_email IS NOT NULL`，空则一封不入队、零报错——游客单/补单/数据修复会彻底静默）。

5. **备份三层自动化 + 恢复演练** — @u5c0f-o 修复 `fcdd6da`，**@u5c0f-q 已逐条实测验收通过（签字），可进 crontab**（前提 `REMOTE` 定了）。8 项全实跑：剪枝 BSD、异地 sha256、0600 权限、空壳 dump 打穿（MISMATCH exit 1）、`.counts` 缺失 exit 4、有数据用例、清理无残留。
   **仍卡用户**：① 异地目标 `192.168.0.1` 是否接受；② **加密未做**（age/gpg，需先定私钥谁保管）。
   **新增判据（第 9 项，已由 @u5c0f-o 实现 `verify-credentials.ts`）**：恢复后调 `openCredential` 解密，**抽最早 1 条 + 最新 1 条**（只抽最新会漏掉"换过密钥、老密文全废"的假绿），两条都过才 PASS。退出码分级：正确密钥 0 / 换密钥 1 / 没给密钥 1（防 demo 回落 throwaway key）/ 空库存 5=`UNPROVEN`（进周报不进告警，只有 1 和 4 才呼人，否则每周假警）。
   **两把钥匙分开**：`ENCRYPTION_KEY` 必须有独立离线第二份、**不与 dump 同机**（dump+`.env` 一起泄露=全部买家凭据明文）；备份加密私钥只在恢复方、不与备份同机。
   **runbook 待补**：本地跑传 `DB_CONTAINER=store-db-1`；首周 `expected=N restored=N-1` 先看是否正在下单；排查口诀 `42703 / column ... does not exist` = 库没迁移、别查镜像网络。


## 二、上线前门槛（P1，不阻塞代码，但缺了不能上线）

7. **e2e 进 CI + 报数铁律** — @u5c0f-q。铁律：报测试数必须同时贴 `N passed / N skipped`。
8. **验签固定向量测试 + 三家沙箱真发一次** — @u5c0f-q。XorPay 两组向量已三方交叉验证一致（可直接写固定向量）。GMPay 回调要真发一笔（mock 测不出 404）。
9. **support-playbook.md** — @u5c0f-d 已交（`598acdd`/`de989ff`/`052361d`）：按渠道退款表、加密货币问答（**第一句先问"看到收款地址了吗"，没看到=占位单没转过钱，不需哈希**）、未实现能力账本、第 4 节"不要随手改订单状态"（改状态会发信）。
10. **CHANGELOG + 文档修正** — @u5c0f-d 已交（`598acdd`）。
11. **代理商自托管前的品牌清理（P1，不阻塞 getcodex.plus 上线，阻塞"代理商自托管"能力）** — 品牌名 `GetCodex Plus` 写死在代码 **27 处/14 文件**（@u5c0f-d 复核；@u5c0f-r 原报 14 处漏了页头 `Site.tsx:33`、`seo.ts` 标题模板、页脚版权等最显眼处），多在买家可见（页头、`<title>`、JSON-LD、邮件主题、验证码主题、GA page_title）。代理商不改代码上线=顶着本仓库品牌卖货。已写 `docs/DEPLOYER-SETTINGS.md`（行号 + 改前改后 grep 归零）。**正确方向**：加 `settings.brandName`（后台可配）让 27 处读它，清单缩成"已知写死点"——列 backlog。改品牌不影响已注册 passkey（issuer/appName/rpName 只是显示名，校验依据 rpID/baseURL）。

## 三、非阻塞（backlog，上线稳定后做）

- `refunds:write` 权限拆分、提现大额双人复核、每日对账视图。

## 四、需要用户本人拍板（我们无法自造/自定）

1. **GMPay 商户域名** → 挂起，用户自行注册新号、注册后回报（后台域名或平台类型即可，@u5c0f-i 脚本自动判定）。
2. ~~USDT 留不留~~ → **已定：保留**（含推广提现）。按"高人工成本渠道"单独定价限流；客服剧本 crypto 退款口径先按待定。
4. **加密货币退款汇率差口径（必拍，用户决定中）**：USDT 保留后此条必须定——按实收金额退、汇率波动由谁承担；未定前客服剧本 crypto 退款口径按待定。
5. **异地备份目标** `192.168.0.1` 行不行 + **加密私钥谁保管** + **`ENCRYPTION_KEY` 离线第二份放哪**（绝不能与 dump 同机）。
6. **push 时机**：当前 **39 个**本地提交未上图，等你点头统一 push。
7. **上线外部资源**：域名+HTTPS、服务器（未回）；~~邮件服务~~ Resend 已有账号（API Key+发件地址上线前用户自行填后台）；~~支付/上游~~ 用户自行注册新号（不依赖原作者）。
8. **`APP_MODE` demo→live 时点**。
9. **AICDK 对接文档 + 沙箱/测试额度 + Session 留存政策书面答复**（@u5c0f-i，排前三）——没有它，兑换链路一次真实验证都做不了；AICDK 拿的是买家 Session/accessToken（系统里最敏感的数据），却**没有公开文档**。上线前必须在对方环境实测五条（附录 §8）：同键连发不重复、uncertain 重试不二次兑换、超时语义、account-session 取回上限、被拒是否消耗卡密。**用户自注册新号，新号到位后先做 §8 五条实验**（无真实订单时试错不要钱，上量后试错就是赔单）。
10. **真出事时多久内通知买家**（@u5c0f-d，上线前必须定）：行业惯例发现后尽快、72 小时内书面说明；定错无法事后补救。

## 五、已拍板决策（2026-11-19）

- 邮件时间承诺 **"2 小时"**；`paid: true` 三家协议都合法，但三家都缺查单兜底。
- **能力开关方案**（`supportsQuery`/`supportsRefund` 独立字段 + 默认 false）替代渠道 fork；**7 个统一语义**（`CREDITED`/`PAID_UNCREDITED`/`NOT_PAID`/`AWAITING_SELECTION`/`EXPIRED`/`MANUAL_REVIEW`/`ORDER_NOT_FOUND`）收敛渠道差异。
- **占位单（`AWAITING_SELECTION`）不计死单、不报警**，归"不该动作"档。
- 实现/验收分离：P0#1/#2/#4 由 @u5c0f-r 实现，@u5c0f-q 按任务单逐条实测验收。
- 权限拆分、双人复核、对账 → backlog。
- **backlog 另记**：加密格式 `v2:` 加 `<keyid>`（换钥匙时可枚举未重封的密文，越晚改越贵）；**禁止手改 `inventory.id`**（AAD 绑 `kind:recordId`，改了那批卡密永久解不开且不报警，确需重建先解密导出再重封）。
- **uncertain 单默认"只回读、不重发"**：`Idempotency-Key` 键不变只给上游去重机会、不等于上游会去重（AICDK 无文档、未验证），除非 AICDK 环境五条实测通过。任何给 uncertain 单加补偿的改动**绝对不许递增 `fulfillmentAttempt` 或换 `requestId`**（否则上游无法去重=重复交付白送一单）。
- **`/privacy` 已写对**（"兑换服务处理以其实际运行配置为准"的退路）；客服红线：口头/促销承诺不得比 `/privacy` 更宽松，AICDK 留存政策书面答复到手后**先改 `/privacy` 再改剧本**。
- **排期（改表类 P0）**：P0#3（最小迁移账本）→ P0#4（job 上限 + 两封信）→ P0#1 → P0#2；P0#5 已完成只等 REMOTE+加密。一个 Codex 轮次别同时改触发器 + 契约 + 业务逻辑。
- 下一步：等用户回 GMPay 域名（P0#0）+ 定谁落地（@u5c0f-r 自己写还是给 Codex），任务单已可直接扔给 Codex。
