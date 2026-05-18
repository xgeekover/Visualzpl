import { describe, expect, it } from 'vitest';
import type { TableCellSpan } from '../../types';
import {
  buildOffsets,
  resolveCellRect,
  rangeFromTwoCells,
  expandRangeToContainMerges,
  rangeMatchesMerge,
} from './tableGeometry';

describe('buildOffsets', () => {
  it('returns prefix sums starting at 0', () => {
    expect(buildOffsets([10, 20, 30])).toEqual([0, 10, 30, 60]);
  });
  it('handles a single entry', () => {
    expect(buildOffsets([7])).toEqual([0, 7]);
  });
});

describe('resolveCellRect', () => {
  const rows = [10, 10, 10];
  const cols = [20, 20, 20];

  it('returns the 1×1 rect for an un-merged cell', () => {
    expect(resolveCellRect(1, 2, rows, cols, [])).toEqual({
      row: 1, col: 2, rowSpan: 1, colSpan: 1,
      x: 40, y: 10, w: 20, h: 10,
    });
  });

  it('returns the full merged rect for any cell inside the merge', () => {
    const merges: TableCellSpan[] = [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }];
    const expected = {
      row: 0, col: 0, rowSpan: 2, colSpan: 2,
      x: 0, y: 0, w: 40, h: 20,
    };
    expect(resolveCellRect(0, 0, rows, cols, merges)).toEqual(expected);
    expect(resolveCellRect(0, 1, rows, cols, merges)).toEqual(expected);
    expect(resolveCellRect(1, 0, rows, cols, merges)).toEqual(expected);
    expect(resolveCellRect(1, 1, rows, cols, merges)).toEqual(expected);
  });
});

describe('rangeFromTwoCells', () => {
  it('normalizes regardless of drag direction', () => {
    expect(rangeFromTwoCells(2, 3, 0, 1)).toEqual({
      startRow: 0, startCol: 1, endRow: 2, endCol: 3,
    });
  });
});

describe('expandRangeToContainMerges', () => {
  it('returns the input range when no merge is partially crossed', () => {
    const input = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    const merges: TableCellSpan[] = [{ row: 2, col: 2, rowSpan: 2, colSpan: 2 }];
    expect(expandRangeToContainMerges(input, merges)).toEqual(input);
  });

  it('expands to fully contain a merge it partially overlaps', () => {
    const input = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    const merges: TableCellSpan[] = [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }];
    expect(expandRangeToContainMerges(input, merges)).toEqual({
      startRow: 0, startCol: 0, endRow: 2, endCol: 2,
    });
  });

  it('is idempotent', () => {
    const input = { startRow: 0, startCol: 0, endRow: 1, endCol: 1 };
    const merges: TableCellSpan[] = [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }];
    const once = expandRangeToContainMerges(input, merges);
    const twice = expandRangeToContainMerges(once, merges);
    expect(twice).toEqual(once);
  });
});

describe('rangeMatchesMerge', () => {
  const merges: TableCellSpan[] = [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }];

  it('returns the merge when range exactly matches', () => {
    expect(
      rangeMatchesMerge(
        { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
        merges,
      ),
    ).toEqual(merges[0]);
  });

  it('returns null when range does not match', () => {
    expect(
      rangeMatchesMerge(
        { startRow: 0, startCol: 0, endRow: 2, endCol: 2 },
        merges,
      ),
    ).toBeNull();
  });
});
