# 上线阻塞清单（Go-Live Blockers）

> 汇总自团队 2026-11-19 的五线并行审计（测试 / 涉钱代码 / 运维 / 文档客服 / 上游协议）。
> 结论先行：**代码是健康的（基线 check/db:verify/test 326/build 全绿、e2e 56 过 4 跳过），卡点全在"上线后钱货别出事、出事有人知道、能查、能救"。**
> 每条标注：负责人 + 验收判据。未全部做完前，`APP_MODE` 不得转 live。

## 一、上线阻塞（P0，做完才准上线）

**0. GMPay 实现分叉（最急，用户只需给商户域名）** — @u5c0f-i 用两条 curl 30 秒判定，**不用翻后台/登录**：
   - `GET /pay/check-status/x`：Epusdt 回 200/`status_code:10008`，gmpay-edge 回 404；
   - `GET /payments/gmpay/v1/order/query`：Epusdt 404，edge 401（缺签名）。
   判定后：**Epusdt** 改 URL + 重写响应结构（只回 `{trade_id,status}`，现代码期望的 currency/amount/order_id 全无）；**edge** 维持现状。
   证据（@u5c0f-i 核实 + @u5c0f-q 复读代码确认）：`confirmGmpayReceipt` 请求 `order/query`（`payments.ts:236`），挂在主回调路径（`route.ts:43`），接 Epusdt 时每笔回调 404 → `ApiError(503)` → 厂商重试耗尽 → **GMPay 全部收入进不了账**。mock 测不出这个 404，沙箱真发一笔。

1. **XorPay 主动查询兜底（sweeper）+ 能力矩阵** — 实现 @u5c0f-r，**验收 @u5c0f-q**。任务单 `docs/prompts/P0-1-xorpay-query-sweeper.md` + 附录 `APPENDIX-payment-status-mapping.md`（7 个统一语义，渠道差异压映射层，厂商原始状态不外报）。
   判据：`status ∈ {payed, success}` 且金额一致才补入账；`fee_error` 落人工；复用 `acceptPayment`，`(provider, transactionId)` 唯一键防双记。
   **能力开关存独立字段 + 默认 false，不塞 `publicKeys`**（否则①被 `saveIntegration` 白名单静默吞掉 ②触发"所有字段非空才能启用"）。sweeper 按开关跑，**无查询能力渠道跳过 + 静态警示**，不每 10 分钟打 404 制造噪音。
   **三档"不该动作"归一不报警**：`not_exist`（XorPay `not_exist` / Epusdt `10008` / edge 400 业务码）、`expire`、**`AWAITING_SELECTION`（占位单，买家没选链没转过钱，不是死单）**——三家各喂一条都进同一条告警，占位单不计死单。
   **并发**：sweeper 与真回调撞车时 `acceptPayment` 抛 409，必须当"已入账"吞掉，否则每 10 分钟假警一次。

2. **上游错误码补全 + 资金滞留人工路径** — 实现 @u5c0f-r，**验收 @u5c0f-q**；runbook 7.2 人工分支 @u5c0f-o 已写。任务单 `P0-2-upstream-error-codes.md`。
   补 `invalid_order_key`、`stock_unavailable`；**未知 4xx 不再无限重试**（含 Epusdt 配置类 400：`10016/10017/10018/10019` 映射 `MANUAL_REVIEW` + 配置告警，不是买家问题）。

3. **数据库迁移基线化** — @u5c0f-o 出方案。根因坐实：**真正 schema 源头是 `prisma/init.sql`（触发器/约束都在里面）**，`prisma/migrations` 为空（`e7dcd59` 主动移除历史），"以前怎么升库"永久无解，只能新建 `schema_version` 账本。改表走 expand-contract 两步。

4. **Worker 业务心跳 + 出货 job 最大重试上限** — @u5c0f-o 做 `ops_heartbeat`，@u5c0f-r 补 job 上限，**验收 @u5c0f-q**。任务单 `P0-4-job-retry-cap.md`。
   判据：job 达上限转 `failed` 并发通知。**注意发信是数据库触发器**（`init.sql:759`，状态一变自动入队 `email_outbox`），误改状态也会发信；且 `email_outbox` 唯一键 `ON CONFLICT DO NOTHING` 会吞掉「failed→改回 processing→再 failed」的第二封——验收加一条：**同一订单两次不同时段进 failed，买家必须收到两封**（或明确记录为已知限制）。

5. **备份三层自动化 + 恢复演练** — @u5c0f-o 修复 `fcdd6da`，**@u5c0f-q 已逐条实测验收通过（签字），可进 crontab**（前提 `REMOTE` 定了）。8 项全实跑：剪枝 BSD、异地 sha256、0600 权限、空壳 dump 打穿（MISMATCH exit 1）、`.counts` 缺失 exit 4、有数据用例、清理无残留。
   **仍卡用户**：① 异地目标 `192.168.0.1` 是否接受；② **加密未做**（age/gpg，需先定私钥谁保管）。
   **runbook 待补两处**：本地跑须传 `DB_CONTAINER=store-db-1`（默认 `store-postgres-1` 会直接 `not running`）；首周演练若报 `expected=N restored=N-1` 先看那一刻是否正在下单（`DRILL_TOLERANCE=0` 是对的，红可能是假的）。

6. **客服入口配置门禁（P0）** — 0 行代码：后台填 `supportEmail`。空态文案"请先暂停购买"（`Support.tsx`）——为空上线会劝买家别买。自检已进 runbook 第 2 节第 5 项（断言：正文含真实邮箱 **且** 不含「尚未公布」）。**需要用户给真实邮箱。**

## 二、上线前门槛（P1，不阻塞代码，但缺了不能上线）

7. **e2e 进 CI + 报数铁律** — @u5c0f-q。铁律：报测试数必须同时贴 `N passed / N skipped`。
8. **验签固定向量测试 + 三家沙箱真发一次** — @u5c0f-q。XorPay 两组向量已三方交叉验证一致（可直接写固定向量）。GMPay 回调要真发一笔（mock 测不出 404）。
9. **support-playbook.md** — @u5c0f-d 已交（`598acdd`/`de989ff`/`052361d`）：按渠道退款表、加密货币问答（**第一句先问"看到收款地址了吗"，没看到=占位单没转过钱，不需哈希**）、未实现能力账本、第 4 节"不要随手改订单状态"（改状态会发信）。
10. **CHANGELOG + 文档修正** — @u5c0f-d 已交（`598acdd`）。

## 三、非阻塞（backlog，上线稳定后做）

- `refunds:write` 权限拆分、提现大额双人复核、每日对账视图。

## 四、需要用户本人拍板（我们无法自造/自定）

1. **GMPay 商户域名**（只要这个，@u5c0f-i 两条 curl 30 秒判定实现，不用翻后台）。
2. **GMPay 是 USDT 加密货币收款，留不留**：留 → 每单客服人工核对哈希、首周双倍备人，按"高人工成本渠道"单独定价限流；不留 → 换渠道。
3. **支持邮箱**（或 TG / Tawk）。
4. **加密货币退款汇率差口径**：按实收金额退、汇率波动由谁承担——客服不许自行承诺。
5. **异地备份目标** `192.168.0.1` 行不行 + **加密私钥谁保管**（@u5c0f-o 已卡在这条）。
6. **push 时机**：当前 **10 个**本地提交未上图，等你点头统一 push。
7. **上线外部资源**：域名+HTTPS、服务器、三家真实支付商户号、上游采购账号、邮件服务账号。
8. **`APP_MODE` demo→live 时点**。

## 五、已拍板决策（2026-11-19）

- 邮件时间承诺 **"2 小时"**；`paid: true` 三家协议都合法，但三家都缺查单兜底。
- **能力开关方案**（`supportsQuery`/`supportsRefund` 独立字段 + 默认 false）替代渠道 fork；**7 个统一语义**（`CREDITED`/`PAID_UNCREDITED`/`NOT_PAID`/`AWAITING_SELECTION`/`EXPIRED`/`MANUAL_REVIEW`/`ORDER_NOT_FOUND`）收敛渠道差异。
- **占位单（`AWAITING_SELECTION`）不计死单、不报警**，归"不该动作"档。
- 实现/验收分离：P0#1/#2/#4 由 @u5c0f-r 实现，@u5c0f-q 按任务单逐条实测验收。
- 权限拆分、双人复核、对账 → backlog。
- 下一步：等用户回 GMPay 域名（P0#0）+ 定谁落地（@u5c0f-r 自己写还是给 Codex），任务单已可直接扔给 Codex。
