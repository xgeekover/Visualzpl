# VisualZPL Desktop

Cross-platform (Windows / macOS / Linux) desktop build of VisualZPL, packaged
with **Electron**. Produces **no-install** executables.

## Architecture

The web app has two parts: a React frontend and a Java Spring Boot backend. The
backend's *only* job the frontend uses is a **ZPL → PNG preview proxy** to
[Labelary](https://labelary.com) (`POST /api/label/preview`). Everything else —
ZPL generation, batch data, canvas editing — already runs client-side.

So the desktop build **drops Java entirely**:

```
Electron main (Node)
├─ loopback HTTP proxy  →  re-implements POST /api/label/preview → Labelary
└─ BrowserWindow        →  loads the built frontend (renderer/)
     └─ preload injects the proxy URL as window.__VZPL_API_BASE__
```

No JRE to bundle → a small, single-language app.

> **Preview needs internet.** Labelary is a cloud renderer, so the live preview
> requires a connection (same as the web app). Editing / ZPL export work offline.

## Build

Prereqs: Node 18+ (repo uses Node 20 in CI).

```bash
cd desktop
npm install
npm run dist          # build for the current OS → dist-app/
```

Per-OS (run on that OS, or via CI — cross-compiling Windows from macOS/Linux is
unreliable):

```bash
npm run dist:mac      # → VisualZPL-*-mac-*.dmg / .zip
npm run dist:win      # → VisualZPL-*-win-*.exe (portable + nsis)
npm run dist:linux    # → VisualZPL-*-linux-*.AppImage
```

Quick dev run (no packaging):

```bash
npm run dev           # builds the frontend, then launches the Electron window
```

## No-install artifacts

| OS | Artifact | How to run |
| --- | --- | --- |
| Windows | `VisualZPL-*-win-*.exe` (portable) | double-click the `.exe` |
| Linux | `VisualZPL-*-linux-*.AppImage` | `chmod +x` then run |
| macOS | `VisualZPL-*-mac-*.zip` | unzip → drag `VisualZPL.app`; first launch: right-click → Open (unsigned) |

## Cross-platform builds via CI

`.github/workflows/desktop-build.yml` builds all three natively on
`windows-latest` / `macos-latest` / `ubuntu-latest`. Trigger it manually
(*workflow_dispatch*) or by pushing a `v*` tag; artifacts are uploaded per OS.

## Notes

- macOS builds are **unsigned**. For distribution, set `mac.identity` in
  `electron-builder.yml` and provide signing/notarization credentials.
- App icons use the Electron default. Add `build/icon.png` (Linux/Win) and
  `build/icon.icns` (mac) to customize.
