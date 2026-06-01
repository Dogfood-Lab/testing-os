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
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**AI時代におけるテスト用のオペレーティングシステム**

*AIによる支援を受けたソフトウェアのためのプロトコル、証拠ストア、および学習ループ。*

<!-- version:start -->
**v1.3.0** — 7つのパッケージ (`@dogfood-lab/*`)、ワークスペース全体のテストスイート、インジェストレシーバーが稼働、ハンドブックがデプロイ。
<!-- version:end -->

📖 **[ハンドブックを読む →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## 概要

`testing-os`は、[Dogfood Lab](https://github.com/dogfood-lab) GitHub組織の主要なモノリポジトリであり、現在はアーカイブされた[`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs)の後継です。AIネイティブな開発ワークフローで、テストを実行、記録、および学習するためのプロトコルとインフラストラクチャをまとめて提供します。

- コードベースに対して並列エージェント監査を実行するための**スワームプロトコル**。
- 上記の実行から得られる記録、結果、パターン、および推奨事項のための**証拠ストア + スキーマバックボーン**。
- 何が「検証済み」であるかを決定し、それをすべてのコンシューマーリポジトリに適用する**ポリシー + 検証者**レイヤー。
- 生のデータを再利用可能なパターンとドクトリンに変換する**インテリジェンスレイヤー**。

## ステータス

**v1.3.0** — すべてのコンシューマーで単一の標準スキーマ検証器（スキーマごとに1つのAjvインスタンス、プロセスごと）。安定したコード（`ISOLATION_FAILED`、`DUPLICATE_RUN_ID`、`STATE_MACHINE_*`、`DISPATCH_*`、`VALIDATOR_FAULT_*`、…）を持つ構造化された最上位レベルのエラーと、すべての失敗パスに「次へ」のヒント。ポリシーYAMLは、ロード時にスキーマによってゲートされ、構造的に無効なポリシーファイルは、サイレントに緩いデフォルトにフォールバックするのではなく、明確にエラーを発生させます。ハンドブックは[dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/)で公開されており、ライト/ダークテーマのパリティ、ページごとのWCAG-AAアクセシビリティ（CIでのpa11yによる再試行）、1つの`swarm` CLIリファレンス、およびカスタム404を備えています。6つのパッケージがv1.3.0でロックステップでnpmに公開され、`@dogfood-lab`の下に公開されます。v1.2.xからの破壊的な変更はありません。[CHANGELOG.md](CHANGELOG.md)を参照して、v1.3.0の完全なエントリを確認してください。

レシーバーが稼働しています。コンシューマーリポジトリの`dogfood.yml`ワークフローは、このリポジトリにディスパッチされ、[.github/workflows/ingest.yml](.github/workflows/ingest.yml)が結果のレコードとインデックスを`main`にコミットします。ハンドブックは[dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/)にデプロイされています。主要なインストール：`npm install -g @dogfood-lab/dogfood-swarm`。レシーバー側は、ディスパッチを介して消費されます。詳細は、ハンドブックの統合ページを参照してください。

**プラットフォーム:** Darwin/APFS上でエンドツーエンドで検証済み（Session Gの一部として、[`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)）。サポートされているファイルシステムについては、[ローカル開発](#local-development)を参照してください。バージョンごとの詳細は、[CHANGELOG.md](CHANGELOG.md)を参照してください。

## 脅威モデル

testing-osは、`mcp-tool-shop-org/*`および`dogfood-lab/*`の下にある信頼できるGitHubリポジトリから`repository_dispatch`を介してディスパッチされたdogfoodの送信を処理します。検証者はGitHub Actionsのプロビナンスを必要とします。主張された実行IDはGitHub APIを介して確認され、形状が不正、参照が欠落している、またはポリシーの主張が無効な送信は拒否されます。

**testing-osが扱うもの:** 各`repository_dispatch`ペイロード内の送信JSON、このリポジトリ内の`policies/`、`fixtures/`、`records/`、および`indexes/`、およびプロビナンス検証のための`api.github.com`へのアウトバウンド呼び出し。

**testing-osが扱わないもの:** コンシューマーのソースコード、コンシューマーリポジトリ内のディスパッチエンベロープを超えたシークレット、またはこのリポジトリのワーキングツリー外のすべてのもの。

**必要な権限:** レシーバーワークフローは、このリポジトリに限定された`contents: write`で実行されます。プロビナンス検証は、ワークフローのデフォルトの`GITHUB_TOKEN`を使用して、読み取り専用のActions API呼び出しを行います。**テレメトリ、サードパーティサービス、分析はありません。このコードベースは、ホームに電話をかけたり、GitHubを超えてネットワークインターフェイスを公開したりしません。**

## パッケージ

| パッケージ | ソース | 目的 |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | 8つのJSONスキーマ（レコード、結果、パターン、推奨事項、ドクトリン、ポリシー、シナリオ、送信）。 |
| `@dogfood-lab/verify` | JS | 中央の送信検証器。送信は、永続化される前にここを通過します。 |
| `@dogfood-lab/findings` | JS | 結果のコントラクト + 派生/レビュー/合成/アドバイスのパイプライン。 |
| `@dogfood-lab/ingest` | JS | パイプラインのグルー：ディスパッチ → 検証 → 永続化 → インデックス作成。 |
| `@dogfood-lab/report` | JS | ソースリポジトリ用の送信ビルダー。 |
| `@dogfood-lab/portfolio` | JS | クロスリポジトリポートフォリオジェネレーター。 |
| `@dogfood-lab/dogfood-swarm` | JS | 10段階の並列エージェントプロトコル + SQLiteコントロールプレーン + `swarm`バイナリ。 |

公開されたAPIを介して統合されるが、**独立性を維持する**兄弟のテストツール：[`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck)、[`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge)、[`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp)、[`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine)、[`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab)。

## レイアウト

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

## ローカル開発

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Node 22以上が必要です。CIマトリックスでは、`ubuntu-latest`上でNode 22と24を実行し、ローカル環境でNode 25で検証します。

**サポートされているファイルシステム:** APFS、HFS+、ext4（CIの基本設定）、NTFS — POSIX `link(2)`を実装しているもの。**サポート対象外:** exFAT、FAT32。[`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js)内のファイルロックCASは、アトミックな公開のためにハードリンクのセマンティクスを必要とします。exFATの場合、`linkSync`は`ENOTSUP`エラーを発生させます（エラーメッセージが表示されます）。注意点：クロスプラットフォームの外部SSDは、多くの場合exFATでフォーマットされています。代わりに、リポジトリをローカルのAPFS/HFS+にクローンしてください。完全なSession G検証マトリックスについては、[`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)を参照してください。

## バージョン管理

すべての`@dogfood-lab/*`パッケージで、バージョンが同期して更新されます。このREADMEのバージョン行は、`scripts/sync-version.mjs`（`prebuild`として実行）によって`package.json`から自動的に取得されます。**v1.2.0**では、6つのパッケージが`@dogfood-lab`スコープの下でnpmに公開されます：`schemas`、`verify`、`report`、`ingest`、`findings`、`dogfood-swarm`。7番目のパッケージ（`@dogfood-lab/portfolio`）は、モノリポジトリ内で内部的に使用されます。

## ライセンス

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[ハンドブック](https://dogfood-lab.github.io/testing-os/handbook/)** · **[すべてのリポジトリ](https://github.com/orgs/dogfood-lab/repositories)** · **[プロフィール](https://github.com/dogfood-lab)**

まずは食べて、次にリリースしましょう。

</div>
