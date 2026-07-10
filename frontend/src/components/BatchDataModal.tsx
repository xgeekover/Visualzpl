/**
 * BatchDataModal
 *
 * Modal dialog that lets the user define rows of values for every `{{variable}}`
 * placeholder used in the current LabelDocument. The dialog drives two
 * downstream actions:
 *
 *   1. Download Batch ZPL — wraps `generateBatchZpl(...)` in a Blob download.
 *   2. Print Batch to Zebra — sends the concatenated ZPL to the parent's
 *      Browser Print integration via the `onPrintBatch` callback prop.
 *
 * The dialog is intentionally always mounted (toggled via the `hidden` class)
 * so user-entered data persists across open/close cycles within one session.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  type ChangeEvent,
} from 'react';
import type { LabelDocument } from '../types';
import {
  cellKey,
  extractVariables,
  generateBatchZpl,
  validateBatchData,
  type BatchValidationIssue,
  type DataRow,
} from '../BatchZpl';
import { downloadTextFile } from '../downloadFile';

export interface BatchDataModalProps {
  isOpen: boolean;
  onClose: () => void;
  doc: LabelDocument;
  /** Controlled data grid — owned by the parent so presets can hydrate it. */
  dataRows: DataRow[];
  /** Replace the entire dataRows list. */
  onDataRowsChange: (rows: DataRow[]) => void;
  /** Send a concatenated batch ZPL string to the Zebra printer. */
  onPrintBatch: (zpl: string) => Promise<void>;
  /** Whether the Print button is currently allowed. */
  canPrint: boolean;
  /** True while a print request is in flight (single or batch). */
  isPrinting: boolean;
  /** Tooltip shown on the Print button when `canPrint` is false. */
  printDisabledReason?: string;
}

/** Build a fresh empty row, with one key per detected variable. */
function buildEmptyRow(variableNames: string[]): DataRow {
  const row: DataRow = {};
  for (const name of variableNames) row[name] = '';
  return row;
}

export function BatchDataModal({
  isOpen,
  onClose,
  doc,
  dataRows,
  onDataRowsChange,
  onPrintBatch,
  canPrint,
  isPrinting,
  printDisabledReason,
}: BatchDataModalProps) {
  const variables = useMemo(() => extractVariables(doc), [doc]);

  // Re-validate every time the doc or any cell changes.
  const validation = useMemo(
    () => validateBatchData(doc, dataRows),
    [doc, dataRows],
  );

  // Close on Escape (only attaches the listener while the dialog is visible).
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleCellChange = useCallback(
    (rowIndex: number, variableName: string, value: string) => {
      onDataRowsChange(
        dataRows.map((row, i) =>
          i === rowIndex ? { ...row, [variableName]: value } : row,
        ),
      );
    },
    [dataRows, onDataRowsChange],
  );

  const handleAddRow = useCallback(() => {
    onDataRowsChange([...dataRows, buildEmptyRow(variables)]);
  }, [dataRows, variables, onDataRowsChange]);

  const handleRemoveRow = useCallback(
    (rowIndex: number) => {
      onDataRowsChange(dataRows.filter((_, i) => i !== rowIndex));
    },
    [dataRows, onDataRowsChange],
  );

  const handleClearAll = useCallback(() => {
    onDataRowsChange([buildEmptyRow(variables)]);
  }, [variables, onDataRowsChange]);

  const handleDownloadBatch = useCallback(() => {
    const zpl = generateBatchZpl(doc, dataRows);
    const filename = `visual-zpl-batch-${dataRows.length}.zpl`;
    downloadTextFile(zpl, filename);
  }, [doc, dataRows]);

  const handlePrintBatch = useCallback(async () => {
    const zpl = generateBatchZpl(doc, dataRows);
    await onPrintBatch(zpl);
  }, [doc, dataRows, onPrintBatch]);

  const labelCount = dataRows.length;
  const hasVariables = variables.length > 0;
  const hasRows = labelCount > 0;
  const hasErrors = validation.errorCount > 0;
  const downloadDisabled = !hasRows || hasErrors;
  const printDisabled = !hasRows || hasErrors || !canPrint || isPrinting;
  const actionBlockedReason = hasErrors
    ? `Resolve ${validation.errorCount} validation error${validation.errorCount === 1 ? '' : 's'} first.`
    : undefined;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-data-modal-title"
      aria-hidden={!isOpen}
      className={
        isOpen
          ? 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4 animate-fade-in'
          : 'hidden'
      }
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl ring-1 ring-slate-200 shadow-pop w-full max-w-3xl max-h-[85vh] flex flex-col animate-pop-in"
        onClick={event => event.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2
              id="batch-data-modal-title"
              className="text-base font-semibold text-slate-800"
            >
              Batch Data
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Provide one row per label. Use{' '}
              <code className="px-1 bg-slate-100 rounded">
                {'{{VariableName}}'}
              </code>{' '}
              placeholders inside Text / Barcode / QR Code data fields.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 inline-flex items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {hasVariables ? (
            <div className="text-xs text-slate-500 flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-600">
                Detected variables:
              </span>
              {variables.map(name => (
                <code
                  key={name}
                  className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded font-mono"
                >
                  {`{{${name}}}`}
                </code>
              ))}
            </div>
          ) : (
            <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-xs text-slate-600">
              No <code>{'{{variable}}'}</code> placeholders found. Each row
              below will print as an identical copy of the current label.
            </div>
          )}

          <div className="rounded-lg ring-1 ring-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-2 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider w-10">
                    #
                  </th>
                  {hasVariables ? (
                    variables.map(name => (
                      <th
                        key={name}
                        className="px-2 py-2 text-left text-xs font-mono font-medium text-slate-700"
                      >
                        {name}
                      </th>
                    ))
                  ) : (
                    <th className="px-2 py-2 text-left text-xs font-medium text-slate-400 italic">
                      (no variables — row prints the label as-is)
                    </th>
                  )}
                  <th className="px-2 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {dataRows.map((row, rowIndex) => (
                  <tr
                    key={rowIndex}
                    className="border-t border-slate-100 hover:bg-slate-50/60"
                  >
                    <td className="px-2 py-1.5 text-xs text-slate-400 font-mono align-middle">
                      {rowIndex + 1}
                    </td>
                    {hasVariables ? (
                      variables.map(name => {
                        const issue = validation.byCell.get(
                          cellKey(rowIndex, name),
                        );
                        return (
                          <td key={name} className="px-1 py-1 align-middle">
                            <CellInput
                              value={row[name] ?? ''}
                              placeholder={`{{${name}}}`}
                              issue={issue}
                              onChange={value =>
                                handleCellChange(rowIndex, name, value)
                              }
                            />
                          </td>
                        );
                      })
                    ) : (
                      <td className="px-2 py-1.5 text-xs text-slate-400 italic align-middle">
                        copy of base label
                      </td>
                    )}
                    <td className="px-2 py-1 text-center align-middle">
                      <button
                        type="button"
                        onClick={() => handleRemoveRow(rowIndex)}
                        disabled={dataRows.length <= 1}
                        aria-label={`Remove row ${rowIndex + 1}`}
                        title="Remove row"
                        className="text-slate-400 hover:text-red-600 disabled:text-slate-200 disabled:cursor-not-allowed"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              onClick={handleAddRow}
              className="text-blue-600 hover:text-blue-800"
            >
              + Add Row
            </button>
            <span className="text-slate-300">|</span>
            <button
              type="button"
              onClick={handleClearAll}
              className="text-slate-500 hover:text-slate-700"
            >
              Clear All
            </button>
          </div>
        </div>

        {(validation.errorCount > 0 || validation.warningCount > 0) && (
          <div
            role={validation.errorCount > 0 ? 'alert' : 'status'}
            className="px-5 py-2 border-t border-slate-200 bg-slate-50 text-xs space-y-1"
          >
            {validation.errorCount > 0 && (
              <p className="text-red-700">
                {validation.errorCount} validation error
                {validation.errorCount === 1 ? '' : 's'} — fix highlighted
                cells before exporting or printing.
              </p>
            )}
            {validation.warningCount > 0 && (
              <p className="text-amber-700">
                {validation.warningCount} warning
                {validation.warningCount === 1 ? '' : 's'} — output will still
                print but may be sanitized.
              </p>
            )}
          </div>
        )}

        <footer className="px-5 py-3 border-t border-slate-200 flex items-center justify-between bg-slate-50 rounded-b-xl">
          <span className="text-sm text-slate-600">
            Ready to print{' '}
            <span className="font-semibold text-slate-800">{labelCount}</span>{' '}
            {labelCount === 1 ? 'label' : 'labels'}.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadBatch}
              disabled={downloadDisabled}
              title={actionBlockedReason}
              className="btn-secondary"
            >
              Download Batch ZPL
            </button>
            <button
              type="button"
              onClick={handlePrintBatch}
              disabled={printDisabled}
              title={
                actionBlockedReason ??
                (!canPrint ? printDisabledReason : undefined)
              }
              className="btn text-white bg-emerald-600 shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {isPrinting ? 'Sending…' : 'Print Batch to Zebra'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * Single cell editor with validation-aware border and tooltip. Extracted so
 * the look-and-feel of all cells stays consistent and easy to tweak.
 */
function CellInput({
  value,
  placeholder,
  issue,
  onChange,
}: {
  value: string;
  placeholder: string;
  issue: BatchValidationIssue | undefined;
  onChange: (value: string) => void;
}) {
  const severityClass =
    issue?.severity === 'error'
      ? 'border-red-400 ring-1 ring-red-200 focus:border-red-500'
      : issue?.severity === 'warning'
        ? 'border-amber-400 ring-1 ring-amber-200 focus:border-amber-500'
        : 'border-slate-200 focus:border-blue-400';

  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(event: ChangeEvent<HTMLInputElement>) =>
        onChange(event.target.value)
      }
      title={issue?.message}
      aria-invalid={issue?.severity === 'error' ? true : undefined}
      className={`w-full rounded-lg border px-2 py-1 text-sm font-mono transition focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${severityClass}`}
    />
  );
}
