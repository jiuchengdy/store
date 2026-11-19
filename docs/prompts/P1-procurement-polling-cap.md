# 任务单 P1：采购单轮询上限 + 采购单可见性 + 取消出口

> 自包含任务单，给实现者（本项目由团队自己实现，不交外部编码代理）。
> 本单**不下真单**：真实 `POST /orders` 只允许 @u5c0f-q 按小G 批准的那一条（`insufficient_balance` 拒绝路径）执行；Codex 只写 mock。
> **修订版 2（2026-11-19）**：上限改按**时间**判定（消掉「轮询与退避共用 `attempts` 会误导分诊」）、可见性升为可自动断言、幂等断言按上游真实行为改写、取消出口定调、补 `manual` 商品约束。

## 0. 一句话目标

采购单卡在上游中间态时，现在**永远每 15 秒打一次上游**，而且**后台看不到任何采购单**；修到「卡住 30 分钟自动转人工、人工看得见、处置有 SOP」。

## 1. 现状（2026-11-19 代码/上游事实，不要重新论证）

**代码侧**
- `src/server/procurement.ts:208`：中间态只 `nextRunAt = later(15)`，`later` 同文件 `:143` 定义成**秒** → 每 15 秒一次；`attempts` 在这个分支里**完全没被读**。
- `src/server/procurement.ts:217`：异常退避 `min(300, 5 * 2 ** min(attempts, 6))` 秒，**同样无上限**。
- `claimStockPurchase`（`src/server/database-sql.ts:45-55`）每次领取 `attempts += 1` + 90 秒租约——**中间态轮询和异常退避共用同一个计数器**，按 `attempts` 卡上限会在混合场景误诊（先网络慢重试 10 次、再正常轮询，`attempts>=20` 先触发，运维看到 `retry_exhausted` 却只是慢）。**本单因此不用 `attempts` 判上限，改用时间。**
- `stock_purchases` **没有任何读出口**：`grep -rn stockPurchase src/components src/app/api src/server/data.ts src/server/services.ts` → **0 命中**。`state='review'` 只是库里一个字符串，后台看不见、没人被通知。
- 已有幂等：`purchase.upstreamOrderId` 存在时不再 `create`，只查 `order`。**这部分是对的，不要改。**

**上游侧（Dujiao-Next 开放接口）**
- `create()` 的请求体只有 `sku_id / quantity / downstream_order_no / trace_id`，**不含 `manual_form_data`**；官方要求「商品为 `manual` 类型时该字段必填」→ 映射到 `manual` 商品会在**建单那一步** `400 bad_request`，落 `PurchaseRejection` → `state='rejected'`，走不到交付判断。
- 重复提交同一 `downstream_order_no` 时，上游**返回已有订单**（不报错）。**Dujiao 没有 10002 这种码**（10002 是 EPUSDT 的），验收别等它。
- 官方有 `POST /orders/:id/cancel`，并规定：**本地取消前必须先执行上游取消；上游返回不可取消时，本地必须拒绝取消与退款**；另有明文「上游采购失败时应标异常待处理，**不应自动做本地取消/退款关闭**」。

## 2. 要交付的东西

| 文件 | 改什么 |
|---|---|
| `src/server/procurement.ts` | ①中间态：`state='polling'` 且 `created_at` 距今 **≥30 分钟** → `state='review'`、`lastError='stale_upstream:<上游当前 status>'`，不再续 `nextRunAt`；未到 30 分钟照旧 15 秒后重查；②异常：`created_at` 距今 **≥6 小时** → `state='review'`、`lastError='retry_exhausted:<最后错误码>'`；③中间态分支把上游当前 status 写进 `lastError`（原先写 `null`），转 review 时能直接看出卡在哪一步；④两个阈值写常量并注释 |
| `src/server/data.ts` | 新增**只读**查询：采购单列表，字段至少 `id / state / attempts / lastError / upstreamOrderId / productId / skuId / quantity / createdAt / nextRunAt`，按下单时间倒序，可按 `state` 过滤 |
| 新增 API 路由（`src/app/api/admin/...`，权限沿用后台现有校验） | 暴露上面的查询，**必须能返回 JSON**，否则判据 3 无法自动断言 |
| `src/components/Admin.tsx` | ①集成配置区下方加「采购单」只读列表（默认 `review`/`rejected`/`polling`），`lastError` 原样显示，**只读**、无「重试/改状态」按钮，并写一句「卡住的单请去上游后台处理，本页不改状态」；②进货映射表单加提示：**只能选 `fulfillment_type=auto` 的上游商品**，`manual` 会在建单时被上游拒绝且本系统看不到原因 |
| `src/server/procurement.test.ts` | 中间态超 30 分钟 → `review`+`stale_upstream:*`；异常超 6 小时 → `review`+`retry_exhausted:*`；未到阈值仍续跑且 `nextRunAt ≈ now+15s`；**上限之后上游请求次数为 0** |
| `docs/ops-runbook.md` | 「采购单卡住」SOP：看哪个列表 → `stale_upstream` 去上游后台核对是否卡在部分交付 → `retry_exhausted` 查我们这边网络/时钟/签名 → **取消/退款一律人工**：先在上游后台取消成功，再手工把本地置 `review` 并写 `lastError='cancelled_by_admin'`；上游说不可取消就**不许**本地取消或退款（引官方 §1.3） |

**禁止**：改 `dujiao.ts` 的签名逻辑（`path.split('?')[0]` 是对的，带 query 签实测 `401 invalid_signature`，见 `APPENDIX-dujiao-next-upstream.md` §2）；改 `create` 的幂等键；真打 `POST /orders`；新增 `stock_purchases` 的列（本单不迁移）；实现自动 cancel（进 backlog，本轮只做人工 SOP）。

## 3. 实现要点

1. **为什么用时间不用 `attempts`**：`attempts` 是「领取总次数」，轮询与异常退避共用；按它卡上限会在混合场景误诊。改用 `created_at` 距当前的时长，语义是「这单卡了多久」，与运维直觉和 30 分钟口径一致，且**不新增列、不做迁移**。副作用要写进注释：排队时间也计入，所以排队久的单会更早进 review——那本来也该有人看。
2. **两个 `lastError` 前缀必须能一眼分诊**：`stale_upstream:` = 上游一直不给终态（去上游看）；`retry_exhausted:` = 我们这边连续出错（查网络/时钟/签名）。冒号后必须带当时的真实值（上游 status 或错误码），只写前缀等于没写。
3. **转 review 后必须真停**：`state='review'` 不在 `claimStockPurchase` 的 `state IN ('queued','polling')` 里，天然不再被领取。**不要**另加「定时扫 review 重试」的循环，那就等于没上限。
4. **可见性是一等公民**：没有列表，「转人工」就是扔黑洞；没有 API，判据 3 只能靠人眼看，不算可核判据。
5. **取消/退款本轮只做人工**：自动 `cancel` 要「先调上游成功再改本地、`cancel_not_allowed` 时拒绝本地」的完整状态机，而余额不足现在联调不了真 cancel，写出来就是没验过的死代码 → 进 backlog。本轮把人工步骤写进 runbook。
6. **告警不做新渠道**：靠后台列表 + runbook。主动告警另开单，别往采购链路里塞通知逻辑。

## 4. 验收判据（@u5c0f-q）

1. **中间态上限**：mock 上游一直回 `fulfilling`，`created_at` 回拨 29 分钟 → 仍 `polling`、`nextRunAt ≈ now+15s`；回拨 31 分钟 → `state='review'`、`lastError='stale_upstream:fulfilling'`、**之后 0 次上游请求**（用 mock 调用次数断言，不看日志）。
2. **异常上限**：mock 持续 500，`created_at` 回拨 7 小时 → `state='review'`、`lastError` 以 `retry_exhausted:` 开头，之后 0 次请求。
3. **可见性可自动断言**：调新增 API 拿 JSON，`review` 过滤下能查到上面两条、`lastError` 与数据库逐字一致；空库返回空数组不报错。**必须贴请求与原始响应。**
4. **幂等未被破坏**：已有 `upstreamOrderId` 的采购单不再 `POST /orders`（mock 断言 create 次数为 0）。上游真的重复提交时，判据是「**返回同一个 `order_id`、上游订单数不增、`ok:true`**」——**不要等 10002**。
5. **manual 商品**：后台映射页对 `manual` 上游商品有可见提示；mock 一次 `manual` 商品建单 → `PurchaseRejection` → `state='rejected'`（证明提示对应真实失败路径）。
6. **不误伤**：`dujiao.ts` 的 `git diff` 为空；`dujiao.test.ts`、`procurement.test.ts` 全绿；`orders.status` 未新增取值。
7. **回归**：`bun run check` 0 error；带 `TEST_DATABASE_URL` 报数时**同时报 passed / skipped**（基线 326 / 0，新增用例要能对上）；`bun run db:verify` 仍 **335/393/85/6/6**（本单不迁移，数字必须不变）；契约 `--check` exit 0。

## 5. 命令与基线

```bash
cd ~/Documents/store
export PATH="$HOME/.bun/bin:$PATH"
open -a OrbStack && docker start store-db-1
bun run check
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test bun run test
bun run db:verify
bun scripts/ops/gen-contract.ts --check
```

## 6. 交付格式

1. 文件清单 + 两个时间阈值的常量与注释（含「排队时间也计入」的副作用说明）；
2. 六条命令输出（含 skipped 与契约 exit code）；
3. §4 七条各自验证方式：第 1、2 条贴「上限后 0 次上游请求」断言输出，第 3 条贴 API 原始响应，第 5 条贴 `rejected` 落库结果；
4. 本地提交，不 push。
