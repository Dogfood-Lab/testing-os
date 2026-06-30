<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.md">English</a>
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

**Sistema operacional para testes na era da IA**

*Protocolos, repositórios de evidências e ciclos de aprendizado para software assistido por IA.*

<!-- version:start -->
**v1.6.0** — versão atual. Consulte [CHANGELOG.md](CHANGELOG.md) para ver o que foi incluído nesta versão.
<!-- version:end -->

📖 **[Leia o manual →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## O que é isso

`testing-os` é o principal monorepos da organização [Dogfood Lab](https://github.com/dogfood-lab) do GitHub — sucessor do agora arquivado [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs). Ele reúne os protocolos e a infraestrutura para executar, registrar e aprender com testes em um fluxo de trabalho de desenvolvimento nativo de IA:

- Um **protocolo de enxame** para executar auditorias de agentes paralelos em uma base de código.
- Um **repositório de evidências + estrutura de esquema** para os registros, descobertas, padrões e recomendações que resultam dessas execuções.
- Uma **camada de política + verificador** que decide o que conta como "verificado" — e aplica isso em todos os repositórios de consumidores.
- Uma **camada de inteligência** que transforma as descobertas brutas em padrões e doutrinas reutilizáveis.

## Guia de início rápido

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

Gostaria de registrar os resultados dos testes do seu próprio repositório aqui? O **[`kit inicial examples/`](examples/)** permite que você comece em cinco minutos (`npx @dogfood-lab/report` gera o envio; `dogfood-init` cria a estrutura do fluxo de trabalho). O guia do operador, a referência da CLI, a referência do esquema e os exemplos de integração estão disponíveis no **[manual](https://dogfood-lab.github.io/testing-os/handbook/)**. Os detalhes por versão estão em [CHANGELOG.md](CHANGELOG.md).

## Modelo de ameaças

testing-os processa envios do Dogfood enviados por meio de `repository_dispatch` de repositórios confiáveis do GitHub sob `mcp-tool-shop-org/*` e `dogfood-lab/*`. O verificador requer a proveniência do GitHub Actions — os IDs de execução reivindicados são confirmados por meio da API do GitHub, e os envios com formas malformadas, referências ausentes ou reivindicações de política inválidas são rejeitados.

**A proveniência é a comprovação.** Para um envio do `github`, o verificador confirma que a execução do GitHub Actions alegada realmente existe (API do GitHub) e associa o `repo` e o `commit_sha` do envio àquela execução confirmada — uma verificação ativa e sem necessidade de chaves, baseada na própria identidade OIDC do GitHub, para que um registro não possa atestar uma execução ou commit que não ocorreu. O **GitLab CI** é suportado como opção (`source.provider: gitlab`); um envio do GitLab é o único caso em que o verificador chama um host diferente do GitHub (`gitlab.com/api`) e apenas para envios do `gitlab`.

**A integridade do registro é evidente contra adulterações, mas não à prova de adulterações.** Cada registro persistido contém um bloco de `integridade` (`submission_digest` + `prev_digest`), formando uma cadeia hash que permite apenas adições e que o comando `dogfood ingest --verify-chain` valida completamente offline — detectando adulterações externas, corrupção do disco e restaurações parciais. Ele **não** protege contra as credenciais de envio em si, que podem reescrever tanto um registro quanto a cadeia; para evitar isso, é necessária uma âncora fora do controle do escritor. Uma **âncora XRPL opcional, desativada por padrão** (`dogfood ingest --anchor-*`), testemunha o cabeçalho da cadeia no XRP Ledger público, tornando qualquer truncamento ou reescrita abaixo de um ponto ancorado detectável — a segunda chamada não GitHub divulgada e apenas quando um operador a habilita.

**O que testing-os acessa:** o JSON de envio em cada carga útil `repository_dispatch`; `policies/`, `fixtures/`, `records/` e `indexes/` neste repositório; chamadas de saída para `api.github.com` para verificação de proveniência.

**O que testing-os NÃO acessa:** código-fonte do consumidor, segredos nos repositórios do consumidor além do envelope de envio ou qualquer coisa fora da árvore de trabalho deste repositório.

**Superfície de rede.** Por padrão, a única saída é `api.github.com` (proveniência somente leitura). As duas exceções são opcionais e foram divulgadas acima: um envio do provedor GitLab (`gitlab.com/api`) e uma âncora XRPL habilitada pelo operador. **Sem telemetria, sem análise — este código-fonte nunca se conecta a nenhum servidor; na ausência desses dois caminhos opcionais, ele não expõe nenhuma superfície de rede além do GitHub.** O fluxo de trabalho do receptor é executado com permissões `contents: write` restritas apenas a este repositório.

## Pacotes

| Pacote | Fonte | Finalidade |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Os 8 esquemas JSON (registro, descoberta, padrão, recomendação, doutrina, política, cenário, envio). |
| `@dogfood-lab/verify` | JS | Validador de envio central. Os envios passam por aqui antes de serem persistidos. |
| `@dogfood-lab/findings` | JS | Contrato de descoberta + pipelines de derivação/revisão/síntese/aconselhamento. |
| `@dogfood-lab/ingest` | JS | Cola do pipeline: envio → verificação → persistência → indexação. |
| `@dogfood-lab/report` | JS | Construtor de envio para repositórios de origem. |
| `@dogfood-lab/portfolio` | JS | Gerador de portfólio entre repositórios. |
| `@dogfood-lab/dogfood-swarm` | JS | O protocolo de agente paralelo de 10 fases + plano de controle SQLite + binário `swarm`. |

Ferramentas de teste irmãs que **permanecem independentes**, mas se integram por meio de APIs publicadas: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

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

## Desenvolvimento local

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Requer Node ≥ 22. A matriz de CI executa o Node 22 e 24 no `ubuntu-latest`; validado localmente no Node 25.

**Sistemas de arquivos suportados:** APFS, HFS+, ext4 (base de referência da CI), NTFS — qualquer sistema que implemente o POSIX `link(2)`. **Não suportado:** exFAT, FAT32. O CAS de bloqueio de arquivos em [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) requer semântica de link físico para publicação atômica; no exFAT, `linkSync` gera `ENOTSUP` (mensagem explícita, não silenciosa). Um erro comum: SSDs externos multiplataforma são frequentemente formatados em exFAT — clone o repositório para um APFS/HFS+ local. Consulte [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) para a matriz completa de validação da Sessão G.

## Controle de versão

Todos os pacotes `@dogfood-lab/*` são atualizados em conjunto — um único número em todo o monorepositorio. Seis pacotes são publicados no npm sob `@dogfood-lab` na versão v1.5.0, de forma sincronizada (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); o sétimo, `@dogfood-lab/portfolio`, permanece interno. A linha da versão perto do topo deste README é gerada automaticamente a partir de `package.json` por meio de [`scripts/sync-version.mjs`](scripts/sync-version.mjs) em cada execução de `npm run build`.

## Licença

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Todos os Repositórios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Coma primeiro. Lance depois.*

</div
