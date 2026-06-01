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
**v1.3.0** — 7 pacotes (`@dogfood-lab/*`), conjunto de testes em todo o espaço de trabalho, receptor de ingestão ativo, manual implementado.
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

## Status

**v1.3.0** — um único validador de esquema canônico em todos os consumidores (uma instância Ajv por esquema por processo; uma divisão de elevação de espaço de trabalho é uma barreira rígida). Erros estruturados de nível superior com códigos estáveis (`ISOLATION_FAILED`, `DUPLICATE_RUN_ID`, `STATE_MACHINE_*`, `DISPATCH_*`, `VALIDATOR_FAULT_*`, …) e uma dica `Next:` em cada caminho de falha. O YAML de política agora é validado pelo esquema no momento do carregamento — um arquivo de política estruturalmente inválido falha de forma explícita, em vez de passar silenciosamente para valores padrão mais permissivos. O manual em [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) vem com paridade de temas claro/escuro, acessibilidade WCAG-AA por página (pa11y no CI com repetição), uma referência CLI `swarm` por verbo e um 404 personalizado. Seis pacotes são publicados no npm sob `@dogfood-lab` na v1.3.0 em sincronia — veja a tabela abaixo. Sem alterações incompatíveis em relação à v1.2.x. Consulte [CHANGELOG.md](CHANGELOG.md) para a entrada completa da v1.3.0.

O receptor está ativo: os fluxos de trabalho `dogfood.yml` nos repositórios de consumidores são enviados para este repositório, e o arquivo [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) confirma os registros e índices resultantes de volta para `main`. O manual é implementado em [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). A instalação principal: `npm install -g @dogfood-lab/dogfood-swarm`. O lado do receptor continua a ser consumido por meio de envio — consulte a página de Integração no manual.

**Plataforma:** validado de ponta a ponta em Darwin/APFS como parte da Sessão G ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)). Consulte [Desenvolvimento local](#local-development) para os sistemas de arquivos suportados. Detalhes por versão em [CHANGELOG.md](CHANGELOG.md).

## Modelo de ameaças

testing-os processa envios do Dogfood enviados por meio de `repository_dispatch` de repositórios confiáveis do GitHub sob `mcp-tool-shop-org/*` e `dogfood-lab/*`. O verificador requer a proveniência do GitHub Actions — os IDs de execução reivindicados são confirmados por meio da API do GitHub, e os envios com formas malformadas, referências ausentes ou reivindicações de política inválidas são rejeitados.

**O que testing-os acessa:** o JSON de envio em cada carga útil `repository_dispatch`; `policies/`, `fixtures/`, `records/` e `indexes/` neste repositório; chamadas de saída para `api.github.com` para verificação de proveniência.

**O que testing-os NÃO acessa:** código-fonte do consumidor, segredos nos repositórios do consumidor além do envelope de envio ou qualquer coisa fora da árvore de trabalho deste repositório.

**Permissões necessárias:** o fluxo de trabalho do receptor é executado com `contents: write` restrito a este repositório. A verificação de proveniência usa o `GITHUB_TOKEN` padrão do fluxo de trabalho para chamadas de API de Ações somente leitura. **Sem telemetria, sem serviços de terceiros, sem análises — este código-base não envia informações para casa nem expõe uma superfície de rede além do GitHub.**

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
├── scripts/                   # Repo-level utilities (sync-version, build)
└── .github/workflows/         # ci.yml, ingest.yml, pages.yml
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

Controle de versão sincronizado em todos os pacotes `@dogfood-lab/*` — eles são atualizados em conjunto. A linha de versão neste arquivo README é gerada automaticamente a partir de `package.json` por meio de `scripts/sync-version.mjs` (executado como `prebuild`). A partir da **versão 1.2.0**, seis pacotes são publicados no npm sob o escopo `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. O sétimo (`@dogfood-lab/portfolio`) permanece interno ao monorepos.

## Licença

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Todos os Repositórios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Coma primeiro. Lance depois.*

</div
