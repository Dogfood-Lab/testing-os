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
[![dogfood](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/badges/dogfood-lab--testing-os--cli.json)](https://dogfood-lab.github.io/testing-os/handbook/read-model/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Sistema operativo per il testing nell'era dell'IA**

*Protocolli, archivi di evidenze e cicli di apprendimento per software assistito dall'IA.*

<!-- version:start -->
**v1.10.0** — versione corrente. Per i dettagli sulle modifiche, consultare il file [CHANGELOG.md](CHANGELOG.md).
<!-- version:end -->

📖 **[Leggi la guida →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## Cos'è questo progetto

`testing-os` registra, verifica e apprende dai dati reali dei test del tuo repository all'interno di un flusso di lavoro nativo AI. Puntalo a un repository e ogni esecuzione dei test diventerà una registrazione convalidata in termini di provenienza, su cui puoi fare affidamento, e non solo un risultato auto-dichiarato positivo.

Cosa otterrai:

- **Registrazioni convalidata in termini di provenienza.** Ogni invio è associato a una reale esecuzione CI, senza la necessità di chiavi, tramite l'identità del provider stesso, prima che venga accettato. Il risultato è un archivio di dati verificabile e modificabile solo in appendice, e non semplicemente un sistema basato sulla fiducia.
- **Un contratto di policy che puoi controllare.** Definisci cosa conta come "verificato" in YAML: un DSL predicativo delimitato (senza valutazione) (`field`/`op`/`value` + `all`/`any`/`not`/`implies`) e applicalo a tutti i tuoi repository. Esegui il linting di una policy prima di pubblicarla con `dogfood-verify lint`.
- **Un protocollo swarm multi-agente.** Esegui audit multi-agente su un codebase, quindi trasforma i risultati grezzi in modelli e dottrine riutilizzabili.
- **Una dashboard di stato in tempo reale.** Registrazioni per repository, indici e un badge di stato, tutto servito da un unico archivio dati.

È il monorepository principale dell'organizzazione [Dogfood Lab](https://github.com/dogfood-lab): sette pacchetti `@dogfood-lab/*` dietro una singola CLI `swarm`.

## Guida rapida all'avvio

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

Vuoi che i dati dei test del tuo repository vengano registrati qui? Il **[`examples/` starter kit](examples/)** ti permette di iniziare in cinque minuti (`npx @dogfood-lab/report` crea l'invio; `dogfood-init` configura il flusso di lavoro). La guida per l'operatore, il riferimento della CLI, il riferimento dello schema e le ricette di integrazione sono disponibili nel **[handbook](https://dogfood-lab.github.io/testing-os/handbook/)**. I dettagli per versione sono disponibili in [CHANGELOG.md](CHANGELOG.md).

## Modello delle minacce

testing-os elabora le richieste di test inviate tramite `repository_dispatch` da repository GitHub affidabili sotto `mcp-tool-shop-org/*` e `dogfood-lab/*`. Il verificatore richiede la provenienza CI: gli ID delle esecuzioni dichiarate vengono confermati tramite l'API del provider e le richieste con strutture non valide, riferimenti mancanti o affermazioni di policy non valide vengono rifiutate.

**La provenienza è l'attestazione.** Per un invio a `github`, il verificatore conferma che la presunta esecuzione di GitHub Actions esiste effettivamente (tramite l'API di GitHub) e associa il `repo` e l'`commit_sha` dell'invio a tale esecuzione convalidata: una verifica in tempo reale, senza chiavi, basata sull'identità OIDC di GitHub, quindi una registrazione non può attestare un'esecuzione o un commit che non sono avvenuti. **GitLab CI** è supportato tramite attivazione esplicita (`source.provider: gitlab`); un invio GitLab è l'unico caso in cui il verificatore chiama un host diverso da GitHub (`gitlab.com/api`) e solo per gli invii `gitlab`.

**L'integrità della registrazione è evidente, non a prova di manomissione.** Ogni registrazione memorizzata contiene un blocco `integrity` (`submission_digest` + `prev_digest`), che forma una catena hash modificabile solo in appendice che `dogfood ingest --verify-chain` convalida completamente offline, rilevando manipolazioni esterne, corruzione del disco e ripristini parziali. Non protegge dalle credenziali di invio stesse, che possono riscrivere sia una registrazione che la catena; per risolvere questo problema è necessario un ancoraggio esterno al controllo dello scrittore. Un **ancoraggio XRPL opzionale, disattivato per impostazione predefinita** (`dogfood ingest --anchor-*`), testimonia l'intestazione della catena nel registro pubblico XRP Ledger, rendendo rilevabile qualsiasi troncamento o riscrittura al di sotto del punto ancorato: la seconda chiamata non GitHub divulgata e solo quando un operatore la abilita.

**Quali elementi vengono interessati dai test:** il JSON di invio in ogni payload `repository_dispatch`; le cartelle `policies/`, `fixtures/`, `records/`, `indexes/` e `dogfood/roadmap/` in questo repository (l'ultima viene modificata solo tramite il comando `swarm roadmap compile` eseguito da un operatore, mai tramite il processo di ingest automatizzato); le chiamate in uscita a `api.github.com` per la verifica della provenienza; e — solo per gli invii relativi a `github` — una lettura (in sola modalità) del file `dogfood/scenarios/<scenario_id>.yaml` del repository che effettua l'invio, all'altezza del commit attestato (la definizione dello scenario che alimenta l'applicazione dei passaggi obbligatori; i file vengono controllati per dimensioni e schema prima dell'uso; in caso di assenza, il controllo viene semplicemente omesso con un avviso visibile).

**Cosa testing-os NON elabora:** codice sorgente del consumatore oltre ai file di definizione `dogfood/scenarios/` dichiarati, segreti nei repository dei consumatori oltre all'invio stesso o qualsiasi elemento al di fuori dell'albero di lavoro di questo repository.

**Le transizioni di stato relative alle anomalie sono basate su prove e vengono aggiunte in modo sequenziale.** I verbi di chiusura del piano di controllo dello swarm (`swarm reopen`, `swarm close`) richiedono una motivazione esplicita, delle prove e — per le chiusure effettuate dagli operatori — una modalità di verifica dichiarata; ogni transizione scrive una riga immutabile in `finding_events` che registra l'autorità responsabile. Nessun processo automatizzato può chiudere un'anomalia a causa della sua obsolescenza o riaprirla tramite previsione, e nessun verbo può riscrivere la cronologia degli eventi: un set di credenziali utilizzato in modo errato può aggiungere transizioni, ma ogni aggiunta viene registrata.

**Superficie di rete.** Per impostazione predefinita, l'unica uscita è `api.github.com` (provenienza in sola lettura). Le due eccezioni sono entrambe attivate esplicitamente e divulgate sopra: un invio dal provider GitLab (`gitlab.com/api`) e un ancoraggio XRPL abilitato dall'operatore. **Nessun telemetria, nessuna analisi: questo codebase non comunica mai con l'esterno; in assenza di questi due percorsi attivati esplicitamente, non espone alcuna superficie di rete oltre a GitHub.** Il flusso di lavoro del ricevitore viene eseguito con `contents: write` limitato solo a questo repository.

## Pacchetti

| Pacchetto | Origine | Scopo |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Gli 8 schemi JSON (record, finding, pattern, recommendation, doctrine, policy, scenario, submission). |
| `@dogfood-lab/verify` | JS | Validatore centrale delle richieste. Le richieste passano attraverso questo componente prima di essere memorizzate. |
| `@dogfood-lab/findings` | JS | Contratto per i risultati + pipeline di derivazione/revisione/sintesi/consulenza. |
| `@dogfood-lab/ingest` | JS | Collegamento tra le pipeline: invio → verifica → memorizzazione → indicizzazione. |
| `@dogfood-lab/report` | JS | Strumento di creazione delle richieste per i repository di origine. |
| `@dogfood-lab/portfolio` | JS | Generatore di portfolio inter-repository. |
| `@dogfood-lab/dogfood-swarm` | JS | Il protocollo parallelo a 10 fasi + piano di controllo SQLite + bin `swarm`. |

Strumenti di testing correlati che **rimangono indipendenti** ma si integrano tramite API pubblicate: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Struttura

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

## Sviluppo locale

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # version-sync + doc-drift + regression-pin gates + build + tests (canonical pre-commit check — NOT the same as build && test)
```

Richiede Node ≥ 22. La matrice CI esegue Node 22 + 24 su `ubuntu-latest`; localmente è stato convalidato su Node 25.

**Filesystem supportati:** APFS, HFS+, ext4 (baseline CI), NTFS — qualsiasi filesystem che implementi POSIX `link(2)`. **Non supportati:** exFAT, FAT32. Il CAS di blocco dei file in [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) richiede la semantica del collegamento fisico per la pubblicazione atomica; su exFAT, `linkSync` genera un errore `ENOTSUP` (chiaro, non silenzioso). Un problema comune: gli SSD esterni multipiattaforma sono spesso formattati in exFAT — clona il repository in APFS/HFS+ locale. Consultare [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) per la matrice di validazione completa della sessione G.

## Versioning

Tutti i pacchetti `@dogfood-lab/*` vengono aggiornati contemporaneamente, con un unico numero di versione nell'intero monorepository. Sei pacchetti vengono pubblicati su npm sotto il nome `@dogfood-lab` alla versione v1.10.0 in modo sincronizzato (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); il settimo, `@dogfood-lab/portfolio`, rimane interno. La riga della versione che si trova all'inizio di questo file README viene aggiunta automaticamente dal file `package.json` tramite lo script [`scripts/sync-version.mjs`](scripts/sync-version.mjs) ogni volta che viene eseguito il comando `npm run build`.

## Licenza

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Guida](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tutti i repository](https://github.com/orgs/dogfood-lab/repositories)** · **[Profilo](https://github.com/dogfood-lab)**

*Prima mangia, poi spedisci.*

</div>
