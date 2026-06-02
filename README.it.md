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
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Sistema operativo per il testing nell'era dell'IA**

*Protocolli, archivi di evidenze e cicli di apprendimento per software assistito dall'IA.*

<!-- version:start -->
**v1.3.2** — versione corrente. Per informazioni sulle modifiche apportate, consultare il file [CHANGELOG.md](CHANGELOG.md).
<!-- version:end -->

📖 **[Leggi il manuale →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## Cos'è

`testing-os` è il principale monorepo dell'organizzazione [Dogfood Lab](https://github.com/dogfood-lab) su GitHub, successore del [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs), ora archiviato. Raggruppa i protocolli e l'infrastruttura per eseguire, registrare e apprendere dai test in un flusso di lavoro di sviluppo nativo per l'IA:

- Un **protocollo swarm** per eseguire audit paralleli su una base di codice.
- Un **archivio di evidenze + struttura di schema** per i record, le scoperte, i modelli e le raccomandazioni che derivano da tali esecuzioni.
- Un livello di **policy + verificatore** che decide cosa conta come "verificato" e lo applica su tutti i repository.
- Un livello di **intelligenza** che trasforma i risultati grezzi in modelli e dottrine riutilizzabili.

## Guida rapida

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

La guida per l'operatore, il riferimento per l'interfaccia a riga di comando, il riferimento dello schema e le istruzioni per l'integrazione sono disponibili nel **[manuale](https://dogfood-lab.github.io/testing-os/handbook/)**. I dettagli relativi a ciascuna versione sono disponibili nel file [CHANGELOG.md](CHANGELOG.md).

## Modello di minaccia

testing-os elabora le richieste di Dogfood inviate tramite `repository_dispatch` da repository GitHub affidabili sotto `mcp-tool-shop-org/*` e `dogfood-lab/*`. Il verificatore richiede la provenienza di GitHub Actions: gli ID di esecuzione dichiarati vengono confermati tramite l'API di GitHub e le richieste con forme errate, riferimenti mancanti o richieste di policy non valide vengono rifiutate.

**Cosa tocca testing-os:** il JSON della richiesta in ogni payload `repository_dispatch`; `policies/`, `fixtures/`, `records/` e `indexes/` in questo repository; chiamate in uscita a `api.github.com` per la verifica della provenienza.

**Cosa testing-os NON tocca:** il codice sorgente del consumatore, i segreti nei repository del consumatore oltre all'invio o qualsiasi cosa al di fuori dell'albero di lavoro di questo repository.

**Autorizzazioni richieste:** il flusso di lavoro del ricevitore viene eseguito con `contents: write` limitato a questo repository. La verifica della provenienza utilizza il `GITHUB_TOKEN` predefinito del flusso di lavoro per le chiamate API di Actions in sola lettura. **Nessun telemetria, nessun servizio di terze parti, nessuna analisi: questo codice non invia dati a casa né espone una superficie di rete oltre a GitHub.**

## Pacchetti

| Pacchetto | Origine | Scopo |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Gli 8 schemi JSON (record, finding, pattern, recommendation, doctrine, policy, scenario, submission). |
| `@dogfood-lab/verify` | JS | Validatore di richieste centrale. Le richieste passano attraverso questo validatore prima di essere memorizzate. |
| `@dogfood-lab/findings` | JS | Contratto di finding + pipeline di derivazione/revisione/sintesi/consiglio. |
| `@dogfood-lab/ingest` | JS | Collegamento della pipeline: invio → verifica → memorizzazione → indicizzazione. |
| `@dogfood-lab/report` | JS | Costruttore di richieste per i repository di origine. |
| `@dogfood-lab/portfolio` | JS | Generatore di portfolio tra repository. |
| `@dogfood-lab/dogfood-swarm` | JS | Il protocollo parallelo a 10 fasi + piano di controllo SQLite + bin `swarm`. |

Strumenti di testing secondari che **rimangono indipendenti** ma si integrano tramite API pubblicate: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Layout

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

Richiede Node ≥ 22. La matrice CI esegue Node 22 e 24 su `ubuntu-latest`; è stata convalidata localmente su Node 25.

**Filesystem supportati:** APFS, HFS+, ext4 (configurazione di base CI), NTFS — qualsiasi filesystem che implementi POSIX `link(2)`. **Non supportati:** exFAT, FAT32. Il meccanismo di blocco dei file in [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) richiede la semantica dei collegamenti fisici per la pubblicazione atomica; su exFAT, `linkSync` genera l'errore `ENOTSUP` (un errore evidente, non silenzioso). Un errore comune: gli SSD esterni multipiattaforma sono spesso formattati in exFAT; è consigliabile clonare il repository in locale su APFS/HFS+. Consultare [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) per la matrice completa di validazione della Sessione G.

## Gestione delle versioni

Tutti i pacchetti `@dogfood-lab/*` vengono aggiornati contemporaneamente, con un unico numero di versione per l'intero repository monolitico. Sei pacchetti vengono pubblicati su npm con il prefisso `@dogfood-lab` alla versione v1.3.2, in modo sincronizzato (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); il settimo, `@dogfood-lab/portfolio`, rimane di uso interno. La riga della versione che si trova nella parte superiore di questo file README viene aggiornata automaticamente dal file `package.json` tramite lo script [`scripts/sync-version.mjs`](scripts/sync-version.mjs) ogni volta che viene eseguito il comando `npm run build`.

## Licenza

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuale](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tutti i repository](https://github.com/orgs/dogfood-lab/repositories)** · **[Profilo](https://github.com/dogfood-lab)**

*Prima mangia, poi pubblica.*

</div
