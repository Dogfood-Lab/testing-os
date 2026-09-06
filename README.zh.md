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

*用于人工智能辅助软件的协议、证据存储和学习循环。*

<!-- version:start -->
**v1.12.0** — 当前版本。有关已发布内容，请参阅 [CHANGELOG.md](CHANGELOG.md)。
<!-- version:end -->

📖 **[阅读手册 →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## 这是什么

`testing-os` 记录、验证并从您仓库中的实际测试证据中学习，采用人工智能原生工作流程。将其指向一个仓库，每次测试运行都将成为一个可信的、具有来源证明的记录——而不是自我报告的通过状态。

您将获得：

- **具有来源证明的记录。** 每个提交都与真实的 CI 运行相关联——通过提供商自己的身份进行无密钥绑定——然后才被接受。结果是一个防篡改的、仅追加的证据存储，而不是一个基于诚信原则的绿色复选标记。
- **您可以控制的策略契约。** 在 YAML 中声明什么被认为是“已验证”——一个有界、无评估谓词 DSL（`field`/`op`/`value` + `all`/`any`/`not`/`implies`）——并在您的仓库中强制执行。在发布之前使用 `dogfood-verify lint` 检查策略。
- **一个并行代理群协议。** 针对代码库运行多代理审计，然后将原始结果转换为可重用的模式和原则。
- **一个实时状态界面。** 每个仓库的记录、索引和一个状态徽章，所有这些都来自一个证据存储。

它是 [Dogfood Lab](https://github.com/dogfood-lab) 组织的旗舰单仓库项目——七个 `@dogfood-lab/*` 包，通过一个 `swarm` CLI 进行集成。

## 快速入门

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

想要将您自己的仓库的测试证据记录到这里吗？**[`examples/` 启动工具包](examples/)** 可以在五分钟内完成设置（`dogfood-report` 构建提交；`dogfood-init` 搭建工作流程）。操作指南、CLI 参考、模式参考和集成示例都位于 **[手册](https://dogfood-lab.github.io/testing-os/handbook/)** 中。每个版本的详细信息都位于 [CHANGELOG.md](CHANGELOG.md) 中。

## 威胁模型

testing-os 处理通过 `repository_dispatch` 从受信任的 GitHub 仓库（位于 `mcp-tool-shop-org/*` 和 `dogfood-lab/*` 下）发送的 dogfood 提交。验证器需要 CI 来源——声明的运行 ID 通过提供商的 API 进行确认，并且具有格式错误的、缺少引用或无效策略声明的提交将被拒绝。

**来源是证明。** 对于 `github` 提交，验证器会确认声明的 GitHub Actions 运行确实存在（GitHub API），并将提交的 `repo` 和 `commit_sha` 绑定到该已确认的运行——这是一个实时的、无密钥的检查，其根源在于 GitHub 自己的 OIDC 身份，因此记录不能证明不存在的运行或提交。**GitLab CI** 默认支持（`source.provider: gitlab`）；GitLab 提交是验证器调用非 GitHub 主机的唯一情况（`gitlab.com/api`），并且仅适用于 `gitlab` 提交。

**记录完整性是防篡改的，但不是完全防篡改的。** 每个持久化的记录都包含一个 `integrity` 块（`submission_digest` + `prev_digest`），形成一个仅追加的哈希链，该链由 `node packages/ingest/run.js --verify-chain` 完全离线验证——检测外部篡改、磁盘损坏和部分恢复。它**不**防御针对摄取凭据本身的攻击，该凭据可以重写记录和链；要解决这个问题，需要一个超出写入者控制范围的锚点。一个**可选的、默认关闭的 XRPL 锚点**（`node packages/ingest/run.js --anchor-*`）将链头记录到公共 XRP Ledger，从而可以检测任何低于已锚定点的截断或重写——这是第二个公开的非 GitHub 调用，并且仅当操作员启用它时才会发生。

**testing-os 触及的内容：**每个 `repository_dispatch` 有效负载中的提交 JSON；此仓库中的 `policies/`、`fixtures/`、`records/`、`indexes/` 和 `dogfood/roadmap/`（最后由操作员调用的 `swarm roadmap compile` 写入，而不是由自动摄取路径写入）；对 `api.github.com` 进行的外部调用，以进行来源验证；以及——仅针对 `github` 提交——对提交仓库的 `dogfood/scenarios/<scenario_id>.yaml` 的只读获取，该仓库位于已证明的提交处（场景定义，用于强制执行所需的步骤；大小受限且在之前进行模式验证，缺少的 文件只会导致该检查未强制执行，并显示可见的警告）。

**testing-os 不触及的内容：**超出声明的 `dogfood/scenarios/` 定义文件的消费者源代码、消费者仓库中的秘密（超出分发信封），或此仓库工作树之外的任何内容。

**查找状态转换具有证据，并且仅追加。** 蜂群控制平面的闭合动词（`swarm reopen`、`swarm close`）需要明确的原因、证据，并且——对于操作员闭合——需要声明的验证模式；每次转换都会写入一个不可变的 `finding_events` 行，记录执行权限。没有自动路径可以因停滞而关闭一个查找，也没有自动路径可以通过预测重新打开一个查找，并且没有动词可以重写事件历史——一个使用不当的凭据可以添加转换，但每次添加本身都会被记录。

**网络接口。** 默认情况下，唯一的出站连接是 `api.github.com`（只读：来源确认 + 上述场景定义获取）。 两个例外都是可选的，并且已在上面说明：一个 GitLab 提供商提交（`gitlab.com/api`），以及一个由操作员启用的 XRPL 锚点运行。 **没有遥测数据，没有分析数据——此代码库绝不会向外部发送数据；如果没有这两个可选路径，它就不会暴露任何超出 GitHub 之外的网络接口。** 接收器工作流使用 `contents: write`，并且仅限于此仓库。

## 软件包

| 软件包 | 源代码 | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8 个 JSON 模式（记录、发现、模式、建议、原则、策略、场景、提交）。 |
| `@dogfood-lab/verify` | JS | 中央提交验证器。提交内容在持久化之前会经过此验证。 |
| `@dogfood-lab/findings` | JS | 发现契约 + 推导/审查/综合/建议流水线。 |
| `@dogfood-lab/ingest` | JS | 流水线粘合剂：分发 → 验证 → 持久化 → 索引。 |
| `@dogfood-lab/report` | JS | 用于源代码仓库的提交构建器。 |
| `@dogfood-lab/portfolio` | JS | 跨仓库的组合生成器。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10 阶段的并行代理协议 + SQLite 控制平面 + `swarm` 二进制文件。 |

**保持独立的**但通过已发布的 API 集成的辅助测试工具：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck)，[`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge)，[`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp)，[`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine)，[`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

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

需要 Node ≥ 22。CI 矩阵在 `ubuntu-latest` 上运行 Node 22 + 24；本地验证在 Node 25 上进行。

**支持的文件系统：**APFS、HFS+、ext4（CI 基准）、NTFS——任何实现 POSIX `link(2)` 的文件系统。**不支持：**exFAT、FAT32。 [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) 中的文件锁定 CAS 需要硬链接语义来实现原子发布；在 exFAT 上，`linkSync` 会抛出 `ENOTSUP`（发出警告，而不是静默）。 常见问题：跨平台的外部 SSD 通常格式化为 exFAT——请将仓库克隆到本地 APFS/HFS+。 请参阅 [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)，了解完整的 Session G 验证矩阵。

## 版本控制

All `@dogfood-lab/*` packages bump together — one number across the monorepo. Six packages publish to npm under `@dogfood-lab` at v1.12.0 in lockstep (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); the seventh, `@dogfood-lab/portfolio`, stays internal. The version line near the top of this README is auto-stamped from `package.json` via [`scripts/sync-version.mjs`](scripts/sync-version.mjs) on every `npm run build`.

## 许可证

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[手册](https://dogfood-lab.github.io/testing-os/handbook/)** · **[所有仓库](https://github.com/orgs/dogfood-lab/repositories)** · **[个人资料](https://github.com/dogfood-lab)**

*先吃，再发布。*

</div
