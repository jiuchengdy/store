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

1. **XorPay 主动查询兜底（sweeper）+ 能力矩阵** — 实现 @u5c0f-r，**验收 @u5c0f-q**。
   判据：`status ∈ {payed, success}` 且金额一致才补入账；`fee_error` 落人工；复用 `acceptPayment`，`(provider, transactionId)` 唯一键防双记。
   **能力矩阵**（@u5c0f-i）：每家 integration 配置存 `supportsQuery`/`supportsRefund` 开关，sweeper 按开关跑；**无查询能力的渠道跳过 + 静态警示"该渠道无查询能力（死单不可自愈）"**——不能每 10 分钟打一次 404 制造告警噪音。
   **`not_exist` 三家归一**：XorPay 是 `status: not_exist`，Epusdt 是 `status_code: 10008`，edge 是 400 带业务码——验收时三家各喂一条，都必须进同一条告警。

2. **上游错误码补全 + 资金滞留人工路径** — 实现 @u5c0f-r，**验收 @u5c0f-q**；runbook 7.2 人工分支 @u5c0f-o 已写。
   补 `invalid_order_key`、`stock_unavailable`（当前 zod 解析失败 → 退化成 502 → 永远 retry_pending、永不进人工队列，且上游已扣款无退款接口）。

3. **数据库迁移基线化** — @u5c0f-o 出方案。@u5c0f-d 已坐实根因：`e7dcd59` **主动移除了迁移历史**，不是"没做过"，"以前怎么升库"永久无解，只能新建 `schema_version` 账本。改表走 expand-contract 两步。

4. **Worker 业务心跳 + 出货 job 最大重试上限** — @u5c0f-o 做 `ops_heartbeat`，@u5c0f-r 补 job 上限，**验收 @u5c0f-q**。判据：job 达上限转 `failed` 并发通知（当前 `Math.min(300, 5*2**attempts)` 封顶后无限重试，缺货单永不进 failed、买家永远收不到失败通知）。

5. **备份三层自动化 + 恢复演练** — @u5c0f-o 已交修复 `fcdd6da`（剪枝 BSD 失效、sha256 相对路径、0600 权限、`.counts` sidecar 9 表行数、`REMOTE` 未设退 3）——**@u5c0f-q 待逐条实测验收**（剪枝 / 异地 sha256 / 空壳 dump / `.counts` 缺失退 4），**不接受"跑通了"的自述**。**加密未做**（age/gpg 需先定私钥谁保管，卡用户），已写进 runbook 第 9 节缺口。

6. **客服入口配置门禁（P0）** — 0 行代码：后台 `/admin → 网站设置 → 支持邮箱` 填真实邮箱。空态文案"支持联系方式尚未公布……请先暂停购买"（`Support.tsx`）——为空上线会主动劝买家别买。@u5c0f-o 已把自检加进 runbook 第 2 节第 5 项（@u5c0f-d 已审措辞）；采纳 @u5c0f-d 补强：断言须**「正文含真实邮箱」且「不含『尚未公布』」**。**需要用户给真实邮箱。**

## 二、上线前门槛（P1，不阻塞代码，但缺了不能上线）

7. **e2e 进 CI + 报数铁律** — @u5c0f-q。铁律：报测试数必须同时贴 `N passed / N skipped`（裸跑 156 过/170 跳是绿的假象）。
8. **验签固定向量测试 + 三家沙箱真发一次** — @u5c0f-q 写测试，@u5c0f-i 补 GMPay/易支付向量。XorPay 两组向量已三方交叉验证一致（@u5c0f-i 文档重算 == @u5c0f-q python 独立 == 仓库实现），可直接写成固定向量。GMPay 回调要真发一笔（mock 测不出 404）。
9. **support-playbook.md** — @u5c0f-d 已交 `598acdd` + `de989ff`：3.5 按渠道退款表（删"1–3 工作日"）、3.5b 加密货币问答（必须索取交易哈希）、未实现能力账本 5 行。
10. **CHANGELOG + 文档修正** — @u5c0f-d 已交 `598acdd`：38 commit 倒推、README 备份措辞、development.md 补 OrbStack 前置。

## 三、非阻塞（backlog，上线稳定后做）

- `refunds:write` 权限拆分、提现大额双人复核、每日对账视图。

## 四、需要用户本人拍板（我们无法自造/自定）

1. **GMPay 商户域名**（只要这个，@u5c0f-i 两条 curl 30 秒判定是 Epusdt 还是 edge，不用翻后台）。
2. **GMPay 是 USDT 加密货币收款，留不留**：国内用户链上转 USDT 转化率差；@u5c0f-d 补客服成本维度——每单都要人工核对哈希、首周需双倍备人。留 → 按"高人工成本渠道"单独定价限流；不留 → 换渠道。
3. **支持邮箱**（或 TG / Tawk）。
4. **加密货币退款汇率差口径（新）**：按实收金额退、不按计价金额退，汇率波动由谁承担——客服不许自行承诺。
5. **异地备份目标** `ops@192.168.0.1`（Q 機）行不行 + **加密私钥谁保管**（age/gpg 加密前先定）。
6. **push 时机**：当前 **6 个**本地提交未上图（`3deb2af`/`42c8af3` 清单、`c224d7f`/`fcdd6da` 备份、`598acdd`/`de989ff` 文档），等你点头统一 push。
7. **上线外部资源**：域名+HTTPS、服务器、三家真实支付商户号、上游采购账号、邮件服务账号。
8. **`APP_MODE` demo→live 时点**。

## 五、已拍板决策（2026-11-19）

- 邮件时间承诺用 **"2 小时"**；`paid: true` 在三家协议都合法（三家都只对成功回调），但三家都缺查单兜底。
- **能力开关方案**（`supportsQuery`/`supportsRefund`）替代渠道 fork 的统一实现，易支付协议族不追问"签哪家"。
- @u5c0f-i 出「三家查询接口 + 状态 → 业务语义」映射表，作为附录贴进 `docs/prompts/` 任务单。
- 实现/验收分离：P0#1/#2/#4 由 @u5c0f-r 实现，@u5c0f-q 按任务单逐条实测验收。
- 权限拆分、双人复核、对账 → backlog。
- 下一步：@u5c0f-r 先出三份 Codex 任务单放 `docs/prompts/`（纯文档），落地实现等用户点头 + 指定谁跑。
