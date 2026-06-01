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
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Système d’exploitation pour les tests à l’ère de l’IA**

*Protocoles, référentiels de preuves et boucles d’apprentissage pour les logiciels assistés par l’IA.*

<!-- version:start -->
**v1.3.0** — 7 paquets (`@dogfood-lab/*`), suite de tests à l’échelle de l’espace de travail, récepteur d’ingestion en ligne, manuel déployé.
<!-- version:end -->

📖 **[Consultez le manuel →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## Présentation

`testing-os` est le principal monorepos de l’organisation [Dogfood Lab](https://github.com/dogfood-lab) sur GitHub, successeur de [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs), qui a été archivé. Il regroupe les protocoles et l’infrastructure nécessaires à l’exécution, à l’enregistrement et à l’apprentissage à partir de tests dans un flux de développement natif de l’IA :

- Un **protocole en essaim** pour exécuter des audits multi-agents parallèles sur une base de code.
- Un **référentiel de preuves + structure de schéma** pour les enregistrements, les résultats, les modèles et les recommandations qui découlent de ces exécutions.
- Une **couche de politique + de vérificateur** qui détermine ce qui est considéré comme « vérifié » et l’applique dans tous les référentiels consommateurs.
- Une **couche d’intelligence** qui transforme les résultats bruts en modèles et en doctrines réutilisables.

## État

**v1.3.0** — un seul validateur de schéma canonique dans tous les consommateurs (une instance Ajv par schéma par processus ; une séparation à l’échelle de l’espace de travail est une condition sine qua non). Erreurs structurées de haut niveau avec des codes stables (`ISOLATION_FAILED`, `DUPLICATE_RUN_ID`, `STATE_MACHINE_*`, `DISPATCH_*`, `VALIDATOR_FAULT_*`, …) et un indice `Next:` sur chaque chemin d’échec. Le fichier YAML de politique est désormais validé par un schéma au moment du chargement : un fichier de politique structurellement invalide génère une erreur au lieu de passer silencieusement à des valeurs par défaut permissives. Le manuel est disponible à l’adresse [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) et propose une compatibilité de thème clair/sombre, une accessibilité WCAG-AA par page (pa11y dans CI avec nouvelle tentative), une référence CLI `swarm` par verbe et une page 404 personnalisée. Six paquets sont publiés sur npm sous `@dogfood-lab` en v1.3.0, en synchronisation ; voir le tableau ci-dessous. Aucune modification importante par rapport à la v1.2.x. Consultez [CHANGELOG.md](CHANGELOG.md) pour l’entrée complète de la v1.3.0.

Le récepteur est en ligne : les flux de travail `dogfood.yml` dans les référentiels consommateurs sont envoyés vers ce référentiel, et [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) valide les enregistrements et les index résultants et les renvoie vers `main`. Le manuel est déployé à l’adresse [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). Installation principale : `npm install -g @dogfood-lab/dogfood-swarm`. Le côté récepteur est géré via l’envoi ; consultez la page Intégration du manuel.

**Plateforme :** validée de bout en bout sur Darwin/APFS dans le cadre de la session G ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)). Consultez [Développement local](#local-development) pour connaître les systèmes de fichiers pris en charge. Détails par version dans [CHANGELOG.md](CHANGELOG.md).

## Modèle de menace

testing-os traite les soumissions Dogfood envoyées via `repository_dispatch` à partir de référentiels GitHub de confiance sous `mcp-tool-shop-org/*` et `dogfood-lab/*`. Le vérificateur exige une provenance de GitHub Actions : les ID d’exécution revendiqués sont confirmés via l’API GitHub, et les soumissions présentant des formes incorrectes, des références manquantes ou des revendications de politique non valides sont rejetées.

**Ce que testing-os touche :** le JSON de la soumission dans chaque charge utile `repository_dispatch` ; `policies/`, `fixtures/`, `records/` et `indexes/` dans ce référentiel ; appels sortants à `api.github.com` pour la vérification de la provenance.

**Ce que testing-os ne touche PAS :** le code source du consommateur, les secrets dans les référentiels des consommateurs au-delà de l’enveloppe d’envoi, ou quoi que ce soit en dehors de l’arborescence de travail de ce référentiel.

**Autorisations requises :** le flux de travail du récepteur s’exécute avec `contents: write` limité à ce référentiel uniquement. La vérification de la provenance utilise le `GITHUB_TOKEN` par défaut du flux de travail pour les appels d’API Actions en lecture seule. **Aucune télémétrie, aucun service tiers, aucune analyse : ce code ne communique pas avec l’extérieur et n’expose aucune surface réseau au-delà de GitHub.**

## Paquets

| Paquet | Source | Objectif |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Les 8 schémas JSON (enregistrement, résultat, modèle, recommandation, doctrine, politique, scénario, soumission). |
| `@dogfood-lab/verify` | JS | Validateur de soumission central. Les soumissions passent par ici avant d’être persistées. |
| `@dogfood-lab/findings` | JS | Contrat de résultat + pipelines de dérivation/examen/synthèse/conseil. |
| `@dogfood-lab/ingest` | JS | Colle de pipeline : envoi → vérification → persistance → indexation. |
| `@dogfood-lab/report` | JS | Générateur de soumissions pour les référentiels sources. |
| `@dogfood-lab/portfolio` | JS | Générateur de portefeuille inter-référentiels. |
| `@dogfood-lab/dogfood-swarm` | JS | Le protocole parallèle à 10 phases + plan de contrôle SQLite + `swarm` bin. |

Outils de test frères qui **restent indépendants** mais s’intègrent via des API publiées : [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Disposition

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

Nécessite Node ≥ 22. La matrice CI exécute Node 22 + 24 sur `ubuntu-latest`; validation locale effectuée sur Node 25.

**Systèmes de fichiers pris en charge :** APFS, HFS+, ext4 (configuration de base CI), NTFS — tout système qui implémente POSIX `link(2)`. **Non pris en charge :** exFAT, FAT32. Le CAS de verrouillage de fichiers dans [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) nécessite une sémantique de liens physiques pour une publication atomique ; sur exFAT, `linkSync` génère une erreur `ENOTSUP` (message d’erreur clair, pas silencieux). Piège courant : les SSD externes multiplateformes sont souvent formatés en exFAT — clonez plutôt le dépôt sur un système APFS/HFS+ local. Consultez [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) pour obtenir la matrice complète de validation de la session G.

## Gestion des versions

Mise à jour synchronisée de tous les paquets `@dogfood-lab/*` — ils sont mis à jour ensemble. La ligne de version dans ce fichier README est automatiquement générée à partir de `package.json` via `scripts/sync-version.mjs` (s’exécute en tant que `prebuild`). À partir de la version **v1.2.0**, six paquets sont publiés sur npm sous le nom de domaine `@dogfood-lab` : `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. Le septième (`@dogfood-lab/portfolio`) reste interne au monorepo.

## Licence

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuel](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tous les dépôts](https://github.com/orgs/dogfood-lab/repositories)** · **[Profil](https://github.com/dogfood-lab)**

*Mangez d’abord. Publiez ensuite.*

</div
