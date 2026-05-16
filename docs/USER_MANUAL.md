# VisualZPL — User Manual

> A practical, task-oriented guide for end users of the VisualZPL label
> editor. All UI labels in this document match the application's
> English-only interface exactly.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Interface Overview](#2-interface-overview)
3. [Using Layout Presets](#3-using-layout-presets)
4. [Designing Elements](#4-designing-elements)
   - [Text](#41-text)
   - [Barcode (Code 128)](#42-barcode-code-128)
   - [QR Code](#43-qr-code)
   - [Image](#44-image)
5. [Exporting & Printing](#5-exporting--printing)
   - [Copy to Clipboard](#51-copy-to-clipboard)
   - [Download ZPL File](#52-download-zpl-file)
   - [Batch Data](#53-batch-data)
   - [Print to Zebra](#54-print-to-zebra)
6. [Troubleshooting Quick Reference](#6-troubleshooting-quick-reference)

---

## 1. Getting Started

VisualZPL runs entirely in a modern web browser — no installation is
required for end users.

1. Open your browser (Chrome, Edge, or Firefox; latest two versions
   supported).
2. Navigate to the URL provided by your administrator. Typical values:
   - Standalone install: `http://localhost:8080`
   - Internal server: `http://visualzpl.company.local:8080`
3. The editor loads with an empty 100 × 50 mm canvas by default.

> **Tip:** Use *Quick Presets* (Section 3) instead of staring at a
> blank canvas — every preset produces a printable label in one click.

---

## 2. Interface Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ VisualZPL — Label Editor   [Quick Presets ▾]    Width / Height (mm) │  ← Header
├──────────────────────────────────────────────────────────────────────┤
│ Export  [Copy] [Download] [Batch Data]  │  [Print to Zebra]  toasts │  ← Top Control Bar
├────────┬──────────────────────────────────────────┬──────────────────┤
│  Tools │                                          │   Properties     │
│        │             Canvas (WYSIWYG)             │                  │
│ Layers │                                          │   (per element)  │
├────────┴──────────────────────────────────────────┴──────────────────┤
│ ZPL Code (Live)         [Copy Code] │    Live Preview                │  ← Bottom
└──────────────────────────────────────────────────────────────────────┘
```

| Region | Purpose |
|--------|---------|
| Header | Label dimensions (Width / Height in mm) and **Quick Presets** dropdown. |
| Top Control Bar | Export actions (Copy / Download / Batch Data) and the hardware **Print to Zebra** button. Transient toasts appear here. |
| Left Toolbar | Buttons to add new elements (Text / Barcode / QR Code / Image) and the layer list. |
| Canvas | Drag, resize, rotate elements directly. Click an element to select it. |
| Right Property Panel | Adapts to the selected element — edit position, rotation, data, font height, threshold, etc. |
| Bottom-Left | Live-rendered ZPL II source — copy with the **Copy Code** shortcut. |
| Bottom-Right | Live Preview rendered by the backend (PNG image of the actual label). |

---

## 3. Using Layout Presets

Three industry-standard templates eliminate the blank-canvas problem
and come with pre-filled batch data.

| Preset | Dimensions | Variables |
|--------|-----------|-----------|
| **Logistics Shipping Label** | 4 × 6 in (101.6 × 152.4 mm) | `{{Recipient}}`, `{{Address}}`, `{{City}}`, `{{Service}}`, `{{TrackingNumber}}` |
| **Asset Identification Tag** | 2 × 1 in (50.8 × 25.4 mm) | `{{AssetID}}` |
| **Retail Price Tag** | 40 × 30 mm | `{{ItemName}}`, `{{Price}}`, `{{SKU}}` |

### Loading a preset

1. Click **Quick Presets** in the header.
2. Pick a preset card from the dropdown menu — each card shows the
   dimensions, element count, and sample-row count.
3. If your current canvas already has elements, a confirmation dialog
   appears: *"Loading a preset will replace your current design.
   Proceed?"* Click **OK** to replace or **Cancel** to keep your
   work.
4. A green toast confirms the load:
   *"Loaded preset: <name> · 3 sample rows ready"*.

The canvas, label dimensions, and the **Batch Data** modal's rows are
all hydrated at once. Open **Batch Data** to see the populated grid.

---

## 4. Designing Elements

### 4.1 Text

1. Click **Add Text** in the left toolbar — a new "Sample Text"
   element appears at the top-left of the canvas and is automatically
   selected.
2. Drag it to position; drag the corners to scale.
3. In the right **Properties** panel:
   - **Data** — the printed text. May contain `{{Variable}}`
     placeholders for batch mode (Section 5.3).
   - **Font Height (mm)** — vertical size; width is auto-proportional.
   - **Rotation** — 0° / 90° / 180° / 270°.
   - **X / Y (mm)** — direct coordinate input.

### 4.2 Barcode (Code 128)

1. Click **Add Barcode** — a Code 128 element appears with the default
   value `12345678`.
2. In **Properties**:
   - **Data** — the value to encode. Code 128 accepts printable
     ASCII (`0x20`–`0x7E`) only.
   - **Height (mm)** — bar height. Width is automatic, derived from
     the data length and **Module Width**.
   - **Module Width (dot)** — width of the thinnest bar (1–10 dots).
     Larger values are more scannable but consume more horizontal
     space.

> **Note:** The on-canvas barcode is a visual approximation. The
> *Live Preview* (lower right) shows the actual printer-rendered
> barcode produced by the Labelary backend proxy.

### 4.3 QR Code

1. Click **Add QR Code** — a new QR appears with default URL data.
2. In **Properties**:
   - **Data** — the payload (URL, plain text, etc.). QR codes support
     Unicode, so non-ASCII characters are allowed.
   - **Magnification** — cell size multiplier (1–10). Larger = bigger
     printed QR.
   - **Error Correction** — `L` (~7 % recovery), `M` (~15 %),
     `Q` (~25 %), `H` (~30 %). Use `H` for tags exposed to wear.

### 4.4 Image

VisualZPL converts PNG / JPEG images into 1-bit monochrome ZPL `^GFA`
graphic fields so they print on any Zebra label printer.

1. Click **Add Image** — the file picker opens.
2. Select a PNG or JPEG file (recommended size: under 2 megapixels for
   smooth editing).
3. The image is added at a default size scaled to roughly half the
   label width.
4. In **Properties**:
   - **Width / Height (mm)** — physical print size. Resizing also
     triggers re-encoding so the printed bitmap matches the
     on-screen size.
   - **Threshold (0–255)** — the **luma cutoff** for the 1-bit
     conversion:
     - **Lower** values → more pixels considered dark → more black
       ink, useful for faint pencil sketches or low-contrast logos.
     - **Higher** values → more pixels considered light → more
       white, useful for dark photos where you want only the
       outline.
     - Default `128` is the midpoint and works for typical line art.
   - **Encoded** line below the threshold slider reports the cached
     payload: `Encoded 800×400 dots · 39.1 KB`. While the slider is
     moving, you may briefly see *"Encoding bitmap…"* in amber.

> **Note:** Image rotation is disabled because ZPL's `^GFA` command
> does not support orientation parameters. Rotate the source image
> before uploading if you need a different orientation.

---

## 5. Exporting & Printing

All export actions live in the **Top Control Bar**. After every action,
a colored toast appears in the right side of the bar:

| Color    | Severity | Examples |
|----------|----------|----------|
| Emerald  | Success  | *"ZPL copied to clipboard"*, *"Print success!"* |
| Amber    | Warning  | *"Label resize cancelled"*, *"Preset load cancelled"* |
| Red      | Error    | *"Clipboard copy failed"*, *"Printer Not Found"* |

### 5.1 Copy to Clipboard

1. Click **Copy to Clipboard** in the Top Control Bar — *or* the small
   **Copy Code** button next to the live ZPL panel at the bottom.
2. The current ZPL II string (`^XA … ^XZ`) is placed on your
   clipboard.
3. Paste it anywhere — a print spooler, a ZPL test tool such as
   https://labelary.com/viewer.html, or your IT team's ticketing
   system.

### 5.2 Download ZPL File

1. Click **Download ZPL File**.
2. Your browser saves the current label as `visual-zpl-label.zpl`.
3. The file is plain text — you can open it in any editor or pipe it
   to a printer with `lp -d zebra visual-zpl-label.zpl`.

### 5.3 Batch Data

Batch mode replaces `{{Variable}}` placeholders inside any Text /
Barcode / QR data field with values from a data grid, generating one
label per row.

#### Defining variables

1. Edit a Text / Barcode / QR element's **Data** field to include
   placeholders such as `{{Name}}` or `{{Price}}`.
   - Variable names must start with a letter or `_` and contain only
     letters, digits, and underscores.
2. The **Batch Data** button's badge updates with the detected
   variable count, e.g. *Batch Data (3)*.

#### Filling in rows

1. Click **Batch Data** — the modal opens.
2. The grid has one column per detected variable, plus a `#`
   (row number) column.
3. Edit cells inline. Buttons:
   - **+ Add Row** — appends a new empty row.
   - **Clear All** — resets to a single empty row.
   - Row-level **✕** — removes that row (disabled if only one row
     remains).
4. The footer always shows *"Ready to print N labels"*.

#### Reading validation indicators

Cells are validated in real time and highlighted:

| Visual cue         | Meaning                                                       | Action |
|--------------------|---------------------------------------------------------------|--------|
| Plain grey border  | Valid                                                         | None |
| **Amber** border   | Warning — output will print but is sanitized (e.g. `^`/`~` replaced with spaces) | Optional fix |
| **Red** border     | Error — must be fixed before exporting or printing            | Required fix |

Hover any highlighted cell to see the exact reason in a tooltip, for
example:

- *"Code 128 does not support character "한" (U+D55C)."*
- *"ZPL control characters ^ and ~ are not allowed in barcode data."*
- *"Barcode value cannot be empty."*

A summary banner above the action buttons aggregates issue counts:
*"3 validation errors — fix highlighted cells before exporting or
printing."*

#### Exporting the batch

Once errors (if any) are resolved:

- **Download Batch ZPL** — saves all `N` substituted labels as a
  single `visual-zpl-batch-N.zpl` file. Concatenated `^XA…^XZ`
  blocks; the printer advances and cuts one label per block.
- **Print Batch to Zebra** — sends the same concatenated ZPL stream
  directly to the connected Zebra printer through the Zebra Browser
  Print agent. See Section 5.4 below.

> **Note:** Both buttons are disabled while validation errors are
> present. Hover any disabled button for the reason.

### 5.4 Print to Zebra

Direct hardware printing requires the **Zebra Browser Print** desktop
utility on your PC. Download it from https://www.zebra.com/ and start
it before opening VisualZPL.

#### Single-label print

1. Verify the **Print to Zebra** button is **enabled** (green).
2. If it is greyed out, hover for the cause:
   - *"Zebra Browser Print agent not running"* — start the desktop
     utility.
   - *"No Zebra printer connected"* — plug in or pair your printer.
   - *"Send the generated ZPL to the connected Zebra printer"* —
     button is ready.
3. Click **Print to Zebra**.
4. The button label changes to *Sending…* while the request is in
   flight; a green *"Print success!"* toast confirms completion, or a
   red error toast names the failure cause.

#### Batch print

The same flow applies from inside the **Batch Data** modal — click
**Print Batch to Zebra** and the entire substituted batch is sent in
one request.

---

## 6. Troubleshooting Quick Reference

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Live Preview shows *"Awaiting first render…"* and never updates | Backend not reachable | Confirm the URL with your administrator; check that the backend service is running. |
| Live Preview displays a red error alert | The current ZPL is invalid (Labelary returned 400) | Read the message — it usually pinpoints the bad field. |
| **Print to Zebra** button stays disabled | Agent not running, or no printer attached | Launch Zebra Browser Print on your PC; reconnect the printer cable. |
| Image looks pure black or pure white after upload | Threshold mis-set for that image | Adjust the **Threshold** slider; midpoint `128` is a good starting baseline. |
| Batch row cells show red borders | Validation errors block export | Hover the cell for the exact reason and fix the value. |
| Clipboard copy fails silently in HTTPS environments | Browser security context blocked the API | Make sure the page is loaded over HTTPS or `localhost`; the Clipboard API rejects insecure origins. |
| Preset replaced your work and you wanted to undo | No built-in undo for preset load | Reload the browser tab before clicking Save / Copy / Download to discard the preset. |

If a problem persists, send your administrator a screenshot of the
red toast / alert and the contents of the bottom **ZPL Code (Live)**
panel — those two artifacts are enough to reproduce most issues
locally.
