# 附录：Dujiao-Next 上游采购协议核对（2026-11-19）

> **用途**：`src/server/integrations/dujiao.ts` 的唯一外部依据 + 联调结论。
> **上游官方文档**：`https://dujiao-next.com/api/integration-open-api`（自标更新 2026-04-01，覆盖 `/api/v1/upstream/*` 串货接口）。**此前项目内没有任何指向该文档的引用**，实现全靠自洽；本次核对补上。
> **实测日期**：2026-11-19，只做**只读**接口（`POST /ping`、`GET /products`、`GET /categories`）。

---

## 1. 结论：读路径实测通过，协议一致

| 项 | 官方文档 | 我们的实现 | 实测 |
|---|---|---|---|
| Base | `https://<站点>/api/v1/upstream` | `supplierOrigin(binding.url) + '/api/v1/upstream/' + resource` | ✅ |
| 请求头 | `Dujiao-Next-Api-Key` / `-Timestamp` / `-Signature` | 同 | ✅ |
| 签名串 | `{METHOD}\n{PATH}\n{TIMESTAMP}\n{md5(BODY)}` | 同（`dujiaoSignature`） | ✅ 实测 `ping` 200 |
| 签名算法 | `hex_lower(hmac_sha256(signString, api_secret))` | 同 | ✅ |
| 响应 | `{ok:true,...}` / `{ok:false,error_code,error_message}` | 同 | ✅ |
| `POST /ping` | 返回 `site_name/protocol_version/user_id/balance/currency/member_level` | 只取 `site_name/balance/currency/protocol_version` | ✅ `ok:true`、`protocol_version:"1.0"`、`currency:"CNY"`、`member_level:null` |
| `GET /products` | `items/total/page/page_size`；`skus[].id/sku_code/price_amount/stock_quantity/is_active` | zod 逐字段校验 | ✅ 200，`total=7`，**所有必填字段都在**（含 `sku_code`、`stock_quantity`） |
| `GET /categories` | `categories[]` | 未使用 | ✅ 200，2 个分类 |
| `POST /orders` | `sku_id/quantity/downstream_order_no/trace_id/callback_url`；幂等键 = API Key + `downstream_order_no` | 传前四项，**不传 `callback_url`** | ⛔ **未实测**（真实下单会扣上游钱包余额、生成真实采购单，属有副作用操作，需用户点头） |
| 回调 | B 站 → A 站 `POST /api/v1/upstream/callback`，header 签名 | **未实现**（我们靠轮询 `GET /orders/:id`） | 不适用 |

---

## 2. 最容易改错的一处：GET 带 query 时，签名串里的 PATH **不含 query**

官方文档写的是「请求路径（不含域名和查询参数）」，但这类描述很容易被实现者按完整 URL 签。**实测把三种写法都打了一遍**：

| 请求 | 签名用的 PATH | 结果 |
|---|---|---|
| `GET /products?page=1&page_size=5` | `/api/v1/upstream/products?page=1&page_size=5`（含 query） | **401 `invalid_signature`** |
| `GET /products?page=1&page_size=5` | `/api/v1/upstream/products`（不含 query） | **200** |
| `GET /products`（无 query） | `/api/v1/upstream/products` | 200 |

我们的 `dujiaoSignature` 里 `path.split('?')[0]` 正好是对的。**这条不要「顺手优化」成签完整 URL**，会静默 401。

---

## 3. 上线风险（按严重度）

1. **时钟偏差 ±60 秒是硬闸**：`Dujiao-Next-Timestamp` 超过 ±60 秒直接 `401 timestamp_expired`，所有采购全停。本机历史上出现过整体偏两天的时钟漂移 → **部署体检必须验 NTP 同步**（和 10041 的 DNS 检查同类，属于「机器环境不对就 100% 失败」的项，不是代码问题）。
2. **`invalid_callback_url`（400）**：一旦哪天补上 `callback_url`，它必须公网可达，内网/localhost 直接拒——和 EPUSDT 的 10041 是同一类坑，别踩两遍。
3. **无限轮询没有告警**：`procurement.ts` 的 else 分支对 `pending_payment / paid / fulfilling / partially_delivered` 一律「15 秒后再查」，**没有次数上限、没有告警**。上游若卡在 `fulfilling` 或 `partially_delivered`（官方确实有这两个状态），采购单会永远每 15 秒打一次网关且没人知道。建议加一条「停留超过 N 分钟 → `review` + 告警」。
4. **`manual` 交付类型会进 `review`**：我们要求 `fulfillment.type ∈ {auto, upstream}`，官方 `type` 只有 `auto`/`manual`。人工交付商品必然走 `DeliveryMismatch` → `review`，这是**正确**的（人工货不该自动入库），但映射商品时要避开 `manual` 类型，否则每单都要人工。
5. **`partially_delivered` 不能当完成**：现有映射只认 `delivered/completed/fulfilled`，`partially_delivered` 会继续轮询——方向对，但要配合第 3 条的上限，否则就是无限等。
6. **`manual` 商品是「下单就失败」，不是「交付才进人工」**：官方 `POST /orders` 参数表写明 `manual_form_data`「当商品为 `manual` 类型时必填」。我们的 `create()` 不传该字段 → 映射到 `manual` 商品会直接 `400 bad_request`（走 `PurchaseRejection` → `state='rejected'`），根本走不到交付判断。**建映射时只能选 `fulfillment_type='auto'` 的商品。**
7. **进货单没有取消/追款出口**：官方有 `POST /orders/:id/cancel`，但 `procurement.ts` 从未调用它，`StockPurchase` 也没有取消入口。官方 §1.3 的明文要求是「**本地取消前必须先执行上游取消；若上游返回不可取消，本地必须拒绝取消与退款**」。对我们的含义：卡在 `review` 的进货单**既不能取消、也拿不回上游钱包里的钱**，只能等上游完成或过期。建议任务单里明确二选一——①实现「先调上游 cancel，成功后再改本地状态」；②本期不支持取消，但在运维文档写清「人工去上游后台取消，再手工改本地状态」。**不能什么都不写**，否则运维会以为点个按钮就能退。

8. **加「上限」本身会造一条新的货损路径（P1 修复必须一起解决）**：把卡住的采购单从 `polling` 挪进 `review` 之后，**轮询就停了**。如果上游在 30 分钟之后才交付（`delivered`），我们既不轮询、也没有任何入口去取，结果是**钱付了、卡密烂在上游、本地永远没有库存**，而且没人会知道。而上游 `POST /orders/:id/cancel` 对已交付单返回 `cancel_not_allowed`（409）——**已交付的单不能取消，只能把货取回来**。
   → `review` 必须保留一条「重新同步」路径：手动按钮或低频轮询（如每小时一次）调 `GET /orders/:id`，命中 `delivered` 就走正常的入库分支。这条要和「后台只读列表」一起交付，否则 P1 的修复本身会制造丢货。

---

## 3.5 上游对「采购失败」的明文约束（写进任务单当依据，不是我们自己拍脑袋）

官方 §1.3「当前实现约束（重要）」原文四条，逐条对我们的含义：

| 上游约束 | 对我们的含义 |
|---|---|
| 支付成功后的采购为异步执行，不阻断终端用户支付流程 | 我们本来就是异步 job（`syncStockPurchase`），符合 |
| 对接商品（存在启用上游映射）必须等待上游回调，不允许本地手工/自动交付 | 我们是**进货模式**（采购入库再本地发货），不走 dropship，**不适用**；但代理商若照文档做直发会踩这条 |
| 本地取消前必须先执行上游取消；上游不可取消则本地必须拒绝取消与退款 | 见风险 7：我们目前**完全没有这条路径** |
| 上游采购失败时，调用方应将订单标记为异常待处理，**不应自动做本地取消/退款关闭** | 支持 `state='review'` 的设计，且是上游明文要求——可直接引为任务单依据 |


---

## 4. 联调下一步（需要用户点头的有副作用项）

1. `POST /orders` 用小额 SKU 建一单：验证 `downstream_order_no` 幂等（同键重发返回同一 `order_id`）、钱包扣款、`status` 初值。
2. 验证 `GET /orders/:id` 的 `fulfillment.payload` 是纯文本卡密且能被 `parseInventoryText` 解析（多行/一行多卡两种形态）。
3. 若要改成回调模式：需实现 `POST /api/v1/upstream/callback` 验签（header 签名 + body md5），且 `callback_url` 必须公网可解析——**目前不必要，轮询是官方推荐的兜底方式**。
