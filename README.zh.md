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
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**用于人工智能时代的测试操作系统**

*用于人工智能辅助软件的协议、证据存储和学习循环。*

<!-- version:start -->
**v1.2.0** — 包含 7 个包 (`@dogfood-lab/*`)，整个工作区的测试套件，实时数据接收器，用户手册已部署。
<!-- version:end -->

📖 **[阅读用户手册 →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## 简介

`testing-os` 是 [Dogfood Lab](https://github.com/dogfood-lab) GitHub 组织的旗舰单仓库项目，它是 `mcp-tool-shop-org/dogfood-labs` 的继任者（后者已存档）。它集成了运行、记录和从测试中学习的协议和基础设施，以实现人工智能原生开发流程：

- 一种 **集群协议**，用于对代码库执行并行代理审计。
- 一种 **证据存储 + 模式框架**，用于记录、发现、模式和建议。
- 一种 **策略 + 验证器** 层，用于确定哪些内容被认为是“已验证”，并在所有客户端仓库中强制执行。
- 一种 **智能层**，用于将原始发现转换为可重用的模式和规范。

## 状态

**v1.2.0** — `@dogfood-lab/*` 单仓库项目的首次 npm 发布。现在有六个包在 `@dogfood-lab` 命名空间下公开：`schemas`、`verify`、`report`、`ingest`、`findings` 和 `dogfood-swarm`（主要的 `swarm` CLI）。此版本的新功能：波级别状态机 + 三个 R 的恢复合约 (`swarm revalidate`, `swarm rewind`, `swarm redrive`) + `swarm history` 审计跟踪功能 + A–D 阶段的健康性检查（0 个关键错误 / 0 个高危错误）。 **1105 个测试用例。** 自 v1.0.0 以来，整个仓库的累计测试用例包括以上内容，以及 Phase 7 dogfood swarm（约 31 个波次，约 115 个已验证的修复，14 个审计覆盖类别）。 权威的 swarm 目录：[`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md)。

数据接收器已启用：客户端仓库中的 `dogfood.yml` 工作流会发送到此仓库，并且 [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) 会将生成的记录和索引提交到 `main` 分支。用户手册已部署在 [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/)。 初始安装：`npm install -g @dogfood-lab/dogfood-swarm`。 客户端通过分发方式接收数据，详情请参阅用户手册的“集成”页面。

**平台：** 已在 Darwin/APFS 上进行端到端验证，作为 Session G 的一部分 ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md))。有关受支持的文件系统，请参阅 [本地开发](#local-development)。每个版本的详细信息请参阅 [CHANGELOG.md](CHANGELOG.md)。

## 安全模型

`testing-os` 处理通过 `repository_dispatch` 从受信任的 GitHub 仓库（`mcp-tool-shop-org/*` 和 `dogfood-lab/*`）发送的 dogfood 提交。验证器需要 GitHub Actions 的凭证，已声明的运行 ID 会通过 GitHub API 进行确认，并且具有不正确结构、缺少引用或无效策略声明的提交将被拒绝。

**`testing-os` 涉及的内容：** 每个 `repository_dispatch` 负载中的 JSON 提交数据；此仓库中的 `policies/`、`fixtures/`、`records/` 和 `indexes/`；以及对 `api.github.com` 的外部调用，用于验证凭证。

**testing-os 不会处理以下内容：** 消费端源代码，消费端仓库中超出派发范围的敏感信息，以及任何位于此仓库工作目录之外的内容。

**所需权限：** 接收端工作流程使用 `contents: write` 权限，仅限于此仓库。 溯源验证使用工作流程的默认 `GITHUB_TOKEN` 进行只读的 Actions API 调用。 **没有遥测数据，没有第三方服务，没有分析功能——此代码库既不会向外部发送数据，也不会暴露任何超出 GitHub 的网络接口。**

## 包

| 包 | 源 | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8 个 JSON 模式（记录、发现、模式、建议、原则、策略、场景、提交）。 |
| `@dogfood-lab/verify` | JS | 中央提交验证器。 提交在此处经过验证，然后再进行持久化。 |
| `@dogfood-lab/findings` | JS | 发现模块 + 衍生/审查/综合/建议流水线。 |
| `@dogfood-lab/ingest` | JS | 流水线连接：派发 → 验证 → 持久化 → 索引。 |
| `@dogfood-lab/report` | JS | 用于源仓库的提交构建器。 |
| `@dogfood-lab/portfolio` | JS | 跨仓库组合生成器。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10 阶段的并行代理协议 + SQLite 控制平面 + `swarm` 二进制文件。 |

独立的测试工具，但通过已发布的 API 进行集成：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

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
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml
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

需要 Node ≥ 20。 CI 矩阵在 `ubuntu-latest` 上运行 Node 20 + 22；本地验证版本为 Node 25。

**支持的文件系统：** APFS, HFS+, ext4 (CI 基础)，NTFS — 任何实现 POSIX `link(2)` 的文件系统。 **不支持：** exFAT, FAT32。 `packages/findings/lib/file-lock.js` 中的文件锁 CAS 需要硬链接语义才能进行原子性发布；在 exFAT 上，`linkSync` 会抛出 `ENOTSUP` 错误（会报错，而不是静默失败）。 常见问题：跨平台的外置 SSD 通常格式为 exFAT — 建议将仓库克隆到本地的 APFS/HFS+ 格式的磁盘上。 详情请参阅 [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)，其中包含完整的 Session G 验证矩阵。

## 版本控制

所有 `@dogfood-lab/*` 包的版本保持同步。 此 README 文件中的版本号由 `scripts/sync-version.mjs` 脚本从 `package.json` 文件中自动生成（在 `prebuild` 阶段运行）。 截至 **v1.2.0** 版本，六个包发布到 npm，作用域为 `@dogfood-lab`：`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`。 第七个包 (`@dogfood-lab/portfolio`) 仍然是单仓库中的内部组件。

## 许可证

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[手册](https://dogfood-lab.github.io/testing-os/handbook/)** · **[所有仓库](https://github.com/orgs/dogfood-lab/repositories)** · **[个人资料](https://github.com/dogfood-lab)**

*先吃，后发。*

</div
