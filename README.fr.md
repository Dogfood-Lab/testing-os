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
**v1.12.0** — version actuelle. Consultez [CHANGELOG.md](CHANGELOG.md) pour connaître les nouveautés.
<!-- version:end -->

📖 **[Lisez le manuel →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## Ce que c’est

`testing-os` enregistre, vérifie et apprend à partir des preuves de test réelles de votre dépôt dans un flux de travail natif de l’IA. Indiquez-lui un dépôt, et chaque exécution de test devient un enregistrement dont la provenance est confirmée et auquel vous pouvez faire confiance, et non un simple résultat déclaré.

Ce que vous obtenez :

- **Enregistrements dont la provenance est confirmée.** Chaque soumission est liée à une exécution CI réelle, sans clé, via l’identité propre du fournisseur, avant d’être acceptée. Le résultat est un référentiel de preuves inviolable et en append-only, et non une simple case à cocher basée sur l’honneur.
- **Un contrat de politique que vous contrôlez.** Déclarez ce qui est considéré comme « vérifié » en YAML — un DSL prédicatif limité et sans évaluation (`field`/`op`/`value` + `all`/`any`/`not`/`implies`) — et appliquez-le à tous vos dépôts. Validez une politique avant de la déployer avec `dogfood-verify lint`.
- **Un protocole de groupe d’agents parallèles.** Exécutez des audits multi-agents sur une base de code, puis transformez les résultats bruts en modèles et doctrines réutilisables.
- **Une surface d’état en direct.** Enregistrements par dépôt, index et badge d’état, le tout servi à partir d’un seul référentiel de preuves.

Il s’agit du monorepo phare de l’organisation [Dogfood Lab](https://github.com/dogfood-lab) — sept paquets `@dogfood-lab/*` derrière une seule interface de ligne de commande `swarm`.

## Démarrage rapide

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

Vous souhaitez que les preuves de test de votre propre dépôt soient enregistrées ici ? Le **[kit de démarrage `examples/`](examples/)** vous permet de commencer en cinq minutes (`dogfood-report` crée la soumission ; `dogfood-init` crée le flux de travail). Le guide de l’opérateur, la référence de l’interface de ligne de commande, la référence du schéma et les recettes d’intégration sont disponibles dans le **[manuel](https://dogfood-lab.github.io/testing-os/handbook/)**. Les détails par version sont disponibles dans [CHANGELOG.md](CHANGELOG.md).

## Modèle de menace

testing-os traite les soumissions Dogfood envoyées via `repository_dispatch` à partir de dépôts GitHub de confiance sous `mcp-tool-shop-org/*` et `dogfood-lab/*`. Le vérificateur exige une provenance CI — les ID d’exécution revendiqués sont confirmés via l’API du fournisseur, et les soumissions ayant des formes incorrectes, des références manquantes ou des revendications de politique non valides sont rejetées.

**La provenance est l’attestation.** Pour une soumission `github`, le vérificateur confirme que l’exécution GitHub Actions revendiquée existe réellement (API GitHub) et lie les `repo` et `commit_sha` de la soumission à cette exécution confirmée — une vérification en direct et sans clé, basée sur l’identité OIDC propre à GitHub, de sorte qu’un enregistrement ne peut pas attester d’une exécution ou d’un commit qui ne s’est pas produit. **GitLab CI** est pris en charge en option (`source.provider: gitlab`) ; une soumission GitLab est le seul cas où le vérificateur appelle un hôte non GitHub (`gitlab.com/api`), et uniquement pour les soumissions `gitlab`.

**L’intégrité des enregistrements est inviolable, mais pas à 100 %.** Chaque enregistrement persistant contient un bloc `integrity` (`submission_digest` + `prev_digest`) formant une chaîne de hachage en append-only que `node packages/ingest/run.js --verify-chain` valide entièrement hors ligne — détectant les altérations, la corruption du disque et les restaurations partielles. Il ne se protège **pas** contre les informations d’identification d’ingestion elles-mêmes, qui peuvent réécrire à la fois un enregistrement et la chaîne ; pour y remédier, il faut un ancrage extérieur au contrôle de l’auteur. Un **ancrage XRPL facultatif, désactivé par défaut** (`node packages/ingest/run.js --anchor-*`) témoigne du point de départ de la chaîne sur le XRP Ledger public, ce qui permet de détecter toute troncature ou réécriture en dessous du point ancré — la deuxième requête divulguée à un hôte non GitHub, et uniquement lorsque l’opérateur l’active.

**Ce que testing-os touche :** le JSON de la soumission dans chaque charge utile `repository_dispatch` ; `policies/`, `fixtures/`, `records/`, `indexes/` et `dogfood/roadmap/` dans ce dépôt (le dernier étant écrit uniquement par une opération invoquée par l’opérateur `swarm roadmap compile` — jamais par le chemin d’ingestion automatisé) ; les appels sortants à `api.github.com` pour la vérification de la provenance ; et — uniquement pour les soumissions `github` — une récupération en lecture seule du `dogfood/scenarios/<scenario_id>.yaml` du dépôt soumettant au commit attesté (la définition du scénario qui alimente l’application des étapes requises ; la taille est limitée et le schéma est validé avant l’utilisation, les fichiers manquants laissent simplement cette vérification non appliquée avec un avertissement visible).

**Ce que testing-os ne touche pas :** le code source du consommateur au-delà des fichiers de définition `dogfood/scenarios/` déclarés, les secrets dans les dépôts des consommateurs au-delà de l’enveloppe de soumission, ou quoi que ce soit en dehors de l’arborescence de travail de ce dépôt.

**Les transitions d’état des résultats sont basées sur des preuves et sont en append-only.** Les verbes de fermeture du plan de contrôle du groupe d’agents (`swarm reopen`, `swarm close`) nécessitent une raison et des preuves explicites, et — pour les fermetures de l’opérateur — un mode de vérification déclaré ; chaque transition écrit une ligne `finding_events` immuable enregistrant l’autorité qui agit. Aucun chemin automatisé ne peut fermer un résultat en raison de son ancienneté ou en rouvrir un par prédiction, et aucun verbe ne peut réécrire l’historique des événements — une information d’identification mal utilisée peut ajouter des transitions, mais chaque ajout est enregistré.

**Interface réseau.** Par défaut, la seule sortie est `api.github.com` (en lecture seule : confirmation de la provenance + récupération de la définition du scénario mentionnée ci-dessus). Les deux exceptions sont toutes deux facultatives et sont décrites ci-dessus : une soumission du fournisseur GitLab (`gitlab.com/api`) et une exécution d’ancrage XRPL activée par l’opérateur. **Aucune télémétrie, aucune analyse : ce code ne communique jamais avec un serveur externe ; en l’absence de ces deux options, il n’expose aucune interface réseau au-delà de GitHub.** Le flux de travail du récepteur s’exécute avec `contents: write`, limité à ce dépôt uniquement.

## Paquets

| Paquet | Source | Objectif |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Les 8 schémas JSON (enregistrement, découverte, modèle, recommandation, doctrine, politique, scénario, soumission). |
| `@dogfood-lab/verify` | JS | Validateur central des soumissions. Les soumissions passent par ici avant d’être enregistrées. |
| `@dogfood-lab/findings` | JS | Contrat de découverte + pipelines de dérivation/examen/synthèse/conseil. |
| `@dogfood-lab/ingest` | JS | Colle des pipelines : envoi → vérification → enregistrement → indexation. |
| `@dogfood-lab/report` | JS | Générateur de soumissions pour les dépôts sources. |
| `@dogfood-lab/portfolio` | JS | Générateur de portefeuille multi-dépôts. |
| `@dogfood-lab/dogfood-swarm` | JS | Le protocole d’agent parallèle en 10 phases + plan de contrôle SQLite + `swarm`. |

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

Nécessite Node ≥ 22. La matrice CI exécute Node 22 + 24 sur `ubuntu-latest` ; validée localement sur Node 25.

**Systèmes de fichiers pris en charge :** APFS, HFS+, ext4 (base de référence CI), NTFS — tout système qui implémente POSIX `link(2)`. **Non pris en charge :** exFAT, FAT32. Le CAS de verrouillage de fichiers dans [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) nécessite une sémantique de lien physique pour une publication atomique ; sur exFAT, `linkSync` génère `ENOTSUP` (bruyant, pas silencieux). Piège courant : les SSD externes multiplateformes sont souvent formatés en exFAT — clonez le dépôt sur APFS/HFS+ local à la place. Voir [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) pour la matrice de validation complète de la session G.

## Gestion des versions

Tous les `@dogfood-lab/*` paquets sont mis à jour ensemble : un seul numéro dans tout le monorepo. Six paquets sont publiés sur npm sous `@dogfood-lab` à la version 1.12.0 en synchronisation (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`) ; le septième, `@dogfood-lab/portfolio`, reste interne. La ligne de version près du haut de ce fichier README est automatiquement ajoutée à partir de `package.json` via [`scripts/sync-version.mjs`](scripts/sync-version.mjs) à chaque `npm run build`.

## Licence

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuel](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tous les dépôts](https://github.com/orgs/dogfood-lab/repositories)** · **[Profil](https://github.com/dogfood-lab)**

*Mangez d’abord. Publiez ensuite.*

</div
