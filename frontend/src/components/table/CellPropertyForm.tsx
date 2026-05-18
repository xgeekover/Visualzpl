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
    const base: TableCellContent = existing ?? { row, col };
    setCell({ ...base, ...patch });
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
