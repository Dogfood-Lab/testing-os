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
[![dogfood](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/badges/dogfood-lab--testing-os--cli.json)](https://dogfood-lab.github.io/testing-os/handbook/read-model/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Système d’exploitation pour les tests à l’ère de l’IA**

*Protocoles, référentiels de preuves et boucles d’apprentissage pour les logiciels assistés par l’IA.*

<!-- version:start -->
**v1.10.0** — version actuelle. Consultez le fichier [CHANGELOG.md](CHANGELOG.md) pour connaître les nouveautés de cette version.
<!-- version:end -->

📖 **[Consultez le manuel →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## Présentation

`testing-os` enregistre, vérifie et apprend à partir des preuves de test réelles de votre dépôt dans le cadre d’un flux de travail natif pour l’IA. Indiquez un dépôt, et chaque exécution de test devient un enregistrement dont la provenance est confirmée et auquel vous pouvez faire confiance — et non une simple indication de réussite auto-déclarée.

Ce que vous obtenez :

- **Enregistrements dont la provenance est confirmée.** Chaque soumission est liée à une exécution CI réelle, sans clé, via l’identité du fournisseur avant d’être acceptée. Le résultat est un référentiel de preuves inviolable et en append-only, et non une simple case verte basée sur le principe de confiance.
- **Un contrat de politique que vous contrôlez.** Déclarez ce qui compte comme « vérifié » dans YAML — un DSL prédicat borné sans évaluation (`field`/`op`/`value` + `all`/`any`/`not`/`implies`) — et appliquez-le à tous vos dépôts. Validez une politique avant de la déployer avec `dogfood-verify lint`.
- **Un protocole d’essaim d’agents parallèles.** Exécutez des audits multi-agents sur une base de code, puis transformez les résultats bruts en modèles et doctrines réutilisables.
- **Une surface d’état en direct.** Enregistrements par dépôt, index et badge d’état, le tout servi à partir d’un seul référentiel de preuves.

Il s’agit du monorepo phare de l’organisation [Dogfood Lab](https://github.com/dogfood-lab) — sept packages `@dogfood-lab/*` regroupés dans une seule interface CLI `swarm`.

## Démarrage rapide

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

Vous souhaitez que les preuves de test de votre propre dépôt soient enregistrées ici ? Le **kit de démarrage [`examples/`](examples/)** vous permet de commencer en cinq minutes (`npx @dogfood-lab/report` génère le fichier à soumettre ; `dogfood-init` configure le flux de travail). Le guide d’utilisation, la référence de l’interface en ligne de commande, la référence du schéma et les exemples d’intégration sont disponibles dans le **[manuel](https://dogfood-lab.github.io/testing-os/handbook/)**. Les détails spécifiques à chaque version se trouvent dans [CHANGELOG.md](CHANGELOG.md).

## Modèle de menace

testing-os traite les soumissions Dogfood envoyées via `repository_dispatch` à partir de dépôts GitHub fiables sous `mcp-tool-shop-org/*` et `dogfood-lab/*`. Le vérificateur exige une provenance CI — les ID d’exécution revendiqués sont confirmés via l’API du fournisseur, et les soumissions présentant des formes incorrectes, des références manquantes ou des revendications de politique non valides sont rejetées.

**La provenance est la preuve.** Pour une soumission `github`, le vérificateur confirme que l’exécution de GitHub Actions revendiquée existe réellement (API GitHub) et associe le `repo` et le `commit_sha` de la soumission à cette exécution confirmée, ce qui constitue une vérification en direct sans clé, basée sur l’identité OIDC propre à GitHub. Ainsi, un enregistrement ne peut pas attester d’une exécution ou d’un commit qui n’a pas eu lieu. **GitLab CI** est pris en charge de manière optionnelle (`source.provider: gitlab`) ; une soumission GitLab est le seul cas où le vérificateur appelle un hôte autre que GitHub (`gitlab.com/api`), et uniquement pour les soumissions `gitlab`.

**L’intégrité des enregistrements est visible en cas de falsification, mais pas inviolable.** Chaque enregistrement persistant contient un bloc d’« intégrité » (`submission_digest` + `prev_digest`) qui forme une chaîne de hachage à laquelle on ne peut ajouter que des éléments. La commande `dogfood ingest --verify-chain` valide entièrement cette chaîne hors ligne, ce qui permet de détecter toute falsification ou corruption des données, ainsi que les restaurations partielles. Cela ne protège **pas** contre la compromission des informations d’identification utilisées pour l’ingestion, car elles peuvent réécrire à la fois un enregistrement et la chaîne ; pour éviter cela, il faut utiliser une ancre extérieure au contrôle de l’auteur. Une **ancre XRPL optionnelle, désactivée par défaut** (`dogfood ingest --anchor-*`), témoigne du début de la chaîne dans le registre public XRP, ce qui permet de détecter toute troncature ou réécriture en dessous d’un point ancré ; il s’agit de la deuxième requête non GitHub divulguée, et elle n’est effectuée que si un opérateur l’active.

**Éléments concernés par les tests :** le fichier JSON soumis dans chaque charge utile `repository_dispatch`; les répertoires `policies/`, `fixtures/`, `records/`, `indexes/` et `dogfood/roadmap/` de ce dépôt (le dernier étant uniquement modifié par un opérateur via la commande `swarm roadmap compile` — jamais par le processus d’ingestion automatisé) ; les appels sortants vers `api.github.com` pour la vérification de la provenance ; et — uniquement pour les soumissions à `github` — une récupération en lecture seule du fichier `dogfood/scenarios/<scenario_id>.yaml` du dépôt soumis, au niveau du commit attesté (la définition du scénario qui permet d’appliquer l’ensemble des étapes requises ; la taille est limitée et le schéma est validé avant utilisation, les fichiers manquants entraînent simplement une vérification non effectuée avec un avertissement visible).

**Ce que testing-os ne traite PAS :** le code source du consommateur au-delà des fichiers de définition `dogfood/scenarios/` déclarés, les secrets dans les dépôts des consommateurs au-delà de l’enveloppe de la soumission ou tout ce qui se trouve en dehors de l’arborescence de travail de ce dépôt.

**Les transitions d’état de détection fournissent des preuves et sont ajoutées en mode append-only.** Les verbes de fermeture du plan de contrôle du swarm (`swarm reopen`, `swarm close`) nécessitent une raison explicite, des preuves et — pour les fermetures par un opérateur — un mode de vérification déclaré ; chaque transition écrit une ligne immuable dans `finding_events` qui enregistre l’autorité responsable. Aucun processus automatisé ne peut fermer une détection en fonction de son ancienneté ou la rouvrir sur la base d’une prédiction, et aucun verbe ne peut réécrire l’historique des événements — un identifiant mal utilisé peut ajouter des transitions, mais chaque ajout est enregistré.

**Surface réseau.** Par défaut, la seule communication sortante est vers `api.github.com` (provenance en lecture seule). Les deux exceptions sont facultatives et ont été mentionnées ci-dessus : une soumission avec le fournisseur GitLab (`gitlab.com/api`) et une ancre XRPL activée par un opérateur. **Aucune télémétrie, aucune analyse — ce code ne communique jamais vers l’extérieur ; en l’absence de ces deux options, il n’expose aucune surface réseau au-delà de GitHub.** Le flux de travail du récepteur s’exécute avec les autorisations `contents: write`, limitées à ce dépôt.

## Packages

| Package | Source | Objectif |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Les 8 schémas JSON (enregistrement, résultat, modèle, recommandation, doctrine, politique, scénario, soumission). |
| `@dogfood-lab/verify` | JS | Validateur central des soumissions. Les soumissions passent par ici avant d’être stockées. |
| `@dogfood-lab/findings` | JS | Contrat de résultats + pipelines de dérivation/examen/synthèse/conseil. |
| `@dogfood-lab/ingest` | JS | Colle du pipeline : envoi -> vérification -> persistance -> indexation. |
| `@dogfood-lab/report` | JS | Générateur de soumissions pour les dépôts sources. |
| `@dogfood-lab/portfolio` | JS | Générateur de portefeuille inter-dépôts. |
| `@dogfood-lab/dogfood-swarm` | JS | Le protocole parallèle à 10 phases + plan de contrôle SQLite + `swarm` bin. |

Outils de test frères qui **restent indépendants** mais s’intègrent via des API publiées : [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Disposition

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

## Développement local

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # version-sync + doc-drift + regression-pin gates + build + tests (canonical pre-commit check — NOT the same as build && test)
```

Nécessite Node ≥ 22. La matrice CI exécute Node 22 + 24 sur `ubuntu-latest` ; validée localement sur Node 25.

**Systèmes de fichiers pris en charge :** APFS, HFS+, ext4 (base de référence CI), NTFS — tout système qui implémente POSIX `link(2)`. **Non pris en charge :** exFAT, FAT32. Le CAS de verrouillage de fichier dans [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) nécessite une sémantique de lien physique pour la publication atomique ; sur exFAT, `linkSync` génère une erreur `ENOTSUP` (bruyante, pas silencieuse). Piège courant : les SSD externes multiplateformes sont souvent formatés en exFAT — clonez le dépôt vers APFS/HFS+ local à la place. Consultez [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) pour obtenir la matrice de validation complète de la session G.

## Gestion des versions

Tous les paquets `@dogfood-lab/*` sont mis à jour simultanément — un seul numéro dans tout le monorepo. Six paquets sont publiés sur npm sous `@dogfood-lab` à la version v1.10.0, en synchronisation (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`) ; le septième, `@dogfood-lab/portfolio`, reste interne. La ligne de version située près du haut de ce fichier README est automatiquement ajoutée à partir de `package.json` via [`scripts/sync-version.mjs`](scripts/sync-version.mjs) à chaque exécution de `npm run build`.

## Licence

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuel](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tous les dépôts](https://github.com/orgs/dogfood-lab/repositories)** · **[Profil](https://github.com/dogfood-lab)**

*D’abord, testez. Ensuite, publiez.*

</div>
