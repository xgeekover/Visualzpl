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
