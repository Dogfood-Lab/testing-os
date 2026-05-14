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
**v1.2.0** — 7 pacchetti (`@dogfood-lab/*`), suite di test per l'intero ambiente di lavoro, ricevitore attivo, documentazione pubblicata.
<!-- version:end -->

📖 **[Leggi la documentazione →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## Cos'è questo progetto

`testing-os` è il monorepo principale dell'organizzazione GitHub [Dogfood Lab](https://github.com/dogfood-lab) — successore di [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs), ora archiviata.  Raggruppa i protocolli e l'infrastruttura per eseguire, registrare e apprendere dai test in un flusso di lavoro di sviluppo nativo per l'intelligenza artificiale:

- Un **protocollo di swarm** per eseguire audit paralleli su una base di codice.
- Un **archivio di dati + schema** per i record, i risultati, i modelli e le raccomandazioni che derivano da tali esecuzioni.
- Un livello di **policy + verifier** che decide cosa conta come "verificato" e lo applica a tutti i repository.
- Un livello di **intelligenza** che trasforma i risultati grezzi in modelli e principi riutilizzabili.

## Stato

**v1.2.0** — prima pubblicazione npm del monorepo `@dogfood-lab/*`. Sei pacchetti sono ora disponibili pubblicamente sotto lo scope `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm` (il CLI `swarm` principale). Novità in questa versione: macchina a stati a livello di "wave" + contratto di ripristino "Three R's" (`swarm revalidate`, `swarm rewind`, `swarm redrive`) + verbo `swarm history` per la traccia degli audit + test di salute di livello A–D a 0 errori critici / 0 errori gravi. **1105/1105 test.** Totale nel ciclo di vita del repository (dal rilascio v1.0.0 del 2026-04-25): tutto quanto sopra più il dogfood swarm di Fase 7 (~31 "wave", ~115 correzioni verificate, 14 classi di copertura degli audit). Catalogo swarm autorevole: [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md).

Il ricevitore è attivo: i workflow `dogfood.yml` nei repository dei clienti vengono inviati a questo repository, e il file [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) salva i record risultanti e li indicizza in `main`. La documentazione è disponibile all'indirizzo [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). Installazione principale: `npm install -g @dogfood-lab/dogfood-swarm`. Il lato ricevente viene utilizzato tramite dispatch — vedere la pagina di integrazione della documentazione.

**Piattaforma:** validato end-to-end su Darwin/APFS come parte della Sessione G ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)). Consultare [Local Development](#local-development) per i filesystem supportati. Dettagli per versione in [CHANGELOG.md](CHANGELOG.md).

## Modello di minaccia

testing-os elabora le proposte inviate tramite `repository_dispatch` da repository GitHub attendibili sotto `mcp-tool-shop-org/*` e `dogfood-lab/*`. Il verifier richiede la provenienza di GitHub Actions: gli ID di esecuzione dichiarati vengono confermati tramite l'API di GitHub e le proposte con formati errati, riferimenti mancanti o affermazioni di policy non valide vengono rifiutate.

**Cosa tocca testing-os:** il JSON della proposta in ogni payload `repository_dispatch`; `policies/`, `fixtures/`, `records/` e `indexes/` in questo repository; chiamate in uscita a `api.github.com` per la verifica della provenienza.

**Cosa testing-os NON tocca:** il codice sorgente destinato agli utenti finali, i segreti contenuti nei repository destinati agli utenti finali al di fuori dell'ambito di invio, o qualsiasi cosa al di fuori dell'albero di lavoro di questo repository.

**Autorizzazioni richieste:** il flusso di lavoro del ricevitore viene eseguito con `contents: write` limitato a questo repository. La verifica della provenienza utilizza il `GITHUB_TOKEN` predefinito del flusso di lavoro per le chiamate API di Actions in sola lettura. **Nessuna telemetria, nessun servizio di terze parti, nessuna analisi: questo codice non invia dati e non espone una superficie di rete al di fuori di GitHub.**

## Pacchetti

| Pacchetto | Origine | Scopo |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Gli 8 schemi JSON (record, finding, pattern, recommendation, doctrine, policy, scenario, submission). |
| `@dogfood-lab/verify` | JS | Validatore centrale per le submission. Le submission passano attraverso questo componente prima di essere memorizzate. |
| `@dogfood-lab/findings` | JS | Contratto per i "findings" e pipeline per la derivazione, la revisione, la sintesi e la consulenza. |
| `@dogfood-lab/ingest` | JS | Componente di collegamento delle pipeline: dispatch → verify → persist → index. |
| `@dogfood-lab/report` | JS | Generatore di submission per i repository di origine. |
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

Sincronizzazione tra tutti i pacchetti `@dogfood-lab/*`: vengono aggiornati contemporaneamente. La riga di versione in questo file README viene aggiornata automaticamente da `package.json` tramite `scripts/sync-version.mjs` (viene eseguito come `prebuild`). A partire dalla versione **v1.2.0**, sei pacchetti vengono pubblicati su npm con il prefisso `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. Il settimo (`@dogfood-lab/portfolio`) rimane interno al monorepo.

## Licenza

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuale](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tutti i repository](https://github.com/orgs/dogfood-lab/repositories)** · **[Profilo](https://github.com/dogfood-lab)**

*Mangiare prima. Spedire dopo.*

</div
