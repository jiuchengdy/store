# 任务单 P0#6：GMPay（EPUSDT v2.0.0）兼容性修复

> 自包含任务单，给实现者（本项目由团队自己实现，不交外部编码代理），不依赖聊天记录。
> 仓库：`~/Documents/store`。**不要 git push**，改完只做本地提交。
> 本单只改 GMPay 通道；不要顺手动 XorPay / 易支付的任何代码。
> **修订版 2（2026-11-19，按 @u5c0f-i / @u5c0f-q 复核意见改）**：金额判据拆成「不可达/不符」两条、ack 与入账解耦、10002 措辞更正（商户侧无自动恢复、恢复走网关管理端）、明确允许改的文件清单与「不许新增 status」。

## 0. 一句话目标

把 `gmpay` 通道从「一单都建不出来」修到「能建单、能收钱、能入账、金额对不上不发货」，并且对「建单成功但响应丢失」有明确处置。**签名算法不要改**，它是对的。

## 1. 现状（2026-11-19 线上实测，不要重新论证）


| 编号 | 缺陷 | 实测证据 |
|---|---|---|
| P0-A | 下单 100% 失败 | `services.ts` 生成 `o_`+sha256 前 32 位 = **34 字符**；网关 `CreateTransactionRequest.OrderId` 校验 `maxLen:32` → `400 / 10009 failed to parse request params`；同参数 32 字符 → `200 success`。现有测试夹具用 `orderId:'tx'`（2 字符），绕过了这条限制 |
| P0-B | 付款不入账 | `confirmGmpayReceipt` 调 `GET /payments/gmpay/v1/order/query`；v2.0.0 `src/route/router.go` 只注册 `POST /order/create-transaction` 与 `GET /config`，该路径 **GET/POST 均 404** → 代码抛 `503「支付状态暂时无法核实」` → `notify/.../route.ts` 的 `acceptPayment` 永不执行 |
| P1-C | 改路由也不够 | 真路由 `GET /pay/check-status/{trade_id}` 只回 `{trade_id, status}`；现有 `currency/order_id/amount` 四重比对全部是 `undefined`，必抛「支付查询结果不匹配」 |
| P1-D | 10002 不可**自动**恢复 | 网关按 `order_id` 全局查重（`order_service.go:139-145`，进程内锁）。**商户 API** 没有按 `order_id` 反查 `trade_id` 的接口，但**网关管理端有**：`GET /admin/api/v1/orders?keyword=` 可按 order_id/trade_id 搜，另有 `resend-callback`、`mark-paid`（实测未带凭据返回 `401` 而非 `404`，路由确实存在）。结论：**商户侧无自动恢复，恢复走管理端人工；admin 凭据不进应用、不写仓库/板子** |
| P2-E | 10041 环境项 | 网关下单时对 `notify_url` 的 host 做**实时 DNS 解析**并要求全部解析到公网 IP（`src/util/security/url_guard.go`）。实测 `example.com`→200；`example.test`/`no-such-host-*.com`（不解析）/`192.168.0.1`（私网）→`10041`。**不是代码 bug，是部署体检项** |

**已核实正确、不要改**：
- 签名：HMAC-SHA256 + 参数名 ASCII 排序 + 排除 `signature` 与空值，与网关 `src/util/sign/sign.go` 一致。实测用 store 的算法自签，金额非法时网关回 `10004` 而**不是** `401`，说明签名通过。
- 请求必须 `application/x-www-form-urlencoded`。**不要改成 JSON**：JSON 会把 `100.00` 规范化成 `100`，改变待签串，静默验签失败。现有 `post()` 已正确。
- 回调：网关 POST JSON `{pid, trade_id, order_id, amount, actual_amount, receive_address, token, block_transaction_id, status, signature}`，`status=2` 为成功，`amount` 是 JSON 数字；ack 必须是纯文本 `ok` 或 `success`（store 回 `ok` ✅）。回调**没有** `currency` 字段，`payments.ts` 里「有则校验」的写法是对的。
- 响应：`data.trade_id`、`data.payment_url` 均存在，`currency=CNY` 大写被服务端 `ToUpper` 接受。
- **10002 是全局查重、不带 pid 过滤**：`GetOrderInfoByOrderId` 只按 `order_id = ?` 查（`order_data.go:107-110`）。多商户共用一台网关时订单号必须全实例唯一——`o_`+sha256 前 30 位（120 bit）天然满足。实测还顺带证明了 **10002 在金额校验之前触发**（复用同一 order_id 换不同金额，全部只回 10002）。
- **最低支付金额 0.01 元，实测可付**：`CnyMinimumPaymentAmount = 0.01`，且 `0.01` 实测返回 `200 success`（我原以为请求校验要求 `>0.01`，实测推翻）。不存在「最低消费」门槛，`10004` 只在金额非法/精度不满足时出现。

## 2. 允许改的文件（超出此清单即超范围，验收打回）

| 文件 | 改什么 |
|---|---|
| `src/server/services.ts` | **只改**订单号生成：`o_` + `hash(...).slice(0, 30)` = 32 字符。**保持确定性**（同一 `requestKey` 仍得同一 id，幂等键语义不变）。历史 34 字符订单不迁移、不兼容重建 |
| `src/server/integrations/payments.ts` | ①`confirmGmpayReceipt` 改调 `GET /pay/check-status/{trade_id}`，返回**四态结果**而不是直接抛错（**判定顺序写死在 §3.2，不许调换**）：`credited` / `unreachable`（查不了）/ `mismatch`（查到了但不是我们这单）/ `manual`（账实矛盾或未真正进支付）；②金额核对走 `GET /pay/checkout-counter-resp/{trade_id}`（字段 `amount/actual_amount/currency/status/token/network`）；③`createPayment` 对 `status_code === 10002` 抛专用错误并给出「该订单在网关已存在，请勿重复支付，请联系支持核对」的用户可见文案，**不要**静默重试 |
| `src/app/api/payments/notify/[provider]/[revision]/route.ts` | **ack 与入账解耦**，按 §3.2 三态分流 |
| `src/server/integrations/payments.test.ts` | 32 字符订单号做正例、**34 字符做反向用例**；新增 10002、`order/query` 404→`unreachable`、`status=4` 不判成功的用例 |
| `scripts/ops/deployer-preflight.sh` | 启用 `gmpay` 时检查 `APP_URL` 的 host 能解析到公网 IP，否则 FAIL 并提示「GMPay 下单会 10041」；未启用 gmpay 时跳过 |
| `docs/database.md`、`docs/GO-LIVE-BLOCKERS.md`、`docs/prompts/P0-1-xorpay-query-sweeper.md` | 同步结论；P0-1 里「gmpay 走现有 confirmGmpayReceipt」一句改成新实现 |

**禁止**（做了就超范围）：
- 改 `signatures.ts` 任何函数、`post()` 的 Content-Type / 重定向策略、`acceptPayment` 的入账语义；
- **新增 `orders.status` 取值**：`orders_status_check` 是 DB CHECK 约束，只有 7 个值（`unpaid/processing/completed/needs_session/failed/refunded/cancelled`）。加值必须走 `db:migrate` 迁移 + 契约重生成 + 后台筛选/发货判断/统计一起改——**本单不做**，人工待核用 `risk_events` 记录、订单保持原状态（见 §3.3）；
- 改风险规则引擎（`src/server/risk.ts` 的判定逻辑）。

## 3. 实现要点

1. **订单号**：只改截断长度，不换 hash 算法、不加时间戳（会破坏幂等）。改完 grep 全仓确认没有第二处拼订单号。
2. **三态四值判定顺序（写死，不许调换顺序 —— @u5c0f-i 的洞 1/洞 2）**：`confirmGmpayReceipt` 触达网关后，按下面这个顺序判，**先 `trade_id` 再金额**：
   1. HTTP/网络失败、超时、5xx、路由 404 → `unreachable`（= 查不了）；
   2. `status_code === 10008`（订单不存在）→ **`manual`**，**不是** `unreachable`：回调说付了、网关说没这单，是账实矛盾，必须人工；
   3. `data.trade_id !== receipt.transactionId` → **`mismatch`**：这是串单/伪造回调/`paymentId` 被别的单覆盖的形态，**先判它再看金额**，否则一笔串单可能因为金额碰巧相等被放行；
   4. `Number(data.status) === 4`（占位单）或任何非 2 的终态 → **`manual`**：没真正进支付流程，既不是 credited 也不是 unreachable；
   5. `status === 2` 且金额核对**不可达** → `credited`（记 warn，见 3a）；
   6. `status === 2` 且金额/币种与订单**不符** → `mismatch`（见 3b）；
   7. 其余（`status===2` 且金额核对通过）→ `credited`。
   两种 `mismatch` 与 `manual` 的落库方式相同：`risk_events` + 告警 + 不入账。
2.1 **ack 与入账必须解耦**（本单最关键的一条）：
   - `mismatch`（含 `trade_id` 不符）与 `manual`（10008 / `status=4`）→ **对网关回 `ok` 200**（别让它重投到重试耗尽变成噪音），但**不调用 `acceptPayment`**，订单保持原状态、不发货，落 `risk_events` + 告警。**回了 ok 不等于已入账。**
   - `unreachable` → 靠「签名有效 + status=2」入账，记一条 warn（签名已证明来源，查询只是二次确认）。
   - `credited` → 正常 `acceptPayment`。
   - 四态里只有 `credited` 和 `unreachable` 会入账；`mismatch` / `manual` 永不入账。
3. **金额不符的记录**：复用 `recordRisk(scene, decision, facts, subjects, referenceId, client)`（`src/server/risk.ts:37`），`referenceId` 填订单 id，`facts` 写 `{ expectedMinor, receivedMinor, currency, tradeId, provider }`。**不要新增表、不要加列、不要新增 status**。`RiskDecision` 形状不匹配时允许本单内薄封装，但不许改风险引擎判定。
4. **金额核对的对象**：`checkout-counter-resp` 返回法币 `amount`/`currency`；用 `decimalToMinor(String(data.amount))` 对比订单 `externalAmount`。**不可达不阻断入账；正常返回但不符必须阻断。**
5. **查单**：`check-status` 是无签名的公开接口，只接受 `trade_id`，不要往里塞 `pid`/`signature`。
6. **超时/网络错误**：`createPayment` 失败时不要把 `paymentId` 写空后重试；**禁止在没有 trade_id 的情况下二次调用 create**，那正是 10002 的来源。
7. **10002 的处置**：不自动重试、不自动置已支付、不自动退款；订单进人工列表并给明确文案。恢复动作在网关管理端（按 order_id 搜 → 取 trade_id → resend-callback / mark-paid），**应用不持有 admin 凭据**。
8. **回调解析**：已由 `parseFlatCallbackJSON` 处理，不要绕过它。

## 4. 上线前置（写进文档，不改代码）

- **修好并实测通过前，后台 `gmpay` 集成保持 disabled**（真实买家碰一次 P0-B 就是赔钱 + 赔偿）。
- 部署体检：`APP_URL` 必须是「公网可解析的域名」；裸 IP、内网域名、`*.test`/`*.invalid` 一律建单失败。
- live 回调测试需要公网可达的 `https://<域名>/api/payments/notify/gmpay/<integrationId>`；**域名在下单那一刻就要能解析到公网 IP**（隧道域名可行，前提是解析存在）。demo 模式路由直接 404，回调只能在 live 测。

## 5. 验收判据

> **执行分工 + 本轮范围（2026-11-19 用户拍板后更新）**：用户已决定**上线前不做支付通道真实联调**。因此判据 1、2、8 的「live」部分**本轮不执行**，改为「上线后第一笔真实支付触发时补测」；**合入门槛只看实现者的 mock 判据 + preflight**。实现者不要试图伪造 live 调用；@u5c0f-q 也不要在上线前为此去真建单。
> 合入前必须绿：判据 3（3a/3b）、4、5、6、7、9 全部 mock/本地可验。判据 1/2/8 的 mock 部分照做（32 字符正例、34 字符反例、trade_id 不符），只有「真实网关建单/真签名回调」这一步挂起。
> 兜底（首周）：每 30 分钟扫 `processing` 超 30 分钟订单，见 `docs/ops-runbook.md`；**第一笔真实支付任何异常 → 立即补做 1/2/8 的 live 部分，不等第二笔**。

1. **建单（实现者自测：mock；小Q：live）**：真实订单号形态（32 字符）建单 → `200`，拿到 `trade_id` + `payment_url`；**反向用例**：34 字符必须失败且错误可读。
2. **查单（实现者自测：mock；小Q：live）**：`confirmGmpayReceipt` 打的是 `GET /pay/check-status/{trade_id}`；`status=2` → `credited` 并落库；`status=4`（占位单）→ 不判成功。
3. **金额（双向，实现者用 mock 全覆盖）**：
   - **3a 核对接口不可达**（超时/5xx/mock 抛错）→ 订单**仍然入账**，且有 1 条 warn 日志。
   - **3b 核对接口正常返回但不符**（amount 或 currency 与订单不同）→ **订单不入账**（状态不变、不发货）、`risk_events` 新增一条（`reference_id`=订单 id，`facts` 含预期/实收）、**对网关仍回 `ok` 200**，且日志里能看出「收到回调但未入账」。少付/改单号/复用订单号都不许发货。
4. **10002**：mock 网关回 `10002` → 不重复建单、不进已支付、后台可见人工处置提示。
5. **10041**：preflight 在 `APP_URL` 指内网/不可解析时判 FAIL；指公网域名时 PASS；未启用 gmpay 时不检查。
6. **回归**：`bun run check` 0 error；带 `TEST_DATABASE_URL` **326 passed / 0 skipped**（新增用例则报数与新增条数必须对得上，**同时报 passed 与 skipped**）；`bun run db:verify` **335/393/85/6/6**；契约 `--check` exit 0。
7. **不误伤**：`signatures.ts` 的 `git diff` 为空；`post()` 仍发 form-urlencoded；XorPay/易支付用例全绿；`orders.status` 未新增取值。
8. **trade_id 不符（q 的第八条 live 验收，实现者用 mock 覆盖）**：造一条**签名正确、status=2，但 `trade_id` 与本地 `paymentId` 不同**的回调 → **不入账**（订单状态不变）、`risk_events` 新增一条（`facts` 里能看出两边 trade_id）、**仍回 `ok` 200**；且验证判定顺序：让这条的金额**恰好等于**订单金额，仍然必须判 `mismatch`（证明「先 trade_id 再金额」没写反）。
9. **10008 / 占位单（洞 2）**：`checkout-counter-resp` 回 `status_code=10008` 或 `status=4` → 归 `manual`：不入账、`risk_events` 一条、回 `ok`；**不许**当成 `unreachable` 走「靠签名入账」那条路。

## 6. 命令与基线

```bash
cd ~/Documents/store
export PATH="$HOME/.bun/bin:$PATH"
open -a OrbStack && docker start store-db-1
bun run check
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test bun run test
bun run db:verify
bun scripts/ops/gen-contract.ts --check
```

基线：`check` 0 error；`test` 41 文件 / 326 passed / 0 skipped（**裸跑会静默跳过 170 项仍显全绿，报数必须同时报 passed 与 skipped**）；`db:verify` 335/393/85/6/6；契约 check exit 0。

## 7. 交付格式

1. 改动文件清单 + 每处一句话说明（只列 §2 清单内的文件）；
2. 六条命令真实输出（含 skipped 数与契约 exit code）；
3. §5 九条各自对应的验证方式；3a/3b、第 8 条要贴日志与 `risk_events` 落库结果；10002 要贴响应原文；
4. 明确写出「签名、form 编码、`orders.status` 取值未动」的证据（`git diff --stat`）；
5. 本地提交，不 push。
