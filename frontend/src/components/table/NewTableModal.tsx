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
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Insert table"
        className="w-72 rounded-xl bg-white p-5 shadow-pop ring-1 ring-slate-200 animate-pop-in"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="mb-4 text-sm font-semibold text-slate-800">Insert Table</h2>
        <div className="mb-5 grid grid-cols-2 gap-3">
          <div>
            <label className="field-label">Rows</label>
            <input
              ref={firstInputRef}
              type="number"
              min={1}
              max={20}
              value={rows}
              onChange={e => setRows(Number(e.target.value))}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
              autoFocus
              className="input"
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
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="button" onClick={submit} className="btn-primary">
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
