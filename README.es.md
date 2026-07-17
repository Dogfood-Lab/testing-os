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

**Sistema operativo para pruebas en la era de la IA**

*Protocolos, almacenes de evidencia y ciclos de aprendizaje para software asistido por IA.*

<!-- version:start -->
**v1.10.0** — versión actual. Consulte [CHANGELOG.md](CHANGELOG.md) para ver qué se incluyó en esta versión.
<!-- version:end -->

📖 **[Lea el manual →](https://dogfood-lab.github.io/testing-os/handbook/)**

</div&gt;

---

## ¿Qué es esto?

`testing-os` registra, verifica y aprende de las pruebas reales de su repositorio en un flujo de trabajo nativo de IA. Apunte a un repositorio y cada ejecución de prueba se convertirá en un registro con confirmación de procedencia en el que puede confiar, no solo en una aprobación autoinformada.

Lo que obtendrá:

- **Registros con confirmación de procedencia.** Cada envío está vinculado a una ejecución real de CI, sin necesidad de claves, mediante la identidad del propio proveedor, antes de ser aceptado. El resultado es un almacén de pruebas inalterable y de solo anexión, no simplemente una marca verde basada en la confianza.
- **Un contrato de políticas que usted controla.** Declare qué se considera "verificado" en YAML: un DSL de predicados delimitado y sin evaluación (`field`/`op`/`value` + `all`/`any`/`not`/`implies`), y aplíquelo en todos sus repositorios. Analice una política antes de implementarla con `dogfood-verify lint`.
- **Un protocolo de enjambre de agentes paralelos.** Ejecute auditorías multiagente contra una base de código y, a continuación, convierta los resultados brutos en patrones y doctrinas reutilizables.
- **Una superficie de estado en vivo.** Registros e índices por repositorio, así como un distintivo de estado, todo servido desde un único almacén de pruebas.

Es el monorepositorio principal de la organización [Dogfood Lab](https://github.com/dogfood-lab): siete paquetes `@dogfood-lab/*` detrás de una única CLI `swarm`.

## Inicio rápido

```bash
npm install -g @dogfood-lab/dogfood-swarm
swarm --help
```

¿Quiere que las pruebas de su propio repositorio se registren aquí? El **kit de inicio [`examples/`](examples/)** le permitirá empezar en cinco minutos (`npx @dogfood-lab/report` genera el envío; `dogfood-init` crea la estructura del flujo de trabajo). La guía del operador, la referencia de la CLI, la referencia del esquema y las recetas de integración se encuentran en el **[manual](https://dogfood-lab.github.io/testing-os/handbook/)**. Los detalles por versión se encuentran en [CHANGELOG.md](CHANGELOG.md).

## Modelo de amenazas

testing-os procesa los envíos de "dogfood" que se transmiten a través de `repository_dispatch` desde repositorios GitHub confiables bajo `mcp-tool-shop-org/*` y `dogfood-lab/*`. El verificador requiere un origen CI: los ID de ejecución declarados se confirman a través de la API del proveedor, y los envíos con formatos incorrectos, referencias faltantes o afirmaciones de política no válidas se rechazan.

**La procedencia es la prueba.** Para un envío de `github`, el verificador confirma que la ejecución de GitHub Actions reclamada realmente existe (API de GitHub) y vincula el `repo` y el `commit_sha` del envío a esa ejecución confirmada: una comprobación en vivo y sin claves, basada en la identidad OIDC propia de GitHub, por lo que un registro no puede dar fe de una ejecución o un commit que no se produjo. Se admite **GitLab CI** (opcionalmente; `source.provider: gitlab`); un envío de GitLab es el único caso en el que el verificador llama a un host que no es de GitHub (`gitlab.com/api`) y solo para los envíos de `gitlab`.

**La integridad del registro es evidente, pero no infalible.** Cada registro persistente contiene un bloque de `integrity` (`submission_digest` + `prev_digest`), que forma una cadena hash de solo anexión que `dogfood ingest --verify-chain` valida por completo fuera de línea, detectando manipulaciones externas, corrupción del disco y restauraciones parciales. **No** protege contra las credenciales de ingesta en sí, que pueden reescribir tanto un registro como la cadena; para evitarlo, se necesita un ancla fuera del control del escritor. Un **ancla XRPL opcional y desactivada por defecto** (`dogfood ingest --anchor-*`) da testimonio del encabezado de la cadena en el libro mayor público XRP, lo que hace que cualquier truncamiento o reescritura por debajo de un punto anclado sea detectable: esta es la segunda llamada no GitHub revelada y solo se realiza cuando un operador la habilita.

**Qué aspectos toca el proceso de pruebas:** el archivo JSON de envío en cada carga útil de `repository_dispatch`; los directorios `policies/`, `fixtures/`, `records/`, `indexes/` y `dogfood/roadmap/` en este repositorio (el último se escribe solo cuando un operador invoca `swarm roadmap compile`, nunca a través del proceso automatizado de ingestión); las llamadas salientes a `api.github.com` para la verificación de procedencia; y, únicamente para los envíos de `github`, una lectura (solo para consulta) del archivo `dogfood/scenarios/<scenario_id>.yaml` del repositorio que realiza el envío en el commit certificado (la definición del escenario que impulsa la aplicación de los pasos obligatorios; los archivos se limitan en tamaño y se validan según un esquema antes de usarlos; si faltan archivos, simplemente se omite esa comprobación y se muestra una advertencia visible).

**Qué NO afecta testing-os:** código fuente del consumidor más allá de los archivos de definición declarados en `dogfood/scenarios/`, secretos en los repositorios del consumidor más allá del sobre de transmisión, o cualquier cosa fuera del árbol de trabajo de este repositorio.

**Las transiciones de estado de detección son evidencia y solo se pueden agregar.** Los verbos de cierre del plano de control del enjambre (`swarm reopen`, `swarm close`) requieren una razón explícita, evidencia y, para los cierres realizados por un operador, un modo de verificación declarado; cada transición escribe una fila inmutable de `finding_events` que registra la autoridad responsable. Ningún proceso automatizado puede cerrar una detección por falta de actualización o volver a abrirla mediante predicción, y ningún verbo puede reescribir el historial de eventos: unas credenciales utilizadas incorrectamente pueden agregar transiciones, pero cada adición se registra en sí misma.

**Superficie de red.** Por defecto, el único tráfico saliente es hacia `api.github.com` (procedencia en modo de solo lectura). Las dos excepciones son opcionales y se han revelado anteriormente: un envío del proveedor GitLab (`gitlab.com/api`) y una ejecución de ancla XRPL habilitada por el operador. **No hay telemetría ni análisis; este código base nunca "llama a casa"; sin esos dos caminos opcionales, no expone ninguna superficie de red más allá de GitHub.** El flujo de trabajo del receptor se ejecuta con permisos `contents: write` limitados solo a este repositorio.

## Paquetes

| Paquete | Origen | Propósito |
|---------|--------|---------|
| `@dogfood-lab/schemas` | TypeScript | Los 8 esquemas JSON (registro, hallazgo, patrón, recomendación, doctrina, política, escenario, envío). |
| `@dogfood-lab/verify` | JS | Validador central de envíos. Los envíos pasan por aquí antes de que se almacenen. |
| `@dogfood-lab/findings` | JS | Contrato de hallazgos + derivar/revisar/sintetizar/asesorar. |
| `@dogfood-lab/ingest` | JS | Conexión del flujo de trabajo: transmisión → verificación → persistencia → indexación. |
| `@dogfood-lab/report` | JS | Constructor de envíos para repositorios de código fuente. |
| `@dogfood-lab/portfolio` | JS | Generador de portafolios entre repositorios. |
| `@dogfood-lab/dogfood-swarm` | JS | El protocolo paralelo de 10 fases + plano de control SQLite + bin `swarm`. |

Herramientas de prueba complementarias que **permanecen independientes** pero se integran a través de API publicadas: [`shipcheck`](https://github.com/mcp-tool-shop-org/shipcheck), [`repo-knowledge`](https://github.com/mcp-tool-shop-org/repo-knowledge), [`ai-eyes-mcp`](https://github.com/mcp-tool-shop-org/ai-eyes-mcp), [`taste-engine`](https://github.com/mcp-tool-shop-org/taste-engine), [`style-dataset-lab`](https://github.com/mcp-tool-shop-org/style-dataset-lab).

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

**Sistemas de archivos compatibles:** APFS, HFS+, ext4 (línea base de CI), NTFS: cualquier sistema que implemente POSIX `link(2)`. **No compatible:** exFAT, FAT32. El CAS de bloqueo de archivos en [`packages/findings/lib/file-lock.js`](packages/findings/lib/file-lock.js) requiere semántica de enlace duro para la publicación atómica; en exFAT, `linkSync` lanza `ENOTSUP` (ruidoso, no silencioso). Un problema común: los SSD externos multiplataforma a menudo tienen formato exFAT; clone el repositorio en APFS/HFS+ local en su lugar. Consulte [`docs/m5-validation-2026-04-29.md`](docs/m5-validation-2026-04-29.md) para obtener la matriz de validación completa de la sesión G.

## Control de versiones

Todos los paquetes `@dogfood-lab/*` se actualizan juntos, con un único número en todo el monorepositorio. Seis paquetes se publican en npm bajo `@dogfood-lab` en la versión v1.10.0 de forma sincronizada (`schemas`, `verify`, `report`, `ingest`, `findings`, `dogfood-swarm`); el séptimo, `@dogfood-lab/portfolio`, permanece interno. La línea de versión que aparece cerca de la parte superior de este archivo README se genera automáticamente a partir de `package.json` mediante [`scripts/sync-version.mjs`](scripts/sync-version.mjs) en cada ejecución de `npm run build`.

## Licencia

[MIT](LICENSE) © 2026 mcp-tool-shop

---

<div align="center">

**[Manual](https://dogfood-lab.github.io/testing-os/handbook/)** · **[Todos los repositorios](https://github.com/orgs/dogfood-lab/repositories)** · **[Perfil](https://github.com/dogfood-lab)**

*Primero come, luego envía.*

</div&gt;
