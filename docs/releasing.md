# 版本发布

[返回 README](../README.md)

本项目通过 GitHub Release 发布源码版本，通过 GHCR 发布容器镜像。`package.json` 保留 `private: true`，不发布到 npm。

## 仓库介绍

仓库地址：<https://github.com/getcodex-plus/store>。

GitHub About 建议使用：

> 可自托管的 ChatGPT 充值商城，支持 Dujiao-Next 上游采购、AICDK 自动兑换、在线支付、钱包、优惠码与邀请返现。

英文简介：

> Self-hosted ChatGPT recharge storefront with Dujiao-Next procurement, AICDK fulfillment, payments and referrals.

建议 Topics：`chatgpt`、`storefront`、`self-hosted`、`nextjs`、`bun`、`postgresql`、`prisma`、`dujiao-next`、`aicdk`。

项目主页可使用仓库 README。仓库首页应指向本项目文档；实际运营站点、供货站点与项目文档需要明确区分。

## 首次公开前

- [ ] 确认仓库 `getcodex-plus/store` 可访问，源码、锁文件、依赖补丁、数据库更新和文档均已提交。
- [ ] 确认发布包包含 [Apache License 2.0 全文](../LICENSE)，且 `package.json` 的 `license` 字段为 `Apache-2.0`。
- [ ] 启用 GitHub Actions，允许工作流创建 Release、推送 GHCR 包。默认分支需包含工作流，才能手动运行 Release。
- [ ] 在仓库 Security 设置中启用私密漏洞报告，使 [安全说明](../SECURITY.md) 中的报告入口可用。
- [ ] 确认 Git 未跟踪真实 `.env`、数据库备份、初始密码、卡密、客户 Session、日志或测试证据。
- [ ] 首次镜像推送后检查 GHCR 包可见性；仓库公开不会自动保证容器包公开。

许可证和仓库可见性由维护者决定，发布工作流不会代为设置。

## 发布前检查

在准备发布的同一提交上完成：

1. 按 [开发与测试](development.md) 运行类型检查、单元与数据库集成测试、生产构建；账户、订单、支付或界面有变化时运行相应生产 E2E。
2. 在空 schema 验证初始化、种子数据与 `db:verify`；有存量数据库时在副本上验证升级路径。
3. 确认 Web 与 Worker 能从相同镜像运行，HTTPS 网关提供正确的客户端 IP。
4. 核对 README 功能承诺、配置示例、镜像地址与实际实现；Release 说明列明数据库更新和行为变化。
5. 把历史验收当作历史证据；本次验证需记录提交、环境、命令、结果及未验证范围。

软件版本发布与运营站点切流分别验收。真实支付、上游采购与兑换、邮件、备份恢复和进程守护需在 [生产部署](deployment.md) 的目标环境另行验证。

## 工作流

| 工作流                                         | 触发条件                                  | 执行内容                                                                          |
| ---------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| [`Test`](../.github/workflows/test.yaml)       | push、pull request、手动或被 Release 复用 | 锁文件安装、类型检查、单元与真实数据库集成测试、生产构建、容器构建及 Web 健康冒烟 |
| [`Release`](../.github/workflows/release.yaml) | 手动输入版本和预发布标记                  | 校验版本、复用完整 Test，通过后创建固定在已验证提交上的 Tag 和 Draft Release      |
| [`Docker`](../.github/workflows/docker.yaml)   | Release 发布或转为正式版                  | 构建并推送 amd64 / arm64 镜像，附带 Provenance、SBOM 和镜像摘要                   |

Test 当前不自动运行 Playwright E2E，也不验证真实外部服务。容器冒烟只检查 Web 启动、健康入口和 `/api/bootstrap`，不代表完整 Worker 业务验收。

## 创建并发布版本

1. 确认本地变更全部进入目标提交，推送至仓库。
2. 在 GitHub **Actions → Release → Run workflow** 选择分支，填写不带 `v` 的版本，例如 `0.1.0` 或 `0.1.0-rc.1`。带预发布后缀时必须勾选 `prerelease`，不支持 `+metadata`。
3. 工作流验证该次运行的提交，创建 `v<version>` Tag 和 Draft Release。同名 Release 已存在时会拒绝覆盖；同名 Tag 指向其他提交时也会拒绝。
4. 在 Draft Release 中补充下方模板的功能、迁移和验证说明，确认 Tag 和提交正确后，通过 GitHub 页面发布。
5. 检查 Docker 工作流结果，记录版本镜像及摘要；成功后再按 [部署指南](deployment.md) 更新服务。

发布应在 GitHub 页面完成，或使用维护者自身凭证完成。不要另外添加用默认 `GITHUB_TOKEN` 自动发布草稿的步骤，否则后续 Release 事件可能无法触发镜像工作流。

版本号以 Release Tag 为准，工作流不自动修改 `package.json`。需要保持包版本一致时，在触发 Release 前修改并提交。

### 镜像标签

镜像仓库：`ghcr.io/getcodex-plus/store`。

| 标签                 | 含义                                                     |
| -------------------- | -------------------------------------------------------- |
| `<version>`          | 去掉 `v` 的 Release 版本，如 `0.1.0`、`0.1.0-rc.1`       |
| `sha-<完整提交 SHA>` | 对应源码提交                                             |
| `latest`             | 最近一次正式版发布，不由预发布更新                       |
| `prereleased`        | 最近一次发布，无论正式版还是预发布；不要把它当作固定版本 |

Tag 不应移动。生产部署可直接固定工作流输出的 `ghcr.io/getcodex-plus/store@sha256:…` 摘要。

### Release 说明模板

```markdown
## 本次变化

- 面向使用者说明新增功能、修复和行为变化。

## 部署与升级

- 所需运行时、镜像版本、环境变量变化。
- 数据库 SQL、执行顺序，以及 Web / Worker 更新要求。
- 与旧版本的兼容性及回滚条件。

## 验证

- 提交：
- 类型检查、单元 / 数据库测试、生产构建：
- 端到端 / 容器验证：
- 未覆盖的外部服务及已知限制：
```

使用 [数据库维护](database.md) 中列出的真实脚本，不用“重新初始化数据库”替代升级步骤。
