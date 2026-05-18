/**
 * Minimal typed wrappers around localStorage. All access is guarded so that
 * SSR or storage-disabled browsers degrade to `null`/no-op instead of throwing.
 */

export function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // QuotaExceeded / disabled storage — silently ignore. The feature using
    // this helper must still work without persistence.
  }
}
