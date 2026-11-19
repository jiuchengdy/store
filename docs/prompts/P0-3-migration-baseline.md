# 任务单 P0#3：数据库迁移基线（最小版）

> 给实现者（Codex，全新对话）：自包含任务单，不依赖聊天记录。
> 仓库：`~/Documents/store`。**不要 git push**，改完只做本地提交。
> **一个 Codex 轮次只做这一件事**：不要在同一次提交里同时改触发器、契约和业务逻辑，验收时分不清是哪一步坏的。

## 0. 一句话目标

现在改表没有安全做法：`db:init` 只能在空库跑，`prisma/migrations` 为 0，`prisma/updates/` 只有 4 个裸 SQL、没有版本账本、没有顺序、没有回滚。所有要改表的 P0（能力开关加列、job 上限）都在等这一条。目标：**一张 `schema_version` 表 + 编号 SQL + 一个执行并记账的脚本**，把"改表"变成可重复、可判定、可回退到旧版本的动作。

## 1. 现状（已核实的代码事实，不要重新论证）

- `scripts/init-database.ts`：非空库直接拒绝（`Database initialization requires an empty schema`）。
- **真正的 schema 源头是 `prisma/init.sql`**（335 列 / 393 约束 / 85 索引 / 6 触发器 / 6 函数全在里面），`prisma/migrations` 是空的（历史被 `e7dcd59` 移除过）。
- `scripts/verify-database.ts`（`bun run db:verify`）是**精确比对**：多一列就红（`Unexpected columns: ...`），少一条约束也红。
- `scripts/ops/gen-contract.ts` 已存在：`bun scripts/ops/gen-contract.ts` 从活库重生成 `prisma/database-contract.json`；`--check` 只校验不写。
- `compose.prod.yaml`：**只有 postgres 有 healthcheck（`pg_isready`），web 没有任何 healthcheck，worker 显式 `disable: true`**。所以"新镜像 + 旧库"不会让容器起不来，真正症状是运行时 500。别依赖健康检查拦住顺序错误。
- 关键业务约束（改表时不能碰）：`orders_channel_check`（`alipay/wechat/crypto/balance`）、`orders_status_check`（7 个状态）、`orders_discount_check`（`list_amount - discount_amount = amount`）等都在 `init.sql:368-375`。

## 2. 要交付的东西

| 文件 | 内容 |
|---|---|
| `prisma/init.sql`（追加，不重写） | 新建 `schema_version`（`version int primary key`, `applied_at timestamptz not null default now()`, `checksum text not null`）· **只追加，不改动已有对象** |
| `prisma/migrations/0001_baseline.sql` | 基线迁移：只创建 `schema_version` 并写入 `version=1`（因为现状已经等于 init.sql） |
| `scripts/migrate.ts` | 迁移执行器：按文件名排序取未应用的 `NNNN_*.sql` → **每个文件一个事务**，跑完写 `schema_version`（含内容 checksum）→ 失败整体回滚，库停在旧版本 |
| `package.json` | 新增 `db:migrate` 脚本 |
| `docs/database.md` | 补「改表四步 + 部署顺序」：见第 4 节 |

**不要动**：任何已有表结构、`gen-contract.ts`、`verify-database.ts`、`init.sql` 中 `schema_version` 之外的内容。

## 3. 实现要点

1. **引导问题（bootstrap，必须显式处理）**：引入 `schema_version` 本身多了一张表，`db:verify` 会红。做法：这次改动里手工 `bun scripts/ops/gen-contract.ts` 重生成契约并一起提交——**这是一次性例外**，之后所有迁移都必须走 `db:migrate` + `gen-contract`。
2. 迁移文件只用**编号 + 下划线**命名（`0002_add_payment_capability.sql`），排序即执行顺序。
3. 幂等：同一迁移重复执行不报错、不重复记账（查 `schema_version` 决定是否执行，同时用 checksum 检出"已应用的 SQL 被偷偷改过"→ 直接报错退出，不要静默重跑）。
4. 事务边界：**一个文件一个事务**，禁止把多个文件包进一个大事务（一次失败会倒退到很远）。
5. 明确不支持「自动回滚脚本」：回滚 = 恢复备份（`ops-runbook.md` 已覆盖）。但必须支持「迁移失败 → 停在旧版本且 `schema_version` 没前进」。
6. expand-contract 纪律写进文档：**只加不删**（先加列/新表，下一版本才清理旧列），否则旧镜像会在滚动窗口内 500。

## 4. 部署顺序（写进 `docs/database.md` 和 runbook，别只写在代码注释里）

```
1) 备份（scripts/ops/backup-db.sh）
2) 迁移库（bun run db:migrate）            ← 必须在新镜像上线之前
3) bun run db:verify 绿
4) bun scripts/ops/gen-contract.ts --check 绿
5) 滚动部署新镜像
6) 旧镜像必须仍能正常跑（expand 阶段只加不删）
```

反了会怎样（实测）：新镜像 + 旧库 → 查询新列直接 500；**不是**健康检查变红、也不是容器起不来，因为没有 web healthcheck。所以顺序错误的表现是「网站开始报错」，排查方向会很偏。

## 5. 验收判据（@u5c0f-q 按此打，实现者不参与验收）

1. 空库从零跑完所有编号 SQL → `db:verify` 绿 **且** `gen-contract --check` 绿（两个都绿才算）。
2. 有数据的库跑增量 → 目标表行数前后不变、抽样数据一致。
3. 同一迁移重复执行 → 不报错、`schema_version` 不重复记账（幂等）。
4. **迁移中途失败 → 事务回滚、库停在旧版本、`schema_version` 不变**（故意在第二个语句写语法错来验，这条最容易漏）。
5. 迁移完成后，**旧镜像仍能正常跑**（expand 阶段只加不删的实证）。
6. 已应用迁移的 SQL 被改过 → `db:migrate` 必须报错退出（checksum 检出），不能静默跳过。

## 6. 命令与基线

```bash
cd ~/Documents/store
open -a OrbStack && docker start store-db-1
bun run check
TEST_DATABASE_URL=postgresql://getgpt@127.0.0.1:55439/getgpt_test bun run test
bun run db:verify
bun scripts/ops/gen-contract.ts --check
```

基线：`check` 0 error；`test` 41 文件 / **326 passed / 0 skipped**（带 `TEST_DATABASE_URL`；裸跑会静默跳过 170 项并显示全绿，**报数必须同时报 passed 与 skipped**）；`db:verify` 335/393/85/6/6；契约 check exit 0。

## 7. 交付格式

1. 改动文件清单 + `schema_version` 表结构；
2. 六条命令的真实输出（含 skipped 数、contract check 的 exit code）；
3. 第 5 节 6 条各自对应的验证方式（第 4 条要贴失败现场的输出）；
4. bootstrap 一次性同步契约这件事，明确写"已做"并说明只此一次；
5. 本地提交，不 push。
