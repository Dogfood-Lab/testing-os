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
[![dogfood](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/badges/dogfood-lab--testing-os--cli.json)](https://dogfood-lab.github.io/testing-os/handbook/read-model/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](package.json)

**Sistema operativo para pruebas en la era de la IA.**

*Protocolos, almacenes de evidencia y ciclos de aprendizaje para software asistido por IA.*

<!-- version:start -->
**v1.11.0** — versión actual. Consulte [CHANGELOG.md](CHANGELOG.md) para ver las novedades.
<!-- version:end -->

📖 **[Lea el manual →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div

---

## ¿Qué es esto?

`testing-os` registra, verifica y aprende de la evidencia real de las pruebas de su repositorio en un flujo de trabajo nativo de IA. Apúntelo a un repositorio y cada ejecución de prueba se convertirá en un registro confirmado por su procedencia, en el que puede confiar, y no solo en una confirmación autoinformada.

Lo que obtendrá:

- **Registros con confirmación de procedencia.** Cada envío está vinculado a una ejecución real de CI, sin necesidad de claves, mediante la propia identidad del proveedor, antes de ser aceptado. El resultado es un almacén de evidencia inmutable y de solo anexión, no una simple marca verde basada en la confianza.
- **Un contrato de políticas que usted controla.** Declare qué cuenta como "verificado" en YAML: un DSL de predicados acotado y sin evaluación (`field`/`op`/`value` + `all`/`any`/`not`/`implies`), y aplíquelo en todos sus repositorios. Analice una política antes de implementarla con `dogfood-verify lint`.
- **Un protocolo de enjambre de agentes paralelos.** Ejecute auditorías multiagente contra una base de código y, a continuación, convierta los resultados brutos en patrones y doctrinas reutilizables.
- **Una superficie de estado en vivo.** Registros por repositorio, índices y un distintivo de estado, todo servido desde un único almacén de evidencia.

Es el monorepositorio insignia de la organización [Dogfood Lab](https://github.com/dogfood-lab): siete paquetes `@dogfood-lab/*` detrás de una CLI `swarm`.

## Comenzar rápidamente

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

¿Quiere que se registre la evidencia de las pruebas de su propio repositorio aquí? El **[kit de inicio `examples/`](examples/)** le permitirá empezar en cinco minutos (`dogfood-report` genera el envío; `dogfood-init` crea el flujo de trabajo). La guía del operador, la referencia de la CLI, la referencia del esquema y las recetas de integración se encuentran en el **[manual](https://dogfood-lab.github.io/testing-os/handbook/)**. Los detalles por versión están en [CHANGELOG.md](CHANGELOG.md).

## Modelo de amenazas

testing-os procesa los envíos de dogfood enviados a través de `repository_dispatch` desde repositorios GitHub confiables bajo `mcp-tool-shop-org/*` y `dogfood-lab/*`. El verificador requiere la procedencia de CI: se confirman los ID de ejecución declarados a través de la API del proveedor, y se rechazan los envíos con formatos incorrectos, referencias faltantes o reclamaciones de políticas no válidas.

**La procedencia es la atestación.** Para un envío `github`, el verificador confirma que la ejecución de GitHub Actions declarada realmente existe (API de GitHub) y vincula los elementos `repo` y `commit_sha` del envío a esa ejecución confirmada: una comprobación en vivo y sin claves basada en la identidad OIDC de GitHub, por lo que un registro no puede atestiguar una ejecución o un commit que no se produjo. **GitLab CI** es compatible (opcionalmente; `source.provider: gitlab`); un envío de GitLab es el único caso en el que el verificador llama a un host que no es de GitHub (`gitlab.com/api`), y solo para los envíos `gitlab`.

**La integridad del registro es detectable, pero no inviolable.** Cada registro persistente lleva un bloque `integrity` (`submission_digest` + `prev_digest`) que forma una cadena hash de solo anexión que `node packages/ingest/run.js --verify-chain` valida por completo fuera de línea: detecta manipulaciones externas, corrupción de disco y restauraciones parciales. No defiende contra las credenciales de ingestión en sí mismas, que pueden reescribir tanto un registro como la cadena; para evitarlo, se necesita un ancla fuera del control del escritor. Un **ancla XRPL opcional y desactivada por defecto** (`node packages/ingest/run.js --anchor-*`) da testimonio del encabezado de la cadena al libro mayor público XRP, lo que hace que cualquier truncamiento o reescritura por debajo de un punto anclado sea detectable: la segunda llamada divulgada a un servicio que no es de GitHub, y solo cuando un operador la habilita.

**testing-os interactúa con:** el JSON del envío en cada carga útil `repository_dispatch`; `policies/`, `fixtures/`, `records/`, `indexes/` y `dogfood/roadmap/` en este repositorio (el último solo lo escribe un operador cuando invoca `swarm roadmap compile`, nunca por la ruta de ingestión automatizada); llamadas salientes a `api.github.com` para la verificación de la procedencia; y —solo para los envíos `github`— una recuperación de solo lectura del archivo `dogfood/scenarios/<scenario_id>.yaml` del repositorio que realiza el envío en el commit atestiguado (la definición del escenario que impulsa la aplicación de los pasos obligatorios; tiene un tamaño máximo y se valida según el esquema antes de su uso, y si faltan archivos, simplemente deja esa comprobación sin aplicar con una advertencia visible).

**testing-os NO interactúa con:** código fuente del consumidor más allá de los archivos de definición `dogfood/scenarios/` declarados, secretos en los repositorios del consumidor más allá del sobre de envío o cualquier cosa fuera del árbol de trabajo de este repositorio.

**Las transiciones de estado de los hallazgos son evidencia y se anexan únicamente.** Los verbos de cierre del plano de control del enjambre (`swarm reopen`, `swarm close`) requieren una razón explícita, evidencia y —para los cierres del operador— un modo de verificación declarado; cada transición escribe una fila inmutable `finding_events` que registra la autoridad que actúa. Ninguna ruta automatizada puede cerrar un hallazgo por inactividad o volver a abrirlo mediante predicción, y ningún verbo puede reescribir el historial de eventos: una credencial utilizada incorrectamente puede agregar transiciones, pero cada adición se registra.

**Superficie de red.** Por defecto, la única salida es `api.github.com` (solo lectura: confirmación de procedencia + la recuperación de la definición del escenario mencionada anteriormente). Las dos excepciones son opcionales y se describen arriba: una entrega de un proveedor de GitLab (`gitlab.com/api`) y una ejecución de ancla XRPL habilitada por el operador. **No hay telemetría, no hay análisis; este código base nunca envía datos a casa; sin esos dos caminos opcionales, no expone ninguna superficie de red más allá de GitHub.** El flujo de trabajo del receptor se ejecuta con `contents: write` y está limitado a este repositorio.

## Paquetes

| Paquete | Origen | Propósito |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Los 8 esquemas JSON (registro, hallazgo, patrón, recomendación, doctrina, política, escenario, entrega). |
| `@dogfood-lab/verify` | JS | Validador central de entregas. Las entregas pasan por aquí antes de ser almacenadas. |
| `@dogfood-lab/findings` | JS | Contrato de hallazgos + derivación/revisión/síntesis/canales de asesoramiento. |
| `@dogfood-lab/ingest` | JS | Conexión del flujo de trabajo: envío → verificación → almacenamiento → indexación. |
| `@dogfood-lab/report` | JS | Generador de entregas para repositorios de origen. |
| `@dogfood-lab/portfolio` | JS | Generador de portafolios entre repositorios. |
| `@dogfood-lab/dogfood-swarm` | JS | El protocolo de agente paralelo de 10 fases + plano de control SQLite + `swarm` bin. |

Herramientas de prueba independientes que **se mantienen independientes** pero se integran a través de API publicadas: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

## Diseño

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

## Desarrollo local

```bash
git clone https://github.com/dogfood-lab/testing-os.git
cd testing-os
npm install
npm run build       # tsc --build across all packages
npm test            # vitest for schemas, node --test for the rest
npm run verify      # version-sync + doc-drift + regression-pin gates + build + tests (canonical pre-commit check — NOT the same as build && test)
```

Requiere Node ≥ 22. La matriz de CI ejecuta Node 22 + 24 en `ubuntu-latest`; se valida localmente en Node 25.

**Sistemas de archivos compatibles:** APFS, HFS+, ext4 (línea base de CI), NTFS: cualquier sistema que implemente POSIX `link(2)`. **No compatible:** exFAT, FAT32. El CAS de bloqueo de archivos en [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) requiere semántica de enlace duro para la publicación atómica; en exFAT, `linkSync` lanza `ENOTSUP` (ruidoso, no silencioso). Un problema común: los SSD externos multiplataforma a menudo tienen formato exFAT; en su lugar, clone el repositorio en APFS/HFS+ local. Consulte [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) para obtener la matriz de validación completa de la Sesión G.

## Control de versiones

Todos los paquetes `@dogfood-lab/*` se actualizan juntos: un número en todo el monorepositorio. Seis paquetes se publican en npm bajo `@dogfood-lab` en v1.11.0 de forma sincronizada (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); el séptimo, `@dogfood-lab/portfolio`, permanece interno. La línea de versión cerca de la parte superior de este README se estampa automáticamente desde `package.json` a través de [`scripts/sync-version.mjs`](scripts/sync-version.mjs) en cada `npm run build`.

## Licencia

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Todos los repositorios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Primero, come. Luego, envía.*

</div
