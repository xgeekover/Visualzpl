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
    expect(zpl).toContain('^FO8,8');
    expect(zpl).toContain('^A0N,24,0');
    expect(zpl).toContain('^FB144,');
    expect(zpl).toContain(',C,0');
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
    expect(zpl).not.toContain('^FO0,80^GB');
    expect(zpl).not.toContain('^FO160,0^GB');
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
    expect(zpl).toContain('^FO168,88^GFA,2,2,1,AABB^FS');
  });
});
