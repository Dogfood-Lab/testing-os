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
[![dogfood](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/badges/dogfood-lab--testing-os--cli.json)](https://dogfood-lab.github.io/testing-os/handbook/read-model/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**人工智能时代用于测试的操作系统**

*用于支持人工智能辅助软件的协议、证据存储和学习循环。*

<!-- version:start -->
**v1.11.0** — 当前版本。有关已发布内容，请参阅 [CHANGELOG.md](CHANGELOG.md)。
<!-- version:end -->

📖 **[阅读手册 →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## 这是什么

`testing-os` 记录、验证并从您的代码仓库中的实际测试证据中学习，采用人工智能原生工作流程。将其指向一个代码仓库，每次测试运行都会成为经过来源确认的记录，您可以信任它——而不是自我报告的通过状态。

您将获得：

- **经过来源确认的记录。** 每个提交都与真实的 CI 运行绑定在一起——无需密钥，而是通过提供商自己的身份进行验证——然后才被接受。结果是一个防篡改、仅追加的证据存储，而不是一个基于诚信原则的绿色复选标记。
- **您可以控制的策略契约。** 在 YAML 中声明什么构成“已验证”，即有界且无评估谓词 DSL（`field`/`op`/`value` + `all`/`any`/`not`/`implies`），并在您的代码仓库中强制执行它。使用 `dogfood-verify lint` 在发布之前检查策略。
- **一个并行代理群协议。** 对代码库运行多代理审计，然后将原始结果转换为可重用的模式和规范。
- **实时状态界面。** 每个代码仓库的记录、索引和一个状态徽章，所有这些都来自同一个证据存储。

它是 [Dogfood Lab](https://github.com/dogfood-lab) 组织的旗舰单体代码仓库——七个 `@dogfood-lab/*` 包构成一个 `swarm` CLI。

## 快速入门

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

想要将您自己的代码仓库的测试证据记录到这里吗？**[`examples/` 入门工具包](examples/)** 可让您在五分钟内开始（`dogfood-report` 构建提交；`dogfood-init` 搭建工作流程）。操作指南、CLI 参考、模式参考和集成示例都位于 **[手册](https://dogfood-lab.github.io/testing-os/handbook/)** 中。每个版本的详细信息都在 [CHANGELOG.md](CHANGELOG.md) 中。

## 威胁模型

testing-os 处理通过 `repository_dispatch` 从受信任的 GitHub 代码仓库（位于 `mcp-tool-shop-org/*` 和 `dogfood-lab/*` 下）发送的 dogfood 提交。验证器需要 CI 来源——声明的运行 ID 通过提供商的 API 进行确认，并且具有格式错误、缺少引用或无效策略声明的提交将被拒绝。

**来源是证明。** 对于一个 `github` 提交，验证器会确认声明的 GitHub Actions 运行确实存在（GitHub API），并将提交的 `repo` 和 `commit_sha` 与该已确认的运行绑定在一起——这是一个实时的、无需密钥的检查，其根源在于 GitHub 自己的 OIDC 身份，因此记录不能证明一个未发生过的运行或提交。**GitLab CI** 支持可选配置（`source.provider: gitlab`）；GitLab 提交是验证器调用非 GitHub 主机（`gitlab.com/api`）的唯一情况，并且仅针对 `gitlab` 提交。

**记录完整性具有防篡改证据，但并非完全防篡改。** 每个持久化的记录都包含一个 `integrity` 块（`submission_digest` + `prev_digest`），形成一个仅追加的哈希链，该链由 `node packages/ingest/run.js --verify-chain` 完全离线验证——检测非预期篡改、磁盘损坏和部分恢复。它不会防御提交凭据本身，因为它可以重写记录和链；要解决这个问题，需要一个在写入者控制之外的锚点。**可选且默认关闭的 XRPL 锚点**（`node packages/ingest/run.js --anchor-*`）见证链头到公共 XRP Ledger，从而可以检测任何低于已锚定点的截断或重写——这是第二个公开的非 GitHub 调用，并且仅当操作员启用它时才会发生。

**testing-os 触及的内容：** 每个 `repository_dispatch` 有效负载中的提交 JSON；此代码仓库中的 `policies/`、`fixtures/`、`records/`、`indexes/` 和 `dogfood/roadmap/`（最后由操作员调用的 `swarm roadmap compile` 写入，而不是由自动摄取路径写入）；到 `api.github.com` 的出站调用以进行来源验证；以及——仅针对 `github` 提交——对已证明的提交代码仓库的 `dogfood/scenarios/<scenario_id>.yaml` 的只读获取（场景定义用于强制执行必需步骤；在之前会限制大小并进行模式验证，缺少的 文件只会使该检查未被强制执行，并且会显示可见警告）。

**testing-os 不触及的内容：** 消费者源代码超出声明的 `dogfood/scenarios/` 定义文件、消费者代码仓库中的密钥（超出提交信封），或此代码仓库工作树之外的任何内容。

**查找状态转换具有证据，并且仅追加。** 群控制平面的关闭动词（`swarm reopen`、`swarm close`）需要明确的原因、证据以及——对于操作员关闭——声明的验证模式；每个转换都会写入一个不可变的 `finding_events` 行，记录执行权限。没有自动路径可以根据停滞状态关闭查找或通过预测重新打开它，并且没有动词可以重写事件历史——滥用的凭据可以添加转换，但每次添加本身都会被记录在案。

**网络接口。** 默认情况下，唯一的出站连接是 `api.github.com`（只读：来源确认 + 上述场景定义获取）。两种例外情况都需要明确选择并已在上述内容中说明：一种是 GitLab 提供方的提交（`gitlab.com/api`），另一种是操作员启用的 XRPL 锚点运行。**没有遥测数据，也没有分析——此代码库绝不会主动连接外部服务器；如果没有这两种可选路径，它就不会暴露任何超出 GitHub 的网络接口。**接收器工作流的范围仅限于此仓库，使用 `contents: write`。

## 软件包

| 包 | 源代码 | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8 个 JSON 模式（记录、发现结果、模式、建议、原则、策略、场景、提交）。 |
| `@dogfood-lab/verify` | JS | 中央提交验证器。提交内容在持久化之前会经过此处的验证。 |
| `@dogfood-lab/findings` | JS | 发现结果协议 + 推导/审查/综合/建议流水线。 |
| `@dogfood-lab/ingest` | JS | 流水线粘合剂：分发 → 验证 → 持久化 → 索引。 |
| `@dogfood-lab/report` | JS | 用于源代码仓库的提交构建器。 |
| `@dogfood-lab/portfolio` | JS | 跨仓库组合生成器。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10 个阶段的并行代理协议 + SQLite 控制平面 + `swarm` 二进制文件。 |

**保持独立的**但通过已发布的 API 进行集成的配套测试工具：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck)、[`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge)、[`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp)、[`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine)、[`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

## 布局

```
testing-os/
├── packages/                  # 7 workspace packages (@dogfood-lab/*)
├── site/                      # Astro Starlight handbook → dogfood-lab.github.io/testing-os/handbook/
├── swarms/                    # Swarm-run artifacts + control-plane.db
├── indexes/                   # Generated read API: latest-by-repo.json, failing.json, stale.json, trends.json, badges/ (shields.io endpoints)
├── policies/                  # Policy YAML by repo
├── records/                   # Submission landing pad (ingest.yml writes here)
├── fixtures/                  # Test/example fixtures
├── docs/                      # Contract docs + architecture notes
├── examples/                  # Copy-paste consumer starter kit (dogfood.yml + scenario + policy)
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml, release.yml, self-dogfood.yml
```

## 本地开发

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # version-sync + doc-drift + regression-pin gates + build + tests (canonical pre-commit check — NOT the same as build && test)
```

需要 Node ≥ 22。CI 矩阵在 `ubuntu-latest` 上运行 Node 22 + 24；本地验证使用 Node 25。

**支持的文件系统：**APFS、HFS+、ext4（CI 基准）、NTFS——任何实现 POSIX `link(2)` 的文件系统。**不支持：**exFAT、FAT32。[`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) 中的文件锁 CAS 需要硬链接语义来实现原子发布；在 exFAT 上，`linkSync` 会抛出 `ENOTSUP`（发出警告，而不是静默）。常见问题：跨平台的外部 SSD 通常格式化为 exFAT——请将仓库克隆到本地 APFS/HFS+。有关完整的 Session G 验证矩阵，请参阅 [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)。

## 版本控制

All `@dogfood-lab/*` packages bump together — one number across the monorepo. Six packages publish to npm under `@dogfood-lab` at v1.11.0 in lockstep (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); the seventh, `@dogfood-lab/portfolio`, stays internal. The version line near the top of this README is auto-stamped from `package.json` via [`scripts/sync-version.mjs`](scripts/sync-version.mjs) on every `npm run build`.

## 许可证

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[手册](https://dogfood-lab.github.io/testing-os/handbook/)** · **[所有仓库](https://github.com/orgs/dogfood-lab/repositories)** · **[个人资料](https://github.com/dogfood-lab)**

*先吃饱，再开始工作。*

</div>
