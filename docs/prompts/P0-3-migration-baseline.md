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
- 健康探针现状（**我第一版写错，这里已更正**）：web **有** HEALTHCHECK，来自镜像 `Dockerfile:59-60`（`docker-entrypoint.sh healthcheck`），compose 没覆盖它。但探针打的是 `/robots.txt`（`docker-entrypoint.sh:24`），**只判断 HTTP 200，完全不碰数据库**；而且 `compose.prod.yaml` 里没有任何服务等 web 健康、也没有 autoheal，**这个状态没人消费**。worker 则是显式 `healthcheck: disable: true`。
- 推论：新镜像 + 旧库时，容器照样 Up、探针照样绿（`/robots.txt` 不查库），症状是**运行时 500**，错误原文是 `Raw query failed. Code: '42703'. Message: 'column "x" does not exist'`。所以顺序错误没有任何自动门禁会拦，只能靠纪律 + 这条排查口诀。
- 关键业务约束（改表时不能碰）：`orders_channel_check`（`alipay/wechat/crypto/balance`）、`orders_status_check`（7 个状态）、`orders_discount_check`（`list_amount - discount_amount = amount`）等都在 `init.sql:368-375`。

## 2. 要交付的东西

| 文件 | 内容 |
|---|---|
| `prisma/init.sql`（追加，不重写） | 新建 `schema_version`：`version int primary key` · `checksum text not null`（SQL 文件哈希）· `applied_at timestamptz not null default now()` · **`applied_by text not null`（记录部署用的镜像 digest，不是 tag：tag 会被覆盖，digest 不会）** — **只追加，不改动已有对象** |
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
6. expand-contract 纪律写进文档：**只加不删**（先加列/新表，下一版本才清理旧列），否则旧镜像会在滚动窗口内 500。**收缩版本单独发一个 release，且发布前先跑一次恢复演练**——收缩之后再回滚旧镜像，等于让旧代码对着一个它不认识的库形状跑，这是最难救的组合。

## 4. 部署顺序（写进 `docs/database.md` 和 runbook，别只写在代码注释里）

```
1) 备份（scripts/ops/backup-db.sh）
2) 迁移库（bun run db:migrate）            ← 必须在新镜像上线之前
3) bun run db:verify 绿
4) bun scripts/ops/gen-contract.ts --check 绿
5) 滚动部署新镜像
6) 旧镜像必须仍能正常跑（expand 阶段只加不删）
```

反了会怎样（实测）：新镜像 + 旧库 → 查询新列直接 500，错误原文 `Raw query failed. Code: '42703'. Message: 'column "x" does not exist'`。**不是**容器起不来，也不是探针变红——探针打的是 `/robots.txt`，不碰数据库，而且没人消费这个状态。所以顺序错误的表现是「网站开始报错」，运维会去查镜像/网络/连接。

**排查口诀（写进 runbook）**：看到 `42703 / column ... does not exist` 就查库迁移了没有，别查镜像和网络。

## 5. 验收判据（@u5c0f-q 按此打，实现者不参与验收）

### 验收形态（本单判据天生跨形态，必须逐条标注）

- 迁移与 `db:migrate` 都在**数据库容器内**执行；`db:verify` / `gen-contract` 可能在宿主机跑。每条判据要写清执行位置（宿主机 / 容器内 / 通过 `docker exec`）。
- 涉及卷与只读性的判据：`compose.prod.yaml:31 read_only: true`，容器内除 `/tmp` 与 `/app/.next/cache` 外不可写——迁移脚本不要往工作目录写临时文件。
- 从宿主机判断"容器内路径是否在 volume 里"不可判定，只能输出"不知道"。
- 验收前先跑 `scripts/ops/deployer-preflight.sh`（已知清单），但它替代不了"照文档走一遍"。


1. 空库从零跑完所有编号 SQL → `db:verify` 绿 **且** `gen-contract --check` 绿（两个都绿才算）。
2. 有数据的库跑增量 → 目标表行数前后不变、抽样数据一致。
3. 同一迁移重复执行 → 不报错、`schema_version` 不重复记账（幂等）。
4. **迁移中途失败 → 事务回滚、库停在旧版本、`schema_version` 不变**（故意在第二个语句写语法错来验，这条最容易漏）。
5. 迁移完成后，**旧镜像仍能正常跑**（expand 阶段只加不删的实证）。
6. 已应用迁移的 SQL 被改过 → `db:migrate` 必须报错退出（checksum 检出），不能静默跳过；报错信息必须能指出**哪一版、何时应用、哪次部署（`applied_by` 的镜像 digest）**。

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
