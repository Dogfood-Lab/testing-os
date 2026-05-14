<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.md">English</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<div align="center">

# testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**用于人工智能时代的软件测试操作系统**

*用于人工智能辅助软件的协议、证据存储和学习循环。*

<!-- version:start -->
**v0.2.0-pre** — 7个软件包 (`@dogfood-lab/*`)，工作区范围内的测试套件，数据接收器已启用，手册已部署。
<!-- version:end -->

📖 **[阅读手册 →](https://dogfood-lab.github.io/testing-os/)**

</div>

---

## 简介

`testing-os` 是 [Dogfood Lab](https://github.com/dogfood-lab) GitHub 组织的旗舰单仓库项目，它是取代现在已归档的 [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs) 的。它包含运行、记录和从测试中学习的协议和基础设施，以实现人工智能原生开发流程：

- 一种 **集群协议**，用于对代码库执行并行代理审计。
- 一种 **证据存储 + 模式框架**，用于记录、发现、模式和建议。
- 一种 **策略 + 验证器** 层，用于确定哪些内容被认为是“已验证”，并在所有客户端仓库中强制执行。
- 一种 **智能层**，用于将原始发现转换为可重用的模式和规范。

## 状态

已完成从 `mcp-tool-shop-org/dogfood-labs` 的迁移（2026-04-25）。数据接收器已启用：客户端仓库中的 `dogfood.yml` 工作流会发送到此仓库，并且 [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) 提交将生成的记录和索引回写到 `main` 分支。手册已部署在 [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/)。v1.0.0 版本将在 [HANDOFF.md](HANDOFF.md) 中的迁移完善工作完成后发布。

## 软件包

| 软件包 | 源文件 | 用途 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8个JSON模式（记录、发现、模式、建议、规范、策略、场景、提交）。 |
| `@dogfood-lab/verify` | JS | 中心提交验证器。提交会通过此处进行验证，然后再持久化。 |
| `@dogfood-lab/findings` | JS | 发现合约 + 派生/审查/综合/建议流水线。 |
| `@dogfood-lab/ingest` | JS | 流水线连接：分发 → 验证 → 持久化 → 索引。 |
| `@dogfood-lab/report` | JS | 用于源仓库的提交构建器。 |
| `@dogfood-lab/portfolio` | JS | 跨仓库组合生成器。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10个阶段的并行代理协议 + SQLite 控制平面 + `swarm` 二进制文件。 |

**保持独立**但通过已发布的 API 集成的其他测试工具：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

## 布局

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/
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

需要 Node ≥ 20。

## 版本控制

所有 `@dogfood-lab/*` 软件包的版本保持一致。当前版本为 `0.1.0-pre`；第一个稳定版本将是 `1.0.0`，具体取决于 [HANDOFF.md](HANDOFF.md) 中的迁移完善工作。此 README 文件中的版本行由 `scripts/sync-version.mjs` 脚本自动更新（在 `prebuild` 阶段运行）。

## 许可证

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[手册](https://dogfood-lab.github.io/testing-os/)** · **[所有仓库](https://github.com/orgs/dogfood-lab/repositories)** · **[个人资料](https://github.com/dogfood-lab)**

*先体验，再发布。*

</div>
