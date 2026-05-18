# Resizable Bottom Panel + Table Object — Design Spec

- **Date:** 2026-05-18
- **Target file (today):** [frontend/src/components/LabelEditor.tsx](../../../frontend/src/components/LabelEditor.tsx)
- **Scope:** Two feature areas delivered together
  1. The bottom panel (ZPL code + Live Preview) becomes drag-resizable and collapsible so the design canvas can claim more vertical space.
  2. A first-class **Table** label object — insert, edit, merge cells, drag-resize rows/columns, embed text or images per cell — flowing through to ZPL output.

---

## 1. Problem Statement

Today the editor lays out as:

- Top header (~52px) + Top control bar (~46px) — fixed
- Middle row: left toolbar `w-52` (208px), Fabric canvas, right property panel `w-80` (320px) — all heights `flex-1`
- Bottom row: ZPL code + Live Preview — fixed `h-72` (288px)

On a 1366×768 laptop screen, the canvas effectively has ~330px of vertical space. Users designing labels that mix text, barcode, QR and now tables run out of room.

Additionally, `TableIcon` exists in [LabelEditor.tsx](../../../frontend/src/components/LabelEditor.tsx) but is only used as the icon for the "Batch Data" button. There is **no table insertion tool** at all. Users expect to insert tables (rows/columns, merged cells, cell text and images) the same way they insert text, barcode, QR and image.

## 2. Goals

- Bottom panel: drag to resize height; one-click collapse/restore; remember per-user via `localStorage`.
- Table tool: insertable from the toolbar, behaves as a single first-class label object (`TableObject`), edits flow through the existing right property panel, exports to valid ZPL using `^GB` / `^FO` / `^FD` / `^GFA`.
- No regression to existing text/barcode/QR/image objects, presets, batch mode, live preview, or print path.

## 3. Non-Goals

- Diagonal cell borders, per-cell background fills, gradient strokes — ZPL has no native support and emulating costs are not justified by the operator workflow.
- Per-cell custom widths within a single row (i.e. an Excel-style irregular grid). Only **row-uniform** heights and **column-uniform** widths are supported. Merging is rectangular only.
- Left toolbar / right property panel resizing. They stay fixed-width.
- A new bottom-panel layout (tabs / accordion). Code and preview remain side-by-side; only the vertical size and visibility change.
- Frontend unit tests for `BatchZpl` (already mirrored on backend — out of scope for this delta).
- Table-aware batch substitution (`{{var}}` inside cells). Cells are static text/images in this iteration.

## 4. User Decisions Already Captured

| # | Decision | Choice |
|---|----------|--------|
| 1 | Table data model | **Single `TableObject`** (not exploded into per-cell objects) |
| 2 | Cell editing UX | **Right property panel** (click cell → panel updates) |
| 3 | Cell merge UX | **Shift+drag range select → "Merge Cells" button** |
| 4 | Layout fix | **Drag-resize + collapse toggle on bottom panel only**; left/right panels fixed |
| 5 | Cell boundary drag | **Entire row height / entire column width** (not per-cell freeform) |
| 6 | Table insertion UX | **Small modal** asking for rows/cols, then insert |

---

## 5. Data Model

Added to [frontend/src/types.ts](../../../frontend/src/types.ts):

```ts
/** A piece of content placed in one (possibly merged) cell.
 *  The (row, col) MUST equal the top-left of the cell or merge span. */
export interface TableCellContent {
  row: number;
  col: number;
  /** Exactly one of `text` / `imageSourceDataUrl` is set. */
  text?: string;
  imageSourceDataUrl?: string;
  /** Lazy-populated ^GFA payload, fit to the cell box. */
  imageEncoded?: ImageEncodedPayload;
  /** Text presentation. Ignored when in image mode. */
  fontHeightMm?: number;            // default 3
  fontRotation?: ZplRotation;       // default 'N'
  align?: 'left' | 'center' | 'right';   // default 'left'
  paddingMm?: number;               // default 1
}

/** Rectangular merge region. rowSpan/colSpan ≥ 1. */
export interface TableCellSpan {
  row: number; col: number;
  rowSpan: number; colSpan: number;
}

export interface TableObject extends BaseLabelObject {
  type: 'table';
  /** Per-row heights (mm). Length determines row count. */
  rowHeightsMm: number[];
  /** Per-column widths (mm). Length determines column count. */
  colWidthsMm: number[];
  /** Border + grid line thickness in dots. 0 = no lines. Default 2. */
  borderDots: number;
  /** Content cells. Absent (row,col) = empty. */
  cells: TableCellContent[];
  /** Merge regions. Absent (row,col) = treated as 1×1. */
  merges: TableCellSpan[];
}
```

`BaseLabelObject.data` is reused for a Layers-panel display label, e.g. `"Table 3×4"`. It is auto-derived from `rowHeightsMm.length × colWidthsMm.length` on any structural change.

`LabelObject` union expands to include `TableObject`.

### Invariants

- `rowHeightsMm.length ≥ 1`, `colWidthsMm.length ≥ 1`
- Each entry in `rowHeightsMm` / `colWidthsMm` ≥ 5mm (UI-enforced minimum)
- Merge spans never overlap; merge spans fit inside the table bounds
- For each `merge`, only the top-left cell may have a `TableCellContent`; if any other cell within the span has content, it is ignored when rendering and dropped on next save
- Each entry in `cells[]` has exactly one of `text` / `imageSourceDataUrl` set (an empty cell is represented by **absence** from the array, not by a content entry with both fields undefined)

### Why row-uniform / column-uniform sizing

It collapses the model to two flat number arrays. Resizing one row = mutating `rowHeightsMm[i]`. Inserting a column = `colWidthsMm.splice(i, 0, w)` + shifting merge spans + shifting cell `(row, col)` indices. The alternative (per-cell freeform sizing) would either require a 2D matrix of cell rectangles or constraint solving on merges; the user already rejected this trade-off (#5).

---

## 6. ZPL Generation

Added to [frontend/src/ZplBuilder.ts](../../../frontend/src/ZplBuilder.ts):

```
private appendTable(table: TableObject): void
```

Algorithm:

1. **Geometry pass** — build `xOffsets[col]` and `yOffsets[row]` as prefix sums (in dots). For each merge span compute its outer rectangle once.
2. **Grid lines** — only emitted if `borderDots > 0`:
   - Outer box: `^FO x,y ^GB totalW,totalH,borderDots,B,0 ^FS`
   - Horizontal lines between each row pair, but skip the segments that fall inside a merge span
   - Vertical lines between each column pair, same skip rule
3. **Cell content** — iterate `cells`. Resolve the (row, col)'s outer rect from merges (or 1×1 default). Then:
   - **Text:** `^FO x+pad,y+pad ^A0,N,heightDots,0 ^FB innerW,maxLines,0,L|C|R,0 ^FD <sanitized> ^FS`
     - `maxLines` derived from `innerH / heightDots`, capped at 9999 (^FB upper bound)
     - Existing `^` / `~` sanitization is reused (`ZplBuilder.sanitize`)
   - **Image:** computed inside the editor's encoding effect (§9), then emitted as `^FO x,y ^GFA totalBytes,totalBytes,bytesPerRow, <hex> ^FS`
4. **Table-level rotation** — Implemented by **pre-rotating the geometry pass around the table's origin** (rotation is applied to each cell's (x,y,w,h) when emitting). All `^FO` coordinates are already rotated, so each cell's text and image still emit with their normal `^A0,N,...` / `^GFA` block. **No `^FW` is emitted at table scope** — this keeps composition with per-cell `fontRotation` trivial: a cell's `fontRotation` is emitted verbatim on its `^A0` command, and the table rotation has already been baked into the cell's placement.

  Trade-off: text wrapping (`^FB`) uses the *post-rotation* `innerW`. Since the table is only rotated in 90° increments, "width" and "height" swap cleanly per cell, which the geometry helper handles.

### Why `^FB` and not multiple `^FD`?

`^FB` is the only ZPL primitive that does word-wrap + alignment inside a known box. Without it, multi-line text in a narrow cell would overflow horizontally on the printer despite looking correct in the canvas preview.

---

## 7. Editor Integration

### 7.1 Toolbar

Add a fifth tool button to the left aside in [LabelEditor.tsx](../../../frontend/src/components/LabelEditor.tsx) (`ToolButton` exists already):

```tsx
<ToolButton onClick={handleAddTableClick} icon={<TableIcon size={16} />} label="Add Table" />
```

The icon component is already defined in the file (`TableIcon`). The Batch Data button keeps its current icon to avoid disturbing existing UX.

### 7.2 New-table modal

New file [frontend/src/components/table/NewTableModal.tsx](../../../frontend/src/components/table/NewTableModal.tsx):

- Two number inputs: Rows (1–20, default 3), Columns (1–20, default 3)
- "Insert" / "Cancel" buttons
- Esc/outside-click closes; Enter submits
- Modal styling matches `BatchDataModal` for consistency

On Insert: build a `TableObject` positioned at (5mm, 5mm), `borderDots: 2`, no cells, no merges, with uniform sizing such that the table occupies **half** of the available label area:

- `colWidthMm = (labelWidthMm * 0.5) / cols`, clamped to ≥ 5mm
- `rowHeightMm = (labelHeightMm * 0.5) / rows`, clamped to ≥ 5mm

(Defaults derive from `doc.widthMm ?? 100`, `doc.heightMm ?? 50`.)

### 7.3 Layers panel

A `TableObject` shows as `▦  table-1` with the same single-row treatment as other objects. No cell-level entries.

### 7.4 Selection model

A new editor-local state alongside `selectedId`:

```ts
type CellSelection =
  | { kind: 'none' }
  | { kind: 'single'; row: number; col: number }
  | { kind: 'range'; startRow: number; startCol: number; endRow: number; endCol: number };

const [cellSelection, setCellSelection] = useState<CellSelection>({ kind: 'none' });
```

- `cellSelection` is only meaningful when `selected?.type === 'table'`
- Selecting a different object or clicking outside the table clears it to `{ kind: 'none' }`
- **Click inside a merged region** resolves to the merge's **top-left** `(row, col)` — this matches where the cell's content actually lives. The overlay highlights the entire merged rectangle, but the model index used by `CellPropertyForm` is the top-left
- **Shift+drag range** is auto-normalized so `startRow ≤ endRow` and `startCol ≤ endCol` regardless of drag direction. If the resulting rectangle partially crosses an existing merge, the rectangle is auto-expanded to the smallest superset that fully contains the offending merges (so "Merge Cells" always operates on a clean rectangular region)

### 7.5 Overlay layer

New file [frontend/src/components/table/tableOverlay.tsx](../../../frontend/src/components/table/tableOverlay.tsx) — an absolute-positioned `<div>` over the Fabric canvas (sibling to the `<canvas>` inside the `<main>` flex item). It is mounted only when the currently selected object is a table.

Responsibilities:

- Read the table model + the canvas's current zoom / scroll offsets
- Render transparent `<div>`s for each cell. Click → set `cellSelection: single`. Shift+drag from one cell to another → `cellSelection: range`
- Render thin (8px hit-target) resize handles on each row boundary (cursor `row-resize`) and column boundary (cursor `col-resize`). Drag → optimistic local height/width, commit to model on `pointerup`. Min 5mm.
- Render a blue 2px outline on selected cell(s) and a faint blue 20% fill

Why not Fabric subTargets: Fabric's group sub-target click conflicts with the group's own move/resize handles, and Fabric's resize cursors do not naturally map to "this internal grid line". A plain HTML overlay aligned to canvas pixel coordinates is simpler, easier to test, and decouples table-internal UX from Fabric's selection state.

### 7.6 Right property panel

`PropertyForm` gets a new branch `object.type === 'table'`:

- **No cell selected** (`cellSelection.kind === 'none'`): renders `TablePropertyForm`
  - X, Y, Rotation, Border thickness (0–10 dots)
  - "Add Row" / "Remove Last Row" (disable Remove at 1 row)
  - "Add Column" / "Remove Last Column" (disable Remove at 1 col)
  - Default added row/col size = average of existing
- **Single cell selected**: renders `CellPropertyForm`
  - Mode toggle: Text / Image
  - Text mode: Text (multiline), Font height (mm), Rotation, Align, Padding (mm)
  - Image mode: "Choose file…" button, current filename, replace button, padding
  - When switching modes, the other mode's fields are dropped from the model
- **Range selected** (≥ 2 cells): renders just a "Merge Cells" button (or "Unmerge" if the range exactly matches an existing merge), with a hint line `"3 rows × 2 cols selected"`
  - The selection rectangle is already normalized + auto-expanded (§ 7.4) so partial-crossing of existing merges is impossible by the time this form renders
  - On Merge: any merges fully contained within the new region are removed from `merges[]`; the new region is added; content cells inside the new region (other than the top-left) are dropped

New files:
- [frontend/src/components/table/TablePropertyForm.tsx](../../../frontend/src/components/table/TablePropertyForm.tsx)
- [frontend/src/components/table/CellPropertyForm.tsx](../../../frontend/src/components/table/CellPropertyForm.tsx)

The existing `NumberField` / `TextField` / `SelectField` helpers in [LabelEditor.tsx](../../../frontend/src/components/LabelEditor.tsx) are extracted to [frontend/src/components/formFields.tsx](../../../frontend/src/components/formFields.tsx) so the new forms can reuse them without circular imports.

### 7.7 Fabric node

New file [frontend/src/components/table/tableNode.ts](../../../frontend/src/components/table/tableNode.ts):

```ts
export function createTableNode(obj: TableObject): LabelNode
```

Builds a `fabric.Group` containing:
- One outer `fabric.Rect`
- A `fabric.Line` per grid segment (skipping segments inside merges)
- For each content cell, either a clipped `fabric.Textbox` or a `fabric.FabricImage` positioned with padding

`shouldRecreate` in [LabelEditor.tsx](../../../frontend/src/components/LabelEditor.tsx) is extended to return `true` for tables whenever **any** of `rowHeightsMm`, `colWidthsMm`, `cells`, `merges`, `borderDots` change. Pure position/rotation changes still flow through `applyModelToNode`.

This is acceptable because table edits are typically deliberate (button click, modal confirm, drag-end commit), not continuous like text typing.

### 7.8 Encoding effect for cell images

Extends the existing image-encoding `useEffect` in [LabelEditor.tsx](../../../frontend/src/components/LabelEditor.tsx) to also walk `cells[]` of every `TableObject` and:

- Compute `computeEncodingKey({ sourceDataUrl, widthMm: cellWidthMm, heightMm: cellHeightMm, threshold: 128, dpmm })`
- If stale, run `imageToZpl(...)` and write the result back into `cells[i].imageEncoded`
- Cancel logic mirrors the existing pattern

Cell width/height for the key derive from the cell's resolved outer rect (post-merge) minus `2 * padding`.

---

## 8. Bottom Panel Resize + Collapse

### 8.1 New component

[frontend/src/components/ResizableBottomPanel.tsx](../../../frontend/src/components/ResizableBottomPanel.tsx):

```tsx
interface Props {
  height: number;             // current height, controlled
  onHeightChange: (h: number) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  minHeight?: number;         // default 120
  maxHeight?: number;         // default window.innerHeight * 0.7
  children: ReactNode;        // existing code + preview row
}
```

Layout:
- When `collapsed`: render only a 32px header row with the toggle chevron (▲) and label "Show code & preview"
- When expanded: render a 6px drag handle on top edge (cursor `row-resize`, hover changes color), then a header with collapse chevron (▼), then `{children}` filling the remaining `height - headerHeight`

Drag implementation: `pointerdown` on handle → capture pointer → `pointermove` updates `height` clamped to `[min, max]` → `pointerup` releases. No global mousemove listeners; pointer capture handles drag-outside cases.

### 8.2 Integration in `LabelEditor`

State:
```ts
const [bottomHeight, setBottomHeight] = useState<number>(() => readStoredHeight() ?? 240);
const [bottomCollapsed, setBottomCollapsed] = useState<boolean>(() => readStoredCollapsed() ?? false);

useEffect(() => writeStored({ height: bottomHeight, collapsed: bottomCollapsed }),
  [bottomHeight, bottomCollapsed]);
```

Storage key: `visualzpl.bottomPanel`, value `{ height: number, collapsed: boolean }`. Read/write helpers in the same file or a tiny [frontend/src/storage.ts](../../../frontend/src/storage.ts).

The current `<section className="h-72 flex shrink-0 border-t …">` is replaced with `<ResizableBottomPanel ...>` wrapping the same inner children.

### 8.3 Why localStorage and not React state only

Editor sessions are long-running. A user who explicitly resizes the panel to their preferred height should not have to redo it after refresh. The data is tiny (≤ 40 bytes), so no quota concerns. Read on mount, write on change, never read again — keeps logic linear.

---

## 9. Code Reorganization

[LabelEditor.tsx](../../../frontend/src/components/LabelEditor.tsx) is already 62KB / ~1900 lines. The table feature alone is several hundred more lines of logic. To keep the main file readable:

```
frontend/src/components/
  LabelEditor.tsx                      (slimmer — table logic delegated)
  ResizableBottomPanel.tsx             NEW
  formFields.tsx                       NEW (extracted NumberField / TextField / SelectField / ReadOnlyField)
  table/
    NewTableModal.tsx                  NEW
    TablePropertyForm.tsx              NEW
    CellPropertyForm.tsx               NEW
    tableNode.ts                       NEW (createTableNode)
    tableGeometry.ts                   NEW (pure geometry helpers)
    tableOverlay.tsx                   NEW
frontend/src/
  storage.ts                           NEW (localStorage helpers, tiny)
  ZplBuilder.ts                        EDITED (appendTable)
  types.ts                             EDITED (TableObject, TableCellContent, TableCellSpan)
```

Extraction is **scoped**: only the helpers needed by the new code move. Existing pure-fabric helpers (`createTextNode`, `createBarcodeNode`, etc.) stay inside `LabelEditor.tsx` for this iteration to avoid unrelated churn.

---

## 10. Testing

The frontend currently has no Vitest setup (per [README.md](../../../README.md) §Testing). This spec adds it for the new pure modules — backend tests stay as-is.

New dev deps: `vitest`, `@vitest/ui` (optional), `jsdom` (only if a test needs DOM). Wire up `npm test` script.

Tests added:
- `frontend/src/components/table/tableGeometry.test.ts`
  - Prefix-sum cell positions match expected `xOffsets` / `yOffsets`
  - `resolveCellRect(row, col, merges)` returns the merged outer rectangle when the (row,col) is inside a merge
  - `expandRangeToContainMerges(range, merges)` returns the smallest superset rectangle that fully contains every merge it partially intersects (idempotent — running twice gives the same result)
  - 90°/180°/270° table rotation: cell rects round-trip through rotation correctly
- `frontend/src/ZplBuilder.test.ts`
  - Empty 2×2 table with `borderDots: 2` emits exactly one outer `^GB` and the right number of inner grid lines
  - A merged 2×2 region produces a single content `^FO` and the correct skipped grid segments
  - Cell text with `^` / `~` is sanitized
  - Cell text uses `^FB` with the right `innerW` and `align` flag
  - Image cell uses the cached `imageEncoded.hexData`

Manual smoke checklist (recorded in plan, not automated):
- Bottom panel: drag resize, hit min/max bounds, collapse, refresh, restore
- Table: insert via modal, add/remove row/col, click cell → edit text, switch to image and upload, Shift+drag → merge, click merged cell → unmerge, drag row line → row height changes, drag column line → column width changes, rotate table, delete table
- Live preview still updates within 400ms after table edits

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Overlay misalignment when canvas scrolls in `<main className="overflow-auto">` | Overlay reads canvas `getBoundingClientRect()` on every relevant pointer event; render the overlay inside the same scrolling container so it shares scroll offset |
| Image re-encoding storms when dragging a column boundary | Encoding effect already debounces by writing back only on commit; drag commits at `pointerup`, so encoding fires once per drag |
| `^FB` line-count miscalc → printer-side clipping | Pessimistic `maxLines = max(1, floor(innerH / heightDots))`; canvas preview also clips so the user sees the same truncation before printing |
| Table rotation + cell text rotation interaction | Spec § 6 #4: table rotation is baked into cell geometry (pre-rotated `^FO` coordinates), and per-cell `fontRotation` is emitted unchanged on the `^A0` command. ZplBuilder test covers 0°/90° table × 0°/90° cell combos to lock the composition rule |
| Bottom panel collapse hides Live Preview error toasts | The existing top-bar `ToastQueue` is unaffected; preview errors continue to surface in the bottom panel header status badge when expanded, and as a top-bar toast if rendering fails outright |

---

## 12. Out of Scope (Explicit Defer List)

- Per-cell background fill (ZPL `^GB` filled box hack — defer until requested)
- Diagonal lines inside a cell
- Cell border styling per side (only uniform `borderDots`)
- Variable substitution inside cell text (`{{var}}`) — keeps batch mode simple
- Undo/redo for table edits (the whole editor lacks it today; out of scope)
- Per-user width persistence for left/right side panels (per user decision #4)
