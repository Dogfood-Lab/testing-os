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
**v1.5.0** — version actuelle. Consultez le fichier [CHANGELOG.md](CHANGELOG.md) pour connaître les nouveautés.
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

## Guide de démarrage rapide

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

Vous souhaitez que les preuves de test de votre propre dépôt soient enregistrées ici ? Le **kit de démarrage [`examples/`](examples/)** vous permet de commencer en cinq minutes (`npx @dogfood-lab/report` génère le fichier à soumettre ; `dogfood-init` configure le flux de travail). Le guide d’utilisation, la référence de l’interface en ligne de commande, la référence du schéma et les exemples d’intégration sont disponibles dans le **[manuel](https://dogfood-lab.github.io/testing-os/handbook/)**. Les détails spécifiques à chaque version se trouvent dans [CHANGELOG.md](CHANGELOG.md).

## Modèle de menace

testing-os traite les soumissions Dogfood envoyées via `repository_dispatch` à partir de référentiels GitHub de confiance sous `mcp-tool-shop-org/*` et `dogfood-lab/*`. Le vérificateur exige une provenance de GitHub Actions : les ID d’exécution revendiqués sont confirmés via l’API GitHub, et les soumissions présentant des formes incorrectes, des références manquantes ou des revendications de politique non valides sont rejetées.

**La provenance est la preuve.** Pour une soumission `github`, le vérificateur confirme que l’exécution de GitHub Actions revendiquée existe réellement (API GitHub) et associe le `repo` et le `commit_sha` de la soumission à cette exécution confirmée, ce qui constitue une vérification en direct sans clé, basée sur l’identité OIDC propre à GitHub. Ainsi, un enregistrement ne peut pas attester d’une exécution ou d’un commit qui n’a pas eu lieu. **GitLab CI** est pris en charge de manière optionnelle (`source.provider: gitlab`) ; une soumission GitLab est le seul cas où le vérificateur appelle un hôte autre que GitHub (`gitlab.com/api`), et uniquement pour les soumissions `gitlab`.

**L’intégrité des enregistrements est visible en cas de falsification, mais pas inviolable.** Chaque enregistrement persistant contient un bloc d’« intégrité » (`submission_digest` + `prev_digest`) qui forme une chaîne de hachage à laquelle on ne peut ajouter que des éléments. La commande `dogfood ingest --verify-chain` valide entièrement cette chaîne hors ligne, ce qui permet de détecter toute falsification ou corruption des données, ainsi que les restaurations partielles. Cela ne protège **pas** contre la compromission des informations d’identification utilisées pour l’ingestion, car elles peuvent réécrire à la fois un enregistrement et la chaîne ; pour éviter cela, il faut utiliser une ancre extérieure au contrôle de l’auteur. Une **ancre XRPL optionnelle, désactivée par défaut** (`dogfood ingest --anchor-*`), témoigne du début de la chaîne dans le registre public XRP, ce qui permet de détecter toute troncature ou réécriture en dessous d’un point ancré ; il s’agit de la deuxième requête non GitHub divulguée, et elle n’est effectuée que si un opérateur l’active.

**Ce que testing-os touche :** le JSON de la soumission dans chaque charge utile `repository_dispatch` ; `policies/`, `fixtures/`, `records/` et `indexes/` dans ce référentiel ; appels sortants à `api.github.com` pour la vérification de la provenance.

**Ce que testing-os ne touche PAS :** le code source du consommateur, les secrets dans les référentiels des consommateurs au-delà de l’enveloppe d’envoi, ou quoi que ce soit en dehors de l’arborescence de travail de ce référentiel.

**Surface réseau.** Par défaut, la seule communication sortante est vers `api.github.com` (provenance en lecture seule). Les deux exceptions sont facultatives et ont été mentionnées ci-dessus : une soumission avec le fournisseur GitLab (`gitlab.com/api`) et une ancre XRPL activée par un opérateur. **Aucune télémétrie, aucune analyse — ce code ne communique jamais vers l’extérieur ; en l’absence de ces deux options, il n’expose aucune surface réseau au-delà de GitHub.** Le flux de travail du récepteur s’exécute avec les autorisations `contents: write`, limitées à ce dépôt.

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
├── examples/                  # Copy-paste consumer starter kit (dogfood.yml + scenario + policy)
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml, release.yml
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

Tous les packages `@dogfood-lab/*` sont mis à jour ensemble, avec un seul numéro pour l’ensemble du monorepo. Six packages sont publiés sur npm sous `@dogfood-lab` en version v1.5.0 de manière synchronisée (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`) ; le septième, `@dogfood-lab/portfolio`, reste interne. La ligne de version située près du haut de ce fichier README est automatiquement ajoutée à partir de `package.json` via [`scripts/sync-version.mjs`](scripts/sync-version.mjs) à chaque exécution de `npm run build`.

## Licence

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuel](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tous les dépôts](https://github.com/orgs/dogfood-lab/repositories)** · **[Profil](https://github.com/dogfood-lab)**

*Mangez d’abord. Publiez ensuite.*

</div
