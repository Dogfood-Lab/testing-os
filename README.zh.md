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

**v1.2.3** — 包含 7 个软件包 (`@dogfood-lab/*`)，整个工作空间的测试套件，数据接收器已上线，用户手册已部署。

📖 **[阅读用户手册 →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## 简介

`testing-os` 是 [Dogfood Lab](https://github.com/dogfood-lab) GitHub 组织的旗舰单仓库项目，它是取代现在已归档的 [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs) 的。它集成了运行、记录和从测试中学习的协议和基础设施，以实现人工智能原生开发流程：

- 一种 **集群协议**，用于对代码库执行并行代理审计。
- 一种 **证据存储 + 模式框架**，用于记录、发现、模式和建议。
- 一种 **策略 + 验证器** 层，用于确定哪些内容被认为是“已验证”，并在所有客户端仓库中强制执行。
- 一种 **智能层**，用于将原始发现转换为可重用的模式和规范。

## 状态

**v1.2.3** — 健康检查模块的清理版本。针对 v1.2.2 版本，我们进行了四阶段的内部测试（阶段 A：错误/安全问题 → 阶段 B：主动改进 → 阶段 C：用户体验优化 → 阶段 D：视觉优化），发现了 50 多个问题；本次发布包含关键修复：加强了数据接收器流水线的安全性（验证运行器中的 `execFileSync` 参数形式，对代理输出的 `JSON.parse` 进行限制，防御性措施以防止 `repository_dispatch` 负载为空），提供了可供操作员使用的错误信息（`loadGlobalPolicy` 的 ENOENT/YAML 错误，重建索引失败时会显示堆栈信息和恢复提示），以及 Node 版本验证（README、CHANGELOG 和 CLAUDE.md 文件），新增了一篇 CLI 参考手册页面，涵盖了 17 个之前未记录的 `swarm` 命令，还包括一个自定义的 404 页面和社交媒体卡片元数据。没有软件包结构的变化，也没有与 1.2.2 版本相比的破坏性更改。所有第五阶段的功能都已保留：波级别状态机 + 三个 R 的恢复机制（`swarm revalidate`、`swarm rewind`、`swarm redrive`）+ `swarm history` 审计跟踪命令。共有 6 个软件包在 `@dogfood-lab` 下发布：`schemas`、`verify`、`report`、`ingest`、`findings`、`dogfood-swarm`。**1105/1105 个测试通过。** 从仓库的整个生命周期（自 v1.0.0 版本发布，即 2026-04-25）开始，包括第七阶段的内部测试（约 31 个波次，约 115 个已验证的修复，14 个审计覆盖类别），v1.2.x 版本的首次 npm 发布，以及 v1.2.3 版本的健康检查模块清理。权威的 `swarm` 目录：[`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md)。

数据接收器已启用：客户端仓库中的 `dogfood.yml` 工作流会发送到此仓库，并且 [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) 提交将生成的记录和索引回写到 `main` 分支。用户手册已部署在 [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/)。 快速安装：`npm install -g @dogfood-lab/dogfood-swarm`。 客户端通过分发方式进行消费，详情请参阅用户手册的“集成”页面。

**平台：** 已在 Darwin/APFS 上进行端到端验证，作为 Session G 的一部分 ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md))。有关受支持的文件系统，请参阅 [本地开发](#local-development)。每个版本的详细信息请参阅 [CHANGELOG.md](CHANGELOG.md)。

## 安全模型

`testing-os` 处理通过 `repository_dispatch` 从受信任的 GitHub 仓库（`mcp-tool-shop-org/*` 和 `dogfood-lab/*`）发送的 dogfood 提交。验证器需要 GitHub Actions 的凭证 — 声明的运行 ID 会通过 GitHub API 进行确认，并且具有不规范的结构、缺少引用或无效策略声明的提交将被拒绝。

**testing-os 涉及的内容：** 每个 `repository_dispatch` 负载中的提交 JSON；此仓库中的 `policies/`、`fixtures/`、`records/` 和 `indexes/` 目录；用于验证来源信息的对 `api.github.com` 的出站调用。

**testing-os 不涉及的内容：** 消费者源代码，超出 dispatch 范围的消费者仓库中的密钥，以及此仓库工作目录之外的任何内容。

**所需权限：** 接收器工作流程以 `contents: write` 的权限运行，仅限于此仓库。 验证来源信息使用工作流程的默认 `GITHUB_TOKEN` 进行只读的 Actions API 调用。 **没有遥测，没有第三方服务，没有分析功能——此代码库既不向外部发送数据，也不暴露任何超出 GitHub 的网络接口。**

## Packages

| Package | Source | Purpose |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | The 8 JSON schemas (record, finding, pattern, recommendation, doctrine, policy, scenario, submission)。 |
| `@dogfood-lab/verify` | JS | Central submission validator. Submissions pass through here before they're persisted. |
| `@dogfood-lab/findings` | JS | Finding contract + derive/review/synthesis/advise pipelines. |
| `@dogfood-lab/ingest` | JS | Pipeline glue: dispatch → verify → persist → index. |
| `@dogfood-lab/report` | JS | Submission builder for source repos. |
| `@dogfood-lab/portfolio` | JS | Cross-repo portfolio generator. |
| `@dogfood-lab/dogfood-swarm` | JS | The 10-phase parallel-agent protocol + SQLite control plane + `swarm` bin. |

Sibling testing tools that **stay independent** but integrate via published APIs: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Layout

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

## Local Development

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Requires Node ≥ 20. CI matrix runs Node 20 + 22 on `ubuntu-latest`; locally validated on Node 25.

**Supported filesystems:** APFS, HFS+, ext4 (CI baseline), NTFS — anything that implements POSIX `link(2)`. **Not supported:** exFAT, FAT32. The file-lock CAS in [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) requires hardlink semantics for atomic publication; on exFAT, `linkSync` throws `ENOTSUP` (loud, not silent). Common gotcha: cross-platform external SSDs are often formatted exFAT — clone the repo to local APFS/HFS+ instead. See [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) for the full Session G validation matrix.

## Versioning

Lockstep across all `@dogfood-lab/*` packages — they bump together. The version line in this README is auto-stamped from `package.json` via `scripts/sync-version.mjs` (runs as `prebuild`). As of **v1.2.0**, six packages publish to npm under the `@dogfood-lab` scope: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. The seventh (`@dogfood-lab/portfolio`) remains internal to the monorepo.

## License

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Handbook](https://dogfood-lab.github.io/testing-os/handbook/)** · **[All Repositories](https://github.com/orgs/dogfood-lab/repositories)** · **[Profile](https://github.com/dogfood-lab)**

*先吃，后发。*

</div
