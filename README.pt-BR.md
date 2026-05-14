<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.md">English</a>
</p>

<div align="center">

# testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**Sistema operacional para testes na era da IA**

*Protocolos, armazenamentos de evidências e ciclos de aprendizado para software com assistência de IA.*

<!-- version:start -->
**v0.2.0-pre** — 7 pacotes (`@dogfood-lab/*`), conjunto de testes abrangente, receptor ativo, manual publicado.
<!-- version:end -->

📖 **[Leia o manual →](https://dogfood-lab.github.io/testing-os/)**

</div>

---

## O que é isso

`testing-os` é o principal repositório monolítico da organização GitHub [Dogfood Lab](https://github.com/dogfood-lab) — sucessor do agora arquivado [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs). Ele reúne os protocolos e a infraestrutura para executar, registrar e aprender com testes em um fluxo de trabalho de desenvolvimento nativo de IA:

- Um **protocolo de enxame** para executar auditorias paralelas em um código-fonte.
- Um **armazenamento de evidências + estrutura de esquema** para os registros, descobertas, padrões e recomendações que resultam dessas execuções.
- Uma camada de **política + verificador** que decide o que conta como "verificado" e aplica isso em todos os repositórios.
- Uma camada de **inteligência** que transforma descobertas brutas em padrões e doutrinas reutilizáveis.

## Status

Migração de `mcp-tool-shop-org/dogfood-labs` concluída (25/04/2026). O receptor está ativo: os fluxos de trabalho `dogfood.yml` em repositórios clientes são enviados para este repositório, e o arquivo `[.github/workflows/ingest.yml](.github/workflows/ingest.yml)` commita os registros resultantes e os índices para o diretório `main`. O manual está disponível em [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). A versão 1.0.0 será lançada quando os ajustes pós-migração em [HANDOFF.md](HANDOFF.md) forem concluídos.

## Pacotes

| Pacote | Fonte | Propósito |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Os 8 esquemas JSON (registro, descoberta, padrão, recomendação, doutrina, política, cenário, envio). |
| `@dogfood-lab/verify` | JS | Validador central de envios. Os envios passam por aqui antes de serem persistidos. |
| `@dogfood-lab/findings` | JS | Contrato de descoberta + pipelines de derivação/revisão/síntese/aconselhamento. |
| `@dogfood-lab/ingest` | JS | Cola de pipeline: despacho → verificação → persistência → indexação. |
| `@dogfood-lab/report` | JS | Construtor de envios para repositórios de origem. |
| `@dogfood-lab/portfolio` | JS | Gerador de portfólio entre repositórios. |
| `@dogfood-lab/dogfood-swarm` | JS | O protocolo paralelo de 10 fases + plano de controle SQLite + binário `swarm`. |

Ferramentas de teste relacionadas que **permanecem independentes**, mas se integram por meio de APIs publicadas: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Layout

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

## Desenvolvimento Local

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Requer Node ≥ 20.

## Versionamento

Sincronizado em todos os pacotes `@dogfood-lab/*`. Atualmente `0.1.0-pre`; a primeira versão estável será `1.0.0` quando os ajustes pós-migração em [HANDOFF.md](HANDOFF.md) forem concluídos. A linha de versão neste arquivo README é automaticamente gerada a partir de `package.json` via `scripts/sync-version.mjs` (executado como `prebuild`).

## Licença

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/)** · **[Todos os repositórios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Experimente primeiro. Lance depois.*

</div>
