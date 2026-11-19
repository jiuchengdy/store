# 任务单 P1：采购单轮询上限 + 采购单可见性

> 自包含任务单，给实现者（Codex，全新对话）。
> 本单**不下真单**：所有验证用 mock，`POST /orders` 一次都不许打。

## 0. 一句话目标

采购单一旦卡在上游的中间态，现在会**永远每 15 秒打一次上游**，而且**后台看不到任何采购单**——修到「卡住 30 分钟自动转人工，且在后台看得见」。

## 1. 现状（2026-11-19 代码事实，不要重新论证）

- `src/server/procurement.ts:208`：上游状态既不是终态成功、也不是取消/退款时，只做 `nextRunAt = later(15)`，**`attempts` 不参与判断、没有上限**。`later(n)` 是**秒**（同文件 `:143`），所以是每 **15 秒**轮询一次。
- `src/server/procurement.ts:217`：异常分支退避 `min(300, 5 * 2 ** min(attempts, 6))` 秒，**同样没有上限**，即上游一直报错也会无限重试（约每 5 分钟一次）。
- `claimStockPurchase`（`src/server/database-sql.ts:45-55`）每次领取都 `attempts += 1` 并设 90 秒租约——`attempts` 已经是个可靠的「轮询次数」计数器。
- **`stock_purchases` 在后端没有任何出口**：`grep -rn stockPurchase src/components src/app/api src/server/data.ts src/server/services.ts` **零命中**。也就是说 `state='review'`／`'rejected'` 只是数据库里的一个字符串，**后台看不见、没人会被通知到**。
- 已有幂等：`purchase.upstreamOrderId` 存在时不再 `create`，只查 `order`。**这部分是对的，不要改。**

## 2. 要交付的东西

| 文件 | 改什么 |
|---|---|
| `src/server/procurement.ts` | ①中间态分支：`attempts >= 120`（15 秒 × 120 ≈ **30 分钟**）→ `state: 'review'`, `lastError: 'stale_upstream'`，不再续 `nextRunAt`；②异常分支：`attempts >= 20` → `state: 'review'`, `lastError: 'retry_exhausted'`；③两个上限都写常量，注释写清换算依据（秒 × 次数 = 分钟） |
| `src/server/data.ts`（或既有 stock 查询所在处） | 新增只读查询：采购单列表（按下单时间倒序，支持按 `state` 过滤），字段至少 `id / state / attempts / lastError / upstreamOrderId / productId / skuId / quantity / createdAt / nextRunAt` |
| 后台（`src/components/Admin.tsx` + 对应 API 路由） | 集成配置区下方加「采购单」只读列表：默认只显示 `review` / `rejected` / `polling` 三类，`lastError` 原样显示。**只读**，不要加"重试/改状态"按钮——改状态会绕过业务判断 |
| `src/server/procurement.test.ts` | 新增：中间态超上限 → `review` + `lastError='stale_upstream'`；异常累计超上限 → `review` + `retry_exhausted`；未到上限仍续跑且 `nextRunAt` 为 15 秒后 |
| `docs/ops-runbook.md` | 「采购单卡住」处置：看哪个列表、`stale_upstream` / `retry_exhausted` 各代表什么、怎么去上游后台核对后手工收/退 |

**禁止**：改 `dujiao.ts` 的签名逻辑（`path.split('?')[0]` 是对的，实测带 query 签会 `401 invalid_signature`）；改 `create` 的幂等键；真打 `POST /orders`；新增 `stock_purchases` 的列（本单不迁移，用 `attempts` 当计数器）。

## 3. 实现要点

1. **30 分钟的算法**：15 秒一次 → 120 次。别用「created_at 差值」判，因为排队/租约/退避都会让时间与次数脱钩；用 `attempts` 最稳，且不需要迁移。
2. **两个上限用不同 `lastError`**：`stale_upstream` = 上游一直不给终态（要去上游后台看是不是卡在部分交付）；`retry_exhausted` = 我们这边连续出错（网络/签名/时钟偏差）。运维看到这两个词要能直接分诊。
3. **转 review 后必须停下**：`state='review'` 不在 `claimStockPurchase` 的 `state IN ('queued','polling')` 里，所以自动停——**不要**再在旁边加个"定时扫 review 重试"的循环，那就等于没上限。
4. **可见性是一等公民**：没有列表的话，「转人工」等于扔进黑洞。列表要能按 `lastError` 排序，方便一眼看出是时钟问题（`retry_exhausted` 集中出现）还是上游问题（`stale_upstream`）。
5. **告警不做新渠道**：本单不接邮件/IM；靠后台列表 + runbook。真要做主动告警，另开单，别在采购链路里塞通知逻辑。

## 4. 验收判据（@u5c0f-q）

1. **中间态上限**：mock 上游一直回 `fulfilling`，把 `attempts` 推到 119 → 仍 `polling` 且 `nextRunAt ≈ now+15s`；到 120 → `state='review'`、`lastError='stale_upstream'`、`nextRunAt` 不再被续、**之后 0 次上游请求**（计数用 mock 调用次数断言，不是看日志）。
2. **异常上限**：mock 上游持续 500 → `attempts` 到 20 时 `state='review'`、`lastError='retry_exhausted'`，之后 0 次请求。
3. **可见性**：后台「采购单」列表能查到上面两条（`review` 过滤下可见），`lastError` 与数据库一致；空库时显示空态不报错。
4. **幂等未被破坏**：已有 `upstreamOrderId` 的采购单不会再次 `POST /orders`（mock 断言 create 调用次数为 0）。
5. **不动签名**：`dujiao.ts` 的 `git diff` 为空；现有 `dujiao.test.ts` 全绿。
6. **回归**：`bun run check` 0 error；带 `TEST_DATABASE_URL` 报数时**同时报 passed / skipped**（当前基线 326 / 0，新增用例要能对上）；`bun run db:verify` 仍 **335/393/85/6/6**（本单不迁移，数字必须不变）。

## 5. 命令与基线

```bash
cd ~/Documents/store
export PATH="$HOME/.bun/bin:$PATH"
open -a OrbStack && docker start store-db-1
bun run check
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test bun run test
bun run db:verify
```

## 6. 交付格式

1. 文件清单 + 两处上限的常量与换算注释；
2. 六条命令输出（含 skipped）；
3. §4 六条各自验证方式，第 1、2 条要贴「上限之后 0 次上游请求」的断言输出；
4. 本地提交，不 push。
