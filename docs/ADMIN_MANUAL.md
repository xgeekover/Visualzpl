# VisualZPL — Administrator Manual

> Operations guide for deploying, monitoring, and troubleshooting
> VisualZPL in production. All configuration keys, paths, and CLI
> arguments below match the application source verbatim.

---

## Table of Contents

1. [Deployment Architecture](#1-deployment-architecture)
2. [Production Run](#2-production-run)
3. [Log Files & Rotation](#3-log-files--rotation)
4. [Analyzing Issues](#4-analyzing-issues)
5. [Health Checks & Metrics](#5-health-checks--metrics)
6. [Configuration Reference](#6-configuration-reference)
7. [Windows Service Lifecycle](#7-windows-service-lifecycle)
8. [Incident Playbook](#8-incident-playbook)

---

## 1. Deployment Architecture

VisualZPL is **stateless** by design — there is nothing to back up,
migrate, replicate, or synchronize.

- **No database.** Layout designs live entirely in the browser. The
  backend never persists user data.
- **No configuration sync.** All configuration is provided at JVM
  start-up via system properties (`-D…`) or environment variables.
  Two instances on two hosts behave identically given the same flags.
- **No session store.** The backend is request/response — every call
  is independent.
- **Three independent network surfaces:**
  1. Browser ↔ Backend Proxy — JSON over HTTP.
  2. Backend Proxy ↔ Labelary (`api.labelary.com`) — outbound HTTP
     for PNG rendering only.
  3. Browser ↔ Zebra Browser Print agent (`localhost:9100`) — local
     HTTP for direct printing. Never traverses the backend.

This means scaling out is a matter of running more `VisualZPL.exe`
processes behind a load balancer. No shared state coordination is
required.

---

## 2. Production Run

### Single-machine standalone

After packaging with `build-windows.bat`, copy `out/VisualZPL/` to the
target host and launch `VisualZPL.exe`. Default behavior:

| Port | Bound to    | Purpose                                          |
|------|-------------|--------------------------------------------------|
| 8080 | All ifaces  | Public API (`/api/label/preview`, static UI)     |
| 8081 | 127.0.0.1   | Management endpoints (`/actuator/*`) — prod only |

To see the application output interactively while validating an
install, launch from a console window:

```cmd
cd C:\Program Files\VisualZPL
VisualZPL.exe -Dvisualzpl.log.level=DEBUG
```

> **Note:** When VisualZPL runs under a Windows Service wrapper the
> stdout/stderr streams are usually captured by the wrapper. For
> day-to-day operations, prefer the log file (Section 3) over console
> output.

### Overriding configuration at launch

Every property is overridable on the command line. Common operator
flags:

```cmd
VisualZPL.exe ^
    -Dspring.profiles.active=prod ^
    -Dvisualzpl.log.level=DEBUG ^
    -Dvisualzpl.log.dir=C:\ProgramData\VisualZPL\logs ^
    -Dserver.port=8090
```

See Section 6 for the full configuration table.

---

## 3. Log Files & Rotation

All log output is governed by `logback-spring.xml` shipped inside the
JAR. The pattern is:

```
[Timestamp] [Thread] [Log-Level] [Logger-Name] - Message
```

Example line:

```
[2026-05-16 14:23:01.482] [http-nio-8080-exec-3] [INFO ] [i.v.s.LabelPreviewService] - Labelary render OK: path=/v1/printers/8dpmm/labels/3.937x1.969/0/ pngBytes=15842 elapsedMs=187
```

### Locations

| File                                                      | Purpose                                       |
|-----------------------------------------------------------|-----------------------------------------------|
| `${visualzpl.log.dir}/visualzpl.log`                      | Current (uncompressed) log file.              |
| `${visualzpl.log.dir}/archive/visualzpl-YYYY-MM-DD.N.log.gz` | Rotated archives, gzipped.                  |

The default for `${visualzpl.log.dir}` is `${user.dir}/logs` — the
process working directory. Under a Windows Service this is typically
the install folder, e.g. `C:\Program Files\VisualZPL\logs\`.

### Rotation policy

| Parameter      | Value      | Behavior                                        |
|----------------|-----------|-------------------------------------------------|
| `maxFileSize`  | **10 MB** | Current file rolls when it hits this size.      |
| Time trigger   | **Daily** | Current file also rolls at midnight.            |
| `maxHistory`   | **30**    | Up to 30 archives are kept; older are pruned.   |
| `totalSizeCap` | **3 GB**  | Total archive directory is capped at 3 GB.      |
| Compression    | **.gz**   | Rotated files are gzipped automatically.        |

Within a single day, files past `maxFileSize` get an index suffix:
`visualzpl-2026-05-16.0.log.gz`, `visualzpl-2026-05-16.1.log.gz`, …

### Manual rotation

Logback rolls automatically — manual rotation is rarely needed. If a
script must force a roll (for example, when a vulnerability scanner
locked the current file), restart the service: the next write reopens
the file handle.

> **Caution:** Never edit `visualzpl.log` while the service is
> running. Use `tail`, `Get-Content -Wait`, or a copy.

---

## 4. Analyzing Issues

The `io.visualzpl.*` package emits a deliberate severity spectrum so
operators can grep meaningfully.

| Level   | When emitted                                                                              | Example pattern in `visualzpl.log` |
|---------|-------------------------------------------------------------------------------------------|------------------------------------|
| `DEBUG` | Full request context (widthMm, heightMm, dpmm, index, zplLength).                          | Enabled per-deployment via `-Dvisualzpl.log.level=DEBUG`. |
| `INFO`  | Every accepted render attempt and successful completion (with `elapsedMs`).                | `Forwarding render to Labelary: path=…`, `Labelary render OK: …` |
| `WARN`  | Client-side mistakes that the request layer rejects.                                       | `Rejecting request with unsupported dpmm=10 (supported=[6, 8, 12, 24])`, `Labelary rejected ZPL for path=…` |
| `ERROR` | Upstream / infrastructure failures. **Always carries a full stack trace.**                 | `Labelary upstream failure for path=…`, `Cannot reach Labelary at path=…`, `Labelary call timed out after 10s: path=…` |

### Useful greps

```bash
# All errors in the last hour
grep "ERROR" visualzpl.log | tail -200

# Upstream failures specifically
grep "Labelary upstream failure" visualzpl.log

# Per-request latency outliers
grep "Labelary render OK" visualzpl.log | awk -F'elapsedMs=' '{print $2}' | sort -n | tail -20

# Rejected client requests (validation)
grep "WARN" visualzpl.log | grep -E "Rejecting|rejected"
```

### Reading ERROR stack traces

A full ERROR entry typically looks like:

```
[2026-05-16 14:25:01.001] [http-nio-8080-exec-5] [ERROR] [i.v.s.LabelPreviewService] - Labelary upstream failure for path=/v1/printers/8dpmm/labels/3.937x1.969/0/: Labelary HTTP 503: Service Unavailable
io.visualzpl.exception.LabelaryUpstreamException: Labelary HTTP 503: Service Unavailable
    at io.visualzpl.service.LabelPreviewService.renderPng(LabelPreviewService.java:113)
    …
```

The first line is the human-readable summary. The lines beneath it
are the Java stack trace (printed automatically because the SLF4J
call passes the Throwable as the last argument).

---

## 5. Health Checks & Metrics

Spring Boot Actuator endpoints are exposed for operational
monitoring. In the `prod` profile they live on a **separate port
bound to the loopback interface**, so they are unreachable from the
public network.

### Endpoint locations

| Endpoint                                       | Profile         | URL                                                |
|-----------------------------------------------|-----------------|----------------------------------------------------|
| Health                                         | default / dev   | `http://localhost:8080/actuator/health`            |
| Health                                         | prod            | `http://127.0.0.1:8081/actuator/health`            |
| Metrics                                        | default / dev   | `http://localhost:8080/actuator/metrics`           |
| Metrics                                        | prod            | `http://127.0.0.1:8081/actuator/metrics`           |
| Info                                           | default / dev   | `http://localhost:8080/actuator/info`              |
| Info                                           | prod            | `http://127.0.0.1:8081/actuator/info`              |

To reach the prod management port from a remote workstation, use an
SSH tunnel:

```bash
ssh -L 8081:127.0.0.1:8081 admin@visualzpl-host
# Then in a browser on your laptop:
#   http://localhost:8081/actuator/health
```

### `/actuator/health` response shape

```json
{
  "status": "UP",
  "components": {
    "diskSpace": {
      "status": "UP",
      "details": {
        "total": 250000000000,
        "free":  120000000000,
        "threshold": 104857600,
        "exists": true
      }
    },
    "labelary": {
      "status": "UP",
      "details": {
        "upstreamStatus": 404,
        "latencyMs": 42
      }
    },
    "ping": { "status": "UP" }
  }
}
```

| Component   | What it checks                                                                                       | DOWN condition |
|-------------|-------------------------------------------------------------------------------------------------------|----------------|
| `diskSpace` | Free space on the partition holding `${visualzpl.log.dir}` (the log directory).                       | Less than **100 MB** free. |
| `labelary`  | Custom probe — 3-second GET to `${labelary.base-url}/`. Any HTTP status (incl. 4xx) counts as UP.    | Network failure, TLS error, or timeout. |
| `ping`      | Always-on liveness sentinel built into Spring Boot.                                                   | Application context is broken. |

The `labelary.details.latencyMs` value is a cheap continuous indicator
of upstream health — graph it in your monitoring tool to detect slow
trends before they become outages.

### `/actuator/metrics`

```
GET /actuator/metrics
GET /actuator/metrics/jvm.memory.used
GET /actuator/metrics/http.server.requests
GET /actuator/metrics/reactor.netty.connection.provider.active.connections
```

The full list is browsable from the index endpoint. Drill into any
metric with the `name` suffix as shown above.

---

## 6. Configuration Reference

| Property                      | Default                   | Purpose                                                  |
|-------------------------------|---------------------------|----------------------------------------------------------|
| `spring.profiles.active`      | (none)                    | Set to `prod` to enable hardened defaults.               |
| `server.port`                 | `8080`                    | Public API port.                                         |
| `server.shutdown`             | `graceful`                | Drain in-flight requests on shutdown.                    |
| `spring.lifecycle.timeout-per-shutdown-phase` | `30s`     | Maximum drain duration.                                  |
| `management.server.port`      | (same as `server.port`)   | In prod profile: `8081`.                                 |
| `management.server.address`   | (any)                     | In prod profile: `127.0.0.1`.                            |
| `labelary.base-url`           | `http://api.labelary.com` | Upstream PNG rendering API.                              |
| `labelary.timeout-seconds`    | `10`                      | WebClient call timeout (single request).                 |
| `labelary.max-response-bytes` | `5242880`                 | Max PNG size accepted from upstream (5 MB).              |
| `visualzpl.log.dir`           | `${user.dir}/logs`        | Logback rolling-file output directory.                   |
| `visualzpl.log.level`         | `INFO`                    | Threshold for `io.visualzpl.*` loggers in the prod profile. |

All keys are overridable via `-D` JVM flags, environment variables
(uppercased with underscores), or a profile-specific YAML override.

---

## 7. Windows Service Lifecycle

The packaged `VisualZPL.exe` plays nicely with the three common
wrappers. Examples below assume the install directory is
`C:\Program Files\VisualZPL\` and that the prod profile is the
deployment target.

### Shutdown sequence (any wrapper)

1. Service Manager sends a **stop signal** to the wrapper.
2. Wrapper sends `CTRL+C` / `SIGTERM` to the JVM.
3. Spring Boot fires its JVM shutdown hook.
4. Embedded Tomcat **stops accepting new connections**.
5. In-flight requests finish, bounded by
   `spring.lifecycle.timeout-per-shutdown-phase` (30 s).
6. `@PreDestroy` hooks run — see `ApplicationLifecycle`:
   `"VisualZPL backend shutdown complete. All cleanup hooks finished."`
7. Logback's shutdown hook **flushes file appenders**.
8. JVM exits.

> **Important:** Configure the wrapper's stop timeout to at least
> **35 seconds** so the graceful drain has a buffer of 5 seconds over
> the Spring phase limit.

### WinSW example

Save as `VisualZPL.xml` next to `WinSW.exe`:

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

Install and start:

```cmd
WinSW.exe install
WinSW.exe start
```

### NSSM example

```cmd
nssm install visualzpl "C:\Program Files\VisualZPL\VisualZPL.exe"
nssm set visualzpl AppDirectory "C:\Program Files\VisualZPL"
nssm set visualzpl AppStopMethodConsole 35000
nssm start visualzpl
```

### Procrun (Apache Commons Daemon)

Procrun's `prunsrv` accepts a similar set of arguments. The key
controls to match are the working directory and a stop timeout
≥ 35 s. Refer to your existing Procrun playbook for the exact
incantation in your environment.

---

## 8. Incident Playbook

| Symptom in `visualzpl.log` or health endpoint                       | Probable cause                                | First action |
|----------------------------------------------------------------------|-----------------------------------------------|--------------|
| `diskSpace` status `DOWN` with `free < threshold`                    | Log directory partition is nearly full.       | Free space; verify `maxHistory: 30` and `totalSizeCap: 3GB` are still enforced; check for unrelated processes filling the disk. |
| `labelary` status `DOWN` and `error` detail mentions `UnknownHost`   | DNS resolution failure to `api.labelary.com`. | Verify outbound DNS; check whether the host is behind an HTTP proxy that needs to be configured via `-Dhttps.proxyHost=…`. |
| `labelary` status `DOWN` and `error` mentions `timeout`              | Upstream slow or unreachable.                 | Increase `labelary.timeout-seconds` temporarily; verify firewall rules permit outbound 80/443. |
| `Cannot reach Labelary` ERROR lines                                  | Network failure between this host and Labelary. | Same as above — check connectivity and proxy settings. |
| Repeated `Labelary HTTP 503` ERROR lines                             | Upstream is overloaded.                       | Brief outage; if persistent, escalate via Zebra/Labelary status page. |
| Repeated `Rejecting request with unsupported dpmm=X` WARN lines      | A client is sending unsupported densities.    | Identify the client (browser IP in `http-nio-…` thread name); coach the user. The supported set is `{6, 8, 12, 24}`. |
| Port 8080 conflict on startup                                        | Another process holds the port.               | Either stop the conflicting process or override with `-Dserver.port=8090`. |
| Service fails to start with no log output                            | Logback could not write to `${visualzpl.log.dir}`. | Verify the service user has write permission to the working directory, or override `-Dvisualzpl.log.dir=C:\ProgramData\VisualZPL\logs`. |
| `/actuator/health` returns 404 on prod port                          | Management endpoints are bound to loopback only. | Connect via SSH tunnel; reaching from a remote workstation directly is by design impossible. |
| End user reports *"Printer Not Found"*                               | Zebra Browser Print agent missing on the user's PC. | Install the Zebra utility on the user's PC; no backend action is required. |

If an issue does not match any row, capture and attach to the ticket:

- The last 200 lines of `visualzpl.log`.
- The current `/actuator/health` response.
- The exact request body sent to `/api/label/preview` (visible in the
  browser DevTools Network panel).

These three artifacts cover virtually every reproducible failure
mode.
