# VisualZPL Desktop

Cross-platform (Windows / macOS / Linux) desktop build of VisualZPL, packaged
with **Electron**. Produces **no-install** executables and previews labels
**fully offline** — safe for air-gapped / closed networks (폐쇄망).

## Architecture

The web app used a Java Spring Boot backend whose only job was proxying ZPL →
PNG previews to [Labelary](https://labelary.com). That's gone here:

- **Preview is rendered locally**, on-device, by `frontend/src/zpl/renderZpl.ts`
  (2D canvas for text/boxes/graphics, **bwip-js** for barcodes/QR). No network,
  no Labelary, no backend — works in a closed network.
- The Electron main process is a thin shell: it just opens a window on the built
  frontend. No Java, no JRE, no local server.

```
Electron main (Node)  →  BrowserWindow → renderer/ (built frontend)
                                            └─ renders ZPL → canvas locally (offline)
```

> Fidelity: preview text approximates the printer's scalable font; layout,
> sizing, boxes, graphics and barcodes/QR are accurate. The exported ZPL remains
> the source of truth for the physical printer.

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
npm run dist:win      # → VisualZPL-*-win-x64.zip + -setup.exe (nsis) + -portable.exe
npm run dist:linux    # → VisualZPL-*-linux-*.AppImage
```

Quick dev run (no packaging):

```bash
npm run dev           # builds the frontend, then launches the Electron window
```

## No-install artifacts

| OS | Artifact | How to run |
| --- | --- | --- |
| **Windows (recommended)** | `VisualZPL-*-win-x64.zip` | Unzip anywhere → run `VisualZPL.exe`. No installer, no admin, **no `%TEMP%` self-extraction** — the safest option on locked-down / air-gapped (폐쇄망) PCs. |
| Windows (installer) | `VisualZPL-*-win-x64-setup.exe` | Run the installer (per-user, no admin) → launch from the Start menu. |
| Windows (portable) | `VisualZPL-*-win-x64-portable.exe` | Double-click. ⚠ Self-extracts to `%TEMP%` before running, so corporate **AppLocker/SRP** policies that forbid executing from temp can silently block it (nothing happens on double-click). Prefer the **zip** in that case. |
| Linux | `VisualZPL-*-linux-*.AppImage` | `chmod +x` then run |
| macOS | `VisualZPL-*-mac-*.zip` | unzip → drag `VisualZPL.app`; first launch: right-click → Open (unsigned) |

> **Windows: the builds are unsigned.** If **SmartScreen** shows *"Windows
> protected your PC"*, click **More info → Run anyway**. If the download itself
> is blocked/greyed out, right-click the file → **Properties → Unblock** (removes
> the *Mark of the Web*), then run it.

## Cross-platform builds & auto-release (CI)

`.github/workflows/desktop-build.yml` builds all three natively on
`windows-latest` / `macos-latest` / `ubuntu-latest`.

- **Manual build:** trigger via *workflow_dispatch* → artifacts uploaded per OS.
- **Release:** push a `v*` tag (e.g. `git tag v0.1.0 && git push --tags`) →
  each OS builds with `electron-builder --publish always`, creating a **GitHub
  Release** for the tag with the Windows / macOS / Linux no-install downloads
  attached.

## Icon

`build/icon.png` (512×512) is the source icon; electron-builder derives the
Windows `.ico`, macOS `.icns`, and Linux icons from it. Regenerate with
`node scripts/gen-icon.cjs`, or replace `build/icon.png` with your own.

## Notes

- macOS builds are **unsigned**. For distribution set `mac.identity` in
  `electron-builder.yml` and provide signing/notarization credentials.
- The old Java backend still lives in `../backend` for the web deployment; the
  desktop app does not use it.
