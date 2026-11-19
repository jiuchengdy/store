# 上线阻塞清单（Go-Live Blockers）

> 汇总自团队 2026-11-19 的五线并行审计（测试 / 涉钱代码 / 运维 / 文档客服 / 上游协议）。
> 结论先行：**代码是健康的（基线 check/db:verify/test 326/build 全绿、e2e 56 过 4 跳过），卡点全在"上线后钱货别出事、出事有人知道、能查、能救"。**
> 每条标注：负责人 + 验收判据。未全部做完前，`APP_MODE` 不得转 live。

## 一、上线阻塞（P0，做完才准上线）

1. **XorPay 主动查询兜底（sweeper）** — @u5c0f-r 实现 + 验收。
   判据：`status ∈ {payed, success}` 且金额与订单一致才补入账；`fee_error` 落人工队列；`not_exist` 报警；查询为只读 GET、无需密钥、10 分钟一次无副作用。复用 `acceptPayment`，`(provider, transactionId)` 唯一键防双记。
2. **上游错误码补全 + 资金滞留人工路径** — @u5c0f-r 改枚举，@u5c0f-o 写 runbook 独立分支。
   补 `invalid_order_key`、`stock_unavailable`（当前 zod 解析失败退化成 502 → 永远 retry_pending，永不进人工队列）；上游已扣款不出货的处置（凭证、找谁、记账字段）。
3. **数据库迁移基线化** — @u5c0f-o 出方案。
   现状：`db:init` 只能空库、`prisma/migrations` 为 0、`updates/` 无版本账本。方案：自建 `schema_version` 表 + 编号 SQL；改表走 expand-contract 两步（先加不删，下一版本清理）。
4. **Worker 业务心跳 + 出货 job 最大重试上限** — @u5c0f-o 做 `ops_heartbeat` 表（最后成功出货时间 + 积压数，每分钟 upsert），@u5c0f-r 补 job 上限（当前 `Math.min(300, 5*2**attempts)` 封顶后无限重试，缺货单永不进 failed、买家永远收不到失败通知）。
5. **备份三层自动化 + 每周恢复演练** — @u5c0f-o 出可执行片段（已批，写好先审再进编排）。
   每小时 `pg_dump -Fc` 留 7 天；每天 rsync 一份到 Q 機（WG 内网）；每周恢复到临时库跑一次 `db:verify`。备份文件存在 ≠ 能恢复，演练才是证明。

## 二、上线前门槛（P1，不阻塞代码，但缺了不能上线）

6. **e2e 进 CI + 报数铁律** — @u5c0f-q。CI 加 Playwright 步骤（现 Test workflow 8m48s，加 2.7m 约 11.5m，`timeout 30m` 够用，加 Actions 缓存省 1 分钟）。**铁律：报测试数必须同时贴 `N passed / N skipped`，只报 passed 不算数**（裸跑测试 156 过/170 跳是绿的假象）。
7. **验签固定向量测试 + 三家沙箱真发一次** — @u5c0f-q 写测试，@u5c0f-i 补 GMPay/易支付向量。验收（@u5c0f-r）：改金额必失败 / 换密钥必失败 / 官方示例 sign 必成功 / 同回调重复投递只产生一条 `payment_event`。现有 5 个验签测试是自算自验，抓不到 join 顺序错。
8. **客服入口 + support-playbook.md** — @u5c0f-d 写。**客服渠道（邮箱/TG + 真实地址）待用户提供**，没给之前结构照写、渠道留空。采用 @u5c0f-r 三档硬线：0–10 查询补入账 / 10–30 定性 / 30 分钟人工接管 + 2 小时内明确答复。**自动退钱包不可用**（`supportsAutomaticRefund` 仅 XorPay，`automatic` 强制 `destination=original`），剧本不得写"自动退钱包"。
9. **基线 CHANGELOG（38 commit 倒推）+ 文档两处修正** — @u5c0f-d。修正：README 把 `deployment.md` 的"备份说明"改成与实际一致（标注"备份/迁移目前未实现"）；`docs/development.md` 补本地库前置 `open -a OrbStack && docker start store-db-1`。

## 三、非阻塞（backlog，上线稳定后做）

- `refunds:write` 权限拆分（现挂在 `orders:write` 上，动钱与改订单共权）。
- 提现大额双人复核。
- 每日对账视图（渠道流水 / payment_event / 提现打款 三表核对）。

## 四、需要用户本人提供的外部资源（我们无法自造）

- 客服渠道：邮箱还是 TG？真实地址。
- 域名 + HTTPS（当前完全没有）。
- 服务器（VPS，从未上过生产）。
- 三家真实支付商户号（XorPay / GMPay / 易支付）。
- 真实上游采购账号（Dujiao-Next）+ AICDK 账号。
- 邮件服务账号（Resend / Sendflare / SMTP）。

## 五、已拍板决策（2026-11-19）

- 邮件时间承诺用 **"2 小时"**（对齐 30 分钟人工接管 + 2 小时明确答复，不给正常单添噪音）。
- XorPay 回调 `paid: true` 符合官方协议（只有成功才回调），@u5c0f-r 原红标撤回，**但必须补主动查询兜底**。
- @u5c0f-r 提的权限拆分、双人复核、对账 → 降为非阻塞 backlog。
