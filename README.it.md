<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.md">English</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**Sistema operativo per i test nell'era dell'intelligenza artificiale**

*Protocolli, archivi di dati e cicli di apprendimento per lo sviluppo software assistito dall'intelligenza artificiale.*

<!-- version:start -->
**v1.2.2** — 7 pacchetti (`@dogfood-lab/*`), suite di test per l'intero ambiente di lavoro, ricevitore attivo, manuale pubblicato.
<!-- version:end -->

📖 **[Leggi il manuale →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## Cos'è questo

`testing-os` è il monorepo principale dell'organizzazione GitHub [Dogfood Lab](https://github.com/dogfood-lab) — successore di [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs), ora archiviata.  Raggruppa i protocolli e l'infrastruttura per eseguire, registrare e apprendere dai test in un flusso di lavoro di sviluppo nativo per l'intelligenza artificiale:

- Un **protocollo di swarm** per eseguire audit paralleli su una base di codice.
- Un **archivio di dati + schema** per i record, i risultati, i modelli e le raccomandazioni che derivano da tali esecuzioni.
- Un livello di **policy + verifier** che decide cosa conta come "verificato" e lo applica a tutti i repository.
- Un livello di **intelligenza** che trasforma i risultati grezzi in modelli e principi riutilizzabili.

## Stato

**v1.2.2** — Rilascio di una patch per il runtime che aggiorna la libreria `better-sqlite3` dalla versione `^11.0.0` alla versione `^12.10.0` (il pacchetto `@dogfood-lab/dogfood-swarm` ora include SQLite versione 3.53.1, precedentemente 3.50.x). Anche gli strumenti per il runtime di test sono stati aggiornati: `vitest` e `@vitest/coverage-v8` dalla versione `3.2.4` alla versione `4.1.6` (solo per lo sviluppo, senza impatto sui pacchetti pubblicati). Tutte le funzionalità della Fase 5 sono state mantenute dalla versione v1.2.0: macchina a stati a livello di "onda" + contratto di ripristino "Three R's" (`swarm revalidate`, `swarm rewind`, `swarm redrive`) + verbo di audit-trail `swarm history` + stato di salute "A–D" con 0 criticità / 0 errori gravi. Sei pacchetti sono stati pubblicati sotto il nome `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. **1105 test.** Totale cumulativo durante l'intero ciclo di vita del repository (a partire dalla versione v1.0.0, data del 2026-04-25): lo "swarm" di test della Fase 7 (circa 31 "onde", circa 115 correzioni verificate e implementate, 14 classi di copertura degli audit) e l'arco di pubblicazione iniziale su npm della versione v1.2.x. Catalogo ufficiale dello "swarm": [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md).

Il ricevitore è attivo: i workflow `dogfood.yml` nei repository dei clienti vengono inviati a questo repository, e il file [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) committa i record risultanti e li indicizza nella directory `main`. Il manuale è disponibile all'indirizzo [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). Installazione: `npm install -g @dogfood-lab/dogfood-swarm`. Il lato ricevente viene utilizzato tramite dispatch; vedere la pagina di integrazione del manuale.

**Piattaforma:** validato end-to-end su Darwin/APFS come parte della Sessione G ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)). Consultare [Local Development](#local-development) per i filesystem supportati. Dettagli per versione in [CHANGELOG.md](CHANGELOG.md).

## Modello di minaccia

testing-os elabora le proposte di dogfood inviate tramite `repository_dispatch` da repository GitHub attendibili sotto `mcp-tool-shop-org/*` e `dogfood-lab/*`. Il verifier richiede la provenienza di GitHub Actions; gli ID di esecuzione dichiarati vengono confermati tramite l'API di GitHub e le proposte con formati errati, riferimenti mancanti o affermazioni di policy non valide vengono rifiutate.

**Cosa tocca testing-os:** il file JSON di invio in ogni payload `repository_dispatch`; le directory `policies/`, `fixtures/`, `records/` e `indexes/` in questo repository; chiamate in uscita a `api.github.com` per la verifica della provenienza.

**Cosa testing-os NON tocca:** il codice sorgente dei consumer, i segreti nei repository dei consumer al di fuori dell'inviluppo di dispatch, o qualsiasi cosa al di fuori dell'albero di lavoro di questo repository.

**Permessi richiesti:** il workflow del ricevitore viene eseguito con `contents: write` limitato solo a questo repository. La verifica della provenienza utilizza il `GITHUB_TOKEN` predefinito del workflow per le chiamate API di Actions in sola lettura. **Nessuna telemetria, nessun servizio di terze parti, nessuna analisi: questo codice non invia dati e non espone una superficie di rete al di fuori di GitHub.**

## Pacchetti

| Pacchetto | Origine | Scopo |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Gli 8 schemi JSON (record, finding, pattern, recommendation, doctrine, policy, scenario, submission). |
| `@dogfood-lab/verify` | JS | Validatore centrale delle inviazioni. Le inviazioni passano attraverso questo componente prima di essere memorizzate. |
| `@dogfood-lab/findings` | JS | Contratto di "finding" + pipeline di derivazione/revisione/sintesi/consulenza. |
| `@dogfood-lab/ingest` | JS | Componente di collegamento delle pipeline: dispatch → verify → persist → index. |
| `@dogfood-lab/report` | JS | Costruttore di inviazioni per i repository di origine. |
| `@dogfood-lab/portfolio` | JS | Generatore di portfolio multi-repository. |
| `@dogfood-lab/dogfood-swarm` | JS | Protocollo parallelo a 10 fasi + piano di controllo SQLite + binario `swarm`. |

Strumenti di test correlati che **rimangono indipendenti** ma si integrano tramite API pubblicate: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Struttura

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

## Sviluppo locale

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Richiede Node ≥ 20. La matrice CI esegue Node 20 + 22 su `ubuntu-latest`; è stata validata localmente con Node 25.

**Sistemi di file supportati:** APFS, HFS+, ext4 (baseline CI), NTFS — qualsiasi sistema che implementi `link(2)` POSIX. **Non supportati:** exFAT, FAT32. Il meccanismo di blocco dei file CAS in [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) richiede la semantica dei collegamenti hard per la pubblicazione atomica; su exFAT, `linkSync` genera un errore `ENOTSUP` (in modo evidente, non silenzioso). Un problema comune: le unità SSD esterne multipiattaforma sono spesso formattate in exFAT; clonare il repository in un disco locale APFS/HFS+ invece. Consultare [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) per la matrice completa di validazione della Sessione G.

## Versioning

Sincronizzazione tra tutti i pacchetti `@dogfood-lab/*`: vengono aggiornati contemporaneamente. La riga di versione in questo file README viene aggiornata automaticamente dal file `package.json` tramite `scripts/sync-version.mjs` (eseguito come `prebuild`). A partire dalla versione **v1.2.0**, sei pacchetti vengono pubblicati su npm con il prefisso `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. Il settimo (`@dogfood-lab/portfolio`) rimane interno al monorepo.

## Licenza

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuale](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tutti i repository](https://github.com/orgs/dogfood-lab/repositories)** · **[Profilo](https://github.com/dogfood-lab)**

*Mangia prima. Spedisci dopo.*

</div
