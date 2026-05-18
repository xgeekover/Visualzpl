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
