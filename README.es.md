<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
</p>

<div align="center">

# ```text
testing-os

[![CI](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml/badge.svg)](https://github.com/dogfood-lab/testing-os/actions/workflows/ci.yml)
[![Pages](https://github.com/dogfood-lab/testing-os/actions/workflows/pages.yml/badge.svg)](https://dogfood-lab.github.io/testing-os/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

**Sistema operativo para pruebas en la era de la IA**

*Protocolos, almacenes de evidencia y bucles de aprendizaje para software asistido por IA.*

<!-- version:start -->
**v0.2.0-pre** — 7 paquetes (`@dogfood-lab/*`), conjunto de pruebas para todo el espacio de trabajo, receptor de ingest activo, manual desplegado.
<!-- version:end -->

📖 **[Leer el manual →](https://dogfood-lab.github.io/testing-os/)**

</div>

---

## ¿Qué es esto?

`testing-os` es el repositorio monolítico principal de la organización de GitHub [Dogfood Lab](https://github.com/dogfood-lab) — sucesor de la organización ahora archivada [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs).  Agrupa los protocolos y la infraestructura para ejecutar, registrar y aprender de las pruebas en un flujo de trabajo de desarrollo nativo de IA:

- Un **protocolo de enjambre** para ejecutar auditorías paralelas contra una base de código.
- Un **almacén de evidencia + columna vertebral de esquema** para los registros, hallazgos, patrones y recomendaciones que se obtienen de esas ejecuciones.
- Una **capa de políticas + verificador** que decide qué cuenta como "verificado" y lo hace cumplir en los repositorios de los consumidores.
- Una **capa de inteligencia** que convierte los hallazgos brutos en patrones y doctrina reutilizables.

## Estado

Migración de `mcp-tool-shop-org/dogfood-labs` completada (25 de abril de 2026). El receptor está activo: los flujos de trabajo de `dogfood.yml` en los repositorios de los consumidores se dirigen a este repositorio, y el archivo `[.github/workflows/ingest.yml`](.github/workflows/ingest.yml) confirma los registros y los índices resultantes en `main`. El manual está disponible en [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). La versión 1.0.0 se lanzará una vez que se complete el ajuste final de la migración en [HANDOFF.md](HANDOFF.md).

## Paquetes

| Paquete | Fuente | Propósito |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Los 8 esquemas JSON (registro, hallazgo, patrón, recomendación, doctrina, política, escenario, envío). |
| `@dogfood-lab/verify` | JS | Validador central de envíos. Los envíos pasan por aquí antes de ser persistidos. |
| `@dogfood-lab/findings` | JS | Contrato de hallazgos + flujos de derivación/revisión/síntesis/asesoramiento. |
| `@dogfood-lab/ingest` | JS | Conexión de flujos: despacho → verificación → persistencia → indexación. |
| `@dogfood-lab/report` | JS | Constructor de envíos para repositorios de origen. |
| `@dogfood-lab/portfolio` | JS | Generador de portafolios entre repositorios. |
| `@dogfood-lab/dogfood-swarm` | JS | El protocolo de agente paralelo de 10 fases + plano de control de SQLite + binario `swarm`. |

Herramientas de prueba relacionadas que **se mantienen independientes** pero se integran a través de API publicadas: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Estructura

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

## Desarrollo local

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Requiere Node ≥ 20.

## Versionado

Sincronización en todos los paquetes `@dogfood-lab/*`. Actualmente `0.1.0-pre`; la primera versión estable será `1.0.0` una vez que se complete el ajuste final de la migración en [HANDOFF.md](HANDOFF.md). La línea de versión en este archivo README se estampa automáticamente desde `package.json` a través de `scripts/sync-version.mjs` (se ejecuta como `prebuild`).

## Licencia

[MIT](LICENSE) © 2026 mcp-tool-shop
```

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/)** · **[Todos los repositorios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Priorizar el uso interno. Lanzar al público después.*

</div>
