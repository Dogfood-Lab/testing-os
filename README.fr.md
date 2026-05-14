<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.md">English</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<div align="center">

# ```french
testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**Système d'exploitation pour les tests à l'ère de l'IA**

*Protocoles, bases de données de preuves et boucles d'apprentissage pour les logiciels assistés par l'IA.*

<!-- version:start -->
**v0.2.0-pre** — 7 paquets (`@dogfood-lab/*`), suite de tests pour l'ensemble du projet, réception des données en direct, documentation en ligne déployée.
<!-- version:end -->

📖 **[Lire la documentation →](https://dogfood-lab.github.io/testing-os/)**

</div>

---

## Qu'est-ce que c'est ?

`testing-os` est le dépôt monorepo principal de l'organisation GitHub [Dogfood Lab](https://github.com/dogfood-lab) — successeur de l'ancien dépôt [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs). Il regroupe les protocoles et l'infrastructure nécessaires pour exécuter, enregistrer et apprendre des tests dans un flux de développement natif à l'IA :

- Un **protocole de "swarm"** pour exécuter des audits parallèles sur un code source.
- Une **base de données de preuves + structure de schéma** pour les enregistrements, les résultats, les modèles et les recommandations qui résultent de ces exécutions.
- Une couche de **politique + vérificateur** qui détermine ce qui compte comme "vérifié" et l'applique à tous les dépôts.
- Une couche d'**intelligence** qui transforme les résultats bruts en modèles et doctrines réutilisables.

## Statut

La migration depuis `mcp-tool-shop-org/dogfood-labs` est terminée (25 avril 2026). Le récepteur est en ligne : les flux de travail `dogfood.yml` dans les dépôts clients sont envoyés à ce dépôt, et le fichier `[.github/workflows/ingest.yml](.github/workflows/ingest.yml)` enregistre les enregistrements résultants et les index dans le dépôt `main`. La documentation en ligne est disponible à l'adresse [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). La version 1.0.0 sera publiée une fois que les améliorations post-migration décrites dans [HANDOFF.md](HANDOFF.md) seront terminées.

## Paquets

| Paquet | Source | Objectif |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Les 8 schémas JSON (enregistrement, résultat, modèle, recommandation, doctrine, politique, scénario, soumission). |
| `@dogfood-lab/verify` | JS | Validateur central des soumissions. Les soumissions passent par ici avant d'être enregistrées. |
| `@dogfood-lab/findings` | JS | Contrat de résultat + pipelines de dérivation, de révision, de synthèse et de conseil. |
| `@dogfood-lab/ingest` | JS | Connecteur de pipeline : envoi → vérification → enregistrement → indexation. |
| `@dogfood-lab/report` | JS | Outil de création de soumissions pour les dépôts sources. |
| `@dogfood-lab/portfolio` | JS | Générateur de portfolio multi-dépôts. |
| `@dogfood-lab/dogfood-swarm` | JS | Le protocole parallèle multi-agents en 10 phases + le plan de contrôle SQLite + l'outil `swarm`. |

Outils de test complémentaires qui **restent indépendants** mais s'intègrent via des API publiées : [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Structure

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

## Développement local

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Nécessite Node ≥ 20.

## Gestion des versions

Synchronisation de toutes les versions des paquets `@dogfood-lab/*`. Actuellement `0.1.0-pre`; la première version stable sera `1.0.0` une fois que les améliorations post-migration décrites dans [HANDOFF.md](HANDOFF.md) seront terminées. La ligne de version dans ce fichier README est automatiquement mise à jour à partir de `package.json` via `scripts/sync-version.mjs` (exécuté comme `prebuild`).

## Licence

[MIT](LICENSE) © 2026 mcp-tool-shop
```

---

<div align="center">

**[Manuel](https://dogfood-lab.github.io/testing-os/)** · **[Tous les dépôts](https://github.com/orgs/dogfood-lab/repositories)** · **[Profil](https://github.com/dogfood-lab)**

*Mangez d'abord. Expédiez ensuite.*

</div>
