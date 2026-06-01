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
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Sistema operativo para pruebas en la era de la IA**

*Protocolos, almacenes de pruebas y ciclos de aprendizaje para software asistido por IA.*

<!-- version:start -->
**v1.3.0** — 7 paquetes (`@dogfood-lab/*`), suite de pruebas a nivel de espacio de trabajo, receptor de datos activo, manual implementado.
<!-- version:end -->

📖 **[Lea el manual →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## ¿Qué es esto?

`testing-os` es el repositorio monorepo principal de la organización [Dogfood Lab](https://github.com/dogfood-lab) de GitHub, sucesor del ahora archivado [`mcp-tool-shop-org/dogfood-labs`](https://github.com/mcp-tool-shop-org/dogfood-labs). Agrupa los protocolos y la infraestructura para ejecutar, registrar y aprender de las pruebas en un flujo de trabajo de desarrollo nativo de la IA:

- Un **protocolo de enjambre** para ejecutar auditorías de agentes paralelos en una base de código.
- Un **almacén de pruebas + estructura de esquema** para los registros, los hallazgos, los patrones y las recomendaciones que se obtienen de esas ejecuciones.
- Una **capa de políticas + verificador** que decide qué se considera "verificado" y lo aplica en todos los repositorios de consumidores.
- Una **capa de inteligencia** que convierte los hallazgos brutos en patrones y doctrinas reutilizables.

## Estado

**v1.3.0** — un único validador de esquemas canónico en todos los consumidores (una instancia de Ajv por esquema por proceso; la división a nivel de espacio de trabajo es una restricción estricta). Errores estructurados de nivel superior con códigos estables (`ISOLATION_FAILED`, `DUPLICATE_RUN_ID`, `STATE_MACHINE_*`, `DISPATCH_*`, `VALIDATOR_FAULT_*`, …) y una indicación `Next:` en cada ruta de error. El archivo YAML de políticas ahora se valida a nivel de esquema en el momento de la carga; un archivo de políticas estructuralmente inválido genera un error en lugar de pasar silenciosamente a valores predeterminados permisivos. El manual en [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/) incluye temas claros y oscuros, accesibilidad WCAG-AA por página (pa11y en CI con reintento), una referencia CLI `swarm` por verbo y una página 404 personalizada. Seis paquetes se publican en npm bajo `@dogfood-lab` en v1.3.0 de forma sincronizada; consulte la tabla a continuación. No hay cambios importantes con respecto a v1.2.x. Consulte [CHANGELOG.md](CHANGELOG.md) para obtener la entrada completa de v1.3.0.

El receptor está activo: los flujos de trabajo `dogfood.yml` en los repositorios de consumidores se envían a este repositorio, y [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) confirma los registros y los índices resultantes de nuevo en `main`. El manual se implementa en [dogfood-lab.github.io/testing-os/](https://dogfood-lab.github.io/testing-os/). Instalación principal: `npm install -g @dogfood-lab/dogfood-swarm`. El lado del receptor se mantiene a través del envío; consulte la página de Integración del manual.

**Plataforma:** validada de extremo a extremo en Darwin/APFS como parte de la Sesión G ([`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md)). Consulte [Desarrollo local](#local-development) para conocer los sistemas de archivos compatibles. Detalles por versión en [CHANGELOG.md](CHANGELOG.md).

## Modelo de amenazas

testing-os procesa los envíos de Dogfood enviados a través de `repository_dispatch` desde repositorios de GitHub confiables bajo `mcp-tool-shop-org/*` y `dogfood-lab/*`. El verificador requiere la procedencia de GitHub Actions; se confirman los ID de ejecución declarados a través de la API de GitHub, y se rechazan los envíos con formas incorrectas, referencias faltantes o reclamaciones de políticas no válidas.

**Qué toca testing-os:** el JSON de envío en cada carga útil de `repository_dispatch`; `policies/`, `fixtures/`, `records/` e `indexes/` en este repositorio; llamadas salientes a `api.github.com` para la verificación de la procedencia.

**Qué NO toca testing-os:** el código fuente del consumidor, los secretos en los repositorios del consumidor más allá del sobre de envío, o cualquier cosa fuera del árbol de trabajo de este repositorio.

**Permisos requeridos:** el flujo de trabajo del receptor se ejecuta con `contents: write` limitado a este repositorio. La verificación de la procedencia utiliza el `GITHUB_TOKEN` predeterminado del flujo de trabajo para las llamadas de la API de Actions de solo lectura. **No hay telemetría, no hay servicios de terceros, no hay análisis; este código base no se comunica con el exterior ni expone una superficie de red más allá de GitHub.**

## Paquetes

| Paquete | Origen | Propósito |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Los 8 esquemas JSON (registro, hallazgo, patrón, recomendación, doctrina, política, escenario, envío). |
| `@dogfood-lab/verify` | JS | Validador de envíos central. Los envíos pasan por aquí antes de que se almacenen. |
| `@dogfood-lab/findings` | JS | Contrato de hallazgo + tuberías de derivación/revisión/síntesis/asesoramiento. |
| `@dogfood-lab/ingest` | JS | Conexión de la tubería: envío → verificación → persistencia → indexación. |
| `@dogfood-lab/report` | JS | Constructor de envíos para repositorios de origen. |
| `@dogfood-lab/portfolio` | JS | Generador de carteras entre repositorios. |
| `@dogfood-lab/dogfood-swarm` | JS | El protocolo de agentes paralelos de 10 fases + plano de control SQLite + bin `swarm`. |

Herramientas de prueba secundarias que **permanecen independientes** pero se integran a través de API publicadas: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Diseño

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

Requiere Node ≥ 22. La matriz de CI ejecuta Node 22 y 24 en `ubuntu-latest`; se valida localmente en Node 25.

**Sistemas de archivos compatibles:** APFS, HFS+, ext4 (línea de base de CI), NTFS; cualquier sistema que implemente POSIX `link(2)`. **No compatibles:** exFAT, FAT32. El CAS de bloqueo de archivos en [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) requiere semántica de enlace duro para la publicación atómica; en exFAT, `linkSync` genera `ENOTSUP` (mensaje visible, no silencioso). Un error común: los SSD externos multiplataforma a menudo están formateados en exFAT; en su lugar, clone el repositorio en APFS/HFS+ local. Consulte [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) para obtener la matriz completa de validación de la Sesión G.

## Control de versiones

Control de versiones sincronizado en todos los paquetes `@dogfood-lab/*`; se actualizan juntos. La línea de versión en este archivo README se genera automáticamente a partir de `package.json` mediante `scripts/sync-version.mjs` (se ejecuta como `prebuild`). A partir de la **versión 1.2.0**, seis paquetes se publican en npm bajo el ámbito `@dogfood-lab`: `schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`. El séptimo (`@dogfood-lab/portfolio`) permanece interno al monorepositorio.

## Licencia

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Todos los repositorios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Primero, come. Luego, publica.*

</div
