# 任务单 P0#2：上游（Dujiao-Next）错误码补全 + 采购单不再无限重试

> 给实现者（Codex，全新对话）：自包含任务单，不依赖聊天记录。
> 仓库：`~/Documents/store`。**不要 git push**，改完只做本地提交。

## 0. 一句话目标

上游返回「缺货 / 订单键非法」这类**已知拒绝**时，现在会被 zod 整包拒绝 → 退化成 502「上游暂时不可用」→ 按 ≤300 秒无限重试，采购单永远停在 `queued/polling`，运营看不到、上游被反复打、钱已经付出去。要让它**识别、落库、停止重试、进人工队列**。

## 1. 现状（已核实的代码事实）

- `src/server/integrations/dujiao.ts:40-42`：`rejections` 只枚举 6 个 code：`insufficient_balance` / `insufficient_stock` / `product_unavailable` / `sku_unavailable` / `bad_request` / `payment_failed`。
- `dujiao.ts:96-99`：只有满足 `resource==='orders' && status<500 && errorEnvelope.safeParse(data).success` 才抛 `PurchaseRejection`；否则一律 `ApiError(502, '进货上游请求未确认…')`。
- 因此官方文档里的 `invalid_order_key`、`stock_unavailable` 会让 `error_code: z.enum(...)` 解析失败 ⇒ 整包 safeParse 失败 ⇒ 变成 502。
- `src/server/procurement.ts:210-220`：`PurchaseRejection` → `state='rejected'`（停止重试）；`DeliveryMismatch` → `state='review'`；**其它一切异常** → `retry_pending` + `nextRunAt = min(300, 5*2**attempts)` ⇒ 无上限重试。
- 采购单 upstream 已付款后，上游**没有退款接口**，只能人工处置（runbook 第 7.2 节）。

## 2. 要改的文件

| 文件 | 改动 |
|---|---|
| `src/server/integrations/dujiao.ts` | `error_code` 改为「宽进严判」：解析用 `z.string().min(1).max(80)`，不再用 `z.enum` 拒绝整包；新增 `DUJIAO_ERRORS` 映射表，把 code 映射到处理策略 |
| `src/server/procurement.ts` | 按策略落库：停止重试 / 进人工 / 保持重试；未知 4xx 一律进 `review`，不要落回无限重试 |
| `src/server/safe-errors.ts` | 若新增 code 要出现在 API/日志里，必须加入 `codes` 白名单，否则会被降级成 `UPSTREAM_ERROR`（该白名单是防止上游字符串注入的，**不要绕过它**） |
| `src/server/procurement.test.ts` | 补用例；原有断言按第 5 节处理 |

**不要动**：签名计算 `dujiaoSignature`、`downstream_order_no` 的生成（`stock_${requestKey}` 是上游幂等键，改了会重复下单）、任何支付相关文件。

## 3. 建议的策略表（可微调，但必须落库可见）

| 上游 error_code | 语义 | state | 是否继续重试 | 备注 |
|---|---|---|---|---|
| `insufficient_stock` / `stock_unavailable` / `sku_unavailable` | 缺货 | `rejected` | 停止 | `lastError` 存原始 code；这是常态，不是故障 |
| `product_unavailable` | 商品下架 | `rejected` | 停止 | |
| `insufficient_balance` | 上游余额不足 | `review` | 停止 | 这是**我们的钱不够**，必须人看见 |
| `invalid_order_key` / `bad_request` | 请求被拒（多为配置/幂等键问题） | `review` | 停止 | 典型原因：`downstream_order_no` 传错 |
| `payment_failed` | 上游扣款失败 | `review` | 停止 | |
| 未知 4xx code | 不认识 | `review` | 停止 | `lastError = 'unknown:<code>'`，**保留原文但截断长度** |
| 5xx / 网络 / 超时 / 响应格式坏 | 真故障 | 保持现状 | 继续（退避） | 不要误判成拒绝 |

要求：所有分支都必须写 `lastError`，且 `lastError` 里能区分「缺货」「配置错误」「未知码」「真故障」四类——运维靠这一列判断找谁。

## 4. 验收判据（@u5c0f-q 按此打）

### 验收形态（每条判据四段齐全才算判据：**验什么对象 · 什么形态 · 失败长什么样 · 在哪个数字上算通过**）

- 判据必须写明 **bare（Bun 直跑 / 裸机）** 还是 **container（compose 容器）**——同一个"通过"在两种形态下可能相反。
- 容器形态事实：`compose.prod.yaml:31 read_only: true`、无 `.data` 挂载，`crypto.ts:8-19` 的 `.data/encryption.key` 回落不算合法来源。
- 从宿主机判断容器内挂载只能给"不知道"，不许 PASS。
- 验收前先跑 `scripts/ops/deployer-preflight.sh`，但它替代不了"照文档走一遍"。
- 判据涉及退出码时：该码必须在 `docs/ops/exit-codes.md` 登记表里**占过位**，且码表与脚本在同一次提交更新；没登记过的码不许写进判据。


1. 上游返回 `{"ok":false,"error_code":"stock_unavailable"}`：`state='rejected'`、`lastError='stock_unavailable'`，**15 分钟内零次重试**（查 `next_run_at` 不再前移）。
2. 上游返回 `invalid_order_key`：`state='review'`、`lastError` 保留原码，停止重试。
3. 上游返回一个从没见过的 4xx code（如 `weird_error_xyz`）：`state='review'`、`lastError='unknown:weird_error_xyz'`，**不再是 `retry_pending`**。
4. 上游 500 / 连接超时：行为不变（继续退避重试），`lastError` 仍是可识别的故障类。
5. 已付款（`upstream_order_id` 非空）的采购单被拒绝时，`upstream_order_id` 必须保留在库里，人工才能凭它去上游查单/催办。
6. 不存在「同一张采购单因为未知 code 被无限重试」的路径（用 3 的用例连跑 3 个 tick 验证）。

## 5. 旧断言怎么处理

`procurement.test.ts` 里现有用例假定「非 6 个 code 一律 502 重试」。这是**要改掉的旧行为**，不是要保住的行为：
- 断言 `retry_pending` 的用例，改成断言具体 state（`rejected` 或 `review`）；
- **不要为了让旧断言过而放宽新逻辑**；改断言时在测试里留一行注释说明「行为变更：未知 4xx 不再无限重试」。

## 6. 命令与基线

```bash
cd ~/Documents/store
open -a OrbStack && docker start store-db-1     # 本地库前置，容器名是 store-db-1
bun run check                                    # 期望 0 error
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test bun run test
bun run build
```

基线：41 文件 / **326 passed / 0 skipped**（带 `TEST_DATABASE_URL`）；裸跑会静默跳过 170 项并显示全绿，**报数必须同时报 passed 与 skipped**。

## 7. 交付格式

1. 改动文件清单 + 策略表最终版（与本单差异要说明）；
2. 三条命令真实输出（含 skipped 数）；
3. 第 4 节 6 条各自的测试用例名；
4. 「上游已扣款不出货」这条人工路径**不在代码里解决**：交付里写一句确认——`state='review'` 的单在后台可见、`upstream_order_id` 可用于人工催办/对账；
5. 本地提交，不 push。
