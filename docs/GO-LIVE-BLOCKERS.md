# 上线阻塞清单（Go-Live Blockers）

> 汇总自团队 2026-11-19 的五线并行审计（测试 / 涉钱代码 / 运维 / 文档客服 / 上游协议）。
> 结论先行：**代码是健康的（基线 check/db:verify/test 326/build 全绿、e2e 56 过 4 跳过），卡点全在"上线后钱货别出事、出事有人知道、能查、能救"。**
> 每条标注：负责人 + 验收判据。未全部做完前，`APP_MODE` 不得转 live。

## 一、上线阻塞（P0，做完才准上线）

   - `GET /pay/check-status/x`：Epusdt 回 200/`status_code:10008`，gmpay-edge 回 404；
   - `GET /payments/gmpay/v1/order/query`：Epusdt 404，edge 401（缺签名）。
   判定后：**Epusdt** 改 URL + 重写响应结构（只回 `{trade_id,status}`，现代码期望的 currency/amount/order_id 全无）；**edge** 维持现状。
   证据（@u5c0f-i 核实 + @u5c0f-q 复读代码确认）：`confirmGmpayReceipt` 请求 `order/query`（`payments.ts:236`），挂在主回调路径（`route.ts:43`），接 Epusdt 时每笔回调 404 → `ApiError(503)` → 厂商重试耗尽 → **GMPay 全部收入进不了账**。mock 测不出这个 404。~~沙箱真发一笔~~ → **2026-11-19 用户拍板：上线前不做支付通道真实联调**（见 §五），本条改为「mock 覆盖 + 上线后首笔真实支付触发」；首周人工盯单兜底。
   - **P0-A 下单 100% 失败**：`services.ts:344` 生成 `o_`+32hex = **34 字符**，超网关 `maxLen:32` → `400/10009`；同参数 32 字符 → `200`。现有测试夹具用 `orderId:'tx'`（2 字符），正好绕过长度限制，所以一直绿。修法：`o_`+30 位 = 32 字符，确定性幂等不变，与历史 34 字符订单并存无需迁移。
   - **P0-B 查单路由不存在**：`/payments/gmpay/v1/order/query` **GET/POST 均 404**（v2.0.0 `router.go` 只注册 `create-transaction` 与 `config`）；真路由 `GET /pay/check-status/{trade_id}` 只回 `{trade_id,status}`，现有四重比对（currency/order_id/amount）必挂 → 判据改为 `status==2`，金额交叉核用 `GET /pay/checkout-counter-resp/{trade_id}`。
   - **10002 不可自动恢复（措辞已更正）**：网关按 `order_id` 全局查重（`order_service.go:139-145`）。**商户 API** 没有按 order_id 反查 trade_id 的接口；**网关管理端有**（`GET /admin/api/v1/orders?keyword=` 同时按 order_id/trade_id 搜，另有 `resend-callback`/`mark-paid`，未带凭据实测 `401` 非 `404`）。所以结论是「商户侧无自动恢复，恢复走管理端人工，admin 凭据不进应用」，不是「支付地址永久丢」。修法：建单超时不盲目重建、`paymentId` 先落库、10002 单独处置文案。
   - **10041 是 DNS 不是黑名单（新，更正队友归因）**：网关下单时对 `notify_url` 的 host 实时解析并要求公网 IP（`url_guard.go`）。同参数对照：`example.com`→200、`example.test`/`.invalid`（不解析）/`192.168.0.1`（私网）→10041。**生产填真实域名不受影响，代码不用改；但代理商裸 IP/内网域名自托管会 100% 建单失败 → 进 `deployer-preflight.sh`。**
   - **签名为兼容项，不要顺手动**：HMAC-SHA256 + ASCII 排序 + 排除 `signature`/空值，与 `signatures.ts` 一致（实测正确签名换到 `10004` 而非 `401`）；回调 `status=2` 判成功、回 `ok` 亦一致。

1. ~~**XorPay 主动查询兜底（sweeper）+ 能力矩阵**~~ → **已挂起（2026-11-19 用户拍板：不注册 XorPay，收款只走 GMPay(USDT) + 钱包余额）**。渠道不启用则该隐患不存在；任务单 `P0-1-xorpay-query-sweeper.md` **保留不动**，未来真要启用 XorPay 时按原单做。注意：这条挂起后，**自动查单兜底只剩 P0#6 里 GMPay 的 `confirmGmpayReceipt`**，它是唯一一条「回调没来也能自己核实」的路径，优先级因此上升。
   ~~原描述~~：实现 @u5c0f-r，**验收 @u5c0f-q**。任务单 `docs/prompts/P0-1-xorpay-query-sweeper.md` + 附录 `APPENDIX-payment-status-mapping.md`（7 个统一语义，渠道差异压映射层，厂商原始状态不外报）。
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

7. **e2e 进 CI（先入闸，再转绿）+ 报数铁律** — @u5c0f-q。2026-11-19 小G 定序：**先让整套 e2e 进 CI 并把当前结果记录为基线（现在是红的），再逐条转绿**；不要「先修断言、等 e2e 能跑了再验」——那修完也没人证明修对了，正是「326 绿、e2e 红」的翻版。
   - 现状证据：`vitest.config.ts` 的 `include` 只有 `src/**/*.test.ts`，**e2e 完全不在 326 那道闸里**；因此「326 passed」只覆盖单测。
   - 已修一处漂移：`tests/refunds.spec.ts:100` 期望 `已原路退款`，而 `src/lib.ts:32` 对 refunded+original 返回 **`已退款`**（`:167` 的单选标签是 `退回原支付方式`）——@u5c0f-q 复现红后提交 `8303363`，只改断言、未动产品代码。
   - 待办：跑完整套 e2e 报**真实 passed/failed 计数**；别处若有红，按同一根因（文案先改、断言没跟）一并收口，不单开卡。
   - **报数铁律升级为两行**：`unit: N passed / S skipped` + `e2e: x passed / y failed（或未跑，附原因）`。一个数字不再代表全部测试。
8. ~~**验签固定向量测试 + 三家沙箱真发一次**~~ → **已评估不做（用户 2026-11-19 拍板，见 §五），首周人工盯单兜底。**
   - 保留的部分：**验签固定向量**照写（纯本地、零风险、可回归）；XorPay 两组向量已三方交叉验证一致。
   - 不做/已免除：三家渠道沙箱或生产真发一笔、GMPay 真回调联调、XorPay 真下单退款联调。**上线前一律不做。**
   - 残余风险（不因不测而消失）：真渠道从未生产联调；XorPay 无主动查单（P0#1 仍在实现）；GMPay 回调窗口 6.5 小时。
   - 兜底：上线首周**每 30 分钟扫一遍 `processing` 超 30 分钟的订单**（`docs/ops-runbook.md` 已有此节，标为强制执行；@u5c0f-o 维护）。
   - 重新捡起条件：**第一笔真实支付出现任何异常**（到账延迟／回调失败／状态卡住）→ 立即做小额全链路测试，不等第二笔。
9. **support-playbook.md** — @u5c0f-d 已交（`598acdd`/`de989ff`/`052361d`）：按渠道退款表、加密货币问答（**第一句先问"看到收款地址了吗"，没看到=占位单没转过钱，不需哈希**）、未实现能力账本、第 4 节"不要随手改订单状态"（改状态会发信）。
10. **CHANGELOG + 文档修正** — @u5c0f-d 已交（`598acdd`）。
11. **代理商自托管前的品牌清理（P1，不阻塞 getcodex.plus 上线，阻塞"代理商自托管"能力）** — 品牌名 `GetCodex Plus` 写死在代码 **27 处/14 文件**（@u5c0f-d 复核；@u5c0f-r 原报 14 处漏了页头 `Site.tsx:33`、`seo.ts` 标题模板、页脚版权等最显眼处），多在买家可见（页头、`<title>`、JSON-LD、邮件主题、验证码主题、GA page_title）。代理商不改代码上线=顶着本仓库品牌卖货。已写 `docs/DEPLOYER-SETTINGS.md`（行号 + 改前改后 grep 归零）。**正确方向**：加 `settings.brandName`（后台可配）让 27 处读它，清单缩成"已知写死点"——列 backlog。改品牌不影响已注册 passkey（issuer/appName/rpName 只是显示名，校验依据 rpID/baseURL）。

13. **渠道收敛后的两处代码清理（新，P1，@u5c0f-r 写单 / @u5c0f-q 验）** — 收款只剩 GMPay + 余额后，代码里留着两个会误导人的入口：
   - **退款**：`services.ts:1531` 的自动退款分支无条件 `integration('xorpay', order.integrationId)` —— 对 GMPay 订单会拿 gmpay 的 integration id 去查 xorpay provider，必抛错（不会退错钱，但后台会弹一个看不懂的错误）。要求：后台退款对话框对 `provider !== 'xorpay'` **隐藏/禁用「自动原路退款」**，只保留「已人工退回，记账完成」与「退到余额」；`refundAutomatic` 对所有非 xorpay 订单一律 false；**并且代码不许在非 xorpay 路径写 `refund_status='processing'`**——`orders_refund_record_check` 要求 `processing` 必须 `refund_automatic=true`，而自动又必须是 `provider='xorpay'`，所以渠道收敛后**新人工退款只可能落 `review`**。靠约束兜底只会把业务错误留成运行时的报错框。文档里出现 `processing` 的地方要标「历史/自动退款遗留状态」，否则运维会去后台找一个永远不会再出现的值。
   - **渠道开关**：`PaymentOptions` 用 `settings[channel]` 过滤按钮，所以只要后台把 alipay/wechat 关掉就不会显示死按钮；但**开关与集成没有一致性校验**——开关为真、对应 provider 集成未启用时，买家会看到按钮、点了 502/503。要求：`deployer-preflight.sh` 增加一条「`settings.<channel>` 为真时，对应 provider 集成必须存在且 enabled，否则 FAIL」，并把渠道默认值从 `'alipay'` 改为「第一个可用渠道」（现在 `usePaymentChannel` 靠 fallback 兜，能工作但不该靠兜）。

12. **采购单轮询上限 + 采购单可见性（新，P1，@u5c0f-r 写单 / @u5c0f-q 验）** — `procurement.ts:208` 中间态只 `nextRunAt=later(15)`（15 **秒**）、`attempts` 不参与判断；`:217` 异常退避 5–300 秒同样无上限。且 `stock_purchases` 在后台**零出口**（`grep stockPurchase` 在 components/api/data/services 全空），`review` 状态等于扔黑洞。任务单 `docs/prompts/P1-procurement-polling-cap.md`：中间态 `attempts>=120`（≈30 分钟）→ `review`+`stale_upstream`；异常 `attempts>=20` → `review`+`retry_exhausted`；后台加只读采购单列表。全部用 `attempts` 当计数器，**不迁移**。

## 三、非阻塞（backlog，上线稳定后做）

- `refunds:write` 权限拆分、提现大额双人复核、每日对账视图。

## 四、需要用户本人拍板（我们无法自造/自定）

2. ~~USDT 留不留~~ → **已定：保留**（含推广提现）。按"高人工成本渠道"单独定价限流；退款口径见第 4 项（已定）。
4. ~~加密货币退款汇率差口径~~ → **已定（2026-11-19）：按币退——实收数量原数退回，汇率波动由买家承担。** 落地要点（@u5c0f-r 审计补充）：`orders` 表只有 `refundNote` / `refundResolutionNote` 两个字符串字段，**没有币种/数量/链/txid**；而"实收数量"只存在于商户后台，我们库里只有人民币分。所以按币退款完成时必须把**币种、实收数量、链、交易哈希**四项写进 `refundResolutionNote`，否则事后无法举证、无法与链上对账（结构化字段属 backlog，等 P0#3 之后加 `refundCrypto jsonb`）。
5. **异地备份目标** `192.168.0.1` 行不行 + **加密私钥谁保管** + **`ENCRYPTION_KEY` 离线第二份放哪**（绝不能与 dump 同机）。
6. **push 时机**：当前 **47 个**本地提交未上图，等你点头统一 push。
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
- **「原路退款」→「退回原支付方式」统一口径**（@u5c0f-d 定）：GMPay 厂商**没有退款接口**，「原路退」是技术上做不到的承诺，必须从对外话术删掉（`src` 现 16 处「原路」、9 处买家/客服可见，待 @u5c0f-r 按 `refund-copy-fix.md` 改，grep `原路` 归零）；`services.ts`/`refunds.ts` 内部审计措辞不改（保持历史对账一致）。
- **验收元规矩（团队确立）**：每条断言必须写「验什么对象、什么形态、失败长什么样」三段，缺一段不算判据——本轮六次踩同一坑（空壳 dump、只抽最新、`.env` 备份不到钥匙、`.data` 容器不合法、0644 钥匙、宿主机读容器挂载），根因都是「检查对象 ≠ 生效对象」。
- **收款渠道收敛：GMPay(USDT) + 钱包余额，不做支付宝/微信，不注册 XorPay（2026-11-19 用户拍板）**。连带：P0#1 挂起；**退款 100% 人工**（GMPay 无退款接口、又无 XorPay 自动退款）；上线收款侧测试范围仅「GMPay 下单/收银台」。当前活跃 P0 = #0（已结）/ #2（错误码）/ #3（迁移账本，已过验收）/ #4（重试上限）+ P0#6（GMPay 兼容修复）。
- **支付通道真实联调：上线前不做（2026-11-19 用户拍板）**。不做：三家渠道沙箱/生产真发一笔、GMPay 真回调联调、XorPay 真下单退款联调。做：验签固定向量（本地）、mock 覆盖、代码静态核对。残余风险（真渠道从未联调／XorPay 无主动查单／GMPay 回调 6.5 小时窗口）接受并记录。兜底：**首周每 30 分钟扫 `processing` 超 30 分钟订单（强制执行）**。重新捡起：**第一笔真实支付任何异常 → 立即小额全链路测试，不等第二笔**。
- 下一步：GMPay 外部资源已闭环（域名/钱包/密钥全部到位），**只剩代码修复**——P0#0 三处实测缺陷（订单号 34>32、`order/query` 404、10002 不可恢复）+ 10041 进 preflight；任务单由 @u5c0f-r 写、@u5c0f-q 验，写好后可直接扔给 Codex。**在修好并实测通过前，后台 `gmpay` 集成保持 disabled。**
