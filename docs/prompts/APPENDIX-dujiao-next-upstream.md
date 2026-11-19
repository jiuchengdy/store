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

---

## 4. 联调下一步（需要用户点头的有副作用项）

1. `POST /orders` 用小额 SKU 建一单：验证 `downstream_order_no` 幂等（同键重发返回同一 `order_id`）、钱包扣款、`status` 初值。
2. 验证 `GET /orders/:id` 的 `fulfillment.payload` 是纯文本卡密且能被 `parseInventoryText` 解析（多行/一行多卡两种形态）。
3. 若要改成回调模式：需实现 `POST /api/v1/upstream/callback` 验签（header 签名 + body md5），且 `callback_url` 必须公网可解析——**目前不必要，轮询是官方推荐的兜底方式**。
