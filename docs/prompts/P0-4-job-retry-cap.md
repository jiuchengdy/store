# 任务单 P0#4：出货 job 重试上限（到限转人工 + 自动通知买家）

> 给实现者（Codex，全新对话）：自包含任务单，不依赖聊天记录。
> 仓库：`~/Documents/store`。**不要 git push**，改完只做本地提交。

## 0. 一句话目标

出货 job 现在**没有最大尝试次数**：`Math.min(300, 5 * 2 ** min(attempts, 6))` 封顶后每 5 分钟重试一次，**永不放弃、永不转人工**。上游永久性报错（账号停用、商品下架、参数错）会让订单永远停在「已付款/processing」，买家永远收不到「需要人工协助处理」那封信。要给一个上限。

## 1. 现状（已核实的代码事实）

- `src/server/worker-tasks.ts:tick()`：`claimJob(client, lease)` 取一条 job；成功且订单已离开 `processing` 才 `done=true`；失败按 `Math.min(300, 5 * 2 ** Math.min(job.attempts, 6))` 秒退避重试，**没有上限判断**。
- `Job` 表有 `attempts` / `runAt` / `lastError` / `done` 字段（`prisma/schema.prisma:312-324`），**没有 `maxAttempts` 概念**——本任务不改表结构，用常量。
- 订单状态集合（业务语义，见 `src/server/notifications.ts:6-14`）：`unpaid` / `processing` / `completed` / `needs_session` / `failed` / `refunded` / `cancelled`。
- **关键机制（务必利用，不要另写邮件代码）**：`prisma/init.sql:759` 有触发器 `order_email_outbox AFTER INSERT OR UPDATE OF status ON orders`，任何 `orders.status` 变更都会自动往 `email_outbox` 入队一封对应状态的信；`email_outbox` 上有 `(order_id, status)` 唯一约束（`init.sql:593`），重复更新同一状态不会重复发信。`failed` 对应的买家文案是「需要人工协助处理」。
- 结论：**只要把订单状态改成 `failed`，买家自动收到通知**；不要去调 `sendEmail`。
- 退款不是本任务范围：`failed` 单仍需人工在后台点退款（`refunds.ts:supportsAutomaticRefund` 只对 XorPay 生效）。

## 2. 要改的文件

| 文件 | 改动 |
|---|---|
| `src/server/worker-tasks.ts` | 在 catch 分支加「达上限」判断：`job.attempts >= MAX_FULFILLMENT_ATTEMPTS` 时不再延后重试，而是转终态 |
| `src/server/fulfillment.ts` 或新文件 `src/server/fulfillment-exhaustion.ts` | 新增一个事务函数 `exhaustFulfillment(orderId, lastError)`：锁订单 → 若仍是 `processing`/`needs_session` → 置 `status='failed'`、`failureReason='fulfillment_retry_exhausted'`、写 `fulfillmentStatus`/日志字段 → `job.done=true` → 记 `audit` |
| `src/server/worker-tasks.test.ts`（或现有对应测试文件） | 见验收 |

**不要动**：`acceptPayment`、`fulfillOrder` 的成功路径、`refunds.ts`、任何支付/退款金额逻辑。

## 3. 实现要点

1. 上限常量：`MAX_FULFILLMENT_ATTEMPTS = 20`（按现有退避，约 100 分钟；写清为什么是这个数）。**可配置但不是必须**：如果要走环境变量，缺省必须是 20，不能缺省成无限。
2. 只在「非终态」时转 `failed`：`completed` / `refunded` / `cancelled` / 已经是 `failed` 的单，**一律不动**（幂等：重复 tick 不会重复改）。
3. `needs_session` 不属于「无限重试」的范畴——那是等用户补账号信息，**不要**把它算进上限计数，也不要自动转 `failed`。
4. 转终态时要保住现场信息：`job.lastError` 保留最后一次上游 code（用 `safeUpstreamError` 的白名单，不要直接落上游原文），`orders.failureReason` 固定字符串，便于后台筛选。
5. 转 `failed` 后必须保证 job 不再被领取：`done=true` 且 `lockedUntil=null`；不要 `delete` job（排查时要能看）。
6. 不要在这一步做任何金额动作（不退钱包、不退渠道），仅改状态 + 通知。

### 3b. 测试数据与通知机制的硬约束（实测得出的，别猜）

1. 触发器 `enqueue_order_email()`（`prisma/init.sql:40-48`）第一行就是 `IF NEW.contact_email IS NOT NULL AND ...`：**订单没有 `contact_email` 就一封都不入队，且零报错**。造测试单必须显式带 `contact_email`（正常下单路径由 `data.ts:124` 回落成 `userId ? user.email : ...`，所以线上多数有值）。
2. `orders_channel_check` 只接受 `alipay / wechat / crypto / balance`；`orders_status_check` 只接受 `unpaid / processing / completed / needs_session / failed / refunded / cancelled`（`init.sql:368`、`:375`）。乱填直接撞约束。
3. `external_amount` 是 NOT NULL 且无默认值，插单必须显式给。
4. `email_outbox` 主键是 `order_id:status`，且 `UNIQUE(order_id, status)` + `ON CONFLICT DO NOTHING`（`init.sql:46`、`:592-593`）：**同一订单第二次进入同一状态，通知会被静默吞掉，买家收不到第二封信**。这是"只发一封"能轻松通过、而"该发两封发不出"的反向陷阱，见第 4 节第 8 条。

## 4. 验收判据（@u5c0f-q 按此打）

### 验收形态

- 出货 worker 在**容器内**运行（compose 里 `worker` 服务），判据要写清是容器内跑还是宿主机直跑。
- 容器只读根文件系统（`compose.prod.yaml:31`），本单不写盘，若实现里引了临时文件写入必须改掉。
- 验收前先跑 `scripts/ops/deployer-preflight.sh`，但它替代不了"照文档走一遍"。


1. 造一个永远失败的上游（mock 抛永久性错误）：连续 tick 到第 20 次后，订单 `status='failed'`、`failureReason='fulfillment_retry_exhausted'`、job `done=true`。
2. 第 21 次 tick：该单**不再被领取**（零次上游请求），订单状态不变。
3. 转 `failed` 的同一个事务里，`email_outbox` 出现一条 `status='failed'` 的记录（触发器生效），且**只有一条**（再 tick 一次仍只有一条）。
4. `completed` / `refunded` / `cancelled` / `needs_session` 四种状态各自造一条 job：达到上限也**不被改成** `failed`。
5. `needs_session` 的计数语义：多次 `needs_session` 往返不计入 20 次上限（用例说明清楚即可）。
6. 上限触发后，`job.lastError` 是白名单内的 code（不是上游原文、不是 null）。
7. `contact_email` 为空的订单转 `failed` 时：**后台必须有可见提示**（例如 `audit` 一条「通知未发送：缺少联系邮箱」或后台列表标记），不允许"什么都没发生"。
8. 同一订单两次不同时段进 `failed`（`failed` → 人工改回 `processing` → 再次 `failed`）：买家**必须收到两封**通知。
   - **判据就是"收到两封"，不接受"已知限制 + 后台提示"的替代**（已拍板）。
   - 实现方式：在 **P0#3 迁移账本落地之后**，用编号 SQL 调整 `email_outbox` 主键/唯一约束（或触发器改为带序号的 `id`），不要在 `init.sql` 里手改后不同步契约——那样 `db:verify` 必红。
   - **两条路径都要验**：注册用户订单、游客订单（`data.ts:124` 的 `contactEmail ?? email` 让游客单也带邮箱）。只测有账号的路径不算通过。
   - 本单的触发上限逻辑与"两封信"的表结构改动**必须在不同提交里**：先交 job 上限（只改代码），再交迁移 + 契约 + 触发器。混在一个提交里，验收分不清是哪一步坏的。

## 5. 旧断言怎么处理

现有测试里若有「失败后一定 `runAt` 前移 / 一定还在重试」的断言，属于**旧行为**：保留它们在前 19 次，第 20 次之后改为断言终态。不要为了让旧断言过而取消上限。

## 6. 命令与基线

```bash
cd ~/Documents/store
open -a OrbStack && docker start store-db-1
bun run check                                    # 期望 0 error
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test bun run test
bun run build
```

基线：41 文件 / **326 passed / 0 skipped**（带 `TEST_DATABASE_URL`）。裸跑会静默跳过 170 项 DB 测试并显示全绿——**报数必须同时报 passed 与 skipped**。

## 7. 交付格式

1. 改动文件清单 + 上限取值的理由（20 次 ≈ 多久）；
2. 三条命令真实输出（含 skipped 数）；
3. 第 4 节 6 条对应测试用例名；
4. 明确写出：这一步之后买家会收到「需要人工协助处理」邮件，**退款仍需人工操作**（不是本任务范围）；
5. 本地提交，不 push。
