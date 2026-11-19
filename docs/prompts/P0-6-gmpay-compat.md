# 任务单 P0#6：GMPay（EPUSDT v2.0.0）兼容性修复

> 自包含任务单，给实现者（Codex，全新对话），不依赖聊天记录。
> 仓库：`~/Documents/store`。**不要 git push**，改完只做本地提交。
> 本单只改 GMPay 通道；不要顺手动 XorPay / 易支付的任何代码。

## 0. 一句话目标

把 `gmpay` 通道从「一单都建不出来」修到「能建单、能收钱、能入账」，并且对「建单成功但响应丢失」这种会丢钱的情况有明确处置。**签名算法不要改**，它是对的。

## 1. 现状（2026-11-19 线上实测，不要重新论证）


| 编号 | 缺陷 | 实测证据 |
|---|---|---|
| P0-A | 下单 100% 失败 | `services.ts` 生成 `o_`+sha256 前 32 位 = **34 字符**；网关 `CreateTransactionRequest.OrderId` 校验 `maxLen:32` → `400 / 10009 failed to parse request params`；同参数 32 字符 → `200 success`。现有测试夹具用 `orderId:'tx'`（2 字符），绕过了这条限制 |
| P0-B | 付款不入账 | `confirmGmpayReceipt` 调 `GET /payments/gmpay/v1/order/query`；v2.0.0 `src/route/router.go` 只注册 `POST /order/create-transaction` 与 `GET /config`，该路径 **GET/POST 均 404** → 代码抛 `503「支付状态暂时无法核实」` → `notify/.../route.ts` 的 `acceptPayment` 永不执行 |
| P1-C | 改路由也不够 | 真路由 `GET /pay/check-status/{trade_id}` 只回 `{trade_id, status}`；现有 `currency/order_id/amount` 四重比对全部是 `undefined`，必抛「支付查询结果不匹配」 |
| P1-D | 10002 不可恢复 | 网关按 `order_id` 全局查重（`order_service.go:139-145`，进程内锁），且**没有按 order_id 反查 trade_id 的接口** → POST 已建单、响应丢失时，重试只拿 `10002 order already exists`，支付地址永久丢 |
| P2-E | 10041 环境项 | 网关下单时对 `notify_url` 的 host 做**实时 DNS 解析**并要求全部解析到公网 IP（`src/util/security/url_guard.go`）。实测 `example.com`→200；`example.test`/`.invalid`（不解析）/`192.168.0.1`（私网）→`10041`。**不是代码 bug，是部署体检项** |

**已核实正确、不要改**：
- 签名：HMAC-SHA256 + 参数名 ASCII 排序 + 排除 `signature` 与空值，与网关 `src/util/sign/sign.go` 一致。实测用 store 的算法自签，金额非法时网关回 `10004` 而**不是** `401`，说明签名通过。
- 请求必须 `application/x-www-form-urlencoded`。**不要改成 JSON**：JSON 会把 `100.00` 规范化成 `100`，改变待签串，静默验签失败。现有 `post()` 已正确。
- 回调：网关 POST JSON `{pid, trade_id, order_id, amount, actual_amount, receive_address, token, block_transaction_id, status, signature}`，`status=2` 为成功，`amount` 是 JSON 数字；ack 必须是纯文本 `ok` 或 `success`（store 回 `ok` ✅）。回调**没有** `currency` 字段，`payments.ts` 里「有则校验」的写法是对的。
- 响应：`data.trade_id`、`data.payment_url` 均存在，`currency=CNY` 大写被服务端 `ToUpper` 接受。

## 2. 要交付的东西

| 文件 | 改什么 |
|---|---|
| `src/server/services.ts` | 订单号压缩到 ≤32：`o_` + `hash(...).slice(0, 30)`。**保持确定性**（同一 `requestKey` 仍得同一 id，幂等键语义不变）。历史 34 字符订单不迁移、不兼容重建 |
| `src/server/integrations/payments.ts` | ①`confirmGmpayReceipt` 改调 `GET /pay/check-status/{trade_id}`，判据 `data.trade_id === receipt.transactionId && Number(data.status) === 2`；②金额/币种交叉核改为可选调用 `GET /pay/checkout-counter-resp/{trade_id}`（字段 `amount/actual_amount/currency/status/token/network`），失败时降级为「签名 + status」但**记一条 warn**；③`createPayment` 处理 `status_code === 10002`：抛专用错误并给出「该订单在网关已存在，请勿重复支付，联系支持核对」的用户可见文案，**不要**静默重试 |
| `src/server/integrations/payments.test.ts` | 用**真实订单号形态**（34 字符）做夹具改前反向用例；新增 10002、404→503 的用例 |
| `scripts/ops/deployer-preflight.sh` | 新增体检项：`APP_URL` 的 host 必须解析到公网 IP（`http`/`https` 均可，`localhost`/私网/解析失败判 FAIL 并提示「GMPay 下单会 10041」）。**这条只对启用 gmpay 的实例生效** |
| `docs/database.md` / `docs/GO-LIVE-BLOCKERS.md` | 同步结论；`docs/prompts/P0-1-xorpay-query-sweeper.md` 里「gmpay 走现有 confirmGmpayReceipt」一句要改成新实现 |

**不要动**：`signatures.ts` 的任何函数、`verifyReceipt` 的 gmpay 分支、`post()` 的 Content-Type、`acceptPayment` 语义。

## 3. 实现要点

1. **订单号**：只改截断长度，不要换 hash 算法、不要加时间戳（会破坏幂等）。改完 grep 全仓确认没有第二处拼订单号。
2. **查单**：`check-status` 是**无签名**的公开接口，只接受 `trade_id`；不要试图往里塞 `pid`/`signature`。
3. **金额核对**：`checkout-counter-resp` 也是公开接口，返回的是法币 `amount` 与 `currency`；核对用「订单外部金额（分）」比对 `decimalToMinor(String(data.amount))`。**这个二次核对失败时不要让整笔回调失败**——签名已经证明来源，二次核对只做防呆，失败记 warn。
4. **10002 语义**：网关认为该 `order_id` 已存在。此时**不能新建**，也拿不到 `trade_id`，只能把订单标成需要人工核对（不要自动退款、不要自动置为已支付）。
5. **超时/网络错误**：`createPayment` 失败时不要把 `paymentId` 写空后重试；要么保持原状让用户重开收银台（同一 `requestKey` 命中原订单），要么走人工。**禁止在没有 trade_id 的情况下二次调用 create**，那正是 10002 的来源。
6. **NUL/重复参数**：回调已由 `parseFlatCallbackJSON` 处理，不要绕过它。

## 4. 上线前置（写进文档，不改代码）

- **修好并实测通过前，后台 `gmpay` 集成保持 disabled**（真实买家碰一次 P0-B 就是赔钱 + 赔偿）。
- 部署体检：`APP_URL` 必须是「公网可解析的域名」；裸 IP、内网域名、`*.test`/`*.invalid` 一律建单失败。
- live 回调测试需要公网可达的 `https://<域名>/api/payments/notify/gmpay/<integrationId>`；**域名在下单那一刻就要能解析到公网 IP**（隧道域名可行，前提是解析存在）。demo 模式路由直接 404，回调只能在 live 测。

## 5. 验收判据（@u5c0f-q 按此打，实现者不参与验收）

1. **建单**：用真实订单号形态（≤32 字符）对 live 网关建单 → `200`，拿到 `trade_id` + `payment_url`；**且**改前形态（34 字符）必须仍失败并给出可读错误（反向用例）。
2. **查单**：`confirmGmpayReceipt` 打的是 `GET /pay/check-status/{trade_id}`；构造 `status=2` 的真签名回调打本地路由 → `acceptPayment` 落库、订单转已支付；构造 `status=4`（占位单）→ 不判成功。
3. **金额不符**：二次核对返回不同 amount → 不阻断入账但必须有 warn 日志（对象：日志；失败长什么样：一条 warn；通过标准：至少 1 条，且订单仍入账）。
4. **10002**：mock 网关回 `10002` → 订单不重复创建、不进已支付、后台可见人工处置提示。
5. **10041**：preflight 在 `APP_URL` 指内网/不可解析时判 FAIL；指公网域名时 PASS。
6. **回归**：`bun run check` 0 error；带 `TEST_DATABASE_URL` **326 passed / 0 skipped**（若新增用例，报数与新增条数必须对得上，同时报 passed 与 skipped）；`bun run db:verify` **335/393/85/6/6**；契约 `--check` exit 0。
7. **不误伤**：`signatures.ts` 的 diff 为空；`post()` 仍发 form-urlencoded；XorPay/易支付用例仍全绿。

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

1. 改动文件清单 + 每处一句话说明；
2. 六条命令真实输出（含 skipped 数与契约 exit code）；
3. 第 5 节 7 条各自对应的验证方式，第 3、4 条要贴日志/响应原文；
4. 明确写出「签名与 form 编码未动」的证据（`git diff --stat` 里 `signatures.ts` 不出现）；
5. 本地提交，不 push。
