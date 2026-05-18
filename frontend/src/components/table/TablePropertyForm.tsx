import type { TableObject } from '../../types';
import { NumberField, ReadOnlyField } from '../formFields';

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
      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
        Table rotation is not yet supported in the printed output. Rotate
        the printer media or split into individual text/barcode objects if
        you need rotated content.
      </div>
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
