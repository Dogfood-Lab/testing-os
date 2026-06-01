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
**v1.3.1** — versão atual. Consulte o arquivo [CHANGELOG.md](CHANGELOG.md) para ver as novidades.
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

O guia do operador, a referência da interface de linha de comando (CLI), a referência do esquema e as instruções de integração estão disponíveis em **[handbook](https://dogfood-lab.github.io/testing-os/handbook/)**. Os detalhes específicos de cada versão podem ser encontrados em [CHANGELOG.md](CHANGELOG.md).

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

Todos os pacotes `@dogfood-lab/*` são atualizados em conjunto — um único número para todo o monorepositorio. Seis pacotes são publicados no npm sob `@dogfood-lab` na versão v1.3.1, de forma sincronizada (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); o sétimo, `@dogfood-lab/portfolio`, permanece interno. A linha de versão no início deste arquivo README é gerada automaticamente a partir do arquivo `package.json` por meio de [`scripts/sync-version.mjs`](scripts/sync-version.mjs) a cada execução de `npm run build`.

## Licença

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Todos os Repositórios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Coma primeiro. Lance depois.*

</div
