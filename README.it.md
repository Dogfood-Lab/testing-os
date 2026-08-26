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
**v1.11.0** — versione corrente. Consultare [CHANGELOG.md](CHANGELOG.md) per i dettagli sulle nuove funzionalità.
<!-- version:end -->

📖 **[Leggi la guida →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div>

---

## Cos'è questo progetto

`testing-os` registra, verifica e apprende dalle evidenze di test reali del tuo repository in un flusso di lavoro nativo per l'IA. Puntalo a un repository e ogni esecuzione dei test diventa una registrazione convalidata sulla provenienza, su cui puoi fare affidamento, non semplicemente un risultato auto-dichiarato positivo.

Cosa otterrai:

- **Registrazioni convalidata sulla provenienza.** Ogni invio è associato a una reale esecuzione CI, tramite l'identità del provider, prima di essere accettato. Il risultato è un archivio di evidenze a prova di manomissione e in cui si possono aggiungere solo nuovi elementi, non un semplice sistema basato sull'onore.
- **Un contratto di policy che puoi controllare.** Definisci cosa conta come "verificato" in YAML: un DSL predicativo limitato (`field`/`op`/`value` + `all`/`any`/`not`/`implies`) e applicalo su tutti i tuoi repository. Verifica una policy prima di pubblicarla con `dogfood-verify lint`.
- **Un protocollo swarm ad agenti paralleli.** Esegui audit multi-agente su un codebase, quindi trasforma i risultati grezzi in modelli riutilizzabili e dottrine.
- **Una superficie di stato live.** Registrazioni per repository, indici e un badge di stato, tutto servito da un unico archivio di evidenze.

È il progetto monorepo principale dell'organizzazione [Dogfood Lab](https://github.com/dogfood-lab): sette pacchetti `@dogfood-lab/*` dietro una singola CLI `swarm`.

## Guida rapida

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

Vuoi che le evidenze dei test del tuo repository vengano registrate qui? Il **[kit di avvio `examples/`](examples/)** ti permette di iniziare in cinque minuti (`dogfood-report` crea l'invio; `dogfood-init` configura il flusso di lavoro). La guida per l'operatore, il riferimento della CLI, il riferimento dello schema e le ricette di integrazione sono disponibili nella **[guida](https://dogfood-lab.github.io/testing-os/handbook/)**. I dettagli per versione sono disponibili in [CHANGELOG.md](CHANGELOG.md).

## Modello delle minacce

testing-os elabora gli invii di dogfood ricevuti tramite `repository_dispatch` da repository GitHub affidabili sotto `mcp-tool-shop-org/*` e `dogfood-lab/*`. Il verificatore richiede la provenienza CI: gli ID di esecuzione dichiarati vengono confermati tramite l'API del provider e gli invii con forme non corrette, riferimenti mancanti o affermazioni di policy non valide vengono rifiutati.

**La provenienza è l'attestazione.** Per un invio `github`, il verificatore conferma che la presunta esecuzione GitHub Actions esiste effettivamente (API GitHub) e associa l'`repo` e l'`commit_sha` dell'invio a tale esecuzione confermata: una verifica live e senza chiavi basata sull'identità OIDC di GitHub, in modo che una registrazione non possa attestare un'esecuzione o un commit che non si è verificato. Il supporto per **GitLab CI** è disponibile come opzione (`source.provider: gitlab`); un invio GitLab è l'unico caso in cui il verificatore chiama un host diverso da GitHub (`gitlab.com/api`), e solo per gli invii `gitlab`.

**L'integrità della registrazione è a prova di manomissione, non completamente protetta.** Ogni registrazione persistente contiene un blocco `integrity` (`submission_digest` + `prev_digest`) che forma una catena hash in cui si possono aggiungere solo nuovi elementi e che `node packages/ingest/run.js --verify-chain` convalida completamente offline, rilevando manomissioni esterne, corruzione del disco e ripristini parziali. Non protegge dalle credenziali di ingestione stesse, che possono riscrivere sia una registrazione che la catena; per risolvere questo problema è necessario un ancoraggio esterno al controllo dello scrittore. Un **ancoraggio XRPL opzionale, disattivato per impostazione predefinita** (`node packages/ingest/run.js --anchor-*`), testimonia l'intestazione della catena nel registro pubblico XRP Ledger, rendendo rilevabile qualsiasi troncamento o riscrittura al di sotto del punto ancorato: la seconda chiamata divulgata a un host non GitHub e solo quando un operatore lo abilita.

**testing-os elabora:** il JSON dell'invio in ogni payload `repository_dispatch`; `policies/`, `fixtures/`, `records/`, `indexes/` e `dogfood/roadmap/` in questo repository (l'ultimo scritto solo da un operatore tramite `swarm roadmap compile`, mai dal percorso di ingestione automatizzato); chiamate in uscita a `api.github.com` per la verifica della provenienza; e — solo per gli invii `github` — una lettura dei file `dogfood/scenarios/<scenario_id>.yaml` del repository che effettua l'invio al commit attestato (la definizione dello scenario che alimenta l'applicazione dei passaggi obbligatori; le dimensioni sono limitate e lo schema viene convalidato prima dell'uso, i file mancanti lasciano semplicemente tale controllo non applicato con un avviso visibile).

**testing-os NON elabora:** il codice sorgente del consumatore oltre ai file di definizione `dogfood/scenarios/` dichiarati, i segreti nei repository dei consumatori oltre alla busta di invio o qualsiasi cosa al di fuori dell'albero di lavoro di questo repository.

**Le transizioni dello stato dei risultati sono basate su evidenze e in cui si possono aggiungere solo nuovi elementi.** I verbi di chiusura del piano di controllo swarm (`swarm reopen`, `swarm close`) richiedono una motivazione esplicita, delle evidenze e — per le chiusure dell'operatore — una modalità di verifica dichiarata; ogni transizione scrive una riga `finding_events` immutabile che registra l'autorità che ha agito. Nessun percorso automatizzato può chiudere un risultato in base alla sua obsolescenza o riaprirlo tramite previsione e nessun verbo può riscrivere la cronologia degli eventi: le credenziali utilizzate in modo errato possono aggiungere transizioni, ma ogni aggiunta viene registrata.

**Interfaccia di rete.** Per impostazione predefinita, l’unica uscita è `api.github.com` (solo lettura: conferma della provenienza + recupero della definizione dello scenario descritto sopra). Le due eccezioni sono entrambe opzionali e sono state descritte in precedenza: un invio da un provider GitLab (`gitlab.com/api`) e un’esecuzione di un ancoraggio XRPL abilitata dall’operatore. **Nessun telemetria, nessuna analisi: questo codice sorgente non comunica mai con l’esterno; in assenza di questi due percorsi opzionali, non espone alcuna interfaccia di rete al di fuori di GitHub.** Il flusso di lavoro del ricevitore viene eseguito con `contents: write` e si applica solo a questo repository.

## Pacchetti

| Pacchetto | Sorgente | Scopo |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Gli 8 schemi JSON (record, finding, pattern, recommendation, doctrine, policy, scenario, submission). |
| `@dogfood-lab/verify` | JS | Validatore centrale degli invii. Gli invii passano attraverso questo validatore prima di essere salvati in modo permanente. |
| `@dogfood-lab/findings` | JS | Contratto per i risultati + pipeline per la derivazione/revisione/sintesi/consulenza. |
| `@dogfood-lab/ingest` | JS | Collegamento delle pipeline: dispatch → verify → persist → index. |
| `@dogfood-lab/report` | JS | Strumento di creazione degli invii per i repository di origine. |
| `@dogfood-lab/portfolio` | JS | Generatore di portfolio tra diversi repository. |
| `@dogfood-lab/dogfood-swarm` | JS | Il protocollo a 10 fasi con agenti paralleli + piano di controllo SQLite + `swarm` bin. |

Strumenti di test correlati che **rimangono indipendenti** ma si integrano tramite API pubblicate: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Layout

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

Richiede Node ≥ 22. La matrice CI esegue Node 22 + 24 su `ubuntu-latest`; la validazione locale viene eseguita su Node 25.

**Filesystem supportati:** APFS, HFS+, ext4 (baseline CI), NTFS — qualsiasi filesystem che implementi POSIX `link(2)`. **Non supportato:** exFAT, FAT32. Il meccanismo di blocco dei file CAS in [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) richiede la semantica del collegamento fisico per la pubblicazione atomica; su exFAT, `linkSync` genera `ENOTSUP` (un errore evidente, non silenzioso). Un problema comune: gli SSD esterni multipiattaforma sono spesso formattati in exFAT; clona invece il repository in un filesystem APFS/HFS+ locale. Consulta [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) per la matrice completa di validazione della Sessione G.

## Versioning

Tutti i pacchetti `@dogfood-lab/*` vengono aggiornati insieme: un singolo numero in tutto il monorepository. Sei pacchetti vengono pubblicati su npm sotto `@dogfood-lab` alla versione v1.11.0 in modo sincronizzato (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); il settimo, `@dogfood-lab/portfolio`, rimane interno. La riga della versione nella parte superiore di questo README viene aggiunta automaticamente da `package.json` tramite [`scripts/sync-version.mjs`](scripts/sync-version.mjs) a ogni `npm run build`.

## Licenza

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuale](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tutti i repository](https://github.com/orgs/dogfood-lab/repositories)** · **[Profilo](https://github.com/dogfood-lab)**

*Prima mangia, poi pubblica.*

</div>
