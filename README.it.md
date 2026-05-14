<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.md">English</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<div align="center">

# testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**Sistema operativo per i test nell'era dell'intelligenza artificiale**

*Protocolli, archivi di dati e cicli di apprendimento per il software assistito dall'intelligenza artificiale.*

<!-- version:start -->
**v0.2.0-pre** — 7 pacchetti (`@dogfood-lab/*`), suite di test per l'intero ambiente di lavoro, ricevitore attivo, manuale pubblicato.
<!-- version:end -->

📖 **[Leggi il manuale →](https://dogfood-lab.github.io/testing-os/)**

</div>

---

## Cos'è questo progetto

`testing-os` è il monorepo principale dell'organizzazione GitHub [Dogfood Lab](https://github.com/dogfood-lab) — successore di [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs), ora archiviata.  Raggruppa i protocolli e l'infrastruttura per eseguire, registrare e apprendere dai test in un flusso di lavoro di sviluppo nativo per l'intelligenza artificiale:

- Un **protocollo di swarm** per eseguire audit paralleli su una base di codice.
- Un **archivio di dati + schema** per i record, i risultati, i modelli e le raccomandazioni che derivano da tali esecuzioni.
- Un livello di **policy + verifier** che decide cosa conta come "verificato" e lo applica a tutti i repository.
- Un livello di **intelligenza** che trasforma i risultati grezzi in modelli e principi riutilizzabili.

## Stato

Migrazione da `mcp-tool-shop-org/dogfood-labs` completata (2026-04-25). Il ricevitore è attivo: i workflow `dogfood.yml` nei repository dei clienti vengono inviati a questo repository, e il file `[.github/workflows/ingest.yml`](.github/workflows/ingest.yml) salva i record risultanti e gli indici nella directory `main`. Il manuale è disponibile all'indirizzo [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). La versione 1.0.0 sarà rilasciata una volta completata la rifinitura post-migrazione descritta in [HANDOFF.md](HANDOFF.md).

## Pacchetti

| Pacchetto | Origine | Scopo |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Gli 8 schemi JSON (record, risultato, modello, raccomandazione, principio, policy, scenario, invio). |
| `@dogfood-lab/verify` | JS | Validatore centrale degli invii. Gli invii passano attraverso questo componente prima di essere salvati. |
| `@dogfood-lab/findings` | JS | Contratto dei risultati + pipeline di derivazione/revisione/sintesi/consigli. |
| `@dogfood-lab/ingest` | JS | Infrastruttura: dispatch → verify → persist → index. |
| `@dogfood-lab/report` | JS | Costruttore di invii per i repository di origine. |
| `@dogfood-lab/portfolio` | JS | Generatore di portfolio multi-repository. |
| `@dogfood-lab/dogfood-swarm` | JS | Il protocollo parallelo in 10 fasi + il sistema di controllo SQLite + il binario `swarm`. |

Strumenti di test correlati che **rimangono indipendenti** ma si integrano tramite API pubblicate: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Struttura

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

## Sviluppo locale

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Richiede Node ≥ 20.

## Versioning

Sincronizzazione tra tutti i pacchetti `@dogfood-lab/*`. Attualmente `0.1.0-pre`; il primo rilascio stabile sarà `1.0.0` una volta completata la rifinitura post-migrazione descritta in [HANDOFF.md](HANDOFF.md). La versione indicata in questo file README viene aggiornata automaticamente dal file `package.json` tramite `scripts/sync-version.mjs` (eseguito come `prebuild`).

## Licenza

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuale](https://dogfood-lab.github.io/testing-os/)** · **[Tutti i repository](https://github.com/orgs/dogfood-lab/repositories)** · **[Profilo](https://github.com/dogfood-lab)**

*Assaggiare prima. Distribuire poi.*

</div>
