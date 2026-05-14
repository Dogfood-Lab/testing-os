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
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**Sistema operacional para testes na era da IA**

*Protocolos, armazenamentos de evidências e ciclos de aprendizado para software com assistência de IA.*

<!-- version:start -->
**v1.2.0** — 7 pacotes (`@dogfood-lab/*`), conjunto de testes abrangente para todo o projeto, receptor de ingestão ativo, manual publicado.
<!-- version:end -->

📖 **[Leia o manual →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## O que é isso

`testing-os` é o monorepório principal da organização GitHub [Dogfood Lab](https://github.com/dogfood-lab) — sucessor do agora arquivado [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs). Ele reúne os protocolos e a infraestrutura para executar, registrar e aprender com testes em um fluxo de trabalho de desenvolvimento nativo de IA:

- Um **protocolo de enxame** para executar auditorias paralelas em um código-fonte.
- Um **armazenamento de evidências + estrutura de esquema** para os registros, descobertas, padrões e recomendações que resultam dessas execuções.
- Uma **camada de política + verificador** que decide o que conta como "verificado" — e aplica isso em todos os repositórios.
- Uma **camada de inteligência** que transforma descobertas brutas em padrões e doutrinas reutilizáveis.

## Status

**v1.2.1** — Lançamento de correção que adiciona o logotipo "testing-os" a cada arquivo README de cada pacote, para que ele seja exibido em cada página do npm. (Na versão v1.2.0, três pacotes foram lançados no mesmo dia sem o logotipo; a versão v1.2.1 corrige esse problema em todos os 6 pacotes). Todos os recursos da Fase 5 foram mantidos da versão v1.2.0: máquina de estados de nível de onda + contrato de recuperação "Three R's" (`swarm revalidate`, `swarm rewind`, `swarm redrive`) + verbo de rastreamento de auditoria `swarm history` + verificação de saúde nas fases A a D com 0 CRÍTICO / 0 ALTO. Seis pacotes foram publicados sob o nome `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. **1105 testes.** Total acumulado ao longo do ciclo de vida do repositório (desde a versão v1.0.0, corte de 2026-04-25): o "dogfood swarm" da Fase 7 (aproximadamente 31 ondas, aproximadamente 115 correções verificadas e implementadas, 14 classes de cobertura de auditoria) e agora o ciclo de lançamento inicial no npm da versão v1.2.x. Catálogo completo do "swarm": [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md).

O receptor está ativo: os fluxos de trabalho `dogfood.yml` em repositórios clientes são enviados para este repositório, e o arquivo [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) commita os registros resultantes e os índices de volta para o branch `main`. O manual está disponível em [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). Instalação principal: `npm install -g @dogfood-lab/dogfood-swarm`. O lado do receptor continua sendo consumido por meio de envio — veja a página de Integração do manual.

**Plataforma:** validado de ponta a ponta no Darwin/APFS como parte da Sessão G ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)). Consulte [Desenvolvimento Local](#local-development) para os sistemas de arquivos suportados. Detalhes por versão em [CHANGELOG.md](CHANGELOG.md).

## Modelo de Ameaças

`testing-os` processa submissões do tipo dogfood enviadas via `repository_dispatch` de repositórios GitHub confiáveis sob `mcp-tool-shop-org/*` e `dogfood-lab/*`. O verificador requer a autenticidade do GitHub Actions — os IDs de execução declarados são confirmados por meio da API do GitHub, e as submissões com formatos incorretos, referências ausentes ou reivindicações de política inválidas são rejeitadas.

**O que o `testing-os` acessa:** o JSON de submissão em cada payload `repository_dispatch`; `policies/`, `fixtures/`, `records/` e `indexes/` neste repositório; chamadas de saída para `api.github.com` para verificação de autenticidade.

**O que o "testing-os" NÃO acessa:** código-fonte de aplicações, segredos em repositórios de aplicações além do escopo de envio, ou qualquer coisa fora da árvore de trabalho deste repositório.

**Permissões necessárias:** o fluxo de trabalho do receptor é executado com a permissão `contents: write`, restrita apenas a este repositório. A verificação de origem utiliza o `GITHUB_TOKEN` padrão do fluxo de trabalho para chamadas de API do GitHub somente leitura. **Não há telemetria, nem serviços de terceiros, nem análises — este código não envia dados para fora e não expõe nenhuma superfície de rede além do GitHub.**

## Pacotes

| Pacote | Origem | Propósito |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Os 8 esquemas JSON (registro, descoberta, padrão, recomendação, doutrina, política, cenário, submissão). |
| `@dogfood-lab/verify` | JS | Validador central de submissões. As submissões passam por aqui antes de serem persistidas. |
| `@dogfood-lab/findings` | JS | Contrato de descoberta + pipelines de derivação/revisão/síntese/aconselhamento. |
| `@dogfood-lab/ingest` | JS | Conexão entre pipelines: envio → verificação → persistência → indexação. |
| `@dogfood-lab/report` | JS | Construtor de submissões para repositórios de origem. |
| `@dogfood-lab/portfolio` | JS | Gerador de portfólio entre repositórios. |
| `@dogfood-lab/dogfood-swarm` | JS | Protocolo paralelo de 10 fases + plano de controle SQLite + utilitário `swarm`. |

Ferramentas de teste relacionadas que **permanecem independentes**, mas se integram através de APIs publicadas: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Estrutura

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

## Desenvolvimento Local

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Requer Node ≥ 20. A matriz de CI executa Node 20 + 22 em `ubuntu-latest`; validado localmente com Node 25.

**Sistemas de arquivos suportados:** APFS, HFS+, ext4 (baseline do CI), NTFS — qualquer um que implemente `link(2)` do POSIX. **Não suportados:** exFAT, FAT32. O bloqueio de arquivos CAS em [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) requer semântica de hardlink para publicação atômica; no exFAT, `linkSync` lança `ENOTSUP` (de forma explícita, não silenciosa). Um problema comum: SSDs externos multiplataforma são frequentemente formatados em exFAT — clone o repositório para um APFS/HFS+ local em vez disso. Consulte [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) para a matriz completa de validação da Sessão G.

## Versionamento

Sincronização em todos os pacotes `@dogfood-lab/*` — eles são atualizados juntos. A linha de versão neste arquivo README é gerada automaticamente a partir do `package.json` via `scripts/sync-version.mjs` (executado como `prebuild`). A partir da versão **v1.2.0**, seis pacotes são publicados no npm sob o escopo `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. O sétimo (`@dogfood-lab/portfolio`) permanece interno ao monorepositorio.

## Licença

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Todos os Repositórios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Coma primeiro. Envie depois.*

</div
