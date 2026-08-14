/**
 * useDocHistory
 *
 * `useState` 를 대체하는 실행취소/다시실행 스택. 문서 전체 스냅샷을 쌓는다.
 *
 * 스냅샷은 **얕은 복사**다 — 호출부가 `{...doc, objects: [...]}` 형태로 불변
 * 갱신을 하므로 바뀌지 않은 객체(특히 큰 이미지 DataURL)는 참조가 공유된다.
 * 따라서 깊은 복사 없이도 메모리 부담이 거의 없다.
 *
 * 세 가지 기록 방식:
 *   - 기본            : 변경마다 되돌림 지점 1개
 *   - `coalesceKey`   : 같은 키의 연속 변경을 하나로 묶는다(속성 패널 타이핑 등).
 *                       한 글자마다 되돌림 지점이 생기는 것을 막는다.
 *   - `record: false` : 되돌림 지점을 만들지 않는다. 사용자 동작이 아니라
 *                       코드가 채워 넣는 파생 데이터(이미지 인코딩 캐시 등)용.
 */

import { useCallback, useMemo, useReducer, useRef } from 'react';

/** 되돌림 지점 최대 개수. 오래된 것부터 버린다. */
const HISTORY_LIMIT = 50;

/** 같은 coalesceKey 의 변경이 이 시간 안에 이어지면 하나로 묶는다. */
const COALESCE_WINDOW_MS = 600;

export interface SetDocOptions {
  /** false 면 되돌림 지점을 만들지 않는다. 기본 true. */
  record?: boolean;
  /** 같은 키의 연속 변경을 하나의 되돌림 지점으로 묶는다. */
  coalesceKey?: string;
}

export type DocUpdater<T> = T | ((prev: T) => T);

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
  /** 직전에 되돌림 지점을 만든 변경의 키와 시각 — coalesce 판단용. */
  lastKey: string | null;
  lastAt: number;
}

export type HistoryAction<T> =
  | { type: 'set'; updater: DocUpdater<T>; options: SetDocOptions; now: number }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; value: T };

/** 히스토리 초기 상태. */
export const initHistory = <T,>(present: T): HistoryState<T> => ({
  past: [],
  present,
  future: [],
  lastKey: null,
  lastAt: 0,
});

/** 순수 리듀서 — 히스토리 동작의 전부가 여기 있어 React 없이 검증할 수 있다. */
export function historyReducer<T>(
  state: HistoryState<T>,
  action: HistoryAction<T>,
): HistoryState<T> {
  switch (action.type) {
    case 'set': {
      const { updater, options, now } = action;
      const next =
        typeof updater === 'function' ? (updater as (prev: T) => T)(state.present) : updater;
      // 값이 그대로면 히스토리를 더럽히지 않는다.
      if (Object.is(next, state.present)) return state;

      if (options.record === false) {
        return { ...state, present: next };
      }

      const key = options.coalesceKey ?? null;
      const coalesce =
        key !== null &&
        key === state.lastKey &&
        now - state.lastAt < COALESCE_WINDOW_MS &&
        state.past.length > 0;

      return {
        past: coalesce ? state.past : [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [], // 새 변경이 생기면 다시실행 분기는 버린다.
        lastKey: key,
        lastAt: now,
      };
    }

    case 'undo': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
        lastKey: null, // 되돌린 직후의 변경은 묶지 않는다.
        lastAt: 0,
      };
    }

    case 'redo': {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: rest,
        lastKey: null,
        lastAt: 0,
      };
    }

    case 'reset':
      return { past: [], present: action.value, future: [], lastKey: null, lastAt: 0 };

    default:
      return state;
  }
}

export interface UseDocHistoryResult<T> {
  doc: T;
  setDoc: (updater: DocUpdater<T>, options?: SetDocOptions) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 히스토리를 비우고 새 문서로 시작한다(초기 로드 등). */
  resetHistory: (value: T) => void;
}

export function useDocHistory<T>(initial: T): UseDocHistoryResult<T> {
  const [state, dispatch] = useReducer(
    historyReducer as typeof historyReducer<T>,
    initial,
    initHistory,
  );

  // 시간 소스를 ref 로 감싸 reducer 를 순수하게 유지한다.
  const nowRef = useRef<() => number>(() => Date.now());

  const setDoc = useCallback((updater: DocUpdater<T>, options: SetDocOptions = {}) => {
    dispatch({ type: 'set', updater, options, now: nowRef.current() });
  }, []);

  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const resetHistory = useCallback((value: T) => dispatch({ type: 'reset', value }), []);

  return useMemo(
    () => ({
      doc: state.present,
      setDoc,
      undo,
      redo,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      resetHistory,
    }),
    [state.present, state.past.length, state.future.length, setDoc, undo, redo, resetHistory],
  );
}
