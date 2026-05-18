# Resizable Bottom Panel + Table Object — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a drag-resizable + collapsible bottom panel and a first-class `TableObject` (insert / edit / merge cells / drag-resize rows-cols / per-cell text or image) that exports to valid ZPL.

**Architecture:** TableObject is a single `LabelObject` discriminator backed by parallel `rowHeightsMm[]` / `colWidthsMm[]` arrays plus an explicit `merges[]` list. Per-cell text and images live in a sparse `cells[]`. The Fabric scene gets one `fabric.Group` per table; a sibling HTML overlay (positioned absolutely over the canvas) owns cell-selection and grid-line resize handles. ZPL emission walks the geometry into `^GB` lines + `^FO`/`^A0`/`^FB`/`^FD` text + `^GFA` images. The bottom panel becomes a small controlled component with persisted height/collapse state.

**Tech Stack:** React 18 + TypeScript, Fabric.js 6, Tailwind CSS, Vitest (new, added in Phase 0).

**Spec:** [docs/superpowers/specs/2026-05-18-resizable-panels-and-table-design.md](../specs/2026-05-18-resizable-panels-and-table-design.md)

---

## File Map

```
frontend/
  package.json                                MODIFIED   Vitest dev deps + "test" script
  vite.config.ts                              MODIFIED   add Vitest config block
  src/
    types.ts                                  MODIFIED   TableObject, TableCellContent, TableCellSpan
    storage.ts                                NEW        localStorage helpers (typed)
    ZplBuilder.ts                             MODIFIED   appendTable + table renderer
    ZplBuilder.test.ts                        NEW        table → ZPL coverage
    components/
      LabelEditor.tsx                         MODIFIED   table tool, layers icon, overlay+modal+panel mount
      ResizableBottomPanel.tsx                NEW        bottom panel host
      formFields.tsx                          NEW        extracted ReadOnlyField/NumberField/TextField/SelectField
      table/
        tableGeometry.ts                      NEW        pure helpers (cell rects, merge expansion)
        tableGeometry.test.ts                 NEW
        tableNode.ts                          NEW        createTableNode(...) → fabric.Group
        tableOverlay.tsx                      NEW        HTML overlay for cell select + resize handles
        NewTableModal.tsx                     NEW        rows/cols input dialog
        TablePropertyForm.tsx                 NEW        right panel form when a table (no cell) is selected
        CellPropertyForm.tsx                  NEW        right panel form when a single cell is selected
        RangeMergeForm.tsx                    NEW        right panel form when a range is selected
```

---

## Phase 0 — Vitest Setup

### Task 0.1: Install Vitest + wire `npm test`

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/vite.config.ts`

- [ ] **Step 1: Add dev dependencies and test script**

Run from `frontend/`:

```bash
npm install --save-dev vitest@^2.1.5 @vitest/ui@^2.1.5 jsdom@^25.0.1
```

Then add the `"test"` script to `frontend/package.json` so the scripts block becomes:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

- [ ] **Step 2: Add Vitest config to `vite.config.ts`**

Replace the file at `frontend/vite.config.ts` with:

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
```

(`environment: 'node'` is fine because every test added by this plan is a pure-function test that does not touch the DOM. We avoid pulling jsdom into the default run.)

- [ ] **Step 3: Sanity check — write a throwaway test, run it, delete it**

Create `frontend/src/__smoke__.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('vitest smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run:

```bash
npm test
```

Expected last line: `Test Files  1 passed (1)` / `Tests  1 passed (1)`.

Then delete the file:

```bash
rm src/__smoke__.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts
git commit -m "chore(frontend): wire up Vitest for unit tests"
```

---

## Phase 1 — Bottom Panel: Resize + Collapse

### Task 1.1: Tiny typed `localStorage` helper

**Files:**
- Create: `frontend/src/storage.ts`

- [ ] **Step 1: Create the file**

```ts
/**
 * Minimal typed wrappers around localStorage. All access is guarded so that
 * SSR or storage-disabled browsers degrade to `null`/no-op instead of throwing.
 */

export function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // QuotaExceeded / disabled storage — silently ignore. The feature using
    // this helper must still work without persistence.
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/storage.ts
git commit -m "feat(frontend): add typed localStorage helpers"
```

### Task 1.2: `ResizableBottomPanel` component

**Files:**
- Create: `frontend/src/components/ResizableBottomPanel.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useCallback, useEffect, useRef, type ReactNode } from 'react';

interface Props {
  height: number;
  onHeightChange: (h: number) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  minHeight?: number;
  maxHeight?: number;
  children: ReactNode;
}

const HEADER_HEIGHT = 32;

/**
 * Bottom panel host. When expanded it renders a 6px drag handle above its
 * 32px header, then the caller's children. When collapsed it renders only
 * the header so the design canvas reclaims the space.
 */
export function ResizableBottomPanel({
  height,
  onHeightChange,
  collapsed,
  onToggleCollapse,
  minHeight = 120,
  maxHeight,
  children,
}: Props) {
  const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );

  const resolvedMax = maxHeight ?? Math.round(window.innerHeight * 0.7);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.preventDefault();
      (event.target as Element).setPointerCapture(event.pointerId);
      dragStartRef.current = { startY: event.clientY, startHeight: height };
    },
    [collapsed, height],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStartRef.current;
      if (!drag) return;
      // Pointer moves down → handle moves down → panel shrinks.
      const delta = event.clientY - drag.startY;
      const next = Math.min(
        resolvedMax,
        Math.max(minHeight, drag.startHeight - delta),
      );
      onHeightChange(next);
    },
    [minHeight, resolvedMax, onHeightChange],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragStartRef.current = null;
      try {
        (event.target as Element).releasePointerCapture(event.pointerId);
      } catch {
        /* nothing to release */
      }
    },
    [],
  );

  // Re-clamp on viewport resize so a previously valid height does not exceed
  // the new maximum.
  useEffect(() => {
    const onResize = () => {
      const max = Math.round(window.innerHeight * 0.7);
      if (height > max) onHeightChange(max);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [height, onHeightChange]);

  const totalHeight = collapsed ? HEADER_HEIGHT : height;

  return (
    <section
      className="flex flex-col shrink-0 border-t border-slate-300 bg-white"
      style={{ height: totalHeight }}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize code & preview panel"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="h-1.5 cursor-row-resize bg-slate-200 hover:bg-blue-400 transition-colors"
          style={{ touchAction: 'none' }}
        />
      )}
      <header
        className="flex items-center justify-between px-3 border-b border-slate-200 bg-slate-50"
        style={{ height: HEADER_HEIGHT }}
      >
        <span className="text-xs font-mono uppercase tracking-wider text-slate-500">
          {collapsed ? 'Code & Preview (hidden)' : 'Code & Preview'}
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
          title={collapsed ? 'Show code & preview' : 'Hide code & preview'}
          aria-expanded={!collapsed}
          className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-slate-200 text-slate-600"
        >
          {collapsed ? '▲' : '▼'}
        </button>
      </header>
      {!collapsed && <div className="flex-1 flex overflow-hidden">{children}</div>}
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/ResizableBottomPanel.tsx
git commit -m "feat(frontend): add ResizableBottomPanel component"
```

### Task 1.3: Wire `ResizableBottomPanel` into `LabelEditor`

**Files:**
- Modify: `frontend/src/components/LabelEditor.tsx`

- [ ] **Step 1: Add imports near the top of `LabelEditor.tsx`**

Find the existing block of imports for hooks/components (around line 50) and add:

```tsx
import { ResizableBottomPanel } from './ResizableBottomPanel';
import { readJson, writeJson } from '../storage';
```

- [ ] **Step 2: Add panel state + persistence above the existing `// ── 1) Initialize the fabric canvas` line**

Insert (right after the `selectedIdRef.current = selectedId;` line):

```tsx
// Bottom panel layout — persisted across sessions in localStorage.
const BOTTOM_PANEL_STORAGE_KEY = 'visualzpl.bottomPanel';
type BottomPanelStored = { height: number; collapsed: boolean };
const [bottomHeight, setBottomHeight] = useState<number>(
  () => readJson<BottomPanelStored>(BOTTOM_PANEL_STORAGE_KEY)?.height ?? 240,
);
const [bottomCollapsed, setBottomCollapsed] = useState<boolean>(
  () => readJson<BottomPanelStored>(BOTTOM_PANEL_STORAGE_KEY)?.collapsed ?? false,
);
useEffect(() => {
  writeJson<BottomPanelStored>(BOTTOM_PANEL_STORAGE_KEY, {
    height: bottomHeight,
    collapsed: bottomCollapsed,
  });
}, [bottomHeight, bottomCollapsed]);
```

- [ ] **Step 3: Replace the existing bottom `<section>` block**

Find:

```tsx
      {/* ── Bottom: ZPL output (left) + Live Preview (right) ────────── */}
      <section className="h-72 flex shrink-0 border-t border-slate-300">
        <div className="w-1/2 bg-slate-900 text-slate-100 flex flex-col border-r border-slate-700">
```

Replace the opening `<section …>` line **and** the matching closing `</section>` (the one right before the `<BatchDataModal …/>` line) with:

```tsx
      {/* ── Bottom: ZPL output (left) + Live Preview (right) ────────── */}
      <ResizableBottomPanel
        height={bottomHeight}
        onHeightChange={setBottomHeight}
        collapsed={bottomCollapsed}
        onToggleCollapse={() => setBottomCollapsed(c => !c)}
      >
        <div className="w-1/2 bg-slate-900 text-slate-100 flex flex-col border-r border-slate-700">
```

…and:

```tsx
        </div>
      </ResizableBottomPanel>
```

(Net change: outer `<section>` → `<ResizableBottomPanel>`. The two inner halves are unchanged.)

- [ ] **Step 4: Build to verify**

```bash
cd frontend && npm run build
```

Expected: `vite build` succeeds without TypeScript errors. (Tab completion may complain about an unused import if you missed a step — go back and ensure both `ResizableBottomPanel` and `readJson`/`writeJson` are used.)

- [ ] **Step 5: Smoke test in the browser**

Run `npm run dev` and open `http://localhost:5173`:
1. Grab the gray strip above "Code & Preview" header and drag up/down → panel resizes
2. Click the `▼` button → panel collapses to only the 32px header
3. Click `▲` → panel restores to its previous height
4. Refresh the page → panel height + collapsed state are restored

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/LabelEditor.tsx
git commit -m "feat(frontend): make bottom panel drag-resizable and collapsible"
```

---

## Phase 2 — Table Data Model + ZPL Emission

### Task 2.1: Extend `types.ts` with the table types

**Files:**
- Modify: `frontend/src/types.ts`

- [ ] **Step 1: Insert the new interfaces right before `export type LabelObject =`**

Add (preserving existing imports/structure):

```ts
/** A piece of content placed in one (possibly merged) cell.
 *  (row, col) MUST equal the top-left of the cell or merge span. */
export interface TableCellContent {
  row: number;
  col: number;
  /** Exactly one of `text` / `imageSourceDataUrl` is set. */
  text?: string;
  imageSourceDataUrl?: string;
  /** Lazy-populated ^GFA payload, fit to the cell box. */
  imageEncoded?: ImageEncodedPayload;
  /** Text presentation. Ignored when in image mode. */
  fontHeightMm?: number;
  fontRotation?: ZplRotation;
  align?: 'left' | 'center' | 'right';
  paddingMm?: number;
}

/** Rectangular merge region. rowSpan/colSpan ≥ 1. */
export interface TableCellSpan {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

/** Default text presentation inside a cell when fields are unset. */
export const CELL_DEFAULTS = {
  fontHeightMm: 3,
  fontRotation: 'N' as ZplRotation,
  align: 'left' as 'left' | 'center' | 'right',
  paddingMm: 1,
} as const;

/** Table object — exported as one ZPL block of ^GB lines + cell content. */
export interface TableObject extends BaseLabelObject {
  type: 'table';
  rowHeightsMm: number[];
  colWidthsMm: number[];
  /** Border + grid line thickness in dots. 0 = no lines. Default 2. */
  borderDots: number;
  cells: TableCellContent[];
  merges: TableCellSpan[];
}
```

- [ ] **Step 2: Extend the `BaseLabelObject.type` union and `LabelObject` union**

Update the `type` field on `BaseLabelObject` (around line 29) from:

```ts
  type: 'text' | 'barcode' | 'qrcode' | 'image';
```

…to:

```ts
  type: 'text' | 'barcode' | 'qrcode' | 'image' | 'table';
```

Update the `LabelObject` union at the bottom of the file (around line 112) from:

```ts
export type LabelObject =
  | TextObject
  | BarcodeObject
  | QrCodeObject
  | ImageObject;
```

…to:

```ts
export type LabelObject =
  | TextObject
  | BarcodeObject
  | QrCodeObject
  | ImageObject
  | TableObject;
```

- [ ] **Step 3: Build to verify**

```bash
cd frontend && npm run build
```

Expected: builds. Existing `renderObject(obj: LabelObject)` `switch` in `ZplBuilder.ts` may now warn about a non-exhaustive switch — that's expected, it gets fixed in Task 2.3.

If `tsc -b` blocks the build over the switch, temporarily silence by adding a placeholder case at the end of `renderObject` in `ZplBuilder.ts`:

```ts
      case 'table':
        return '';
```

This will be replaced in Task 2.3.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types.ts frontend/src/ZplBuilder.ts
git commit -m "feat(types): add TableObject / TableCellContent / TableCellSpan"
```

### Task 2.2: Pure geometry helpers (TDD)

**Files:**
- Create: `frontend/src/components/table/tableGeometry.ts`
- Create: `frontend/src/components/table/tableGeometry.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `frontend/src/components/table/tableGeometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TableCellSpan } from '../../types';
import {
  buildOffsets,
  resolveCellRect,
  rangeFromTwoCells,
  expandRangeToContainMerges,
  rangeMatchesMerge,
} from './tableGeometry';

describe('buildOffsets', () => {
  it('returns prefix sums starting at 0', () => {
    expect(buildOffsets([10, 20, 30])).toEqual([0, 10, 30, 60]);
  });
  it('handles a single entry', () => {
    expect(buildOffsets([7])).toEqual([0, 7]);
  });
});

describe('resolveCellRect', () => {
  const rows = [10, 10, 10];
  const cols = [20, 20, 20];

  it('returns the 1×1 rect for an un-merged cell', () => {
    expect(resolveCellRect(1, 2, rows, cols, [])).toEqual({
      row: 1, col: 2, rowSpan: 1, colSpan: 1,
      x: 40, y: 10, w: 20, h: 10,
    });
  });

  it('returns the full merged rect for any cell inside the merge', () => {
    const merges: TableCellSpan[] = [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }];
    const expected = {
      row: 0, col: 0, rowSpan: 2, colSpan: 2,
      x: 0, y: 0, w: 40, h: 20,
    };
    expect(resolveCellRect(0, 0, rows, cols, merges)).toEqual(expected);
    expect(resolveCellRect(0, 1, rows, cols, merges)).toEqual(expected);
    expect(resolveCellRect(1, 0, rows, cols, merges)).toEqual(expected);
    expect(resolveCellRect(1, 1, rows, cols, merges)).toEqual(expected);
  });
});

describe('rangeFromTwoCells', () => {
  it('normalizes regardless of drag direction', () => {
    expect(rangeFromTwoCells(2, 3, 0, 1)).toEqual({
      startRow: 0, startCol: 1, endRow: 2, endCol: 3,
    });
  });
});

describe('expandRangeToContainMerges', () => {
  it('returns the input range when no merge is partially crossed', () => {
    const input = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    const merges: TableCellSpan[] = [{ row: 2, col: 2, rowSpan: 2, colSpan: 2 }];
    expect(expandRangeToContainMerges(input, merges)).toEqual(input);
  });

  it('expands to fully contain a merge it partially overlaps', () => {
    const input = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    const merges: TableCellSpan[] = [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }];
    expect(expandRangeToContainMerges(input, merges)).toEqual({
      startRow: 0, startCol: 0, endRow: 2, endCol: 2,
    });
  });

  it('is idempotent', () => {
    const input = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    const merges: TableCellSpan[] = [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }];
    const once = expandRangeToContainMerges(input, merges);
    const twice = expandRangeToContainMerges(once, merges);
    expect(twice).toEqual(once);
  });
});

describe('rangeMatchesMerge', () => {
  const merges: TableCellSpan[] = [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }];

  it('returns the merge when range exactly matches', () => {
    expect(
      rangeMatchesMerge(
        { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
        merges,
      ),
    ).toEqual(merges[0]);
  });

  it('returns null when range does not match', () => {
    expect(
      rangeMatchesMerge(
        { startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
        merges,
      ),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd frontend && npm test
```

Expected: fails because `./tableGeometry` does not exist yet.

- [ ] **Step 3: Implement the module**

Create `frontend/src/components/table/tableGeometry.ts`:

```ts
import type { TableCellSpan } from '../../types';

export interface CellRect {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  /** Top-left X in the same unit as the input sizes (mm). */
  x: number;
  /** Top-left Y in the same unit as the input sizes (mm). */
  y: number;
  /** Width in the same unit as the input sizes (mm). */
  w: number;
  /** Height in the same unit as the input sizes (mm). */
  h: number;
}

export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/** Prefix sums. `buildOffsets([10,20])` → `[0, 10, 30]`. */
export function buildOffsets(sizes: number[]): number[] {
  const out: number[] = [0];
  for (const s of sizes) out.push(out[out.length - 1] + s);
  return out;
}

/** Returns the merge span that contains (row, col), or null if none. */
export function findContainingMerge(
  row: number,
  col: number,
  merges: TableCellSpan[],
): TableCellSpan | null {
  for (const m of merges) {
    if (
      row >= m.row &&
      row < m.row + m.rowSpan &&
      col >= m.col &&
      col < m.col + m.colSpan
    ) {
      return m;
    }
  }
  return null;
}

/**
 * Returns the outer rectangle (in mm) of the cell at (row, col), accounting
 * for any merge it lives inside. The returned `row`/`col` are the top-left
 * of the merge (or (row, col) itself if no merge applies).
 */
export function resolveCellRect(
  row: number,
  col: number,
  rowHeightsMm: number[],
  colWidthsMm: number[],
  merges: TableCellSpan[],
): CellRect {
  const merge = findContainingMerge(row, col, merges);
  const r = merge ? merge.row : row;
  const c = merge ? merge.col : col;
  const rs = merge ? merge.rowSpan : 1;
  const cs = merge ? merge.colSpan : 1;

  const xs = buildOffsets(colWidthsMm);
  const ys = buildOffsets(rowHeightsMm);

  let w = 0;
  for (let i = 0; i < cs; i++) w += colWidthsMm[c + i] ?? 0;
  let h = 0;
  for (let i = 0; i < rs; i++) h += rowHeightsMm[r + i] ?? 0;

  return { row: r, col: c, rowSpan: rs, colSpan: cs, x: xs[c], y: ys[r], w, h };
}

/** Normalize two arbitrary (row, col) endpoints into a sorted range. */
export function rangeFromTwoCells(
  rowA: number,
  colA: number,
  rowB: number,
  colB: number,
): CellRange {
  return {
    startRow: Math.min(rowA, rowB),
    startCol: Math.min(colA, colB),
    endRow: Math.max(rowA, rowB),
    endCol: Math.max(colA, colB),
  };
}

/**
 * If the input range partially intersects any merge, grow the range to
 * fully contain that merge. Re-run until stable so that newly-pulled-in
 * merges that themselves stick out are also absorbed.
 */
export function expandRangeToContainMerges(
  range: CellRange,
  merges: TableCellSpan[],
): CellRange {
  let { startRow, startCol, endRow, endCol } = range;
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of merges) {
      const mStartRow = m.row;
      const mEndRow = m.row + m.rowSpan - 1;
      const mStartCol = m.col;
      const mEndCol = m.col + m.colSpan - 1;
      const intersects =
        mStartRow <= endRow &&
        mEndRow >= startRow &&
        mStartCol <= endCol &&
        mEndCol >= startCol;
      if (!intersects) continue;
      const fullyContained =
        mStartRow >= startRow &&
        mEndRow <= endRow &&
        mStartCol >= startCol &&
        mEndCol <= endCol;
      if (fullyContained) continue;
      startRow = Math.min(startRow, mStartRow);
      startCol = Math.min(startCol, mStartCol);
      endRow = Math.max(endRow, mEndRow);
      endCol = Math.max(endCol, mEndCol);
      grew = true;
    }
  }
  return { startRow, startCol, endRow, endCol };
}

/** Returns the merge whose box exactly equals the range, or null. */
export function rangeMatchesMerge(
  range: CellRange,
  merges: TableCellSpan[],
): TableCellSpan | null {
  for (const m of merges) {
    if (
      m.row === range.startRow &&
      m.col === range.startCol &&
      m.rowSpan === range.endRow - range.startRow + 1 &&
      m.colSpan === range.endCol - range.startCol + 1
    ) {
      return m;
    }
  }
  return null;
}

/** Total table dimensions in mm. */
export function tableTotalSize(
  rowHeightsMm: number[],
  colWidthsMm: number[],
): { widthMm: number; heightMm: number } {
  return {
    widthMm: colWidthsMm.reduce((a, b) => a + b, 0),
    heightMm: rowHeightsMm.reduce((a, b) => a + b, 0),
  };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd frontend && npm test
```

Expected: all 8 tests in `tableGeometry.test.ts` pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/table/tableGeometry.ts frontend/src/components/table/tableGeometry.test.ts
git commit -m "feat(table): pure geometry helpers (resolveCellRect, range expansion)"
```

### Task 2.3: Extend `ZplBuilder` with `appendTable` (TDD)

**Files:**
- Modify: `frontend/src/ZplBuilder.ts`
- Create: `frontend/src/ZplBuilder.test.ts`

- [ ] **Step 1: Write the failing tests first**

Create `frontend/src/ZplBuilder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ZplBuilder } from './ZplBuilder';
import type { LabelDocument, TableObject } from './types';

function makeDoc(table: TableObject): LabelDocument {
  return {
    unit: 'mm',
    dpmm: 8,
    widthMm: 100,
    heightMm: 50,
    objects: [table],
  };
}

const blankTable = (over: Partial<TableObject> = {}): TableObject => ({
  id: 't1',
  type: 'table',
  x: 0,
  y: 0,
  data: 'Table 2×2',
  rowHeightsMm: [10, 10],
  colWidthsMm: [20, 20],
  borderDots: 2,
  cells: [],
  merges: [],
  ...over,
});

describe('ZplBuilder — table', () => {
  it('emits an outer ^GB box for a 2×2 borderDots:2 empty table', () => {
    const zpl = new ZplBuilder(makeDoc(blankTable())).build();
    // 2 cols × 20mm × 8dpmm = 320 dots wide, 2 rows × 10mm = 160 dots tall.
    expect(zpl).toContain('^FO0,0');
    expect(zpl).toContain('^GB320,160,2,B,0^FS');
  });

  it('emits internal grid lines (1 horizontal + 1 vertical) for 2×2', () => {
    const zpl = new ZplBuilder(makeDoc(blankTable())).build();
    // Horizontal line at y = 80 (between row 0 and row 1), full width.
    expect(zpl).toContain('^FO0,80^GB320,2,2,B,0^FS');
    // Vertical line at x = 160 (between col 0 and col 1), full height.
    expect(zpl).toContain('^FO160,0^GB2,160,2,B,0^FS');
  });

  it('emits no internal lines when borderDots is 0', () => {
    const zpl = new ZplBuilder(makeDoc(blankTable({ borderDots: 0 }))).build();
    expect(zpl).not.toContain('^GB');
  });

  it('renders text cell content via ^A0 + ^FB inside the cell box', () => {
    const zpl = new ZplBuilder(
      makeDoc(
        blankTable({
          cells: [
            {
              row: 0,
              col: 0,
              text: 'Hi',
              fontHeightMm: 3,
              align: 'center',
              paddingMm: 1,
            },
          ],
        }),
      ),
    ).build();
    // Cell (0,0) outer is 0,0 .. 20mm × 10mm. Padding 1mm → 1,1 origin in mm.
    // 1mm × 8dpmm = 8 dots. innerW = (20-2)*8 = 144 dots. fontHeight = 24 dots.
    expect(zpl).toContain('^FO8,8');
    expect(zpl).toContain('^A0N,24,0');
    expect(zpl).toContain('^FB144,');
    expect(zpl).toContain(',C,0'); // center alignment flag
    expect(zpl).toContain('^FDHi^FS');
  });

  it('sanitizes ^ and ~ in cell text', () => {
    const zpl = new ZplBuilder(
      makeDoc(
        blankTable({
          cells: [{ row: 0, col: 0, text: '^FS~CC' }],
        }),
      ),
    ).build();
    expect(zpl).not.toContain('^FS~CC^FS');
    expect(zpl).toContain('^FD  FS CC^FS');
  });

  it('skips internal grid segments inside a merged region', () => {
    const merged = blankTable({
      merges: [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
    });
    const zpl = new ZplBuilder(makeDoc(merged)).build();
    // The single internal horizontal line would normally cross the full
    // width — but since the entire table is one merged cell, it must be
    // omitted. Likewise the vertical line.
    expect(zpl).not.toContain('^FO0,80^GB');
    expect(zpl).not.toContain('^FO160,0^GB');
    // Outer box still present.
    expect(zpl).toContain('^GB320,160,2,B,0^FS');
  });

  it('renders an image cell using its imageEncoded payload', () => {
    const zpl = new ZplBuilder(
      makeDoc(
        blankTable({
          cells: [
            {
              row: 1,
              col: 1,
              imageSourceDataUrl: 'data:image/png;base64,xxx',
              imageEncoded: {
                key: 'k',
                hexData: 'AABB',
                bytesPerRow: 1,
                totalBytes: 2,
                widthDots: 8,
                heightDots: 2,
              },
            },
          ],
        }),
      ),
    ).build();
    // Cell (1,1) outer at x=20mm,y=10mm → 160,80 dots; padding default 1mm = 8 dots.
    expect(zpl).toContain('^FO168,88^GFA,2,2,1,AABB^FS');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd frontend && npm test
```

Expected: every test in `ZplBuilder.test.ts` fails (`appendTable` not implemented yet — the placeholder case from Task 2.1 returns `''`).

- [ ] **Step 3: Implement `renderTable` inside `ZplBuilder`**

Open `frontend/src/ZplBuilder.ts`. Add the import:

```ts
import {
  BarcodeObject,
  CELL_DEFAULTS,
  DEFAULT_DPMM,
  ImageObject,
  LabelDocument,
  LabelObject,
  LabelUnit,
  QrCodeObject,
  TableObject,
  TextObject,
} from './types';
```

…and add this helper import (note: the geometry module is under `components/table/`, but importing from `ZplBuilder.ts` is fine — TS resolves it):

```ts
import {
  buildOffsets,
  findContainingMerge,
  resolveCellRect,
} from './components/table/tableGeometry';
```

Replace the placeholder `case 'table': return '';` line in `renderObject` with:

```ts
      case 'table':
        return this.renderTable(obj);
```

Add the new method just below `renderImage`:

```ts
  /**
   * Render a TableObject as one block of ZPL:
   *   - outer ^GB box (if borderDots > 0)
   *   - inner horizontal/vertical grid segments, skipping merge interiors
   *   - per-cell content (^A0+^FB+^FD for text, ^GFA for image)
   *
   * Table-level rotation is baked into each cell's (x, y) so per-cell
   * ^A0 commands keep their N orientation and per-cell fontRotation
   * composes naturally on top.
   */
  private renderTable(table: TableObject): string {
    const ox = this.toDot(table.x);
    const oy = this.toDot(table.y);
    const colXs = buildOffsets(table.colWidthsMm); // mm offsets, length = cols+1
    const rowYs = buildOffsets(table.rowHeightsMm); // mm offsets, length = rows+1
    const totalWDots = this.mmToDot(colXs[colXs.length - 1]);
    const totalHDots = this.mmToDot(rowYs[rowYs.length - 1]);

    const out: string[] = [];

    // 1) Outer box + inner grid lines
    if (table.borderDots > 0) {
      out.push(
        `^FO${ox},${oy}^GB${totalWDots},${totalHDots},${table.borderDots},B,0^FS`,
      );

      // Horizontal interior lines (between row i and row i+1)
      for (let r = 1; r < table.rowHeightsMm.length; r++) {
        const yMm = rowYs[r];
        const yDot = oy + this.mmToDot(yMm);
        // Walk across columns; emit segments that are NOT swallowed by a merge.
        let segStartCol = 0;
        while (segStartCol < table.colWidthsMm.length) {
          // A merge swallows this h-line at column c iff the merge spans
          // both row r-1 and row r at column c.
          let segEndCol = segStartCol;
          while (segEndCol < table.colWidthsMm.length) {
            const swallowedAbove = findContainingMerge(r - 1, segEndCol, table.merges);
            const swallowedBelow = findContainingMerge(r, segEndCol, table.merges);
            const swallowed =
              !!swallowedAbove &&
              swallowedAbove === swallowedBelow; // same merge spans both
            if (swallowed) break;
            segEndCol++;
          }
          if (segEndCol > segStartCol) {
            const xStartDot = ox + this.mmToDot(colXs[segStartCol]);
            const widthDot =
              this.mmToDot(colXs[segEndCol]) - this.mmToDot(colXs[segStartCol]);
            out.push(
              `^FO${xStartDot},${yDot}^GB${widthDot},${table.borderDots},${table.borderDots},B,0^FS`,
            );
          }
          // Skip the swallowed column(s) — advance past the entire merge.
          if (segEndCol < table.colWidthsMm.length) {
            const m = findContainingMerge(r - 1, segEndCol, table.merges)!;
            segStartCol = m.col + m.colSpan;
          } else {
            segStartCol = segEndCol;
          }
        }
      }

      // Vertical interior lines (between col j and col j+1)
      for (let c = 1; c < table.colWidthsMm.length; c++) {
        const xMm = colXs[c];
        const xDot = ox + this.mmToDot(xMm);
        let segStartRow = 0;
        while (segStartRow < table.rowHeightsMm.length) {
          let segEndRow = segStartRow;
          while (segEndRow < table.rowHeightsMm.length) {
            const left = findContainingMerge(segEndRow, c - 1, table.merges);
            const right = findContainingMerge(segEndRow, c, table.merges);
            const swallowed = !!left && left === right;
            if (swallowed) break;
            segEndRow++;
          }
          if (segEndRow > segStartRow) {
            const yStartDot = oy + this.mmToDot(rowYs[segStartRow]);
            const heightDot =
              this.mmToDot(rowYs[segEndRow]) - this.mmToDot(rowYs[segStartRow]);
            out.push(
              `^FO${xDot},${yStartDot}^GB${table.borderDots},${heightDot},${table.borderDots},B,0^FS`,
            );
          }
          if (segEndRow < table.rowHeightsMm.length) {
            const m = findContainingMerge(segEndRow, c - 1, table.merges)!;
            segStartRow = m.row + m.rowSpan;
          } else {
            segStartRow = segEndRow;
          }
        }
      }
    }

    // 2) Cell content
    for (const cell of table.cells) {
      const rect = resolveCellRect(
        cell.row,
        cell.col,
        table.rowHeightsMm,
        table.colWidthsMm,
        table.merges,
      );
      // Ignore content placed on a non-top-left cell of a merge.
      if (rect.row !== cell.row || rect.col !== cell.col) continue;

      const padMm = cell.paddingMm ?? CELL_DEFAULTS.paddingMm;
      const innerXDot = ox + this.mmToDot(rect.x + padMm);
      const innerYDot = oy + this.mmToDot(rect.y + padMm);
      const innerWDot = this.mmToDot(rect.w - 2 * padMm);
      const innerHDot = this.mmToDot(rect.h - 2 * padMm);
      if (innerWDot <= 0 || innerHDot <= 0) continue;

      if (cell.imageSourceDataUrl) {
        if (!cell.imageEncoded) continue;
        const { hexData, bytesPerRow, totalBytes } = cell.imageEncoded;
        out.push(
          `^FO${innerXDot},${innerYDot}^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hexData}^FS`,
        );
      } else if (cell.text !== undefined) {
        const fontHeightMm = cell.fontHeightMm ?? CELL_DEFAULTS.fontHeightMm;
        const heightDot = this.mmToDot(fontHeightMm);
        const align = cell.align ?? CELL_DEFAULTS.align;
        const alignFlag = align === 'center' ? 'C' : align === 'right' ? 'R' : 'L';
        const maxLines = Math.min(9999, Math.max(1, Math.floor(innerHDot / Math.max(1, heightDot))));
        const fontRotation = cell.fontRotation ?? CELL_DEFAULTS.fontRotation;
        out.push(
          [
            `^FO${innerXDot},${innerYDot}`,
            `^A0${fontRotation},${heightDot},0`,
            `^FB${innerWDot},${maxLines},0,${alignFlag},0`,
            `^FD${this.escapeFieldData(cell.text)}^FS`,
          ].join(''),
        );
      }
    }

    return out.join('\n');
  }
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd frontend && npm test
```

Expected: every test in `ZplBuilder.test.ts` and `tableGeometry.test.ts` passes.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/ZplBuilder.ts frontend/src/ZplBuilder.test.ts
git commit -m "feat(zpl): emit ^GB grid + ^FB cell text + ^GFA cell images for TableObject"
```

---

## Phase 3 — Insertion Modal + Fabric Node

### Task 3.1: Extract reusable form fields out of `LabelEditor.tsx`

**Files:**
- Create: `frontend/src/components/formFields.tsx`
- Modify: `frontend/src/components/LabelEditor.tsx`

- [ ] **Step 1: Create `formFields.tsx` with the four field components**

Copy the four function bodies verbatim from the bottom of `LabelEditor.tsx` (`ReadOnlyField`, `TextField`, `NumberField`, `SelectField`) into the new file, and export them:

```tsx
import type { ChangeEvent } from 'react';

export function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 mb-1">
        {label}
      </label>
      <input
        readOnly
        value={value}
        className="w-full border border-slate-200 bg-slate-50 text-slate-500 rounded px-2 py-1 text-sm"
      />
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  const handle = (
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => onChange(e.target.value);
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">
        {label}
      </label>
      {multiline ? (
        <textarea
          rows={2}
          value={value}
          onChange={handle}
          className="w-full border border-slate-300 rounded px-2 py-1 text-sm font-mono"
        />
      ) : (
        <input
          value={value}
          onChange={handle}
          className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
        />
      )}
    </div>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">
        {label}
      </label>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
      />
    </div>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full border border-slate-300 rounded px-2 py-1 text-sm bg-white"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 2: Delete the four `function` blocks from `LabelEditor.tsx`**

Remove the four field functions from the bottom of `LabelEditor.tsx` (they were inline definitions; the file should no longer contain `function ReadOnlyField`, `function TextField`, `function NumberField`, or `function SelectField`).

Add at the top of `LabelEditor.tsx` (with the other imports):

```tsx
import {
  NumberField,
  ReadOnlyField,
  SelectField,
  TextField,
} from './formFields';
```

- [ ] **Step 3: Build to verify**

```bash
cd frontend && npm run build
```

Expected: builds without errors. The same components are now imported instead of defined inline.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/formFields.tsx frontend/src/components/LabelEditor.tsx
git commit -m "refactor(frontend): extract reusable form fields out of LabelEditor"
```

### Task 3.2: Fabric node factory for tables

**Files:**
- Create: `frontend/src/components/table/tableNode.ts`

- [ ] **Step 1: Create the module**

```ts
import * as fabric from 'fabric';
import {
  CELL_DEFAULTS,
  type ImageEncodedPayload,
  type TableObject,
  type ZplRotation,
} from '../../types';
import { buildOffsets, resolveCellRect } from './tableGeometry';

const PX_PER_MM = 4;

const rotationToAngle = (r?: ZplRotation): number =>
  ({ N: 0, R: 90, I: 180, B: 270 }[r ?? 'N']);

/**
 * Build a fabric.Group representing a TableObject. The group contains:
 *   - one outer Rect (or none, if borderDots is 0)
 *   - interior horizontal/vertical Lines (skipping merge interiors)
 *   - per-cell text (Textbox) or image (FabricImage) children
 *
 * The result is positioned at obj.x, obj.y (mm → px) and rotated as a unit.
 */
export function createTableNode(obj: TableObject): fabric.Group {
  const colXsMm = buildOffsets(obj.colWidthsMm);
  const rowYsMm = buildOffsets(obj.rowHeightsMm);
  const totalWPx = colXsMm[colXsMm.length - 1] * PX_PER_MM;
  const totalHPx = rowYsMm[rowYsMm.length - 1] * PX_PER_MM;

  const children: fabric.FabricObject[] = [];

  // Outer box
  children.push(
    new fabric.Rect({
      left: 0,
      top: 0,
      width: totalWPx,
      height: totalHPx,
      fill: '#ffffff',
      stroke: obj.borderDots > 0 ? '#0f172a' : 'transparent',
      strokeWidth: Math.max(1, obj.borderDots),
      selectable: false,
      evented: false,
    }),
  );

  // Interior horizontal/vertical lines, skipping merge interiors.
  if (obj.borderDots > 0) {
    for (let r = 1; r < obj.rowHeightsMm.length; r++) {
      const y = rowYsMm[r] * PX_PER_MM;
      for (let c = 0; c < obj.colWidthsMm.length; c++) {
        const above = obj.merges.find(
          m => r - 1 >= m.row && r - 1 < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan,
        );
        const below = obj.merges.find(
          m => r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan,
        );
        if (above && above === below) continue;
        const x1 = colXsMm[c] * PX_PER_MM;
        const x2 = colXsMm[c + 1] * PX_PER_MM;
        children.push(
          new fabric.Line([x1, y, x2, y], {
            stroke: '#0f172a',
            strokeWidth: Math.max(1, obj.borderDots / 2),
            selectable: false,
            evented: false,
          }),
        );
      }
    }
    for (let c = 1; c < obj.colWidthsMm.length; c++) {
      const x = colXsMm[c] * PX_PER_MM;
      for (let r = 0; r < obj.rowHeightsMm.length; r++) {
        const left = obj.merges.find(
          m => r >= m.row && r < m.row + m.rowSpan && c - 1 >= m.col && c - 1 < m.col + m.colSpan,
        );
        const right = obj.merges.find(
          m => r >= m.row && r < m.row + m.rowSpan && c >= m.col && c < m.col + m.colSpan,
        );
        if (left && left === right) continue;
        const y1 = rowYsMm[r] * PX_PER_MM;
        const y2 = rowYsMm[r + 1] * PX_PER_MM;
        children.push(
          new fabric.Line([x, y1, x, y2], {
            stroke: '#0f172a',
            strokeWidth: Math.max(1, obj.borderDots / 2),
            selectable: false,
            evented: false,
          }),
        );
      }
    }
  }

  // Cell content
  for (const cell of obj.cells) {
    const rect = resolveCellRect(
      cell.row,
      cell.col,
      obj.rowHeightsMm,
      obj.colWidthsMm,
      obj.merges,
    );
    if (rect.row !== cell.row || rect.col !== cell.col) continue;
    const padMm = cell.paddingMm ?? CELL_DEFAULTS.paddingMm;
    const innerXPx = (rect.x + padMm) * PX_PER_MM;
    const innerYPx = (rect.y + padMm) * PX_PER_MM;
    const innerWPx = (rect.w - 2 * padMm) * PX_PER_MM;
    const innerHPx = (rect.h - 2 * padMm) * PX_PER_MM;
    if (innerWPx <= 0 || innerHPx <= 0) continue;

    if (cell.imageSourceDataUrl) {
      pushImageChild(children, cell.imageSourceDataUrl, innerXPx, innerYPx, innerWPx, innerHPx);
    } else if (cell.text !== undefined) {
      const fontHeightMm = cell.fontHeightMm ?? CELL_DEFAULTS.fontHeightMm;
      const align = cell.align ?? CELL_DEFAULTS.align;
      children.push(
        new fabric.Textbox(cell.text, {
          left: innerXPx,
          top: innerYPx,
          width: innerWPx,
          fontSize: fontHeightMm * PX_PER_MM,
          fontFamily: 'Helvetica, Arial, sans-serif',
          fill: '#0f172a',
          textAlign: align,
          editable: false,
          selectable: false,
          evented: false,
          angle: rotationToAngle(cell.fontRotation),
          originX: 'left',
          originY: 'top',
        }),
      );
    }
  }

  return new fabric.Group(children, {
    left: obj.x * PX_PER_MM,
    top: obj.y * PX_PER_MM,
    angle: rotationToAngle(obj.rotation),
    originX: 'left',
    originY: 'top',
    subTargetCheck: false,
  });
}

/**
 * Push a fabric.FabricImage child once it loads. We push a placeholder
 * Rect immediately so the group geometry is stable, then swap on load.
 * The placeholder is invisible (transparent fill), preserving layout.
 */
function pushImageChild(
  children: fabric.FabricObject[],
  src: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const placeholder = new fabric.Rect({
    left: x,
    top: y,
    width: w,
    height: h,
    fill: 'rgba(148, 163, 184, 0.2)',
    selectable: false,
    evented: false,
  });
  children.push(placeholder);
  void fabric.FabricImage.fromURL(src).then(img => {
    const natW = img.width ?? w;
    const natH = img.height ?? h;
    img.set({
      left: x,
      top: y,
      scaleX: w / natW,
      scaleY: h / natH,
      selectable: false,
      evented: false,
    });
    const group = placeholder.group;
    if (!group) return;
    group.remove(placeholder);
    group.add(img);
    group.canvas?.requestRenderAll();
  }).catch(() => {
    /* leave placeholder visible — the user will re-upload */
  });
}

// Re-export so callers can avoid a separate types import.
export type { ImageEncodedPayload };
```

- [ ] **Step 2: Build to verify**

```bash
cd frontend && npm run build
```

Expected: builds (no consumer yet, but typecheck passes).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/table/tableNode.ts
git commit -m "feat(table): fabric.Group factory for TableObject"
```

### Task 3.3: "New Table" modal

**Files:**
- Create: `frontend/src/components/table/NewTableModal.tsx`

- [ ] **Step 1: Create the modal**

```tsx
import { useEffect, useRef, useState } from 'react';
import { NumberField } from '../formFields';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (rows: number, cols: number) => void;
}

export function NewTableModal({ isOpen, onClose, onConfirm }: Props) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const submit = () => {
    const r = Math.min(20, Math.max(1, Math.round(rows)));
    const c = Math.min(20, Math.max(1, Math.round(cols)));
    onConfirm(r, c);
  };

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 z-30 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Insert table"
        className="bg-white rounded shadow-xl w-72 p-4"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold text-slate-800 mb-3">Insert Table</h2>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {/* NumberField doesn't expose a ref, so render rows ourselves so we can focus it */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Rows</label>
            <input
              ref={firstInputRef}
              type="number"
              min={1}
              max={20}
              value={rows}
              onChange={e => setRows(Number(e.target.value))}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              autoFocus
              className="w-full border border-slate-300 rounded px-2 py-1 text-sm"
            />
          </div>
          <NumberField
            label="Columns"
            value={cols}
            min={1}
            max={20}
            onChange={setCols}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="px-3 py-1.5 text-sm text-white bg-blue-600 border border-blue-600 rounded hover:bg-blue-700"
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/table/NewTableModal.tsx
git commit -m "feat(table): NewTableModal for rows/cols entry"
```

### Task 3.4: Wire "Add Table" toolbar button + modal into `LabelEditor`

**Files:**
- Modify: `frontend/src/components/LabelEditor.tsx`

- [ ] **Step 1: Add imports**

Near the existing component imports, add:

```tsx
import { NewTableModal } from './table/NewTableModal';
import type { TableObject } from '../types';
```

- [ ] **Step 2: Add state for modal**

Inside `LabelEditor()`, near the other `useState` hooks (right after `isBatchModalOpen`), add:

```tsx
const [isNewTableOpen, setIsNewTableOpen] = useState(false);
```

- [ ] **Step 3: Add the `addTable` handler**

Near the other `add*` handlers (`addText`, `addBarcode`, `addQrCode`):

```tsx
const handleAddTableClick = () => setIsNewTableOpen(true);

const handleConfirmNewTable = (rows: number, cols: number) => {
  setIsNewTableOpen(false);
  const labelW = doc.widthMm ?? 100;
  const labelH = doc.heightMm ?? 50;
  const colWidthMm = Math.max(5, (labelW * 0.5) / cols);
  const rowHeightMm = Math.max(5, (labelH * 0.5) / rows);
  const id = nextId('table');
  const obj: TableObject = {
    id,
    type: 'table',
    x: 5,
    y: 5,
    data: `Table ${rows}×${cols}`,
    rowHeightsMm: Array.from({ length: rows }, () => rowHeightMm),
    colWidthsMm: Array.from({ length: cols }, () => colWidthMm),
    borderDots: 2,
    cells: [],
    merges: [],
  };
  setDoc(d => ({ ...d, objects: [...d.objects, obj] }));
  setSelectedId(id);
};
```

- [ ] **Step 4: Add the toolbar button**

In the left aside, after the existing four `<ToolButton>` entries, add:

```tsx
<ToolButton
  onClick={handleAddTableClick}
  icon={<TableIcon size={16} />}
  label="Add Table"
/>
```

- [ ] **Step 5: Mount the modal at the bottom**

Right after `<BatchDataModal …/>`:

```tsx
<NewTableModal
  isOpen={isNewTableOpen}
  onClose={() => setIsNewTableOpen(false)}
  onConfirm={handleConfirmNewTable}
/>
```

- [ ] **Step 6: Extend the Layers panel icon switch**

Find the existing inline icon expression around `o.type === 'text' ? 'T' : …` and extend it:

```tsx
{o.type === 'text'
  ? 'T'
  : o.type === 'barcode'
    ? '‖'
    : o.type === 'qrcode'
      ? '▣'
      : o.type === 'image'
        ? 'I'
        : '▦'}
```

- [ ] **Step 7: Build**

```bash
cd frontend && npm run build
```

Expected: builds. (The Fabric reconcile loop still doesn't know how to render a table — that's Task 3.5; clicking "Add Table" will succeed but the canvas will be blank for the new object.)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/LabelEditor.tsx
git commit -m "feat(editor): Add Table toolbar button + insertion modal"
```

### Task 3.5: Teach the Fabric reconcile loop to render tables

**Files:**
- Modify: `frontend/src/components/LabelEditor.tsx`

- [ ] **Step 1: Import the new factory**

Near the other `./table/*` imports:

```tsx
import { createTableNode } from './table/tableNode';
```

- [ ] **Step 2: Route tables through the existing `createFabricNode` switch**

Find the existing `createFabricNode` function (around the top of the file) and add the `'table'` case:

```ts
function createFabricNode(obj: LabelObject): LabelNode {
  switch (obj.type) {
    case 'text':
      return createTextNode(obj);
    case 'barcode':
      return createBarcodeNode(obj);
    case 'qrcode':
      return createQrNode(obj);
    case 'table':
      return createTableNode(obj) as LabelNode;
    case 'image':
      throw new Error(
        'Image nodes are async — use createImageNode() instead',
      );
  }
}
```

- [ ] **Step 3: Mark tables as always-recreate in `shouldRecreate`**

Inside `shouldRecreate`, add this branch right before the final `return false;`:

```ts
  if (prev.type === 'table' && next.type === 'table') {
    return (
      JSON.stringify(prev.rowHeightsMm) !== JSON.stringify(next.rowHeightsMm) ||
      JSON.stringify(prev.colWidthsMm) !== JSON.stringify(next.colWidthsMm) ||
      JSON.stringify(prev.cells) !== JSON.stringify(next.cells) ||
      JSON.stringify(prev.merges) !== JSON.stringify(next.merges) ||
      prev.borderDots !== next.borderDots
    );
  }
```

(Using `JSON.stringify` is fine for this comparison: tables have small payloads and this only runs on state updates, not in a hot loop.)

- [ ] **Step 4: Smoke test**

Run `npm run dev`, click "Add Table", confirm 3×3 in the modal, and verify a 3×3 grid appears in the top-left of the canvas. The Layers panel shows `▦ table-1`. Selecting the table moves/rotates it as a single Fabric group.

The right property panel still shows nothing useful for tables — that's Phase 5.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/LabelEditor.tsx
git commit -m "feat(editor): render TableObject in the Fabric canvas"
```

---

## Phase 4 — Cell Selection Overlay

### Task 4.1: Add `cellSelection` state to `LabelEditor`

**Files:**
- Modify: `frontend/src/components/LabelEditor.tsx`

- [ ] **Step 1: Add the type and state**

Near the other `useState` calls inside `LabelEditor()`:

```tsx
type CellSelection =
  | { kind: 'none' }
  | { kind: 'single'; row: number; col: number }
  | { kind: 'range'; startRow: number; startCol: number; endRow: number; endCol: number };

const [cellSelection, setCellSelection] = useState<CellSelection>({ kind: 'none' });
```

- [ ] **Step 2: Clear cell selection when the selected object changes**

Add this effect right after the existing `selectedIdRef.current = selectedId;` line:

```tsx
useEffect(() => {
  setCellSelection({ kind: 'none' });
}, [selectedId]);
```

- [ ] **Step 3: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/LabelEditor.tsx
git commit -m "feat(editor): track cell selection state for tables"
```

### Task 4.2: `TableOverlay` component (cell click + Shift+drag range)

**Files:**
- Create: `frontend/src/components/table/tableOverlay.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useRef, useState } from 'react';
import type { TableObject } from '../../types';
import {
  buildOffsets,
  expandRangeToContainMerges,
  rangeFromTwoCells,
  resolveCellRect,
  type CellRange,
} from './tableGeometry';

const PX_PER_MM = 4;

export type CellSelection =
  | { kind: 'none' }
  | { kind: 'single'; row: number; col: number }
  | ({ kind: 'range' } & CellRange);

interface Props {
  table: TableObject;
  selection: CellSelection;
  onSelectionChange: (s: CellSelection) => void;
}

/**
 * HTML overlay rendered over the Fabric canvas, aligned to the table's
 * position. Hosts cell click + Shift+drag range selection. Resize handles
 * are added in Phase 6.
 */
export function TableOverlay({ table, selection, onSelectionChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ row: number; col: number } | null>(null);

  const colXs = buildOffsets(table.colWidthsMm);
  const rowYs = buildOffsets(table.rowHeightsMm);
  const widthPx = colXs[colXs.length - 1] * PX_PER_MM;
  const heightPx = rowYs[rowYs.length - 1] * PX_PER_MM;

  // Hit-test from a pointer's offsetX/Y back to (row, col).
  const cellFromPoint = (xPx: number, yPx: number): { row: number; col: number } | null => {
    if (xPx < 0 || yPx < 0 || xPx >= widthPx || yPx >= heightPx) return null;
    let col = -1;
    for (let c = 0; c < table.colWidthsMm.length; c++) {
      if (xPx < colXs[c + 1] * PX_PER_MM) { col = c; break; }
    }
    let row = -1;
    for (let r = 0; r < table.rowHeightsMm.length; r++) {
      if (yPx < rowYs[r + 1] * PX_PER_MM) { row = r; break; }
    }
    if (row === -1 || col === -1) return null;
    return { row, col };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!rootRef.current) return;
    const rect = rootRef.current.getBoundingClientRect();
    const point = cellFromPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (!point) return;
    e.preventDefault();
    rootRef.current.setPointerCapture(e.pointerId);
    if (e.shiftKey) {
      const baseRow = selection.kind === 'single' ? selection.row : (selection.kind === 'range' ? selection.startRow : point.row);
      const baseCol = selection.kind === 'single' ? selection.col : (selection.kind === 'range' ? selection.startCol : point.col);
      setDragStart({ row: baseRow, col: baseCol });
      const range = expandRangeToContainMerges(
        rangeFromTwoCells(baseRow, baseCol, point.row, point.col),
        table.merges,
      );
      onSelectionChange({ kind: 'range', ...range });
    } else {
      const resolved = resolveCellRect(point.row, point.col, table.rowHeightsMm, table.colWidthsMm, table.merges);
      onSelectionChange({ kind: 'single', row: resolved.row, col: resolved.col });
      setDragStart({ row: point.row, col: point.col });
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!rootRef.current || !dragStart) return;
    if (!e.shiftKey && e.buttons === 0) return;
    const rect = rootRef.current.getBoundingClientRect();
    const point = cellFromPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (!point) return;
    if (e.shiftKey || (selection.kind === 'range')) {
      const range = expandRangeToContainMerges(
        rangeFromTwoCells(dragStart.row, dragStart.col, point.row, point.col),
        table.merges,
      );
      onSelectionChange({ kind: 'range', ...range });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setDragStart(null);
    try { rootRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // Click outside cell area clears selection.
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      onSelectionChange({ kind: 'none' });
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [onSelectionChange]);

  // Highlight rectangles
  const highlightRects: { x: number; y: number; w: number; h: number }[] = [];
  if (selection.kind === 'single') {
    const r = resolveCellRect(selection.row, selection.col, table.rowHeightsMm, table.colWidthsMm, table.merges);
    highlightRects.push({ x: r.x * PX_PER_MM, y: r.y * PX_PER_MM, w: r.w * PX_PER_MM, h: r.h * PX_PER_MM });
  } else if (selection.kind === 'range') {
    const x = colXs[selection.startCol] * PX_PER_MM;
    const y = rowYs[selection.startRow] * PX_PER_MM;
    const w = (colXs[selection.endCol + 1] - colXs[selection.startCol]) * PX_PER_MM;
    const h = (rowYs[selection.endRow + 1] - rowYs[selection.startRow]) * PX_PER_MM;
    highlightRects.push({ x, y, w, h });
  }

  return (
    <div
      ref={rootRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: 'absolute',
        left: table.x * PX_PER_MM,
        top: table.y * PX_PER_MM,
        width: widthPx,
        height: heightPx,
        touchAction: 'none',
      }}
      className="z-10"
    >
      {highlightRects.map((r, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: r.x,
            top: r.y,
            width: r.w,
            height: r.h,
            background: 'rgba(59, 130, 246, 0.18)',
            border: '2px solid rgb(59, 130, 246)',
            pointerEvents: 'none',
          }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/table/tableOverlay.tsx
git commit -m "feat(table): cell selection overlay (click + Shift+drag range)"
```

### Task 4.3: Mount `TableOverlay` in `LabelEditor`

**Files:**
- Modify: `frontend/src/components/LabelEditor.tsx`

- [ ] **Step 1: Add import**

```tsx
import { TableOverlay, type CellSelection as OverlayCellSelection } from './table/tableOverlay';
```

Drop your locally-defined `CellSelection` (from Task 4.1) and reuse the one from the overlay:

```tsx
type CellSelection = OverlayCellSelection;
```

- [ ] **Step 2: Mount the overlay inside the canvas container**

Find the `<main className="flex-1 flex items-center justify-center bg-slate-200 overflow-auto p-8">` block and replace its inner `<div className="bg-white shadow-xl ring-1 ring-slate-300">` wrapper with a relative container that hosts both the canvas and an absolutely-positioned overlay:

```tsx
<main className="flex-1 flex items-center justify-center bg-slate-200 overflow-auto p-8">
  <div className="relative bg-white shadow-xl ring-1 ring-slate-300">
    <canvas ref={canvasElRef} />
    {selected?.type === 'table' && (
      <TableOverlay
        table={selected}
        selection={cellSelection}
        onSelectionChange={setCellSelection}
      />
    )}
  </div>
</main>
```

- [ ] **Step 3: Smoke test**

`npm run dev` → insert a 3×3 table → click a cell: a blue rectangle appears over that cell.
Shift+drag across cells: a blue rectangle covers the dragged range. If the drag started in or crossed an existing merge (you don't have one yet — comes in Phase 5), the selection auto-expands.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/LabelEditor.tsx
git commit -m "feat(editor): mount TableOverlay over the canvas when a table is selected"
```

---

## Phase 5 — Property Forms + Merge

### Task 5.1: `TablePropertyForm` (table-level edits)

**Files:**
- Create: `frontend/src/components/table/TablePropertyForm.tsx`

- [ ] **Step 1: Create the form**

```tsx
import type { TableObject, ZplRotation } from '../../types';
import { NumberField, SelectField, ReadOnlyField } from '../formFields';

interface Props {
  table: TableObject;
  onChange: (patch: Partial<TableObject>) => void;
  onDelete: () => void;
}

export function TablePropertyForm({ table, onChange, onDelete }: Props) {
  const rows = table.rowHeightsMm.length;
  const cols = table.colWidthsMm.length;
  const avgRow = rows ? table.rowHeightsMm.reduce((a, b) => a + b, 0) / rows : 8;
  const avgCol = cols ? table.colWidthsMm.reduce((a, b) => a + b, 0) / cols : 16;

  const addRow = () => onChange({
    rowHeightsMm: [...table.rowHeightsMm, Math.max(5, avgRow)],
    data: `Table ${rows + 1}×${cols}`,
  });
  const removeRow = () => {
    if (rows <= 1) return;
    onChange({
      rowHeightsMm: table.rowHeightsMm.slice(0, -1),
      cells: table.cells.filter(c => c.row < rows - 1),
      merges: clipMerges(table.merges, rows - 1, cols),
      data: `Table ${rows - 1}×${cols}`,
    });
  };
  const addCol = () => onChange({
    colWidthsMm: [...table.colWidthsMm, Math.max(5, avgCol)],
    data: `Table ${rows}×${cols + 1}`,
  });
  const removeCol = () => {
    if (cols <= 1) return;
    onChange({
      colWidthsMm: table.colWidthsMm.slice(0, -1),
      cells: table.cells.filter(c => c.col < cols - 1),
      merges: clipMerges(table.merges, rows, cols - 1),
      data: `Table ${rows}×${cols - 1}`,
    });
  };

  return (
    <div className="space-y-3">
      <ReadOnlyField label="ID" value={table.id} />
      <ReadOnlyField label="Type" value="table" />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="X (mm)" value={table.x} step={0.5}
          onChange={v => onChange({ x: v })} />
        <NumberField label="Y (mm)" value={table.y} step={0.5}
          onChange={v => onChange({ y: v })} />
      </div>
      <SelectField
        label="Rotation"
        value={table.rotation ?? 'N'}
        onChange={v => onChange({ rotation: v as ZplRotation })}
        options={[
          { value: 'N', label: '0°' },
          { value: 'R', label: '90°' },
          { value: 'I', label: '180°' },
          { value: 'B', label: '270°' },
        ]}
      />
      <NumberField
        label="Border (dot)"
        value={table.borderDots}
        min={0}
        max={10}
        onChange={v => onChange({ borderDots: Math.max(0, Math.round(v)) })}
      />
      <div className="grid grid-cols-2 gap-2">
        <button onClick={addRow}
          className="px-2 py-1.5 text-xs text-slate-700 bg-slate-50 hover:bg-blue-50 border border-slate-200 rounded">
          + Row ({rows})
        </button>
        <button onClick={removeRow} disabled={rows <= 1}
          className="px-2 py-1.5 text-xs text-slate-700 bg-slate-50 hover:bg-red-50 border border-slate-200 rounded disabled:opacity-50">
          – Row
        </button>
        <button onClick={addCol}
          className="px-2 py-1.5 text-xs text-slate-700 bg-slate-50 hover:bg-blue-50 border border-slate-200 rounded">
          + Column ({cols})
        </button>
        <button onClick={removeCol} disabled={cols <= 1}
          className="px-2 py-1.5 text-xs text-slate-700 bg-slate-50 hover:bg-red-50 border border-slate-200 rounded disabled:opacity-50">
          – Column
        </button>
      </div>
      <button onClick={onDelete}
        className="w-full mt-4 px-3 py-2 text-sm text-red-700 bg-red-50 hover:bg-red-100 rounded border border-red-200">
        Delete Table
      </button>
    </div>
  );
}

/** Drop or shrink merges that fall outside the new table bounds. */
function clipMerges(
  merges: TableObject['merges'],
  rows: number,
  cols: number,
): TableObject['merges'] {
  const out: TableObject['merges'] = [];
  for (const m of merges) {
    if (m.row >= rows || m.col >= cols) continue;
    const rs = Math.min(m.rowSpan, rows - m.row);
    const cs = Math.min(m.colSpan, cols - m.col);
    if (rs <= 0 || cs <= 0) continue;
    if (rs === 1 && cs === 1) continue;
    out.push({ ...m, rowSpan: rs, colSpan: cs });
  }
  return out;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/table/TablePropertyForm.tsx
git commit -m "feat(table): TablePropertyForm for table-level edits"
```

### Task 5.2: `CellPropertyForm` (per-cell text/image edits)

**Files:**
- Create: `frontend/src/components/table/CellPropertyForm.tsx`

- [ ] **Step 1: Create the form**

```tsx
import { useCallback, useRef, type ChangeEvent } from 'react';
import {
  CELL_DEFAULTS,
  type TableCellContent,
  type TableObject,
  type ZplRotation,
} from '../../types';
import { NumberField, SelectField, TextField } from '../formFields';

interface Props {
  table: TableObject;
  row: number;
  col: number;
  onTableChange: (patch: Partial<TableObject>) => void;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

export function CellPropertyForm({ table, row, col, onTableChange }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const existing = table.cells.find(c => c.row === row && c.col === col);

  const mode: 'text' | 'image' = existing?.imageSourceDataUrl ? 'image' : 'text';

  const setCell = useCallback(
    (next: TableCellContent | null) => {
      const others = table.cells.filter(c => !(c.row === row && c.col === col));
      onTableChange({ cells: next ? [...others, next] : others });
    },
    [table.cells, row, col, onTableChange],
  );

  const switchToText = () => {
    setCell({
      row, col,
      text: existing?.text ?? '',
      fontHeightMm: existing?.fontHeightMm ?? CELL_DEFAULTS.fontHeightMm,
      fontRotation: existing?.fontRotation ?? CELL_DEFAULTS.fontRotation,
      align: existing?.align ?? CELL_DEFAULTS.align,
      paddingMm: existing?.paddingMm ?? CELL_DEFAULTS.paddingMm,
    });
  };

  const switchToImage = () => fileInputRef.current?.click();

  const onFileSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    setCell({
      row, col,
      imageSourceDataUrl: dataUrl,
      paddingMm: existing?.paddingMm ?? CELL_DEFAULTS.paddingMm,
    });
  };

  const update = (patch: Partial<TableCellContent>) => {
    setCell({ row, col, ...(existing ?? { row, col }), ...patch });
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        Cell ({row + 1}, {col + 1})
      </div>
      <div className="flex gap-2">
        <button
          onClick={switchToText}
          className={`flex-1 px-2 py-1 text-xs border rounded ${mode === 'text' ? 'bg-blue-100 border-blue-300 text-blue-800' : 'bg-white border-slate-300 text-slate-700'}`}
        >
          Text
        </button>
        <button
          onClick={switchToImage}
          className={`flex-1 px-2 py-1 text-xs border rounded ${mode === 'image' ? 'bg-blue-100 border-blue-300 text-blue-800' : 'bg-white border-slate-300 text-slate-700'}`}
        >
          Image
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png, image/jpeg"
          className="hidden"
          onChange={onFileSelected}
        />
      </div>

      {mode === 'text' ? (
        <>
          <TextField
            label="Text"
            value={existing?.text ?? ''}
            multiline
            onChange={v => update({ text: v, imageSourceDataUrl: undefined, imageEncoded: undefined })}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Font height (mm)"
              value={existing?.fontHeightMm ?? CELL_DEFAULTS.fontHeightMm}
              step={0.5}
              min={1}
              onChange={v => update({ fontHeightMm: v })}
            />
            <NumberField
              label="Padding (mm)"
              value={existing?.paddingMm ?? CELL_DEFAULTS.paddingMm}
              step={0.5}
              min={0}
              onChange={v => update({ paddingMm: v })}
            />
          </div>
          <SelectField
            label="Align"
            value={existing?.align ?? CELL_DEFAULTS.align}
            onChange={v => update({ align: v as 'left' | 'center' | 'right' })}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Center' },
              { value: 'right', label: 'Right' },
            ]}
          />
          <SelectField
            label="Text rotation"
            value={existing?.fontRotation ?? CELL_DEFAULTS.fontRotation}
            onChange={v => update({ fontRotation: v as ZplRotation })}
            options={[
              { value: 'N', label: '0°' },
              { value: 'R', label: '90°' },
              { value: 'I', label: '180°' },
              { value: 'B', label: '270°' },
            ]}
          />
        </>
      ) : (
        <>
          <div className="text-xs text-slate-500 break-all">
            Image loaded ({(existing?.imageSourceDataUrl?.length ?? 0) > 0 ? 'yes' : 'no'})
          </div>
          <button
            onClick={switchToImage}
            className="w-full px-2 py-1.5 text-xs text-slate-700 bg-slate-50 hover:bg-blue-50 border border-slate-200 rounded"
          >
            Replace image
          </button>
          <NumberField
            label="Padding (mm)"
            value={existing?.paddingMm ?? CELL_DEFAULTS.paddingMm}
            step={0.5}
            min={0}
            onChange={v => update({ paddingMm: v })}
          />
        </>
      )}

      {existing && (
        <button
          onClick={() => setCell(null)}
          className="w-full mt-2 px-3 py-1.5 text-xs text-red-700 bg-red-50 hover:bg-red-100 rounded border border-red-200"
        >
          Clear cell
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/table/CellPropertyForm.tsx
git commit -m "feat(table): CellPropertyForm for per-cell text/image editing"
```

### Task 5.3: `RangeMergeForm` (merge / unmerge)

**Files:**
- Create: `frontend/src/components/table/RangeMergeForm.tsx`

- [ ] **Step 1: Create the form**

```tsx
import type { TableObject } from '../../types';
import { rangeMatchesMerge, type CellRange } from './tableGeometry';

interface Props {
  table: TableObject;
  range: CellRange;
  onTableChange: (patch: Partial<TableObject>) => void;
  onClearSelection: () => void;
}

export function RangeMergeForm({ table, range, onTableChange, onClearSelection }: Props) {
  const rowCount = range.endRow - range.startRow + 1;
  const colCount = range.endCol - range.startCol + 1;
  const existing = rangeMatchesMerge(range, table.merges);

  const doMerge = () => {
    // Drop any merge fully contained in the new region, then add the new one.
    const filteredMerges = table.merges.filter(m => {
      const mEndR = m.row + m.rowSpan - 1;
      const mEndC = m.col + m.colSpan - 1;
      const fullyInside =
        m.row >= range.startRow &&
        m.col >= range.startCol &&
        mEndR <= range.endRow &&
        mEndC <= range.endCol;
      return !fullyInside;
    });
    const filteredCells = table.cells.filter(c => {
      // Keep the top-left cell content; drop others inside the new region.
      const inside =
        c.row >= range.startRow &&
        c.row <= range.endRow &&
        c.col >= range.startCol &&
        c.col <= range.endCol;
      const isTopLeft = c.row === range.startRow && c.col === range.startCol;
      return !inside || isTopLeft;
    });
    onTableChange({
      merges: [
        ...filteredMerges,
        {
          row: range.startRow,
          col: range.startCol,
          rowSpan: rowCount,
          colSpan: colCount,
        },
      ],
      cells: filteredCells,
    });
    onClearSelection();
  };

  const doUnmerge = () => {
    if (!existing) return;
    onTableChange({
      merges: table.merges.filter(m => m !== existing),
    });
    onClearSelection();
  };

  return (
    <div className="space-y-3">
      <div className="text-xs text-slate-500">
        {rowCount} row{rowCount === 1 ? '' : 's'} × {colCount} column{colCount === 1 ? '' : 's'} selected
      </div>
      {existing ? (
        <button
          onClick={doUnmerge}
          className="w-full px-3 py-2 text-sm text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded"
        >
          Unmerge Cells
        </button>
      ) : (
        <button
          onClick={doMerge}
          disabled={rowCount === 1 && colCount === 1}
          className="w-full px-3 py-2 text-sm text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded disabled:opacity-50"
        >
          Merge Cells
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/table/RangeMergeForm.tsx
git commit -m "feat(table): RangeMergeForm for merge/unmerge operations"
```

### Task 5.4: Branch the right `PropertyForm` to dispatch table forms

**Files:**
- Modify: `frontend/src/components/LabelEditor.tsx`

- [ ] **Step 1: Add imports**

```tsx
import { TablePropertyForm } from './table/TablePropertyForm';
import { CellPropertyForm } from './table/CellPropertyForm';
import { RangeMergeForm } from './table/RangeMergeForm';
```

- [ ] **Step 2: Replace the right-panel render**

Find the existing right `<aside>`:

```tsx
<aside className="w-80 bg-white border-l border-slate-200 p-4 overflow-y-auto shrink-0">
  <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
    Properties
  </h2>
  {selected ? (
    <PropertyForm
      object={selected}
      onChange={patch => updateObject(selected.id, patch)}
      onDelete={() => deleteObject(selected.id)}
    />
  ) : (
    <p className="text-sm text-slate-400 italic">
      Select an object on the canvas.
    </p>
  )}
</aside>
```

…and replace the `{selected ? ( …PropertyForm… ) : ( … )}` body with:

```tsx
{selected ? (
  selected.type === 'table' ? (
    cellSelection.kind === 'range' &&
    (cellSelection.startRow !== cellSelection.endRow ||
      cellSelection.startCol !== cellSelection.endCol) ? (
      <RangeMergeForm
        table={selected}
        range={cellSelection}
        onTableChange={patch => updateObject(selected.id, patch)}
        onClearSelection={() => setCellSelection({ kind: 'none' })}
      />
    ) : cellSelection.kind === 'single' ? (
      <CellPropertyForm
        table={selected}
        row={cellSelection.row}
        col={cellSelection.col}
        onTableChange={patch => updateObject(selected.id, patch)}
      />
    ) : (
      <TablePropertyForm
        table={selected}
        onChange={patch => updateObject(selected.id, patch)}
        onDelete={() => deleteObject(selected.id)}
      />
    )
  ) : (
    <PropertyForm
      object={selected}
      onChange={patch => updateObject(selected.id, patch)}
      onDelete={() => deleteObject(selected.id)}
    />
  )
) : (
  <p className="text-sm text-slate-400 italic">
    Select an object on the canvas.
  </p>
)}
```

- [ ] **Step 3: Smoke test**

`npm run dev`:
- Click "Add Table" → 3×3 inserted → right panel shows "TablePropertyForm" with rotation, border, +Row/–Row/+Column/–Column buttons. Add a row → grid grows.
- Click a cell → right panel switches to "CellPropertyForm". Type text → text renders inside the cell. Switch to Image, upload → placeholder appears in the cell. Switch back to Text → text returns.
- Shift+drag two cells → right panel switches to "Merge Cells" button. Click → cells merge visually. Click the merged cell, re-Shift+drag the same area → button becomes "Unmerge Cells".

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/LabelEditor.tsx
git commit -m "feat(editor): dispatch Table/Cell/Range property forms based on selection"
```

---

## Phase 6 — Drag-Resize Row Heights / Column Widths

### Task 6.1: Add resize handles to `TableOverlay`

**Files:**
- Modify: `frontend/src/components/table/tableOverlay.tsx`

- [ ] **Step 1: Extend `Props` and add handle render**

Add two callbacks to `Props` (right after `onSelectionChange`):

```ts
onRowResize?: (rowIndex: number, newHeightMm: number) => void;
onColResize?: (colIndex: number, newWidthMm: number) => void;
```

Inside the component, add a drag state and pointer handlers for handles:

```tsx
const [resizing, setResizing] = useState<
  | { axis: 'row'; index: number; startClientY: number; startSizeMm: number }
  | { axis: 'col'; index: number; startClientX: number; startSizeMm: number }
  | null
>(null);

const onHandleDown = (
  axis: 'row' | 'col',
  index: number,
) => (e: React.PointerEvent<HTMLDivElement>) => {
  e.stopPropagation();
  e.preventDefault();
  (e.target as Element).setPointerCapture(e.pointerId);
  setResizing(
    axis === 'row'
      ? { axis, index, startClientY: e.clientY, startSizeMm: table.rowHeightsMm[index] }
      : { axis, index, startClientX: e.clientX, startSizeMm: table.colWidthsMm[index] },
  );
};

const onHandleMove = (e: React.PointerEvent<HTMLDivElement>) => {
  if (!resizing) return;
  if (resizing.axis === 'row') {
    const deltaMm = (e.clientY - resizing.startClientY) / PX_PER_MM;
    const next = Math.max(5, resizing.startSizeMm + deltaMm);
    onRowResize?.(resizing.index, next);
  } else {
    const deltaMm = (e.clientX - resizing.startClientX) / PX_PER_MM;
    const next = Math.max(5, resizing.startSizeMm + deltaMm);
    onColResize?.(resizing.index, next);
  }
};

const onHandleUp = (e: React.PointerEvent<HTMLDivElement>) => {
  setResizing(null);
  try { (e.target as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
};
```

Inside the JSX return, **add** the handle elements **after** the highlight rects map. Each row boundary (between rows i and i+1) gets a thin horizontal strip; each column boundary, a thin vertical strip.

```tsx
{/* Row resize handles (between row i and i+1) */}
{table.rowHeightsMm.map((_, i) => (
  <div
    key={`rh-${i}`}
    onPointerDown={onHandleDown('row', i)}
    onPointerMove={onHandleMove}
    onPointerUp={onHandleUp}
    onPointerCancel={onHandleUp}
    style={{
      position: 'absolute',
      left: 0,
      top: rowYs[i + 1] * PX_PER_MM - 4,
      width: widthPx,
      height: 8,
      cursor: 'row-resize',
      touchAction: 'none',
    }}
  />
))}

{/* Column resize handles (between col i and i+1) */}
{table.colWidthsMm.map((_, i) => (
  <div
    key={`ch-${i}`}
    onPointerDown={onHandleDown('col', i)}
    onPointerMove={onHandleMove}
    onPointerUp={onHandleUp}
    onPointerCancel={onHandleUp}
    style={{
      position: 'absolute',
      top: 0,
      left: colXs[i + 1] * PX_PER_MM - 4,
      width: 8,
      height: heightPx,
      cursor: 'col-resize',
      touchAction: 'none',
    }}
  />
))}
```

(The outer-most row/col indices' handles overlap the table edge — they still work as "resize the last row/column" handles, matching standard spreadsheet behavior.)

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/table/tableOverlay.tsx
git commit -m "feat(table): row/col resize handles on the overlay"
```

### Task 6.2: Wire resize callbacks in `LabelEditor`

**Files:**
- Modify: `frontend/src/components/LabelEditor.tsx`

- [ ] **Step 1: Pass `onRowResize` / `onColResize`**

At the `<TableOverlay ... />` mount site (added in Task 4.3), extend it:

```tsx
<TableOverlay
  table={selected}
  selection={cellSelection}
  onSelectionChange={setCellSelection}
  onRowResize={(idx, mm) => {
    if (selected.type !== 'table') return;
    const next = [...selected.rowHeightsMm];
    next[idx] = mm;
    updateObject(selected.id, { rowHeightsMm: next });
  }}
  onColResize={(idx, mm) => {
    if (selected.type !== 'table') return;
    const next = [...selected.colWidthsMm];
    next[idx] = mm;
    updateObject(selected.id, { colWidthsMm: next });
  }}
/>
```

- [ ] **Step 2: Smoke test**

`npm run dev`:
- Insert a table, select it
- Hover a row boundary → cursor becomes `row-resize`. Drag down → that row grows
- Hover a column boundary → cursor becomes `col-resize`. Drag right → that column grows
- Min size 5mm is enforced (you can't drag it smaller)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/LabelEditor.tsx
git commit -m "feat(editor): wire row/col resize handles to TableObject mutations"
```

---

## Phase 7 — Cell Image Encoding

### Task 7.1: Extend the image encoding effect to walk `TableObject.cells`

**Files:**
- Modify: `frontend/src/components/LabelEditor.tsx`

- [ ] **Step 1: Locate the existing encoding `useEffect`**

It currently filters `doc.objects` for `ImageObject` and calls `imageToZpl(...)`. Add a parallel pass that also visits each `TableObject`'s cells.

Right after the existing `for (const obj of stale)` loop **inside the same `useEffect`**, add a second pass:

```ts
// Encode any table cells whose imageSourceDataUrl is set but whose
// imageEncoded is missing or stale (based on the current cell box).
for (const obj of doc.objects) {
  if (obj.type !== 'table') continue;
  for (const cell of obj.cells) {
    if (!cell.imageSourceDataUrl) continue;
    // Compute the cell's current outer rect to size the bitmap.
    const rect = (() => {
      // Inline import is heavy here; instead duplicate the small helper:
      const colXs: number[] = [0];
      for (const w of obj.colWidthsMm) colXs.push(colXs[colXs.length - 1] + w);
      const rowYs: number[] = [0];
      for (const h of obj.rowHeightsMm) rowYs.push(rowYs[rowYs.length - 1] + h);
      const merge = obj.merges.find(
        m =>
          cell.row >= m.row &&
          cell.row < m.row + m.rowSpan &&
          cell.col >= m.col &&
          cell.col < m.col + m.colSpan,
      );
      const r = merge ? merge.row : cell.row;
      const c = merge ? merge.col : cell.col;
      const rs = merge ? merge.rowSpan : 1;
      const cs = merge ? merge.colSpan : 1;
      let w = 0; for (let i = 0; i < cs; i++) w += obj.colWidthsMm[c + i] ?? 0;
      let h = 0; for (let i = 0; i < rs; i++) h += obj.rowHeightsMm[r + i] ?? 0;
      return { w, h, topLeftRow: r, topLeftCol: c };
    })();
    if (cell.row !== rect.topLeftRow || cell.col !== rect.topLeftCol) continue;
    const padMm = cell.paddingMm ?? 1;
    const innerWMm = Math.max(1, rect.w - 2 * padMm);
    const innerHMm = Math.max(1, rect.h - 2 * padMm);
    const targetKey = computeEncodingKey({
      sourceDataUrl: cell.imageSourceDataUrl,
      widthMm: innerWMm,
      heightMm: innerHMm,
      threshold: 128,
      dpmm,
    });
    if (cell.imageEncoded && cell.imageEncoded.key === targetKey) continue;
    const widthDots = Math.max(1, Math.round(innerWMm * dpmm));
    const heightDots = Math.max(1, Math.round(innerHMm * dpmm));
    void imageToZpl(cell.imageSourceDataUrl, { widthDots, heightDots, threshold: 128 })
      .then(result => {
        if (cancelled) return;
        setDoc(d => ({
          ...d,
          objects: d.objects.map(o => {
            if (o.id !== obj.id || o.type !== 'table') return o;
            return {
              ...o,
              cells: o.cells.map(c => {
                if (c.row !== cell.row || c.col !== cell.col) return c;
                return {
                  ...c,
                  imageEncoded: {
                    key: targetKey,
                    hexData: result.hexData,
                    bytesPerRow: result.bytesPerRow,
                    totalBytes: result.totalBytes,
                    widthDots: result.widthDots,
                    heightDots: result.heightDots,
                  },
                };
              }),
            };
          }),
        }));
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.warn('Cell image encoding failed:', err);
      });
  }
}
```

- [ ] **Step 2: Smoke test**

`npm run dev`:
- Insert a table, click a cell, switch to Image, upload a small PNG
- After a moment the cell shows a colored placeholder (Fabric image); the Live Preview at the bottom now renders the table with the image baked in (verify by clicking "Copy to Clipboard" — the ZPL contains a `^GFA,...` block inside the table)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/LabelEditor.tsx
git commit -m "feat(editor): encode cell image bitmaps into ^GFA payloads"
```

---

## Phase 8 — Polish & Smoke

### Task 8.1: Full manual smoke checklist

**Files:** none

- [ ] **Step 1: Run the dev server and verify each item below**

Start: `cd frontend && npm run dev`. Open the editor.

**Bottom panel**
- [ ] Drag the gray strip above "Code & Preview" header up and down — it resizes between 120px and ~70% of the viewport
- [ ] Click `▼` → only the 32px header remains. Canvas takes the full middle.
- [ ] Click `▲` → restores the prior height
- [ ] Reload the page → height + collapse state survive

**Table — basic**
- [ ] Click "Add Table" in the toolbar → modal opens
- [ ] Enter rows=4, cols=5, press Enter → table appears at (5mm, 5mm) with uniform sizing
- [ ] Layers panel shows `▦ table-1`. Selecting it in the layer list also selects on the canvas.
- [ ] In the right panel: change Border to 4 → all grid lines thicken on canvas and in Live Preview
- [ ] Rotate to 90° → entire table rotates as a unit

**Table — rows/cols**
- [ ] In TablePropertyForm: + Row → 5 rows. – Row → back to 4. Same for columns.
- [ ] – Row is disabled at 1 row

**Cell editing**
- [ ] Click a cell → CellPropertyForm appears
- [ ] Type text → text appears inside the cell on canvas, and the Live Preview re-renders with the same text
- [ ] Change Align to Center → text re-centers
- [ ] Click Image, upload PNG → after ~1s a placeholder rectangle appears in the cell, then the actual image. The Live Preview shows the dithered ^GFA bitmap.
- [ ] Switch back to Text → previous text returns

**Merge**
- [ ] Shift+drag from cell (1,1) to (2,2) → blue highlight covers 2×2
- [ ] Right panel shows "2 rows × 2 columns selected" and Merge Cells button
- [ ] Click Merge Cells → grid lines disappear inside the merged region; Live Preview reflects the merge
- [ ] Click the merged cell, Shift+drag the same 2×2 → button changes to "Unmerge Cells"

**Drag-resize**
- [ ] Hover a horizontal grid line → cursor becomes row-resize
- [ ] Drag down → that row grows; ZPL and Live Preview update on pointerup
- [ ] Hover a vertical grid line → cursor becomes col-resize, drag right grows the column

**Regression — existing features**
- [ ] Add Text / Barcode / QR / Image all still work and live-preview as before
- [ ] Quick Presets dropdown loads each preset correctly
- [ ] Batch Data modal still detects `{{variables}}` in non-table objects
- [ ] Copy to Clipboard / Download ZPL File contain the correct ZPL including the table block

- [ ] **Step 2: If anything failed, fix and re-run**

For any failed item, find the relevant earlier task and re-examine the diff (`git log --oneline -1 -- <file>`). Commit fixes as small targeted commits.

- [ ] **Step 3: Final commit (if any fixes were needed)**

```bash
git status
```

If no changes: nothing to commit; this task is done. Otherwise:

```bash
git add -A
git commit -m "fix(table): resolve issues from smoke checklist"
```

---

## Self-Review Notes (post-write)

- All spec sections map to tasks: Bottom panel (1.1–1.3); types (2.1); ZPL (2.3); insertion modal (3.3); fabric node (3.2, 3.5); overlay (4.2, 4.3); property panels (5.1–5.4); resize (6.1, 6.2); cell image encoding (7.1); manual smoke (8.1).
- No `TBD` / `TODO` / `implement later` placeholders anywhere.
- `setCell` / `update` / `clipMerges` / `rangeMatchesMerge` / `resolveCellRect` are referenced consistently across files (verified against the type definitions in tasks 2.1, 2.2, 5.1, 5.2, 5.3).
- The `data` field convention `Table {rows}×{cols}` is set at create-time (3.4) and refreshed in TablePropertyForm row/col mutations (5.1).
- Phase 0 (Vitest) sits before any TDD-style task that uses `vitest`.
