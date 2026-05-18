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
