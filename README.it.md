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
**v1.12.0** — versione corrente. Consultare [CHANGELOG.md](CHANGELOG.md) per i dettagli sulle nuove funzionalità.
<!-- version:end -->

📖 **[Leggi la guida →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## Cos'è

`testing-os` registra, verifica e apprende dalle evidenze di test reali del tuo repository, utilizzando un flusso di lavoro nativo per l'IA. Puntalo a un repository e ogni esecuzione di test diventa una registrazione convalidata, di cui puoi fidarti, e non solo un risultato auto-dichiarato.

Cosa otterrai:

- **Registrazioni convalidata.** Ogni invio è associato a una reale esecuzione CI, tramite l'identità del provider, prima di essere accettato. Il risultato è un archivio di evidenze a prova di manomissione e con aggiunte sequenziali, e non solo un semplice segno di spunta basato sulla fiducia.
- **Un contratto di policy che puoi controllare.** Definisci cosa conta come "verificato" in YAML: un DSL predicativo limitato (`field`/`op`/`value` + `all`/`any`/`not`/`implies`) e applicalo in tutti i tuoi repository. Verifica una policy prima di pubblicarla con `dogfood-verify lint`.
- **Un protocollo di swarm di agenti paralleli.** Esegui audit multi-agente su una base di codice, quindi trasforma i risultati grezzi in modelli e dottrine riutilizzabili.
- **Una superficie di stato in tempo reale.** Registrazioni e indici per repository, e un badge di stato, tutto servito da un unico archivio di evidenze.

È il repository monolitico principale dell'organizzazione [Dogfood Lab](https://github.com/dogfood-lab): sette pacchetti `@dogfood-lab/*` dietro un'unica CLI `swarm`.

## Avvio rapido

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

Vuoi che le evidenze di test del tuo repository vengano registrate qui? Il **[kit di avvio `examples/`](examples/)** ti permette di iniziare in cinque minuti (`dogfood-report` crea l'invio; `dogfood-init` crea lo schema del flusso di lavoro). La guida per l'operatore, il riferimento della CLI, il riferimento dello schema e le ricette di integrazione sono disponibili nella **[guida](https://dogfood-lab.github.io/testing-os/handbook/)**. I dettagli per versione sono disponibili in [CHANGELOG.md](CHANGELOG.md).

## Modello di minaccia

testing-os elabora gli invii di dogfood inviati tramite `repository_dispatch` da repository GitHub affidabili sotto `mcp-tool-shop-org/*` e `dogfood-lab/*`. Il verificatore richiede la provenienza CI: gli ID di esecuzione dichiarati vengono confermati tramite l'API del provider e gli invii con forme non corrette, riferimenti mancanti o affermazioni di policy non valide vengono rifiutati.

**La provenienza è l'attestazione.** Per un invio `github`, il verificatore conferma che l'esecuzione di GitHub Actions dichiarata esiste effettivamente (API di GitHub) e associa l'`repo` e l'`commit_sha` dell'invio a tale esecuzione confermata: un controllo in tempo reale e senza chiavi, basato sull'identità OIDC di GitHub, in modo che una registrazione non possa attestare un'esecuzione o un commit che non si sono verificati. **GitLab CI** è supportato in modalità opzionale (`source.provider: gitlab`); un invio GitLab è l'unico caso in cui il verificatore chiama un host non GitHub (`gitlab.com/api`), e solo per gli invii `gitlab`.

**L'integrità della registrazione è a prova di manomissione, ma non a prova di tutto.** Ogni registrazione persistente contiene un blocco `integrity` (`submission_digest` + `prev_digest`) che forma una catena hash con aggiunte sequenziali che `node packages/ingest/run.js --verify-chain` valida completamente offline, rilevando manomissioni esterne, corruzione del disco e ripristini parziali. Non difende contro le credenziali di ingest, che possono riscrivere sia una registrazione che la catena; per risolvere questo problema, è necessario un ancoraggio al di fuori del controllo dello scrittore. Un **ancoraggio XRPL opzionale, disattivato per impostazione predefinita** (`node packages/ingest/run.js --anchor-*`), testimonia l'intestazione della catena nel registro pubblico XRP, rendendo rilevabile qualsiasi troncamento o riscrittura al di sotto del punto ancorato: la seconda chiamata non GitHub divulgata, e solo quando un operatore la abilita.

**Cosa tocca testing-os:** il JSON dell'invio in ogni payload `repository_dispatch`; `policies/`, `fixtures/`, `records/`, `indexes/` e `dogfood/roadmap/` in questo repository (l'ultimo scritto solo da un `swarm roadmap compile` invocato dall'operatore, mai dal percorso di ingest automatizzato); chiamate in uscita a `api.github.com` per la verifica della provenienza; e — solo per gli invii `github` — un recupero in sola lettura dell'`dogfood/scenarios/<scenario_id>.yaml` del repository che invia al commit attestato (la definizione dello scenario che alimenta l'applicazione dei passaggi obbligatori; le dimensioni sono limitate e lo schema viene convalidato prima dell'uso; i file mancanti semplicemente lasciano questo controllo non applicato con un avviso visibile).

**Cosa testing-os NON tocca:** il codice sorgente del consumatore oltre ai file di definizione `dogfood/scenarios/` dichiarati, i segreti nei repository del consumatore oltre alla busta di invio o qualsiasi cosa al di fuori dell'albero di lavoro di questo repository.

**Le transizioni di stato dei risultati contengono evidenze e sono aggiunte sequenzialmente.** I verbi di chiusura del piano di controllo dello swarm (`swarm reopen`, `swarm close`) richiedono una motivazione esplicita, evidenze e — per le chiusure dell'operatore — una modalità di verifica dichiarata; ogni transizione scrive una riga `finding_events` immutabile che registra l'autorità che agisce. Nessun percorso automatizzato può chiudere un risultato a causa di inattività o riaprirlo tramite previsione e nessun verbo può riscrivere la cronologia degli eventi: una credenziale utilizzata in modo errato può aggiungere transizioni, ma ogni aggiunta viene registrata.

**Interfaccia di rete.** Per impostazione predefinita, l’unica uscita è `api.github.com` (solo lettura: conferma della provenienza + recupero della definizione dello scenario descritto sopra). Le due eccezioni sono entrambe opzionali e sono state descritte in precedenza: un invio da un provider GitLab (`gitlab.com/api`) e un’esecuzione di un ancoraggio XRPL abilitata dall’operatore. **Nessun telemetria, nessuna analisi: questo codice sorgente non invia dati all’esterno; in assenza di questi due percorsi opzionali, non espone alcuna interfaccia di rete al di fuori di GitHub.** Il flusso di lavoro del ricevitore viene eseguito con `contents: write`, limitato a questo repository.

## Pacchetti

| Pacchetto | Sorgente | Scopo |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Gli 8 schemi JSON (record, finding, pattern, recommendation, doctrine, policy, scenario, submission). |
| `@dogfood-lab/verify` | JS | Validatore centrale degli invii. Gli invii passano attraverso questo validatore prima di essere salvati. |
| `@dogfood-lab/findings` | JS | Contratto per i risultati + pipeline per derivazione/revisione/sintesi/consulenza. |
| `@dogfood-lab/ingest` | JS | Collegamento delle pipeline: invio → verifica → salvataggio → indicizzazione. |
| `@dogfood-lab/report` | JS | Strumento per la creazione di invii per i repository di origine. |
| `@dogfood-lab/portfolio` | JS | Generatore di portfolio tra repository. |
| `@dogfood-lab/dogfood-swarm` | JS | Il protocollo a agenti paralleli a 10 fasi + piano di controllo SQLite + `swarm`. |

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

Richiede Node ≥ 22. La matrice CI esegue Node 22 + 24 su `ubuntu-latest`; la convalida locale viene eseguita su Node 25.

**Filesystem supportati:** APFS, HFS+, ext4 (baseline CI), NTFS — qualsiasi filesystem che implementi POSIX `link(2)`. **Non supportati:** exFAT, FAT32. Il CAS di blocco dei file in [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) richiede la semantica di hard link per la pubblicazione atomica; su exFAT, `linkSync` genera `ENOTSUP` (un errore evidente, non silenzioso). Un errore comune: gli SSD esterni multipiattaforma sono spesso formattati in exFAT; clona invece il repository in un filesystem APFS/HFS+ locale. Consulta [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) per la matrice di convalida completa della Sessione G.

## Versioning

Tutti i pacchetti `@dogfood-lab/*` vengono aggiornati insieme: un unico numero per l’intero monorepository. Sei pacchetti vengono pubblicati su npm sotto `@dogfood-lab` alla versione v1.12.0 in modo sincronizzato (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); il settimo, `@dogfood-lab/portfolio`, rimane interno. La riga della versione nella parte superiore di questo README viene aggiunta automaticamente da `package.json` tramite [`scripts/sync-version.mjs`](scripts/sync-version.mjs) a ogni `npm run build`.

## Licenza

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manuale](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Tutti i repository](https://github.com/orgs/dogfood-lab/repositories)** · **[Profilo](https://github.com/dogfood-lab)**

*Prima mangia, poi pubblica.*

</div
