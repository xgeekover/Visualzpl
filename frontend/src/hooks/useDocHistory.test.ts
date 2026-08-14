import { describe, expect, it } from 'vitest';
import {
  historyReducer,
  initHistory,
  type HistoryState,
  type SetDocOptions,
} from './useDocHistory';

interface Doc {
  objects: string[];
  widthMm?: number;
}

const start = (): HistoryState<Doc> => initHistory<Doc>({ objects: [] });

/** setDoc 한 번. now 를 직접 넘겨 coalesce 시간 창을 결정론적으로 검증한다. */
const set = (
  state: HistoryState<Doc>,
  updater: (prev: Doc) => Doc,
  options: SetDocOptions = {},
  now = 0,
): HistoryState<Doc> => historyReducer(state, { type: 'set', updater, options, now });

const undo = (s: HistoryState<Doc>) => historyReducer(s, { type: 'undo' });
const redo = (s: HistoryState<Doc>) => historyReducer(s, { type: 'redo' });

describe('useDocHistory 리듀서 — 실행취소/다시실행', () => {
  it('처음에는 되돌릴 것도 다시 할 것도 없다', () => {
    const s = start();
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(0);
  });

  it('변경 후 되돌리면 이전 상태로 돌아간다', () => {
    let s = set(start(), d => ({ ...d, objects: ['a'] }));
    expect(s.present.objects).toEqual(['a']);
    expect(s.past).toHaveLength(1);

    s = undo(s);
    expect(s.present.objects).toEqual([]);
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(1);
  });

  it('되돌린 뒤 다시실행하면 복구된다', () => {
    let s = set(start(), d => ({ ...d, objects: ['a'] }));
    s = redo(undo(s));
    expect(s.present.objects).toEqual(['a']);
    expect(s.future).toHaveLength(0);
  });

  it('여러 단계를 순서대로 되돌리고 다시 실행한다', () => {
    let s = start();
    s = set(s, d => ({ ...d, objects: [...d.objects, 'a'] }), {}, 0);
    s = set(s, d => ({ ...d, objects: [...d.objects, 'b'] }), {}, 1000);
    s = set(s, d => ({ ...d, objects: [...d.objects, 'c'] }), {}, 2000);
    expect(s.present.objects).toEqual(['a', 'b', 'c']);

    s = undo(s);
    expect(s.present.objects).toEqual(['a', 'b']);
    s = undo(s);
    expect(s.present.objects).toEqual(['a']);
    s = redo(s);
    expect(s.present.objects).toEqual(['a', 'b']);
  });

  it('되돌린 뒤 새 변경을 하면 다시실행 분기는 버려진다', () => {
    let s = set(start(), d => ({ ...d, objects: ['a'] }));
    s = undo(s);
    expect(s.future).toHaveLength(1);

    s = set(s, d => ({ ...d, objects: ['z'] }), {}, 5000);
    expect(s.future).toHaveLength(0);
    expect(s.present.objects).toEqual(['z']);
  });

  it('record:false 는 되돌림 지점을 만들지 않는다 (파생 캐시용)', () => {
    let s = set(start(), d => ({ ...d, objects: ['a'] }), {}, 0);
    s = set(s, d => ({ ...d, widthMm: 100 }), { record: false }, 100);
    expect(s.past).toHaveLength(1);
    expect(s.present.widthMm).toBe(100);

    // 한 번의 undo 로 사용자 동작 이전까지 되돌아간다.
    s = undo(s);
    expect(s.present.objects).toEqual([]);
    expect(s.past).toHaveLength(0);
  });

  it('같은 coalesceKey 의 연속 변경은 하나의 되돌림 지점으로 묶인다', () => {
    // 속성 패널에서 한 글자씩 타이핑하는 상황 (100ms 간격)
    let s = start();
    s = set(s, d => ({ ...d, objects: ['h'] }), { coalesceKey: 'obj-1' }, 0);
    s = set(s, d => ({ ...d, objects: ['he'] }), { coalesceKey: 'obj-1' }, 100);
    s = set(s, d => ({ ...d, objects: ['hel'] }), { coalesceKey: 'obj-1' }, 200);
    expect(s.present.objects).toEqual(['hel']);
    expect(s.past).toHaveLength(1);

    s = undo(s);
    expect(s.present.objects).toEqual([]); // 한 번에 타이핑 시작 전으로
  });

  it('같은 키라도 시간 창을 넘기면 새 되돌림 지점이 된다', () => {
    let s = start();
    s = set(s, d => ({ ...d, objects: ['h'] }), { coalesceKey: 'obj-1' }, 0);
    s = set(s, d => ({ ...d, objects: ['he'] }), { coalesceKey: 'obj-1' }, 5000);
    expect(s.past).toHaveLength(2);

    s = undo(s);
    expect(s.present.objects).toEqual(['h']);
  });

  it('다른 coalesceKey 는 묶이지 않는다 (다른 객체를 편집)', () => {
    let s = start();
    s = set(s, d => ({ ...d, objects: ['a'] }), { coalesceKey: 'obj-1' }, 0);
    s = set(s, d => ({ ...d, objects: ['a', 'b'] }), { coalesceKey: 'obj-2' }, 50);
    expect(s.past).toHaveLength(2);

    s = undo(s);
    expect(s.present.objects).toEqual(['a']);
  });

  it('키 없는 변경은 연달아 일어나도 항상 개별 지점이다', () => {
    let s = start();
    s = set(s, d => ({ ...d, objects: ['a'] }), {}, 0);
    s = set(s, d => ({ ...d, objects: ['a', 'b'] }), {}, 10);
    expect(s.past).toHaveLength(2);
    s = undo(s);
    expect(s.present.objects).toEqual(['a']);
  });

  it('값이 그대로면 히스토리를 더럽히지 않는다', () => {
    const s = set(start(), d => d);
    expect(s.past).toHaveLength(0);
  });

  it('reset 은 스택을 비우고 새 문서로 시작한다', () => {
    let s = set(start(), d => ({ ...d, objects: ['a'] }));
    s = historyReducer(s, { type: 'reset', value: { objects: ['loaded'] } });
    expect(s.present.objects).toEqual(['loaded']);
    expect(s.past).toHaveLength(0);
    expect(s.future).toHaveLength(0);
  });

  it('되돌릴/다시할 것이 없으면 아무 일도 하지 않는다', () => {
    const s = start();
    expect(undo(s)).toBe(s);
    expect(redo(s)).toBe(s);
  });

  it('되돌린 직후의 변경은 이전 키와 묶이지 않는다', () => {
    let s = start();
    s = set(s, d => ({ ...d, objects: ['a'] }), { coalesceKey: 'k' }, 0);
    s = undo(s);
    s = set(s, d => ({ ...d, objects: ['b'] }), { coalesceKey: 'k' }, 10);
    // undo 로 돌아간 지점이 덮어써지면 안 된다.
    expect(s.past).toHaveLength(1);
    s = undo(s);
    expect(s.present.objects).toEqual([]);
  });

  it('되돌림 지점은 상한(50) 을 넘지 않는다', () => {
    let s = start();
    for (let i = 0; i < 80; i++) {
      s = set(s, d => ({ ...d, objects: [...d.objects, `o${i}`] }), {}, i * 1000);
    }
    expect(s.past).toHaveLength(50);
    // 가장 오래된 것부터 버려졌으므로, 남은 가장 이른 지점은 30번째 상태다.
    expect(s.past[0].objects).toHaveLength(30);
  });

  it('스냅샷은 얕은 복사라 바뀌지 않은 객체는 참조를 공유한다', () => {
    const big = { id: 'img', payload: 'x'.repeat(1000) };
    type ImgDoc = { objects: Array<{ id: string; payload: string }> };
    let s = initHistory<ImgDoc>({ objects: [big] });
    s = historyReducer(s, {
      type: 'set',
      updater: d => ({ ...d, objects: [...d.objects, { id: 'b', payload: '' }] }),
      options: {},
      now: 0,
    });
    s = historyReducer(s, { type: 'undo' });
    // 되돌린 스냅샷 안의 이미지가 복사본이 아니라 원본과 같은 객체여야 한다.
    expect(s.present.objects[0]).toBe(big);
  });
});
