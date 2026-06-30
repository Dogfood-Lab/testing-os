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
**v1.6.0** — 当前版本。请参阅 [CHANGELOG.md](CHANGELOG.md)，了解已发布的内容。
<!-- version:end -->

📖 **[阅读手册 →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## 这是什么

`testing-os` 是 [Dogfood Lab](https://github.com/dogfood-lab) GitHub 组织的旗舰单仓库项目——它是现在已存档的 [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs) 的继任者。它将协议和基础设施打包在一起，用于在以人工智能为核心的开发流程中运行、记录和学习测试：

- 一个**集群协议**，用于针对代码库运行并行代理审计。
- 一个**证据存储 + 模式框架**，用于存储来自这些运行的记录、发现、模式和建议。
- 一个**策略 + 验证器**层，用于确定哪些内容被认为是“已验证的”——并在所有消费者仓库中强制执行。
- 一个**智能层**，将原始发现转化为可重用的模式和原则。

## 快速入门

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

您是否希望将您自己的代码仓库的测试证据记录在此处？ **[`examples/` 启动工具包](examples/)** 可让您在五分钟内开始使用（`npx @dogfood-lab/report` 用于构建提交内容；`dogfood-init` 用于搭建工作流程）。操作指南、CLI 参考、模式参考和集成示例都位于 **[手册](https://dogfood-lab.github.io/testing-os/handbook/)** 中。每个版本的详细信息请参阅 [CHANGELOG.md](CHANGELOG.md)。

## 威胁模型

testing-os 处理通过 `repository_dispatch` 从受信任的 GitHub 仓库（`mcp-tool-shop-org/*` 和 `dogfood-lab/*`）发送的 dogfood 提交。验证器需要 GitHub Actions 溯源——声明的运行 ID 通过 GitHub API 进行确认，并且具有格式错误、缺少引用或无效策略声明的提交将被拒绝。

**溯源即证明。** 对于 GitHub 提交，验证程序会确认所声称的 GitHub Actions 运行确实存在（GitHub API），并将提交的 `repo` 和 `commit_sha` 与该已确认的运行绑定在一起——这是一种实时的、无需密钥的检查，其根源在于 GitHub 自身的 OIDC 身份，因此记录不能证明未发生过的运行或提交。支持 GitLab CI（可选；`source.provider: gitlab`）；GitLab 提交是验证程序调用非 GitHub 主机（`gitlab.com/api`）的唯一情况，并且仅针对 `gitlab` 提交。

**记录完整性具有防篡改能力，但并非完全防篡改。** 每个持久化的记录都包含一个 `integrity` 块（`submission_digest` + `prev_digest`），形成一个只能追加的哈希链，`dogfood ingest --verify-chain` 可以完全离线地验证该哈希链——检测外部篡改、磁盘损坏和部分恢复。它**不能**防止对提交凭据本身的攻击，因为它可以重写记录和链；要解决这个问题，需要使用写入者无法控制的锚点。一个**可选的、默认关闭的 XRPL 锚点**（`dogfood ingest --anchor-*`）会见证链头到公共 XRP 分账本，从而可以检测出任何低于已锚定点的截断或重写——这是第二个公开的非 GitHub 调用，并且仅当操作员启用时才会发生。

**testing-os 涉及的内容：**每个 `repository_dispatch` 有效负载中的提交 JSON；此仓库中的 `policies/`、`fixtures/`、`records/` 和 `indexes/`；到 `api.github.com` 的传出调用，用于进行溯源验证。

**testing-os 不涉及的内容：**消费者源代码、消费者仓库中的秘密（超出发送范围），或任何超出此仓库工作树的内容。

**网络接口。** 默认情况下，唯一的外部连接是 `api.github.com`（只读溯源）。上述两种情况都是可选的：GitLab 提供商提交（`gitlab.com/api`）和由操作员启用的 XRPL 锚点运行。**没有遥测数据，也没有分析——此代码库绝不会自动向外部发送数据；如果没有这两个可选路径，它就不会暴露任何超出 GitHub 的网络接口。**接收工作流程的权限设置为 `contents: write`，并且仅限于此代码仓库。

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

所有 `@dogfood-lab/*` 包都一起更新——整个单体仓库使用一个版本号。六个包以 v1.5.0 的形式发布到 npm 下的 `@dogfood-lab` 中（`schemas`、`verify`、`report`、`ingest`、`findings`、`dogfood-swarm`）；第七个包 `@dogfood-lab/portfolio` 仍然是内部使用的。此 README 文件顶部的版本行通过 [`scripts/sync-version.mjs`](scripts/sync-version.mjs) 从 `package.json` 中自动提取，并在每次执行 `npm run build` 时进行更新。

## 许可证

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[手册](https://dogfood-lab.github.io/testing-os/handbook/)** · **[所有仓库](https://github.com/orgs/dogfood-lab/repositories)** · **[个人资料](https://github.com/dogfood-lab)**

*先吃饱，再开始工作。*

</div>
