# 数据库维护

[返回 README](../README.md)

## 新数据库

项目使用 PostgreSQL 18。先创建数据库和应用 schema，再配置 `DATABASE_URL`；默认 schema 为 `public`，自定义 schema 通过连接串的 `schema` 查询参数指定。

```sh
bun run db:init
bun run db:seed
bun run db:verify
```

- `db:init` 在事务内执行 `prisma/init.sql`；只接受已有且为空的 schema，发现已有表或函数时拒绝执行，不清空数据。
- `db:seed` 补齐缺失的商品、设置和角色记录，不覆盖现有商业配置。
- `db:verify` 按 `prisma/database-contract.json` 检查列、约束、索引、触发器和函数。
- `db:generate` 根据 `prisma/schema.prisma` 生成 Prisma Client，不修改数据库。

本项目以初始化 SQL 和增量 SQL 管理数据库结构。不要用 `prisma db push` 替代这些脚本，否则可能遗漏约束、触发器等数据库行为。

## 已有数据库

更新前备份数据库并记录当前版本。先在备份副本中验证所需 SQL，再安排维护窗口、停止 Web 与 Worker，执行对应更新。

以下脚本按功能引入顺序列出；只执行当前数据库缺少的更新，并在**应用实际使用的 schema** 下运行：

| 更新脚本                                                                             | 用途                                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [`add-fulfillment-resolution.sql`](../prisma/updates/add-fulfillment-resolution.sql) | 人工确认兑换结果及处理记录                                                  |
| [`add-coupons.sql`](../prisma/updates/add-coupons.sql)                               | 优惠码与使用记录                                                            |
| [`add-downstream-procurement.sql`](../prisma/updates/add-downstream-procurement.sql) | 上游采购与 SKU 映射；下架升级商品并停用升级专用券，保留历史订单、库存和报价 |
| [`add-order-refills.sql`](../prisma/updates/add-order-refills.sql)                   | 原单免费补充记录及手动退款锁定约束；旧订单默认无补充记录                    |

使用 `psql` 时启用 `ON_ERROR_STOP`；自定义 schema 必须先设置正确的 `search_path`。不要直接把带 Prisma `?schema=` 参数的连接串传给 `psql`。

更新完成后运行：

```sh
bun run db:generate
bun run db:verify
bun run db:seed
```

然后以相同代码版本启动 Web 与 Worker。新增优惠码功能后，`db:seed` 也用于补齐内置运营、客服角色的权限。

`bun run db:update-commercial-policy` 会更新已有商品的默认售价和默认返佣比例，仅在明确需要应用仓库的商业配置时使用，不是每次升级的必需步骤。

## 改表：迁移账本

改表只有一条路：编号 SQL + `bun run db:migrate`。`prisma/updates/` 是历史遗留（四个裸 SQL，没有顺序、没有记账），只用于理解旧库怎么变成今天这样，**不要再往里加文件**。

### 四步

1. **备份**（见下方上线顺序第 1 步）。
2. **写文件**：`prisma/migrations/0002_add_payment_capability.sql`。四位编号即执行顺序，文件名只允许 `NNNN_小写字母数字下划线.sql`；版本号重复、文件名不合规时 `db:migrate` 以 `2` 退出。**一个文件一个事务**。
3. **执行**：`bun run db:migrate`（容器内：`docker compose -f compose.prod.yaml run --rm --no-deps web migrate`）。
4. **校验**：`bun run db:verify` 与 `bun scripts/ops/gen-contract.ts --check` 都要绿。迁移若改了业务表结构，必须 `bun scripts/ops/gen-contract.ts` 重生成契约并随同提交，否则第 4 步会红。

`schema_version` 记录 `version / checksum / applied_at / applied_by`：

- `checksum` 是 SQL 文件的 sha256。**已应用的迁移不许再改**——改一个字节，`db:migrate` 直接以 `1` 退出，报错里带上是哪一版、何时应用、哪台机或哪个镜像标识应用的。要改结构就新增下一号。
- 同一迁移重复执行不报错，也不会重复记账（幂等）。
- `applied_by` 取 `MIGRATE_APPLIED_BY` 环境变量；未设置时回落到 `git:<短 SHA>@<主机名>`，镜像内没有 `.git` 时回落 `unknown@<主机名>`。要留部署镜像 digest 就在发布时显式传 `MIGRATE_APPLIED_BY=<digest>`。

### 上线顺序（反了就会 500）

```sh
# 1) 备份
docker compose -f compose.prod.yaml exec -T postgres pg_dump -U <user> -d <db> -Fc > backup.dump
# 2) 迁移库（此时旧 web/worker 还在跑：只加不删，老代码不受影响）
docker compose -f compose.prod.yaml run --rm --no-deps web migrate
# 3) 结构校验
bun run db:verify
bun scripts/ops/gen-contract.ts --check
# 4) 滚动部署新镜像
docker compose -f compose.prod.yaml up -d web worker
# 5) 旧镜像仍能正常跑（expand 阶段只加不删的实证）
```

反了会怎样（实测）：**新镜像 + 旧库** → 查询新列直接 500，错误原文 `Raw query failed. Code: '42703'. Message: 'column "x" does not exist'`。不是容器起不来，也不是探针变红——探针打的是 `/robots.txt`，不碰数据库，而且没有任何服务消费这个状态（`compose.prod.yaml` 里没有 autoheal，也没人等 web 健康）。所以顺序错误的表现是「网站开始报错」，运维会去查镜像、网络、连接。

**排查口诀**：看到 `42703 / column ... does not exist` 先查库迁移了没有，别查镜像和网络。

### expand-contract

- **只加不删**：先加列/新表，等所有实例跑上新代码，下一个版本才清理旧列，否则滚动窗口内旧镜像会 500。
- **收缩版本单独发一个 release**，且发布前先跑一次恢复演练——收缩之后再回滚旧镜像，等于让旧代码对着一个它不认识的库形状跑，这是最难救的组合。

### 回退

本流程**不提供 down 迁移**，也不承诺「可回退到旧版本」。`db:migrate` 失败时整体回滚，库停在旧版本、`schema_version` 不前移；数据层面的回退只有一条路——恢复迁移前的 `pg_dump`。

## 修改数据库结构

同时维护以下文件：

1. `prisma/schema.prisma`：应用模型。
2. `prisma/init.sql`：全新数据库的完整结构（追加式修改，只加不重写）。
3. `prisma/migrations/`：已有数据库的增量迁移，编号即顺序，由 `db:migrate` 记账。
4. `prisma/database-contract.json`：结构验证契约（改业务表后用 `gen-contract.ts` 重生成）。
5. `prisma/updates/`：历史遗留的裸 SQL，只读参考，不再新增。

在独立空 schema 验证初始化、种子数据与结构检查，并在旧版本的测试数据库副本中验证升级。不要对开发或生产业务库执行测试清理。
