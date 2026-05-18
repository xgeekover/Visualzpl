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
  onRowResize?: (rowIndex: number, newHeightMm: number) => void;
  onColResize?: (colIndex: number, newWidthMm: number) => void;
}

/**
 * HTML overlay rendered over the Fabric canvas, aligned to the table's
 * position. Hosts cell click + Shift+drag range selection, and row/column
 * resize handles.
 */
export function TableOverlay({ table, selection, onSelectionChange, onRowResize, onColResize }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ row: number; col: number } | null>(null);

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

  const colXs = buildOffsets(table.colWidthsMm);
  const rowYs = buildOffsets(table.rowHeightsMm);
  const widthPx = colXs[colXs.length - 1] * PX_PER_MM;
  const heightPx = rowYs[rowYs.length - 1] * PX_PER_MM;

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

  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      if (!rootRef.current) return;
      const target = e.target as Node | null;
      if (!target) return;
      // Inside the overlay → don't clear (the overlay handles its own selection).
      if (rootRef.current.contains(target)) return;
      // Inside the right property panel or any modal → don't clear; the
      // panel's buttons (Merge/Unmerge/Delete/etc.) need a stable selection
      // to operate on. Same for the cell file picker that lives in CellPropertyForm.
      const targetEl = target instanceof Element ? target : (target as Node).parentElement;
      if (targetEl?.closest('aside')) return;
      if (targetEl?.closest('[role="dialog"]')) return;
      onSelectionChange({ kind: 'none' });
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [onSelectionChange]);

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
    </div>
  );
}
