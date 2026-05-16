# VisualZPL

> **Standalone Lightweight ZPL Label Editor & Rendering Utility**

VisualZPL is a 100% serverless, database-free label design tool for Zebra
ZPL II printers. The entire layout pipeline — design, variable
substitution, batch generation, image-to-bitmap encoding — runs in the
browser. A minimal Spring Boot proxy is included only for two reasons:
to forward ZPL to the public Labelary API for image previews, and to
host operational health endpoints. **No application database, no user
accounts, no server-side state.**

---

## Table of Contents

1. [Architecture](#architecture)
2. [Key Features](#key-features)
3. [Tech Stack](#tech-stack)
4. [Quick Start (Development)](#quick-start-development)
5. [Production Build (Windows Standalone)](#production-build-windows-standalone)
6. [Configuration Reference](#configuration-reference)
7. [Observability](#observability)
8. [Testing](#testing)
9. [Project Layout](#project-layout)
10. [License](#license)

---

## Architecture

VisualZPL ships as three independently runnable pillars. The browser is
the orchestrator — both the backend proxy and the local printer agent
are accessed *from* the browser, never the other way around.

```
+-----------------------------------------------------------------------+
|                         Browser (Frontend)                             |
|  React + Vite + Tailwind + Fabric.js                                   |
|                                                                        |
|  * LabelEditor          Toolbar / Canvas / Properties / Live Preview  |
|  * ZplBuilder.ts        Document model -> ZPL II string               |
|  * ImageToZpl.ts        PNG / JPEG -> 1-bit monochrome ^GFA hex       |
|  * BatchZpl.ts          {{var}} substitution + validation             |
|  * LabelPresets.ts      Industry-standard starting templates          |
|  * useLabelPreview      400 ms debounced /api/label/preview           |
|  * useBrowserPrint      Zebra Browser Print on localhost:9100         |
|  * useToastQueue        Multi-event Success / Warning / Error queue   |
+-----------------------------------------------------------------------+
                   |                                  |
                   | JSON over HTTP                   | HTTP (CORS)
                   v                                  v
 +----------------------------+     +------------------------------+
 |      Backend Proxy         |     |    Local Hardware Bridge     |
 |  Spring Boot 3 / Java 17   |     |  Zebra Browser Print agent   |
 |                            |     |                              |
 |  POST /api/label/preview   |     |  GET  /available             |
 |  POST .../preview/base64   |     |  GET  /default               |
 |                            |     |  POST /write                 |
 |  WebClient -> Labelary     |     |                              |
 |  InvalidZplException 400   |     |  Installed separately by     |
 |  LabelaryUpstream     502  |     |  the operator, listens at    |
 |                            |     |  http://localhost:9100       |
 |  /actuator/health          |     +------------------------------+
 |  /actuator/metrics         |
 |   - diskSpace              |       (prod profile: management
 |   - labelary (custom)      |        bound to 127.0.0.1:8081)
 |                            |
 |  Logback rolling file      |
 |  ${user.dir}/logs/         |
 +----------------------------+
```

Key invariants:

- **No database.** All design state lives in React state and is
  serialized only when the user clicks *Copy*, *Download*, or *Print
  Batch*.
- **No login.** The backend has no authentication layer — it is
  intended to run alongside the editor on the operator's network or
  as a Windows Service on the operator's own PC.
- **Two independent HTTP boundaries.** Browser → Backend (for preview)
  and Browser → Browser Print agent (for hardware print). Either may
  fail without breaking the other.

---

## Key Features

### Editor

- WYSIWYG canvas via Fabric.js with drag / resize, multi-rotation
  (text / barcode / QR), and snap-on-modify state sync.
- Side property panel that auto-adapts to the selected element type
  (text, barcode, QR, image).
- Top control bar with one-click **Copy to Clipboard**, **Download ZPL
  File**, **Batch Data**, and **Print to Zebra**.
- **Quick Presets** dropdown — three industry-standard starting
  templates (Logistics Shipping Label, Asset Identification Tag,
  Retail Price Tag), each shipping with 2–3 rows of realistic sample
  data so a freshly loaded preset is one click away from a printable
  batch.

### ZPL Generation

- `ZplBuilder` emits a single ZPL II string from the document JSON;
  control characters in user data (`^`, `~`) are sanitized before
  output.
- 1-bit monochrome image encoding via off-screen canvas + BT.601 luma
  + MSB-first bit packing → ASCII hex → `^GFA` Graphic Field command.
- Asynchronous encoded image payloads are cached on the model so
  `ZplBuilder.build()` stays synchronous and the live preview never
  blocks.

### Batch Mode

- `{{VariableName}}` placeholders in any text / barcode / QR data
  field are detected automatically and surfaced as a data grid.
- **Strictest-rule-wins validation**: a variable shared between a text
  and a barcode element is held to the Code 128 character constraints
  (printable ASCII only, no `^` / `~`).
- Per-cell red / amber borders with tooltip messages; action buttons
  auto-disable when any error is present.
- One-shot **Download Batch ZPL** (concatenated `^XA…^XZ` blocks) or
  **Print Batch to Zebra**.

### Live Preview

- `useLabelPreview` hook coalesces rapid edits with a **400 ms**
  trailing debounce, aborts stale in-flight requests via
  `AbortController`, and revokes Object URLs to prevent memory leaks.
- The backend proxies the ZPL to https://labelary.com/ to render a
  real PNG the user can compare against the on-canvas rendering
  before printing.

### Hardware Print

- `useBrowserPrint` polls the Zebra Browser Print agent every 30
  seconds, discovers connected printers, and sends ZPL through the
  agent's local HTTP endpoints — no driver shim required.
- The print button auto-disables with a tooltip explaining the cause
  when the agent is missing or no printer is attached.

### Production Posture

- Rolling Logback (10 MB per file, 30-day history, 3 GB total cap,
  `.gz` compression).
- Graceful shutdown (`server.shutdown: graceful`) compatible with
  Windows Service managers (WinSW / NSSM / Procrun).
- Spring Boot Actuator with the custom `labelary` health probe and
  the built-in `diskSpace` component; management endpoints isolated
  on `127.0.0.1:8081` in the prod profile.

---

## Tech Stack

| Layer    | Technologies                                                  |
|----------|---------------------------------------------------------------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Fabric.js 6         |
| Backend  | Java 17, Spring Boot 3.3, Spring MVC, WebClient, Logback      |
| Tests    | JUnit 5, WireMock 3 (integration), shared `BatchZpl` mirror   |
| Build    | Gradle 8 (backend), Vite (frontend), jpackage (Windows .exe)  |

---

## Quick Start (Development)

Two terminals — both run from the repository root.

### Backend (Spring Boot)

```bash
cd backend
./gradlew bootRun
```

The API listens on `http://localhost:8080`. In the default (dev)
profile, health endpoints share the same port:
`http://localhost:8080/actuator/health`.

### Frontend (Vite dev server)

```bash
cd frontend
npm install
npm run dev
```

The editor opens at `http://localhost:5173`. CORS is preconfigured on
the backend to accept that origin.

### Optional — Zebra Browser Print

Install the Zebra Browser Print desktop utility from
https://www.zebra.com/. The frontend's *Print to Zebra* button
automatically detects the agent at `http://localhost:9100`. Without
it, the button stays disabled with a tooltip; every other feature
works unchanged.

---

## Production Build (Windows Standalone)

VisualZPL ships as a single relocatable Windows directory containing
`VisualZPL.exe` plus a private JRE, produced by `jpackage`. Operators
install it once and either run it on demand or register it as a
Windows Service.

### Prerequisites

- JDK 17+ on the build host (`jpackage` is part of the JDK)
- Node.js 18+
- WiX Toolset (only required if you switch jpackage to `--type msi`)

### One-shot build

From the repository root on Windows:

```cmd
build-windows.bat
```

The script performs:

1. `npm install && npm run build` in `frontend/` → static assets in
   `frontend/dist/`.
2. Copy `frontend/dist/*` into `backend/src/main/resources/static/`
   so Spring Boot serves them at `/`.
3. `gradlew.bat clean bootJar` → executable Spring Boot fat JAR.
4. `jpackage --type app-image` → `out/VisualZPL/VisualZPL.exe`
   plus a self-contained `runtime/` JRE.

The result in `out/VisualZPL/` is fully relocatable — copy the folder
to the operator's PC and double-click `VisualZPL.exe`. The default
working directory becomes the install folder, so Logback writes to
`<install-dir>\logs\visualzpl.log` by default.

### Run as a Windows Service

Pick any wrapper; the example below uses **WinSW**. Save as
`VisualZPL.xml` next to `WinSW.exe`:

```xml
<service>
  <id>visualzpl</id>
  <name>VisualZPL Backend</name>
  <description>VisualZPL label editor + Labelary proxy</description>
  <executable>%BASE%\VisualZPL\VisualZPL.exe</executable>
  <workingdirectory>%BASE%\VisualZPL</workingdirectory>
  <logmode>roll</logmode>
  <stoptimeout>35sec</stoptimeout>
</service>
```

Then:

```cmd
WinSW.exe install
WinSW.exe start
```

Service-managed shutdown sends `CTRL+C`, which triggers Spring's
graceful shutdown (`spring.lifecycle.timeout-per-shutdown-phase: 30s`),
runs every `@PreDestroy` hook (see `ApplicationLifecycle`), and
flushes the Logback file appenders before the JVM exits.

**NSSM** users follow the same pattern via `nssm install visualzpl`
and point at `VisualZPL.exe`. The `stoptimeout` (or NSSM's
`AppStopMethodConsole`) must allow at least 30 seconds for the
graceful drain to finish.

---

## Configuration Reference

All runtime configuration is driven by Spring Boot profiles + system
properties. There is no `.env` file and no database connection string.

### Backend

| Property                      | Default                   | Description                                |
|-------------------------------|---------------------------|--------------------------------------------|
| `spring.profiles.active`      | (none)                    | Set to `prod` to enable hardened defaults  |
| `server.port`                 | `8080`                    | Public API port                            |
| `management.server.port`      | (same as `server.port`)   | In prod profile: `8081`                    |
| `management.server.address`   | (any)                     | In prod profile: `127.0.0.1`               |
| `labelary.base-url`           | `http://api.labelary.com` | Upstream PNG renderer                      |
| `labelary.timeout-seconds`    | `10`                      | WebClient call timeout                     |
| `visualzpl.log.dir`           | `${user.dir}/logs`        | Logback rolling file output directory      |
| `visualzpl.log.level`         | `INFO`                    | Threshold for `io.visualzpl.*` in prod     |

### Frontend

| Env var              | Default                 | Description                              |
|----------------------|-------------------------|------------------------------------------|
| `VITE_API_BASE_URL`  | `http://localhost:8080` | Backend base URL. Empty → same-origin.   |

---

## Observability

### Health

`GET /actuator/health` returns an aggregated UP / DOWN per component:

```json
{
  "status": "UP",
  "components": {
    "diskSpace": { "status": "UP", "details": { "free": 12345678, "threshold": 104857600 } },
    "labelary":  { "status": "UP", "details": { "upstreamStatus": 404, "latencyMs": 42 } },
    "ping":      { "status": "UP" }
  }
}
```

- **`diskSpace`** watches `${visualzpl.log.dir}` and goes DOWN if the
  filesystem has less than 100 MB free.
- **`labelary`** is a custom probe that performs a 3-second GET on the
  configured upstream base URL. Any HTTP response (including 4xx)
  counts as UP — only a network failure or timeout flips the
  component to DOWN. The `latencyMs` detail is useful for spotting
  upstream degradation.

### Metrics

`GET /actuator/metrics` exposes JVM, embedded Tomcat, and WebClient
counters via Micrometer. Drill into a specific metric with
`/actuator/metrics/{name}`.

### Logging

Logback is configured by `logback-spring.xml`:

- Pattern: `[Timestamp] [Thread] [Log-Level] [Logger-Name] - Message`
- Rolling file: **10 MB** per file, daily rotation, `.gz` compressed,
  **30-day** retention, **3 GB** total cap.
- Profile routing:
  - `!prod` → Console + File, `io.visualzpl` at **DEBUG**.
  - `prod`  → File only, level driven by `visualzpl.log.level`.

Flip the `io.visualzpl` logger to DEBUG at runtime without redeploying:

```cmd
VisualZPL.exe -Dvisualzpl.log.level=DEBUG
```

---

## Testing

### Backend

```bash
cd backend
./gradlew test
```

- **`BatchZplTest`** — pure unit tests for placeholder extraction,
  per-row substitution, and the strictest-rule-wins validation
  pipeline (Code 128 non-ASCII rejection, shared-variable escalation,
  multi-row aggregation).
- **`LabelPreviewServiceTest`** — `@SpringBootTest` driving the real
  WebClient against a WireMock-backed Labelary stub. Covers the
  happy 200 path, `4xx → InvalidZplException`,
  `5xx → LabelaryUpstreamException`, request timeout, empty
  response, and the unsupported-`dpmm` short-circuit (verifies that
  the upstream is never contacted in that case).

### Frontend

The TypeScript modules under `frontend/src/` (`ZplBuilder`,
`ImageToZpl`, `BatchZpl`) are designed as pure functions with no DOM
dependencies in their core paths, making them straightforward to
cover with Vitest in the future. The current shipped functionality is
exercised by the backend's mirrored `BatchZpl` test suite to
guarantee that the two implementations cannot diverge silently.

---

## Project Layout

```
VisualZPL/
├── README.md
├── build-windows.bat                           # One-shot Windows packaging script
│
├── frontend/                                    # React + Vite + Tailwind editor
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── types.ts                             # LabelDocument, TextObject, ...
│       ├── ZplBuilder.ts                        # Document -> ZPL II
│       ├── ImageToZpl.ts                        # PNG / JPEG -> ^GFA hex
│       ├── BatchZpl.ts                          # {{var}} substitution + validation
│       ├── LabelPresets.ts                      # Quick Presets data
│       ├── downloadFile.ts                      # Blob download helper
│       ├── components/
│       │   ├── LabelEditor.tsx                  # Top-level editor shell
│       │   └── BatchDataModal.tsx               # Variable data grid
│       └── hooks/
│           ├── useLabelPreview.ts               # Debounced backend preview
│           ├── useBrowserPrint.ts               # Zebra Browser Print client
│           └── useToastQueue.ts                 # Multi-event toast feed
│
└── backend/                                     # Spring Boot proxy + actuator
    ├── build.gradle
    ├── settings.gradle
    └── src/
        ├── main/
        │   ├── java/io/visualzpl/
        │   │   ├── VisualZplApplication.java
        │   │   ├── api/
        │   │   │   ├── LabelController.java
        │   │   │   └── dto/
        │   │   │       ├── PreviewRequest.java
        │   │   │       ├── PreviewBase64Response.java
        │   │   │       └── ApiErrorResponse.java
        │   │   ├── service/
        │   │   │   └── LabelPreviewService.java
        │   │   ├── batch/
        │   │   │   ├── BatchZpl.java            # Server-side mirror of frontend
        │   │   │   └── BarcodeRuleException.java
        │   │   ├── health/
        │   │   │   └── LabelaryHealthIndicator.java
        │   │   ├── config/
        │   │   │   ├── WebClientConfig.java
        │   │   │   └── WebMvcConfig.java        # CORS for the Vite dev origin
        │   │   ├── exception/
        │   │   │   ├── InvalidZplException.java
        │   │   │   ├── LabelaryUpstreamException.java
        │   │   │   └── GlobalExceptionHandler.java
        │   │   └── lifecycle/
        │   │       └── ApplicationLifecycle.java  # @PreDestroy hook
        │   └── resources/
        │       ├── application.yml
        │       ├── application-prod.yml
        │       └── logback-spring.xml
        └── test/
            └── java/io/visualzpl/
                ├── batch/BatchZplTest.java
                └── service/LabelPreviewServiceTest.java
```

---

## License

Internal project. Not yet licensed for redistribution. Reach out to
the maintainers before reusing the code outside this repository.
