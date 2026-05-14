<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.md">English</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**Système d'exploitation pour les tests à l'ère de l'IA**

*Protocoles, bases de données de preuves et boucles d'apprentissage pour les logiciels assistés par l'IA.*

<!-- version:start -->
**v1.2.0** — 7 paquets (`@dogfood-lab/*`), suite de tests pour l'ensemble du projet, réception des données en direct, documentation en ligne déployée.
<!-- version:end -->

📖 **[Consulter la documentation →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## Ce qu'est ce projet

`testing-os` est le projet principal (monorepo) de l'organisation GitHub [Dogfood Lab](https://github.com/dogfood-lab) — successeur de l'organisation archivée [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs). Il regroupe les protocoles et l'infrastructure nécessaires pour exécuter, enregistrer et tirer des leçons des tests dans un flux de développement natif à l'IA :

- Un **protocole de "swarm"** pour exécuter des audits parallèles sur un code source.
- Une **base de données de preuves + structure de schéma** pour les enregistrements, les résultats, les modèles et les recommandations qui résultent de ces exécutions.
- Une couche de **politique + vérificateur** qui détermine ce qui compte comme "vérifié" et l'applique à tous les dépôts consommateurs.
- Une couche d'**intelligence** qui transforme les résultats bruts en modèles et doctrines réutilisables.

## Statut

**v1.2.0** — Première publication npm du monorepo `@dogfood-lab/*`. Six paquets sont désormais publics sous le scope `@dogfood-lab` : `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm` (l'outil CLI principal "swarm"). Nouvelles fonctionnalités de cette version : machine d'état au niveau des "waves" + contrat de récupération "Three R's" (`swarm revalidate`, `swarm rewind`, `swarm redrive`) + verbe `swarm history` pour l'historique des audits + passage de santé de niveau A à D à 0 CRIT / 0 HIGH. **1105/1105 tests.** Total cumulé sur la durée de vie du projet (depuis la version v1.0.0, date de coupe 2026-04-25) : tout ce qui précède, plus la phase 7 du "dogfood swarm" (~31 "waves", ~115 corrections vérifiées, 14 classes de couverture d'audit). Catalogue "swarm" de référence : [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md).

Le récepteur est en ligne : les flux de travail `dogfood.yml` dans les dépôts consommateurs sont envoyés à ce dépôt, et le fichier [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) enregistre les enregistrements résultants et les indexe dans `main`. La documentation est disponible à l'adresse [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). Installation principale : `npm install -g @dogfood-lab/dogfood-swarm`. Le côté récepteur est consommé via l'envoi — voir la page d'intégration de la documentation.

**Plateforme :** Validé de bout en bout sur Darwin/APFS dans le cadre de la session G ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)). Consultez [Développement local](#local-development) pour connaître les systèmes de fichiers pris en charge. Détails par version dans [CHANGELOG.md](CHANGELOG.md).

## Modèle de menace

`testing-os` traite les soumissions "dogfood" envoyées via `repository_dispatch` depuis des dépôts GitHub de confiance sous `mcp-tool-shop-org/*` et `dogfood-lab/*`. Le vérificateur nécessite une provenance GitHub Actions — les identifiants de run déclarés sont confirmés via l'API GitHub, et les soumissions avec des structures incorrectes, des références manquantes ou des revendications de politique non valides sont rejetées.

**Ce que `testing-os` touche :** le JSON de la soumission dans chaque charge utile `repository_dispatch` ; `policies/`, `fixtures/`, `records/` et `indexes/` dans ce dépôt ; appels sortants à `api.github.com` pour la vérification de la provenance.

**Ce que testing-os ne touche PAS :** le code source des applications grand public, les informations sensibles stockées dans les dépôts des applications grand public en dehors de l'enveloppe de distribution, ou tout ce qui se trouve en dehors de l'arborescence de travail de ce dépôt.

**Autorisations requises :** le flux de travail du récepteur s'exécute avec les autorisations `contents: write` limitées à ce dépôt uniquement. La vérification de l'origine utilise le `GITHUB_TOKEN` par défaut du flux de travail pour les appels d'API Actions en lecture seule. **Aucune télémétrie, aucun service tiers, aucune analyse : ce code ne communique pas d'informations et n'expose aucune surface réseau en dehors de GitHub.**

## Paquets

| Paquet | Source | Objectif |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Les 8 schémas JSON (enregistrement, découverte, modèle, recommandation, doctrine, politique, scénario, soumission). |
| `@dogfood-lab/verify` | JS | Validateur central des soumissions. Les soumissions passent par ici avant d'être persistées. |
| `@dogfood-lab/findings` | JS | Contrat de découverte + pipelines de dérivation/examen/synthèse/conseil. |
| `@dogfood-lab/ingest` | JS | Connecteur de pipeline : distribution → vérification → persistance → indexation. |
| `@dogfood-lab/report` | JS | Générateur de soumissions pour les dépôts sources. |
| `@dogfood-lab/portfolio` | JS | Générateur de portfolio multi-dépôts. |
| `@dogfood-lab/dogfood-swarm` | JS | Protocole parallèle à 10 phases + plan de contrôle SQLite + binaire `swarm`. |

Outils de test complémentaires qui **restent indépendants** mais s'intègrent via des API publiées : [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Structure

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

## Développement local

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Nécessite Node ≥ 20. La matrice CI exécute Node 20 + 22 sur `ubuntu-latest`; validé localement sur Node 25.

**Systèmes de fichiers pris en charge :** APFS, HFS+, ext4 (base de la CI), NTFS — tout ce qui implémente `link(2)` POSIX. **Non pris en charge :** exFAT, FAT32. Le verrouillage de fichier CAS dans [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) nécessite une sémantique de lien dur pour une publication atomique ; sur exFAT, `linkSync` génère une erreur `ENOTSUP` (de manière explicite, et non silencieuse). Piège courant : les SSD externes multiplateformes sont souvent formatés en exFAT ; clonez le dépôt vers un APFS/HFS+ local au lieu de cela. Consultez [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) pour la matrice complète de validation de la session G.

## Gestion des versions

Synchronisation de toutes les versions des paquets `@dogfood-lab/*` — ils sont mis à jour ensemble. La ligne de version dans ce fichier README est automatiquement générée à partir de `package.json` via `scripts/sync-version.mjs` (exécutée comme `prebuild`). À partir de la version **v1.2.0**, six paquets publient sur npm sous le scope `@dogfood-lab` : `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. Le septième (`@dogfood-lab/portfolio`) reste interne au monorepo.

## Licence

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuel](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tous les dépôts](https://github.com/orgs/dogfood-lab/repositories)** · **[Profil](https://github.com/dogfood-lab)**

*Mangez d'abord. Expédiez ensuite.*

</div
