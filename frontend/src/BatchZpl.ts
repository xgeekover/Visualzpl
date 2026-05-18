/**
 * BatchZpl
 *
 * Variable-substitution pipeline that turns a single LabelDocument into a
 * concatenated ZPL stream of N labels, one per data row.
 *
 * Variable syntax: any token enclosed in double curly braces, where the name
 * is a valid identifier — e.g. `{{Price}}`, `{{Item_Code}}`, `{{BarcodeData}}`.
 *
 * Why string-level substitution instead of per-row deep-cloning + rebuild?
 *   1. ZplBuilder.escapeFieldData() replaces `^` and `~` with spaces, but
 *      leaves `{` and `}` alone, so placeholders survive into the final ZPL.
 *   2. Running ZplBuilder once is cheaper than rebuilding for every row.
 *   3. The same escape rule (`escapeForZpl`) is applied to substituted values
 *      so user-supplied data containing `^` or `~` cannot break ZPL parsing.
 */

import { ZplBuilder } from './ZplBuilder';
import type { LabelDocument } from './types';

/** Matches `{{VariableName}}` tokens. Names must start with a letter or `_`. */
export const VARIABLE_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** Plain key→value mapping for a single batch row. */
export type DataRow = Record<string, string>;

/**
 * Scan the document for all distinct `{{name}}` placeholders that appear in
 * any field that gets rendered into ZPL (Text / Barcode / QR Code data).
 *
 * Returns names in discovery order so the UI columns stay stable across
 * re-renders and small doc edits.
 */
export function extractVariables(doc: LabelDocument): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const obj of doc.objects) {
    // Image data field is just the filename — it never reaches the printer.
    if (obj.type === 'image') continue;

    // Use a fresh regex each iteration so .lastIndex from a previous match
    // does not leak across object boundaries.
    const pattern = new RegExp(VARIABLE_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(obj.data)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
    }
  }

  return ordered;
}

/**
 * Mirrors ZplBuilder.escapeFieldData so user-entered values can never
 * accidentally introduce a ZPL control prefix (`^` or `~`).
 */
function escapeForZpl(value: string): string {
  return value.replace(/[\^~]/g, ' ');
}

/**
 * Compile the document once, then perform per-row string substitution on the
 * resulting ZPL. The output is a single ZPL stream containing N `^XA…^XZ`
 * blocks back to back — Zebra firmware advances and cuts one label per block.
 *
 * If a row is missing a value for some variable, the placeholder is replaced
 * with an empty string (i.e. printed as blank in that field).
 *
 * If `dataRows` is empty the base ZPL is returned unchanged so the caller can
 * still pre-flight what a single label looks like.
 */
export function generateBatchZpl(
  doc: LabelDocument,
  dataRows: DataRow[],
): string {
  const baseZpl = new ZplBuilder(doc).build();
  if (dataRows.length === 0) return baseZpl;

  const labels: string[] = new Array(dataRows.length);
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const pattern = new RegExp(VARIABLE_PATTERN.source, 'g');
    labels[i] = baseZpl.replace(pattern, (_full, name: string) => {
      const value = row[name];
      return value !== undefined ? escapeForZpl(value) : '';
    });
  }
  return labels.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// Batch data validation
// ──────────────────────────────────────────────────────────────────────────

/** Severity of a single validation issue. */
export type ValidationSeverity = 'warning' | 'error';

/** Machine-readable codes shared between UI highlighting and any logging. */
export type ValidationCode =
  | 'BarcodeRuleException'
  | 'EmptyRequiredField'
  | 'ControlCharacterWarning'
  | 'NonAsciiCharacter';

export interface BatchValidationIssue {
  rowIndex: number;
  variableName: string;
  severity: ValidationSeverity;
  code: ValidationCode;
  /** Human-readable message suitable for cell tooltips and accessible alerts. */
  message: string;
}

export interface BatchValidationResult {
  issues: BatchValidationIssue[];
  /** Map keyed by `cellKey(rowIndex, name)` — holds the worst issue per cell. */
  byCell: Map<string, BatchValidationIssue>;
  errorCount: number;
  warningCount: number;
}

/** Stable lookup key used in `byCell`. */
export function cellKey(rowIndex: number, variableName: string): string {
  return `${rowIndex}#${variableName}`;
}

/** Thrown by callers that want a hard failure instead of a soft issue list. */
export class ValidationError extends Error {
  readonly issues: BatchValidationIssue[];
  constructor(issues: BatchValidationIssue[]) {
    super(`Batch validation failed with ${issues.length} issue(s).`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** Thrown when a value violates Code 128 character constraints. */
export class BarcodeRuleException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarcodeRuleException';
  }
}

const PRINTABLE_ASCII_MIN = 0x20; // space
const PRINTABLE_ASCII_MAX = 0x7e; // tilde

/**
 * Validate every cell of `dataRows` against the constraints implied by the
 * label objects that consume each variable. The strictest object type wins —
 * a variable used in both a Text and a Barcode field is held to the Barcode
 * rules. Returns a structured result the UI can use to highlight cells.
 */
export function validateBatchData(
  doc: LabelDocument,
  dataRows: DataRow[],
): BatchValidationResult {
  type ConsumerType = 'text' | 'barcode' | 'qrcode';

  // Step 1 — classify every variable by the object types that consume it.
  const consumersByVariable = new Map<string, Set<ConsumerType>>();
  for (const obj of doc.objects) {
    if (obj.type === 'image' || obj.type === 'table') continue;
    const pattern = new RegExp(VARIABLE_PATTERN.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(obj.data)) !== null) {
      const name = match[1];
      if (!consumersByVariable.has(name)) {
        consumersByVariable.set(name, new Set());
      }
      consumersByVariable.get(name)!.add(obj.type);
    }
  }

  // Step 2 — per-cell rule application.
  const issues: BatchValidationIssue[] = [];
  for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
    const row = dataRows[rowIndex];
    for (const [variableName, consumers] of consumersByVariable) {
      const value = row[variableName] ?? '';
      const issue = validateCellValue(
        rowIndex,
        variableName,
        value,
        consumers,
      );
      if (issue) issues.push(issue);
    }
  }

  // Step 3 — dedupe by cell, keep the worst severity.
  const byCell = new Map<string, BatchValidationIssue>();
  for (const issue of issues) {
    const key = cellKey(issue.rowIndex, issue.variableName);
    const existing = byCell.get(key);
    if (
      !existing ||
      severityRank(issue.severity) > severityRank(existing.severity)
    ) {
      byCell.set(key, issue);
    }
  }

  let errorCount = 0;
  let warningCount = 0;
  for (const issue of byCell.values()) {
    if (issue.severity === 'error') errorCount++;
    else warningCount++;
  }

  return { issues, byCell, errorCount, warningCount };
}

function severityRank(severity: ValidationSeverity): number {
  return severity === 'error' ? 2 : 1;
}

function validateCellValue(
  rowIndex: number,
  variableName: string,
  value: string,
  consumers: Set<'text' | 'barcode' | 'qrcode'>,
): BatchValidationIssue | null {
  // Strictest rule wins — barcode > qrcode > text.
  if (consumers.has('barcode')) {
    if (value.length === 0) {
      return {
        rowIndex,
        variableName,
        severity: 'error',
        code: 'EmptyRequiredField',
        message: 'Barcode value cannot be empty.',
      };
    }
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      const code = value.charCodeAt(i);
      if (ch === '^' || ch === '~') {
        return {
          rowIndex,
          variableName,
          severity: 'error',
          code: 'BarcodeRuleException',
          message:
            'ZPL control characters ^ and ~ are not allowed in barcode data.',
        };
      }
      if (code < PRINTABLE_ASCII_MIN || code > PRINTABLE_ASCII_MAX) {
        const hex = code.toString(16).padStart(4, '0').toUpperCase();
        return {
          rowIndex,
          variableName,
          severity: 'error',
          code: 'NonAsciiCharacter',
          message: `Code 128 does not support character "${ch}" (U+${hex}).`,
        };
      }
    }
    return null;
  }

  if (consumers.has('qrcode')) {
    if (value.length === 0) {
      return {
        rowIndex,
        variableName,
        severity: 'warning',
        code: 'EmptyRequiredField',
        message: 'QR code value is empty.',
      };
    }
    if (/[\^~]/.test(value)) {
      return {
        rowIndex,
        variableName,
        severity: 'warning',
        code: 'ControlCharacterWarning',
        message:
          'Control characters ^ and ~ will be replaced with spaces on print.',
      };
    }
    return null;
  }

  // Text — most permissive.
  if (/[\^~]/.test(value)) {
    return {
      rowIndex,
      variableName,
      severity: 'warning',
      code: 'ControlCharacterWarning',
      message:
        'Control characters ^ and ~ will be replaced with spaces on print.',
    };
  }
  return null;
}
