# 任务单 P0#1：支付主动查询兜底（sweeper）+ 渠道能力矩阵

> 给实现者（Codex，全新对话）：这是一份自包含任务单，不要依赖任何聊天记录。
> 仓库：`~/Documents/store`（远程 `getcodex-plus/store`）。**不要 git push**，改完只做本地提交。

## 0. 一句话目标

付款成功但回调没到（或回调被上游放弃）的订单，现在会永远停在「未支付」。新增一个**只读、幂等、按渠道能力运行**的查询 sweeper，把这类单补入账；对不能查询的渠道不上报错误噪音，而是留一条静态警示。

## 1. 现状（已核实的代码事实，不要重新论证）

- 回调入口：`src/app/api/payments/notify/[provider]/[revision]/route.ts`，验签在 `src/server/integrations/payments.ts:verifyReceipt`，入账在 `src/server/services.ts:acceptPayment`。
- `acceptPayment` 已经具备全套防线，**必须复用，不要另写入账逻辑**：
  - 校验 `record.provider === provider` 且 `record.integrationId === revision`
  - 金额必须等于 `order.externalAmount`（分）
  - `paymentId` 已存在时必须与 `receipt.transactionId` 一致
  - `(provider, transactionId)` 唯一键 + advisory lock ⇒ 与真实回调并发时最多入账一次
  - 订单状态不是 `unpaid` 时抛 `ApiError(409, '订单状态不允许收款')` —— **sweeper 必须把 409 当作「已被回调入账」正常忽略，不是错误**
- 创建支付时 `aoid` 已存进 `orders.payment_id`（`payments.ts:createPayment`），所以 sweeper 有查询键。
- 配置读取：`src/server/integrations/config.ts:integration(provider, revision)` 返回 `public + secrets` 合并后的 `Record<string,string>`。
- **陷阱**：`saveIntegration` 只保留 `publicKeys[provider]` 白名单里的字段（`config.ts:108-119`、`config.ts:175`）。不先加白名单，新开关会在每次后台保存时被**静默丢弃**。
- 现在只有 GMPay 有查询兜底（`confirmGmpayReceipt`），XorPay / 易支付没有。

## 2. 上游语义（已由 @u5c0f-i 按官方文档核对，直接采信）

XorPay 查询：`GET https://xorpay.com/api/query/{aoid}`，**无需签名/密钥**，返回六态：

| status | 语义 | 动作 |
|---|---|---|
| `success` | 已支付且通知成功 | 补入账（说明回调丢了） |
| `payed` | 已支付但通知未成功 | 补入账 |
| `new` | 未支付 | 不动作 |
| `expire` | 已过期 | 不动作 |
| `not_exist` | 订单不存在 | 不动作 + **告警**（本地存了上游不存在的 aoid） |
| `fee_error` | 已支付但手续费扣除失败 | **不自动入账**，转人工 |

因为查询接口无签名，**金额校验是唯一的真实性防线**：`pay_price` 必须等于 `order.externalAmount`，不等则告警且不入账。

三家「订单不存在」的形态不同，必须归一到同一条告警：XorPay `not_exist`、Epusdt `status_code:10008`、gmpay-edge 约 400 业务码。

## 3. 要改的文件

| 文件 | 改动 |
|---|---|
| `src/server/integrations/config.ts` | `publicKeys` 给 `xorpay`/`gmpay`/`epay_v1`/`epay_v2` 增加 `supportsQuery`、`supportsRefund`（值 `'true'`/`'false'`，缺省视为 `false`） |
| `src/server/integrations/payments.ts` | 新增 `queryPaymentStatus(order, config)`，按 provider 分派：xorpay 走 `GET /api/query/{aoid}`；gmpay 走现有 `confirmGmpayReceipt`（返回已核实/未支付/异常）；epay 无实现 → 返回 `unsupported` |
| `src/server/payment-sweeper.ts`（新） | 扫单逻辑：挑 `status='unpaid'` 且 `payment_id` 非空且 `created_at < now-10min` 的订单，按 integration 的 `supportsQuery` 过滤，单次上限 20 单，逐单 `advisoryLock(判定并处理)` |
| `src/server/worker-tasks.ts` | `tick()` 里增加一次 `sweepUnpaidPayments()`（每 tick 只做一次，不要按分钟硬等） |
| `src/components/Admin.tsx` | 集成页展示两个开关（否则运维无法开启能力，功能等于不存在） |
| `src/server/payment-sweeper.test.ts`（新） | 见验收 |

**不要动**：`acceptPayment` 的任何校验条件、`verifyReceipt` 的签名逻辑、回调路由，以及 `prisma/` 下的任何文件（本任务不改表结构）。

## 4. 实现要点（照做即可，不要自创语义）

1. `supportsQuery` 缺省 = `false` = **不查询**。宁可死单被人工发现，也不要对不支持查询的渠道每 10 分钟打 404。
2. 对 `supportsQuery=false` 的已启用渠道：**每次 worker 启动记一条** `riskEvent`（`scene='payment'`, `action='capability_warning'`, `reasonCodes=['NO_QUERY_CAPABILITY']`, `referenceId=integrationId`）或等价静态警示，一条即可，不要每分钟刷。
3. 处理结果映射：
   - `payed` / `success` → 构造 `Receipt{ orderId, transactionId: aoid, amount, paid: true, channel: order.channel }`，调 `acceptPayment(provider, order.integrationId, receipt)`；捕获 409 视为已入账。
   - `fee_error` → `riskEvent(scene='payment', action='manual_review', reasonCodes=['FEE_ERROR'])`，**不入账、不改订单状态**。
   - `not_exist` → `riskEvent(scene='payment', action='alert', reasonCodes=['NOT_EXIST'])`。
   - `new` / `expire` / `unsupported` → 静默。
   - 网络/HTTP 异常 → 单条跳过，写 `lastError` 级别日志，不抛到 tick。
4. 查询是只读 GET，不需要密钥，**不要缓存结果、不要重试同一次 tick 内**。
5. 单次上限 20 单 + 只挑 10 分钟以上的单，避免把 tick 拖慢、避免和刚下单的用户抢时间。

## 5. 验收判据（@u5c0f-q 会照这些打，写单的人不参与验收）

1. `payed` 与 `success` 两态都能补入账，且 `payment_events` 只多一条。
2. 同一 `aoid` 被回调与 sweeper 同时处理：`payment_events` 恰好一条，订单状态只前进一次，**日志里没有红色报错**（409 被吞）。
3. `pay_price` 与订单金额不一致：不入账、落告警。
4. `fee_error`：不入账、落人工，订单仍是 `unpaid`。
5. `not_exist` 三家形态（xorpay `not_exist` / epusdt `10008` / edge 400）各自喂一条，**都进同一条告警通道**。
6. `supportsQuery=false` 的渠道：一次 tick 内 0 次外部请求，且有且仅有一条能力警示。
7. 后端集成页保存后重新读取，`supportsQuery` 仍然存在（验证白名单已加，没被静默丢弃）。

## 6. 命令与基线（必须全绿才算交付）

```bash
cd ~/Documents/store
bun run check                                   # 期望 0 error
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test bun run test
bun run build
```

- 基线（未改代码时）：`check` 0 error；`test` 41 文件 / **326 passed**；`build` 22 路由成功。
- **报数铁律**：必须同时报 `N passed / N skipped`，只报 passed 不算数。裸跑 `bun run test` 会静默跳过 170 项 DB 测试并显示全绿，别被它骗。
- 本地库前置：`open -a OrbStack && docker start store-db-1`（不是 `store-postgres-1`）。

## 7. 交付格式

1. 改动文件清单 + 每个文件一句话说明；
2. 上面 6 条命令的真实输出（含 skipped 数）；
3. 新增测试的用例名列表，与第 5 节 1:1 对应；
4. 明确写出「未验证项」（例如无真渠道凭证，未做沙箱实测）；
5. 本地提交，**不 push**。

遇到与本单描述不一致的代码现状，**先停下来在交付里写清差异**，不要自行改动涉钱校验条件。
