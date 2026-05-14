<p align="center">
  <a href="README.ja.md">日本語</a> | <a href="README.zh.md">中文</a> | <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.hi.md">हिन्दी</a> | <a href="README.it.md">Italiano</a> | <a href="README.pt-BR.md">Português (BR)</a>
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

**Sistema operativo para pruebas en la era de la IA**

*Protocolos, almacenes de evidencia y bucles de aprendizaje para software asistido por IA.*

<!-- version:start -->
**v1.2.0** — 7 paquetes (`@dogfood-lab/*`), conjunto de pruebas para todo el espacio de trabajo, receptor de ingest activo, manual desplegado.
<!-- version:end -->

📖 **[Leer el manual →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## ¿Qué es esto?

`testing-os` es el repositorio monolítico principal de la organización de GitHub [Dogfood Lab](https://github.com/dogfood-lab) — sucesor de la organización ahora archivada [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs).  Agrupa los protocolos y la infraestructura para ejecutar, registrar y aprender de las pruebas en un flujo de trabajo de desarrollo nativo de IA:

- Un **protocolo de enjambre** para ejecutar auditorías paralelas contra una base de código.
- Un **almacén de evidencia + columna vertebral de esquema** para los registros, hallazgos, patrones y recomendaciones que surgen de esas ejecuciones.
- Una **capa de políticas + verificador** que decide qué cuenta como "verificado" y lo hace cumplir en los repositorios de los consumidores.
- Una **capa de inteligencia** que convierte los hallazgos brutos en patrones y doctrina reutilizables.

## Estado

**v1.2.0** — primera publicación de npm del monorepo `@dogfood-lab/*`. Seis paquetes ahora están disponibles públicamente bajo el alcance `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm` (el CLI de "enjambre" principal). Novedades en esta versión: máquina de estados de nivel de ola + contrato de recuperación de las Tres R (`swarm revalidate`, `swarm rewind`, `swarm redrive`) + verbo `swarm history` para el registro de auditoría + prueba de salud de la Fase A–D a 0 CRIT / 0 HIGH. **1105/1105 pruebas.** Acumuladas durante toda la vida del repositorio (desde la versión v1.0.0, fecha de corte 2026-04-25): todo lo anterior más el enjambre de la Fase 7 (~31 iteraciones, ~115 correcciones verificadas, 14 clases de cobertura de auditoría). Catálogo de enjambre autorizado: [`docs/swarm-evidence-2026-04-27.md`](docs/swarm-evidence-2026-04-27.md).

El receptor está activo: los flujos de trabajo de `dogfood.yml` en los repositorios de los consumidores se envían a este repositorio, y [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) confirma los registros resultantes y los índices en `main`. El manual está disponible en [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). Instalación principal: `npm install -g @dogfood-lab/dogfood-swarm`. El lado del receptor se consume a través del envío; consulte la página de Integración del manual.

**Plataforma:** validado de extremo a extremo en Darwin/APFS como parte de la Sesión G ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)). Consulte [Desarrollo local](#local-development) para obtener información sobre los sistemas de archivos compatibles. Detalles de la versión en [CHANGELOG.md](CHANGELOG.md).

## Modelo de amenazas

`testing-os` procesa las envíos de `dogfood` enviados a través de `repository_dispatch` desde repositorios de GitHub confiables bajo `mcp-tool-shop-org/*` y `dogfood-lab/*`. El verificador requiere la autenticidad de GitHub Actions; los ID de ejecución reclamados se confirman a través de la API de GitHub, y los envíos con formatos incorrectos, referencias faltantes o reclamaciones de políticas inválidas se rechazan.

**Qué toca `testing-os`:** el JSON de envío en cada carga útil de `repository_dispatch`; `policies/`, `fixtures/`, `records/` y `indexes/` en este repositorio; llamadas de salida a `api.github.com` para la verificación de la autenticidad.

**Lo que testing-os NO modifica:** código fuente de componentes, secretos en repositorios de componentes que estén fuera del ámbito de envío, o cualquier cosa que esté fuera del árbol de trabajo de este repositorio.

**Permisos requeridos:** el flujo de trabajo del receptor se ejecuta con `contents: write` limitado únicamente a este repositorio. La verificación de la procedencia utiliza el `GITHUB_TOKEN` predeterminado del flujo de trabajo para llamadas de solo lectura a la API de Actions. **No hay telemetría, ni servicios de terceros, ni análisis: este código no envía información a ningún servidor ni expone ninguna superficie de red más allá de GitHub.**

## Paquetes

| Paquete | Origen | Propósito |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Los 8 esquemas JSON (registro, hallazgo, patrón, recomendación, doctrina, política, escenario, envío). |
| `@dogfood-lab/verify` | JS | Validador central de envíos. Los envíos pasan por aquí antes de ser persistidos. |
| `@dogfood-lab/findings` | JS | Contrato de hallazgo + flujos de trabajo de derivación/revisión/síntesis/asesoramiento. |
| `@dogfood-lab/ingest` | JS | Conexión de flujos de trabajo: envío → verificación → persistencia → indexación. |
| `@dogfood-lab/report` | JS | Constructor de envíos para repositorios de origen. |
| `@dogfood-lab/portfolio` | JS | Generador de portafolios entre repositorios. |
| `@dogfood-lab/dogfood-swarm` | JS | Protocolo paralelo de 10 fases + plano de control SQLite + binario `swarm`. |

Herramientas de prueba relacionadas que **permanecen independientes** pero se integran a través de APIs publicadas: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Estructura

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

## Desarrollo local

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # build + test (canonical pre-commit check)
```

Requiere Node ≥ 20. La matriz de CI ejecuta Node 20 + 22 en `ubuntu-latest`; se valida localmente con Node 25.

**Sistemas de archivos compatibles:** APFS, HFS+, ext4 (línea base de CI), NTFS; cualquier sistema que implemente `link(2)` de POSIX. **No compatibles:** exFAT, FAT32. El bloqueo de archivos CAS en [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) requiere semántica de enlace duro para la publicación atómica; en exFAT, `linkSync` lanza `ENOTSUP` (un error claro, no silencioso). Un problema común: las unidades SSD externas multiplataforma a menudo están formateadas en exFAT; clone el repositorio a un sistema APFS/HFS+ local en su lugar. Consulte [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) para la matriz completa de validación de la sesión G.

## Versionado

Sincronización en todos los paquetes `@dogfood-lab/*`; se actualizan conjuntamente. La línea de versión en este archivo README se genera automáticamente desde `package.json` a través de `scripts/sync-version.mjs` (se ejecuta como `prebuild`). A partir de la versión **v1.2.0**, seis paquetes se publican en npm bajo el alcance `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. El séptimo (`@dogfood-lab/portfolio`) permanece interno al monorepositorio.

## Licencia

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Todos los repositorios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Comer primero. Enviar después.*

</div
