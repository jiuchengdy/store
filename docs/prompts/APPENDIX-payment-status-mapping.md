# 附录：三家支付「查询接口 + 状态 → 业务语义」映射

> **用途**：P0#1（XorPay 查询补入账 sweeper）与能力矩阵（`supportsQuery` / `supportsRefund`）的唯一实现依据。
> 实现者不需要再翻厂商文档，但**本附录只对下列抓取日期负责**——厂商改协议不受我们控制。
>
> **来源与抓取日期**（2026-11-19）：
> - XorPay：`xorpay.com/doc/query.html`、`xorpay.com/doc/notify.html`
> - Epusdt（GMPay 自托管实现）：`epusdt.com/zh/api/payment.html`（文档自标更新于 2026-08-22）
> - gmpay-edge：`github.com/GMWalletApp/gmpay-edge` README.zh-CN.md
> - 易支付：协议族，**无统一实现**，见 §5

---

## 1. 先统一语义，再谈字段

查询结果落到 **7 个业务语义**之一，代码里只认这 7 个，渠道差异全部收敛在映射层。**永远不要把厂商原始状态值当作业务状态往上报。**

| 统一语义 | 含义 | 动作 |
|---|---|---|
| `CREDITED` | 已支付，且本地已入账 | 不动作（可选：核对金额） |
| `PAID_UNCREDITED` | 已支付，本地仍是 `unpaid` | **补入账**（走 `acceptPayment`，不另写逻辑） |
| `NOT_PAID` | 明确未支付 / 等待付款 | 不动作，继续等；**但计入"未支付超时"计数** |
| `AWAITING_SELECTION` | 占位单，等待买家选链/币种 | 不动作；超 30 分钟提示买家 |
| `EXPIRED` | 订单过期 | 不动作，本地订单按过期处理 |
| `MANUAL_REVIEW` | 钱可能到了但账实可能对不上 / 语义不明 | **进人工队列，绝不自动入账** |
| `ORDER_NOT_FOUND` | 渠道侧没有这个单 | 不动作 + **报警**：本地存了渠道不存在的单号 |

两条铁律：

1. **网络错误、超时、5xx、签名错误不是业务语义**，属于 `TRANSIENT`，重试即可，**不得计入死单统计**，否则运维会把真死单埋进噪音里。
2. **未知状态值必须落 `MANUAL_REVIEW` 并告警，绝不能当 `NOT_PAID` 静默**。厂商加一个新状态而我们静默当未支付，等于新造的丢单通道。

---

## 2. 查询接口事实

| | XorPay | Epusdt（GMPay 自托管） | gmpay-edge（GMPay 网关） |
|---|---|---|---|
| 地址 | `GET https://xorpay.com/api/query/{aoid}` | `GET {origin}/pay/check-status/{trade_id}` | `GET {origin}/payments/gmpay/v1/order/query` |
| 鉴权 | **无签名**（靠 HTTPS） | **无签名** | 需签名（与下单同凭证） |
| 查询键 | `aoid`（= 我们存下的 `order.paymentId`） | `trade_id`（= `order.paymentId`） | `trade_id` 或 `order_id` |
| 响应 | `{ status }` | `{ status_code, data: { trade_id, status } }` | `{ status_code, data: {...} }`，以实例 `/docs` 为准 |
| 查不存在 | `status: not_exist`（HTTP 200） | HTTP 400 + `status_code: 10008` | HTTP 400 + 业务码 |
| 能否批量 | 否 | 否 | 否 |

**带签名的 XorPay 备选**：`GET https://xorpay.com/api/query2/{appId}?order_id={订单号}&sign={MD5(order_id + appSecret)}`。当 `order.paymentId` 缺失但订单号在时用它，证据链强于无签名的 `query/{aoid}`。

**判定接的是哪个 GMPay 实现（30 秒，不需要密钥）**：

```bash
curl -s -o /dev/null -w 'check-status=%{http_code}\n' https://<域名>/pay/check-status/nonexistent
curl -s -o /dev/null -w 'order-query=%{http_code}\n'  https://<域名>/payments/gmpay/v1/order/query
# Epusdt：check-status=400（或 200 带 10008），order-query=404
# edge  ：check-status=404，order-query=401/400
```

---

## 3. 状态映射表

### XorPay（`status` 六值）

| 原始值 | 统一语义 | 备注 |
|---|---|---|
| `success` | `CREDITED` | 官方：已支付且通知成功。**若本地还是 `unpaid`，说明入账丢了 → 补** |
| `payed` | `PAID_UNCREDITED` | 官方：**已支付，但通知没成功**。官方单列此状态即说明这是常态 |
| `new` | `NOT_PAID` | 订单未支付 |
| `expire` | `EXPIRED` | 订单过期 |
| `fee_error` | `MANUAL_REVIEW` | 官方：**手续费扣除失败**。钱多半到了但账实可能对不上，自动入账会把对账难题藏起来 |
| `not_exist` | `ORDER_NOT_FOUND` | 报警 |

### Epusdt（`data.status` 四值）

| 原始值 | 统一语义 | 备注 |
|---|---|---|
| `2` | 已支付 | 配 `status_code:200` 时 → `PAID_UNCREDITED`（或 `CREDITED`，按本地订单状态定） |
| `1` | `NOT_PAID` | 等待支付 |
| `3` | `EXPIRED` | 已过期 |
| `4` | `AWAITING_SELECTION` | **占位单**：未分配钱包、未算链上金额，等买家在收银台选 `token/network` |
| `status_code:10008` | `ORDER_NOT_FOUND` | 订单不存在（HTTP 400） |
| `status_code:10016/10017/10018/10019` | `MANUAL_REVIEW` | 资产/服务商配置问题，属我方或渠道配置错，**不是买家问题** |

### gmpay-edge

状态值与 Epusdt 同源（`1/2/3/4`），但**不存在订单的形态是 400 + 业务码**，具体码以运行实例的 `/docs` 或 OpenAPI 合约为准。实现时把「HTTP 400 且业务码属"订单不存在"」整体映射到 `ORDER_NOT_FOUND`，不要把码写死在逻辑里。

### 三家「订单不存在」形态归一（验收必打）

| 渠道 | 原始形态 |
|---|---|
| XorPay | HTTP 200，`status: not_exist` |
| Epusdt | HTTP 400，`status_code: 10008` |
| gmpay-edge | HTTP 400，业务码（依实例） |

**三种形态各喂一条，必须进同一条告警。只处理 XorPay 字面量算不通过。**

---

## 4. 补入账的附加条件（状态之外）

`PAID_UNCREDITED` 只是必要条件，还须同时满足：

1. **金额一致**：查询返回金额（按分）必须等于本地订单的重算金额，**不是**等于买家当初看到的价格。金额不等 → `MANUAL_REVIEW`。
2. **订单归属一致**：返回的 `order_id` 必须等于本地订单号；不一致 → `MANUAL_REVIEW` + 报警（串单是最严重的一类事故）。
3. **走 `acceptPayment` 入账，不另写逻辑**：它已按 `(provider, transactionId)` 唯一键去重，回调与 sweeper 撞车只会记一条。传订单自己的 `integrationId`（`acceptPayment` 会校验 `integrationId === revision`）。
4. **无签名的查询接口只是"传输可信"**：HTTPS 保证不被中间人改，不代表它就是唯一证据。金额与归属必须自己校验。

---

## 5. 能力矩阵：`supportsQuery` / `supportsRefund`

| 渠道 | `supportsQuery` | `supportsRefund` | 说明 |
|---|---|---|---|
| XorPay 原生 | `true` | `true` | 退款**无幂等键**，结果未知不可重试 |
| GMPay（Epusdt / edge） | `true`（路径不同） | **`false`** | 路由表无退款能力，只能人工；下单不传 `token/network` 会建 `status=4` 占位单 |
| 易支付 v1 / v2 | **按服务商** | **按服务商** | 见下 |

**易支付是协议族，不是一家厂商。** `POST api.php` 用 `act` 区分动作——`act=order` 查单、`act=refund` 退款、`act=refund_query` 退款查询——但**各家实现覆盖不一**，必须向具体服务商索取其 act 支持清单，不能因为「易支付文档写了」就假定这家有。所以这两格默认填 `false`，签了服务商拿到文档再逐个打开。

`sweeper` 对 `supportsQuery=false` 的渠道**必须零请求**，并单独记一条静态警示：

> 「渠道 X 无查询能力，该渠道的死单不可自愈，只能人工登商户后台核对」

这条警示应该**在上线那天就存在于监控里**，而不是等第一次丢单才被发现。对无查询能力的渠道每 10 分钟打一次 404，会制造大量无意义失败日志，真出事时没人能从噪音里看出哪条是真故障。

---

## 6. 落库能力开关的三处坑（不改这三处，开关会被静默吞掉）

1. **白名单**：`src/server/integrations/config.ts:108` 的 `publicKeys` 只保留名列其中的字段。给 `xorpay` 加 `supportsQuery` 而不同时改白名单，**后台一保存就没了**，`sweeper` 永远看不到开关、永远不跑，且**没有任何报错**。验收里必须有「保存后重新读取，开关还在」。
2. **启用时的非空校验**：同文件 `:223-226`，启用前要求 **`publicKeys` 与 `secretKeys` 的所有字段都非空**。把能力开关塞进 `publicKeys` 会让「开关为空 = 不能启用」这种莫名其妙的行为出现。建议开关存 `'true'`/`'false'` 字面量并明确默认值，或干脆与 `publicKeys` 分开放。
3. **幂等撞车**：`acceptPayment` 在订单已不是 `unpaid` 时抛 **409**（`services.ts:807`）。sweeper 与真实回调必然撞到。**必须把 409 当「已入账」正常路径吞掉并记 info**，否则每 10 分钟一条假警，运维很快学会无视告警——正好毁掉这条功能的全部意义。

---

## 7. 未覆盖 / 待确认

- **易支付具体服务商的 act 支持清单**：需用户提供签约服务商名称与文档。
- **GMPay 接的是 Epusdt 还是 edge**：决定 P0#0 改不改接口（§2 的判定法）。
- **XorPay 退款结果未知时的处置**：官方无幂等键，重试有重复退款风险，只能人工核实渠道后台后登记。
