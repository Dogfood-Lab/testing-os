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
**v1.5.0** — versione corrente. Consultare [CHANGELOG.md](CHANGELOG.md) per i dettagli sulle modifiche apportate.
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

Desidera che le prove dei test del proprio repository vengano registrate qui? Il **[`kit di avvio examples/`](examples/)** consente di iniziare in cinque minuti (`npx @dogfood-lab/report` crea la richiesta; `dogfood-init` configura il flusso di lavoro). La guida per l'operatore, il riferimento alla CLI, il riferimento allo schema e le istruzioni sull'integrazione sono disponibili nel **[manuale](https://dogfood-lab.github.io/testing-os/handbook/)**. I dettagli relativi a ciascuna versione sono disponibili in [CHANGELOG.md](CHANGELOG.md).

## Modello di minaccia

testing-os elabora le richieste di Dogfood inviate tramite `repository_dispatch` da repository GitHub affidabili sotto `mcp-tool-shop-org/*` e `dogfood-lab/*`. Il verificatore richiede la provenienza di GitHub Actions: gli ID di esecuzione dichiarati vengono confermati tramite l'API di GitHub e le richieste con forme errate, riferimenti mancanti o richieste di policy non valide vengono rifiutate.

**La provenienza è la prova.** Per una richiesta inviata tramite `github`, il verificatore conferma che l'esecuzione di GitHub Actions dichiarata esiste effettivamente (tramite l'API di GitHub) e associa il `repo` e l'`commit_sha` della richiesta a tale esecuzione confermata: si tratta di un controllo in tempo reale, senza chiavi, basato sull'identità OIDC di GitHub, quindi una registrazione non può attestare un'esecuzione o un commit che non sono avvenuti. È supportato anche **GitLab CI** (tramite opzione; `source.provider: gitlab`); una richiesta inviata tramite GitLab è l'unico caso in cui il verificatore chiama un host diverso da GitHub (`gitlab.com/api`) e solo per le richieste inviate tramite `gitlab`.

**L'integrità della registrazione è evidente in caso di manomissione, ma non la previene.** Ogni registrazione memorizzata contiene un blocco `integrity` (`submission_digest` + `prev_digest`) che forma una catena hash a cui è possibile aggiungere solo elementi; `dogfood ingest --verify-chain` convalida completamente questa catena in modalità offline, rilevando manomissioni esterne, danneggiamenti del disco e ripristini parziali. Non protegge dalle credenziali di inserimento stesse, che possono riscrivere sia una registrazione che la catena; per risolvere questo problema è necessario un ancoraggio esterno al controllo dello scrittore. Un **ancoraggio XRPL opzionale, disattivato per impostazione predefinita** (`dogfood ingest --anchor-*`), testimonia l'inizio della catena nel registro pubblico XRP Ledger, rendendo rilevabile qualsiasi troncamento o riscrittura al di sotto del punto ancorato: si tratta della seconda chiamata esterna a GitHub e viene eseguita solo quando un operatore la abilita.

**Cosa tocca testing-os:** il JSON della richiesta in ogni payload `repository_dispatch`; `policies/`, `fixtures/`, `records/` e `indexes/` in questo repository; chiamate in uscita a `api.github.com` per la verifica della provenienza.

**Cosa testing-os NON tocca:** il codice sorgente del consumatore, i segreti nei repository del consumatore oltre all'invio o qualsiasi cosa al di fuori dell'albero di lavoro di questo repository.

**Superficie di rete.** Per impostazione predefinita, l'unica comunicazione in uscita è verso `api.github.com` (provenienza in sola lettura). Le due eccezioni sono entrambe opzionali e descritte sopra: una richiesta inviata tramite un provider GitLab (`gitlab.com/api`) e un ancoraggio XRPL abilitato da un operatore. **Nessuna telemetria, nessuna analisi: questo codice non comunica con server esterni; in assenza di questi due percorsi opzionali, non espone alcuna superficie di rete al di fuori di GitHub.** Il flusso di lavoro del ricevitore viene eseguito con l'ambito `contents: write` limitato a questo repository.

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
├── examples/                  # Copy-paste consumer starter kit (dogfood.yml + scenario + policy)
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml, release.yml
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

Tutti i pacchetti `@dogfood-lab/*` vengono aggiornati insieme, con un unico numero di versione per l'intero monorepository. Sei pacchetti vengono pubblicati su npm sotto `@dogfood-lab` alla versione v1.5.0 in modo sincronizzato (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); il settimo, `@dogfood-lab/portfolio`, rimane interno. La riga della versione all'inizio di questo file README viene aggiunta automaticamente da `package.json` tramite [`scripts/sync-version.mjs`](scripts/sync-version.mjs) ogni volta che si esegue `npm run build`.

## Licenza

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuale](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tutti i repository](https://github.com/orgs/dogfood-lab/repositories)** · **[Profilo](https://github.com/dogfood-lab)**

*Prima mangia, poi pubblica.*

</div
