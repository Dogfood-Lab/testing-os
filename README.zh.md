<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<p align="center">
  <img src="./assets/logo.png" alt="testing-os" width="280">
</p>

<div align="center">

# testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**人工智能时代下的测试操作系统**

*用于人工智能辅助软件的协议、证据存储和学习循环。*

<!-- version:start -->
**v1.8.0** — 当前版本。有关已发布内容，请参阅 [CHANGELOG.md](CHANGELOG.md)。
<!-- version:end -->

📖 **[阅读手册 →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## 这是什么

`testing-os` 在基于 AI 的工作流程中记录、验证并学习您的代码仓库中的真实测试证据。将其指向一个代码仓库，每次测试运行都会成为经过来源验证的记录，您可以信任它——而不是自我报告的通过状态。

您将获得：

- **经过来源验证的记录。** 每个提交都与真实的 CI 运行相关联——无需密钥，而是通过提供商自己的身份进行验证——然后才被接受。结果是一个防篡改、仅追加的证据存储库，而不是一个基于诚信原则的绿色复选标记。
- **您可以控制的策略契约。** 在 YAML 中声明哪些内容算作“已验证”——一种有界、无评估谓词 DSL（`field`/`op`/`value` + `all`/`any`/`not`/`implies`）——并在您的代码仓库中强制执行它。在发布之前，使用 `dogfood-verify lint` 检查策略。
- **一个并行代理集群协议。** 对代码库进行多代理审计，然后将原始结果转换为可重用的模式和规范。
- **实时状态界面。** 每个代码仓库的记录、索引和一个状态徽章，所有这些都来自同一个证据存储库。

它是 [Dogfood Lab](https://github.com/dogfood-lab) 组织的旗舰单体代码仓库——一个 `swarm` CLI 后面的七个 `@dogfood-lab/*` 包。

## 快速入门

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

想要记录您自己的代码仓库的测试证据吗？**[`examples/` 启动工具包](examples/)** 可让您在五分钟内开始使用（`npx @dogfood-lab/report` 构建提交；`dogfood-init` 设置工作流程）。操作指南、CLI 参考、模式参考和集成示例都位于 **[手册](https://dogfood-lab.github.io/testing-os/handbook/)** 中。每个版本的详细信息都在 [CHANGELOG.md](CHANGELOG.md) 中。

## 威胁模型

testing-os 处理通过 `repository_dispatch` 从受信任的 GitHub 仓库（`mcp-tool-shop-org/*` 和 `dogfood-lab/*`）发送的 dogfood 提交。验证器需要 GitHub Actions 溯源——声明的运行 ID 通过 GitHub API 进行确认，并且具有格式错误、缺少引用或无效策略声明的提交将被拒绝。

**来源是证明。** 对于 `github` 提交，验证器会确认所声称的 GitHub Actions 运行确实存在（GitHub API），并将提交的 `repo` 和 `commit_sha` 与该已确认的运行相关联——这是一个实时的、无需密钥的检查，其根源在于 GitHub 自己的 OIDC 身份，因此记录不能证明不存在的运行或提交。**GitLab CI** 支持可选配置（`source.provider: gitlab`）；GitLab 提交是验证器调用非 GitHub 主机 (`gitlab.com/api`) 的唯一情况，并且仅针对 `gitlab` 提交。

**记录完整性具有防篡改的证据，但并非完全防篡改。** 每个持久化的记录都包含一个 `integrity` 块（`submission_digest` + `prev_digest`），形成一个仅追加的哈希链，`dogfood ingest --verify-chain` 可以完全离线验证该链——检测外部篡改、磁盘损坏和部分恢复。它不会防御提交凭据本身，因为它可以重写记录和链；要解决这个问题，需要使用写入者无法控制的锚点。一个**可选的、默认关闭的 XRPL 锚点** (`dogfood ingest --anchor-*`) 会将链头见证到公共 XRP Ledger 中，从而可以检测出任何低于已锚定点的截断或重写——这是第二个公开的非 GitHub 调用，并且仅当操作员启用它时才会发生。

**testing-os 涉及的内容：**每个 `repository_dispatch` 有效负载中的提交 JSON；此仓库中的 `policies/`、`fixtures/`、`records/` 和 `indexes/`；到 `api.github.com` 的传出调用，用于进行溯源验证。

**testing-os 不涉及的内容：**消费者源代码、消费者仓库中的秘密（超出发送范围），或任何超出此仓库工作树的内容。

**网络界面。** 默认情况下，唯一的出口是 `api.github.com`（只读来源）。两种例外情况都已在上面披露，并且都是可选配置：一个 GitLab 提供商提交 (`gitlab.com/api`) 和一个由操作员启用的 XRPL 锚点运行。**没有遥测数据，也没有分析——此代码库不会自动回传；如果没有这两个可选路径，它就不会暴露任何超出 GitHub 的网络界面。** 接收工作流程的范围仅限于此代码仓库，并且具有 `contents: write` 权限。

## 包

| 包 | 来源 | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8 个 JSON 模式（记录、发现、模式、建议、原则、策略、场景、提交）。 |
| `@dogfood-lab/verify` | JS | 中央提交验证器。提交在持久化之前会通过此验证器。 |
| `@dogfood-lab/findings` | JS | 发现契约 + 推导/审查/综合/建议流水线。 |
| `@dogfood-lab/ingest` | JS | 流水线粘合剂：发送 → 验证 → 持久化 → 索引。 |
| `@dogfood-lab/report` | JS | 用于源仓库的提交构建器。 |
| `@dogfood-lab/portfolio` | JS | 跨仓库作品集生成器。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10 阶段的并行代理协议 + SQLite 控制平面 + `swarm` 二进制文件。 |

**保持独立**但通过已发布的 API 集成的其他测试工具：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck)、[`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge)、[`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp)、[`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine)、[`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

## 布局

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/handbook/
├── swarms/                    # Swarm-run artifacts + control-plane.db
├── indexes/                   # Generated read API: latest-by-repo.json, failing.json, stale.json
├── policies/                  # Policy YAML by repo
├── records/                   # Submission landing pad (ingest.yml writes here)
├── fixtures/                  # Test/example fixtures
├── docs/                      # Contract docs + architecture notes
├── examples/                  # Copy-paste consumer starter kit (dogfood.yml + scenario + policy)
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml, release.yml
```

## 本地开发

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

需要 Node 版本 ≥ 22。CI 矩阵在 `ubuntu-latest` 上运行 Node 22 + 24；本地验证使用 Node 25。

**支持的文件系统：**APFS、HFS+、ext4（CI 基准）、NTFS——任何实现 POSIX `link(2)` 的文件系统。**不支持：**exFAT、FAT32。`[`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js)` 中的文件锁定 CAS 需要硬链接语义来实现原子发布；在 exFAT 上，`linkSync` 会抛出 `ENOTSUP` 错误（会发出明显错误，而不是静默错误）。常见问题：跨平台的外部 SSD 通常格式化为 exFAT——请将仓库克隆到本地的 APFS/HFS+ 文件系统。有关完整的 Session G 验证矩阵，请参阅 [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)。

## 版本控制

所有 `@dogfood-lab/*` 包都一起更新——整个单体代码仓库使用一个版本号。六个包以 v1.8.0 的形式发布到 npm 上，并与 `@dogfood-lab` 相关联（`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`）；第七个包 `@dogfood-lab/portfolio` 保持内部状态。此 README 文件顶部的版本行通过 [`scripts/sync-version.mjs`](scripts/sync-version.mjs) 从 `package.json` 中自动提取，并在每次 `npm run build` 时进行更新。

## 许可证

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[手册](https://dogfood-lab.github.io/testing-os/handbook/)** · **[所有仓库](https://github.com/orgs/dogfood-lab/repositories)** · **[个人资料](https://github.com/dogfood-lab)**

*先吃饱，再开始工作。*

</div>
