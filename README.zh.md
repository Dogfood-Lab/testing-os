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
**v1.3.0** — 7 个包 (`@dogfood-lab/*`)，工作区范围内的测试套件，接收器已上线，手册已部署。
<!-- version:end -->

📖 **[阅读手册 →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## 这是什么

`testing-os` 是 [Dogfood Lab](https://github.com/dogfood-lab) GitHub 组织的旗舰单仓库项目——它是现在已存档的 [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs) 的继任者。它将协议和基础设施打包在一起，用于在人工智能原生开发工作流程中运行、记录和学习测试：

- 一个**集群协议**，用于针对代码库运行并行代理审计。
- 一个**证据存储 + 模式框架**，用于存储来自这些运行的记录、发现、模式和建议。
- 一个**策略 + 验证器**层，用于确定哪些内容被认为是“已验证的”——并在所有消费者仓库中强制执行。
- 一个**智能层**，将原始发现转化为可重用的模式和原则。

## 状态

**v1.3.0** — 所有消费者都使用单个规范模式验证器（每个模式每个进程一个 Ajv 实例；工作区提升是一种硬性限制）。结构化的顶级错误，具有稳定的代码（`ISOLATION_FAILED`、`DUPLICATE_RUN_ID`、`STATE_MACHINE_*`、`DISPATCH_*`、`VALIDATOR_FAULT_*`……），并且在每个失败路径上都有一个“下一步：”提示。策略 YAML 现在在加载时通过模式进行验证——结构上无效的策略文件会发出明确的错误，而不是默默地回退到宽松的默认设置。手册位于 [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/)，具有浅色/深色主题的对等性、每个页面的 WCAG-AA 可访问性（在 CI 中进行 pa11y 测试并重试）、每个动词的 `swarm` CLI 参考以及自定义的 404 页面。六个包以 v1.3.0 的形式同步发布到 npm 上，位于 `@dogfood-lab` 下——请参阅下表。与 v1.2.x 相比，没有重大更改。有关完整的 v1.3.0 条目，请参阅 [CHANGELOG.md](CHANGELOG.md)。

接收器已上线：消费者仓库中的 `dogfood.yml` 工作流程会将其发送到此仓库，并且 ` .github/workflows/ingest.yml` 会将生成的记录和索引提交回 `main`。手册已部署到 [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/)。主要安装：`npm install -g @dogfood-lab/dogfood-swarm`。接收器端通过发送进行消费——请参阅手册的“集成”页面。

**平台：**作为 Session G 的一部分，在 Darwin/APFS 上进行了端到端验证（[`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)）。请参阅[本地开发](#local-development)，了解支持的文件系统。每个版本的详细信息请参阅 [CHANGELOG.md](CHANGELOG.md)。

## 威胁模型

testing-os 处理通过 `repository_dispatch` 从受信任的 GitHub 仓库（`mcp-tool-shop-org/*` 和 `dogfood-lab/*`）发送的 dogfood 提交。验证器需要 GitHub Actions 溯源——声明的运行 ID 通过 GitHub API 进行确认，并且具有格式错误、缺少引用或无效策略声明的提交将被拒绝。

**testing-os 涉及的内容：**每个 `repository_dispatch` 有效负载中的提交 JSON；此仓库中的 `policies/`、`fixtures/`、`records/` 和 `indexes/`；到 `api.github.com` 的传出调用，用于进行溯源验证。

**testing-os 不涉及的内容：**消费者源代码、消费者仓库中的秘密（超出发送范围），或任何超出此仓库工作树的内容。

**所需的权限：**接收器工作流程仅在此仓库中运行，并具有 `contents: write` 权限。溯源验证使用工作流程的默认 `GITHUB_TOKEN` 进行只读的 Actions API 调用。**没有遥测、没有第三方服务、没有分析——此代码库既不会“回家报告”，也不会暴露超出 GitHub 的网络接口。**

## 包

| 包 | 来源 | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8 个 JSON 模式（记录、发现、模式、建议、原则、策略、场景、提交）。 |
| `@dogfood-lab/verify` | JS | 中央提交验证器。提交在持久化之前会通过此验证器。 |
| `@dogfood-lab/findings` | JS | 发现契约 + 推导/审查/综合/建议流水线。 |
| `@dogfood-lab/ingest` | JS | 流水线粘合剂：发送 → 验证 → 持久化 → 索引。 |
| `@dogfood-lab/report` | JS | 用于源仓库的提交构建器。 |
| `@dogfood-lab/portfolio` | JS | 跨仓库组合生成器。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10 阶段的并行代理协议 + SQLite 控制平面 + `swarm` 二进制文件。 |

**保持独立**但通过已发布的 API 进行集成的其他测试工具：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck)、[`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge)、[`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp)、[`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine)、[`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

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

需要 Node 版本 ≥ 22。CI 矩阵在 `ubuntu-latest` 上运行 Node 22 + 24；本地验证使用 Node 25。

**支持的文件系统：**APFS、HFS+、ext4（CI 基准）、NTFS——任何实现 POSIX `link(2)` 的文件系统。**不支持：**exFAT、FAT32。`[`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js)` 中的文件锁定 CAS 需要硬链接语义来实现原子发布；在 exFAT 上，`linkSync` 会抛出 `ENOTSUP` 错误（会发出明显错误，而不是静默错误）。常见问题：跨平台的外部 SSD 通常格式化为 exFAT——请将仓库克隆到本地的 APFS/HFS+ 文件系统。有关完整的 Session G 验证矩阵，请参阅 [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)。

## 版本控制

所有 `@dogfood-lab/*` 包都采用同步版本控制——它们一起更新。此 README 文件中的版本号会从 `package.json` 文件中自动提取，并通过 `scripts/sync-version.mjs` 脚本进行更新（作为 `prebuild` 脚本运行）。截至 **v1.2.0**，有六个包发布到 npm，并使用 `@dogfood-lab` 命名空间：`schemas`、`verify`、`report`、`ingest`、`findings`、`dogfood-swarm`。第七个包（`@dogfood-lab/portfolio`）仍然是 monorepo 内部使用的。

## 许可证

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[手册](https://dogfood-lab.github.io/testing-os/handbook/)** · **[所有仓库](https://github.com/orgs/dogfood-lab/repositories)** · **[个人资料](https://github.com/dogfood-lab)**

*先吃饱，再开始工作。*

</div>
