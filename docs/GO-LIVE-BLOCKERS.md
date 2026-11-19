# 上线阻塞清单（Go-Live Blockers）

> 汇总自团队 2026-11-19 的五线并行审计（测试 / 涉钱代码 / 运维 / 文档客服 / 上游协议）。
> 结论先行：**代码是健康的（基线 check/db:verify/test 326/build 全绿、e2e 56 过 4 跳过），卡点全在"上线后钱货别出事、出事有人知道、能查、能救"。**
> 每条标注：负责人 + 验收判据。未全部做完前，`APP_MODE` 不得转 live。

## 一、上线阻塞（P0，做完才准上线）

**0. GMPay 实现分叉（最急，先问用户）** — 先由用户回答接的是 `Epusdt`（自托管 Go）还是 `gmpay-edge`（Workers/Bun 网关），再定代码动作。
   证据（@u5c0f-i 核实 + 已复读代码）：`confirmGmpayReceipt` 请求 `GET /payments/gmpay/v1/order/query`（`payments.ts:236`），这是 **gmpay-edge 的端点**；而 Epusdt 的查询是 `GET /pay/check-status/{trade_id}`、只回 `{trade_id, status}`，官方接口总览里**没有 `order/query`**。且该调用在**主回调路径**上（`notify/route.ts:43` `if (provider === 'gmpay' && receipt.paid)`）——接 Epusdt 时每笔回调 404 → 抛 503 → 厂商重试耗尽 → **GMPay 全部收入进不了账，日志却像"网络问题"**。接 Epusdt 则改接口+字段，接 edge 则维持现状。mock 回调测不出这个 404，必须沙箱真发一笔。

1. **XorPay 主动查询兜底（sweeper）** — 实现 @u5c0f-r，**验收 @u5c0f-q**（实现/验收分离）。
   判据：`status ∈ {payed, success}` 且金额一致才补入账；`fee_error` 落人工；`not_exist` 报警；只读 GET 无需密钥、10 分钟一次无副作用；复用 `acceptPayment`，`(provider, transactionId)` 唯一键防双记。注意易支付同样**没有任何查单兜底**——死单通道是两条（XorPay + 易支付），不是一条。

2. **上游错误码补全 + 资金滞留人工路径** — 实现 @u5c0f-r，**验收 @u5c0f-q**；runbook 7.2 人工分支 @u5c0f-o 已写。
   补 `invalid_order_key`、`stock_unavailable`（当前 zod 解析失败 → 退化成 502 → 永远 retry_pending、永不进人工队列，且上游已扣款无退款接口）。

3. **数据库迁移基线化** — @u5c0f-o 出方案。@u5c0f-d 已坐实根因：`e7dcd59` **主动移除了迁移历史**，不是"没做过"，"以前怎么升库"永久无解，只能新建 `schema_version` 账本。改表走 expand-contract 两步。

4. **Worker 业务心跳 + 出货 job 最大重试上限** — @u5c0f-o 做 `ops_heartbeat`，@u5c0f-r 补 job 上限，**验收 @u5c0f-q**。判据：job 达上限转 `failed` 并发通知（当前 `Math.min(300, 5*2**attempts)` 封顶后无限重试，缺货单永不进 failed、买家永远收不到失败通知）。

5. **备份三层自动化 + 恢复演练** — @u5c0f-o 已交脚本（`c224d7f`），**但 @u5c0f-r 审出 4 条必须修，否则"看起来有备份、实际没有"**：
   - 剪枝 `head -n -3` 是 GNU 扩展，macOS 上静默失效（`2>/dev/null` + `|| true` 把错误吃干净，一个字没删还报成功）→ 改 `sort -r | tail -n +$((KEEP_MIN+1))`；
   - `.sha256` 写的是本地相对路径，rsync 到异地后 `sha256sum -c` 校验不了 → 改 `(cd "$BACKUP_DIR" && sha256sum "$NAME" > "$NAME.sha256")`；
   - 权限+加密：dump 含全库 PII + 口令哈希 + 提现账号，需 `umask 077` + `chmod 600`，异地（Q 機为多 agent 共用机）必须 age/gpg 加密，私钥只在恢复方；
   另：脚本存在系统性"静默吞错误"模式（`|| true`、`OFFHOST=missing` 以 0 退出），一并修。修完 @u5c0f-r 复审，再算交付。

6. **客服入口配置门禁（P0）** — 0 行代码：后台 `/admin → 网站设置 → 支持邮箱` 填真实邮箱（或 Tawk/sessionGuide）。空态文案是"支持联系方式尚未公布……请先暂停购买"（`Support.tsx`）——**为空上线会主动劝买家别买**。@u5c0f-r 在 go-live 自检加断言：请求 `/help/payment` 正文必须含真实邮箱或链接，空即拒绝转 live。@u5c0f-d 把此自检补进 runbook 第 2 节。**需要用户给真实邮箱。**

## 二、上线前门槛（P1，不阻塞代码，但缺了不能上线）

7. **e2e 进 CI + 报数铁律** — @u5c0f-q。铁律：报测试数必须同时贴 `N passed / N skipped`（裸跑 156 过/170 跳是绿的假象）。
8. **验签固定向量测试 + 三家沙箱真发一次** — @u5c0f-q 写测试，@u5c0f-i 补 GMPay/易支付向量。GMPay 回调要真发一笔（mock 测不出 404）。
9. **support-playbook.md** — @u5c0f-d 已交（`598acdd`）：三档硬线 + 第四档 + 未实现能力账本 + 上线首周每 30 分钟人工扫 processing>30min 订单（在缺货自动通知实现前，这是唯一不让买家静默的办法）。
10. **CHANGELOG + 文档修正** — @u5c0f-d 已交（`598acdd`）：38 commit 倒推、README 备份措辞、development.md 补 OrbStack 前置。

## 三、非阻塞（backlog，上线稳定后做）

- `refunds:write` 权限拆分、提现大额双人复核、每日对账视图。

## 四、需要用户本人拍板（我们无法自造/自定）

1. **GMPay 接哪个实现**：Epusdt 还是 gmpay-edge？（决定 P0#0 是改接口还是维持现状）
2. **GMPay 是 USDT 加密货币收款网关**（非人民币微信/支付宝），且不传 `token/network` 时建的是 status=4 占位单、让用户在收银台自选链币——**让买 ChatGPT 会员的国内用户链上转 USDT，转化率会很难看**。这是产品决策，是否接受？（不接受则换渠道）
3. **支持邮箱**（或 TG / Tawk 账号）。
4. **退款到账时效口径**：不能写死"1–3 工作日"——XorPay 原路退款、易支付看服务商、**GMPay 厂商不提供在线退款只能人工**，需分渠道定。
5. **异地备份目标** `ops@192.168.0.1:/srv/store-backups`（Q 機，多 agent 共用）是否接受？接受则必须加密，私钥只在恢复方。
6. **上线外部资源**：域名+HTTPS、服务器、三家真实支付商户号、上游采购账号、邮件服务账号。
7. **push 时机**：当前 3 个本地提交（`3deb2af` 阻塞清单 / `c224d7f` 备份+runbook / `598acdd` 文档）未上图，等你点头统一 push。
8. **`APP_MODE` demo→live 时点**。

## 五、已拍板决策（2026-11-19）

- 邮件时间承诺用 **"2 小时"**；`paid: true` 在三家协议都合法（三家都只对成功回调），原红标撤回，但三家都缺查单兜底（现只有 GMPay 有、还打错地址）。
- 实现/验收分离：P0#1/#2/#4 由 @u5c0f-r 实现，@u5c0f-q 按任务单验收。
- 权限拆分、双人复核、对账 → backlog。
- 下一步：@u5c0f-r 先把 P0#1/#2/#4 写成三份 Codex 任务单放 `docs/prompts/`（纯文档，不动生产代码），落地实现等用户点头 + 指定谁跑。
