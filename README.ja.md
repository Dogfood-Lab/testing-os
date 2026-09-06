<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**AI時代におけるテスト用のオペレーティングシステム**

*AIによる支援を受けたソフトウェアのためのプロトコル、証拠ストア、および学習ループ。*

<!-- version:start -->
**v1.12.0** — 現在のリリース。変更点は[CHANGELOG.md](CHANGELOG.md)を参照。
<!-- version:end -->

📖 **[ハンドブックを読む →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## これは何なのか

`testing-os`は、AIネイティブなワークフローで、リポジトリの実際のテスト証拠を記録、検証し、そこから学習します。リポジトリを指定すると、すべてのテスト実行は、信頼できるProvenance（出所）が確認されたレコードとなり、自己申告による合格ではなくなります。

得られるもの：

- **Provenance（出所）が確認されたレコード。**すべての提出物は、受け入れられる前に、実際のCI実行にバインドされます（プロバイダー自身のIDによる、キーレス）。その結果、改ざんが検知可能な、追記専用の証拠ストアとなり、単なる「合格」のチェックマークではありません。
- **制御可能なポリシー契約。**YAMLで「検証済み」と見なすものを宣言します。これは、境界が定められた、評価を含まない述語DSL（`field`/`op`/`value` + `all`/`any`/`not`/`implies`）であり、リポジトリ全体で強制することができます。`dogfood-verify lint`を使用して、リリース前にポリシーをLint（静的解析）します。
- **並列エージェントスウォームプロトコル。**コードベースに対してマルチエージェント監査を実行し、次に生の調査結果を再利用可能なパターンとドクトリンに変換します。
- **ライブステータスサーフェス。**リポジトリごとのレコード、インデックス、およびステータスバッジはすべて、1つの証拠ストアから提供されます。

これは、[Dogfood Lab](https://github.com/dogfood-lab)組織の主要なモノリポジトリであり、7つの`@dogfood-lab/*`パッケージが1つの`swarm`CLIにまとめられています。

## クイックスタート

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

独自のレポジトリのテスト証拠をここに記録したいですか？**[`examples/`スターターキット](examples/)**を使用すると、5分で開始できます（`dogfood-report`が提出物をビルドし、`dogfood-init`がワークフローを構築します）。オペレーターガイド、CLIリファレンス、スキーマリファレンス、および統合レシピは、**[ハンドブック](https://dogfood-lab.github.io/testing-os/handbook/)**にあります。バージョンごとの詳細は、[CHANGELOG.md](CHANGELOG.md)にあります。

## 脅威モデル

testing-osは、`mcp-tool-shop-org/*`および`dogfood-lab/*`の下にある信頼できるGitHubリポジトリから`repository_dispatch`を介して送信されたdogfood提出物を処理します。検証者は、CIのProvenance（出所）を必要とします。主張された実行IDは、プロバイダーのAPIを介して確認され、形式が正しくない、参照が欠落している、または無効なポリシーの主張を含む提出物は拒否されます。

**Provenance（出所）が認証です。**`github`提出物の場合、検証者は、主張されたGitHub Actions実行が実際に存在すること（GitHub API）を確認し、提出物の`repo`および`commit_sha`をその確認された実行にバインドします。これは、ライブでキーレスのチェックであり、GitHub自身のOIDC IDに根ざしているため、レコードは、実際には発生しなかった実行またはコミットを証明することはできません。**GitLab CI**は、オプションでサポートされています（`source.provider: gitlab`）。GitLab提出物は、検証者が非GitHubホストを呼び出す唯一のケースであり（`gitlab.com/api`）、それも`gitlab`提出物に対してのみです。

**レコードの整合性は、改ざん防止ではなく、改ざんが検知可能です。**永続化されたすべてのレコードには、`integrity`ブロック（`submission_digest` + `prev_digest`）が含まれており、これは追記専用のハッシュチェーンを形成し、`node packages/ingest/run.js --verify-chain`が完全にオフラインで検証します。これにより、外部からの改ざん、ディスクの破損、および部分的な復元を検出できます。ただし、これは、レコード自体とチェーンを書き換えることができるインジェスト認証を防御するものではありません。これを解決するには、書き込み者の制御外にあるアンカーが必要です。**オプションで、デフォルトでは無効になっているXRPLアンカー**（`node packages/ingest/run.js --anchor-*`）は、チェーンのヘッダーをパブリックXRP Ledgerに記録し、アンカーポイントより下の切り捨てまたは書き換えを検出できるようにします。これは、開示された2番目の非GitHub呼び出しであり、オペレーターが有効にした場合にのみ行われます。

**What testing-os touches:** the submission JSON in each `repository_dispatch` payload; `policies/`, `fixtures/`, `records/`, `indexes/`, and `dogfood/roadmap/` in this repo (the last written only by an operator-invoked `swarm roadmap compile` — never by the automated ingest path); outbound calls to `api.github.com` for provenance verification; and — for `github` submissions only — a read-only fetch of the submitting repo's `dogfood/scenarios/<scenario_id>.yaml` at the attested commit (the scenario definition that powers required-steps enforcement; size-capped and schema-validated before use, absent files simply leave that check unenforced with a visible warning).

**testing-osが扱わないもの：**宣言された`dogfood/scenarios/`定義ファイルを超えた消費者のソースコード、消費者のリポジトリ内の送信エンベロープを超えた秘密、またはこのリポジトリのワーキングツリー外のすべてのもの。

**調査状態の遷移は、証拠があり、追記専用です。**スウォーム制御プレーンのクロージャ動詞（`swarm reopen`、`swarm close`）には、明示的な理由と証拠が必要であり、オペレーターによるクロージャの場合には、宣言された検証モードも必要です。すべての遷移は、実行された権限を記録する不変の`finding_events`行を書き込みます。自動化されたパスで調査を終了したり、予測によって再開したりすることはできず、どの動詞もイベント履歴を書き換えることはできません。誤って使用された認証は、遷移を追加できますが、各追加は記録されます。

**ネットワークインターフェース。** デフォルトでは、唯一の送信先は`api.github.com`です（読み取り専用：プロベナンスの確認 + 上記のシナリオ定義の取得）。例外は2つあり、どちらもオプトイン方式で、上記に記載されています。GitLabプロバイダーによる送信（`gitlab.com/api`）、およびオペレーターが有効にしたXRPLアンカーの実行です。**テレメトリーや分析は行いません。このコードベースは外部に情報を送信しません。上記の2つのオプトインパスがない場合、GitHubを超えてネットワークインターフェースを公開することはありません。** 受信ワークフローは、このリポジトリのみにスコープされた`contents: write`で実行されます。

## パッケージ

| パッケージ | ソース | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8つのJSONスキーマ（レコード、検出結果、パターン、推奨事項、ドクトリン、ポリシー、シナリオ、送信）。 |
| `@dogfood-lab/verify` | JS | 中央の送信バリデーター。送信は、永続化される前にここを通過します。 |
| `@dogfood-lab/findings` | JS | 検出結果のコントラクト + 派生/レビュー/合成/アドバイスのパイプライン。 |
| `@dogfood-lab/ingest` | JS | パイプラインの連携：ディスパッチ → 検証 → 永続化 → インデックス作成。 |
| `@dogfood-lab/report` | JS | ソースリポジトリ用の送信ビルダー。 |
| `@dogfood-lab/portfolio` | JS | クロスリポジトリのポートフォリオジェネレーター。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10段階の並列エージェントプロトコル + SQLiteコントロールプレーン + `swarm`バイナリ。 |

**独立性を維持しつつ、公開APIを通じて統合する**関連するテストツール：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck)、[`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge)、[`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp)、[`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine)、[`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

## レイアウト

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

## ローカル開発

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # version-sync + doc-drift + regression-pin gates + build + tests (canonical pre-commit check — NOT the same as build && test)
```

Node ≥ 22が必要です。CIマトリックスは、`ubuntu-latest`でNode 22 + 24を実行します。ローカルではNode 25で検証されます。

**サポートされているファイルシステム：** APFS、HFS+、ext4（CIのベースライン）、NTFS — POSIX `link(2)`を実装しているもの。**サポート対象外：** exFAT、FAT32。[`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js)のファイルロックCASは、アトミックな公開のためにハードリンクのセマンティクスを必要とします。exFATの場合、`linkSync`は`ENOTSUP`をスローします（大きなエラー、静かに処理されません）。一般的な注意点：クロスプラットフォームの外部SSDは、多くの場合exFATでフォーマットされています。リポジトリをローカルのAPFS/HFS+にクローンしてください。完全なSession G検証マトリックスについては、[`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)を参照してください。

## バージョン管理

すべての`@dogfood-lab/*`パッケージがまとめてバージョンアップされ、モノリポジトリ全体でバージョン番号が統一されます。6つのパッケージが、v1.12.0として、`@dogfood-lab`の下でnpmにまとめて公開されます（`schemas`、`verify`、`report`、`ingest`、`findings`、`dogfood-swarm`）。7番目のパッケージ、`@dogfood-lab/portfolio`は、内部利用のままです。このREADMEファイルの冒頭付近にあるバージョン情報は、すべての`npm run build`で、`package.json`から[`scripts/sync-version.mjs`](scripts/sync-version.mjs)を通じて自動的に更新されます。

## ライセンス

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[ハンドブック](https://dogfood-lab.github.io/testing-os/handbook/)** · **[すべてのリポジトリ](https://github.com/orgs/dogfood-lab/repositories)** · **[プロフィール](https://github.com/dogfood-lab)**

*まず食べて、次にリリースする。*

</div
