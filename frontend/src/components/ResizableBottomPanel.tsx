import { useCallback, useEffect, useRef, type ReactNode } from 'react';

interface Props {
  height: number;
  onHeightChange: (h: number) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  minHeight?: number;
  maxHeight?: number;
  children: ReactNode;
}

const HEADER_HEIGHT = 32;

/**
 * Bottom panel host. When expanded it renders a 6px drag handle above its
 * 32px header, then the caller's children. When collapsed it renders only
 * the header so the design canvas reclaims the space.
 */
export function ResizableBottomPanel({
  height,
  onHeightChange,
  collapsed,
  onToggleCollapse,
  minHeight = 120,
  maxHeight,
  children,
}: Props) {
  const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(
    null,
  );

  const resolvedMax = maxHeight ?? Math.round(window.innerHeight * 0.7);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
      event.preventDefault();
      (event.target as Element).setPointerCapture(event.pointerId);
      dragStartRef.current = { startY: event.clientY, startHeight: height };
    },
    [collapsed, height],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStartRef.current;
      if (!drag) return;
      // Pointer moves down → handle moves down → panel shrinks.
      const delta = event.clientY - drag.startY;
      const next = Math.min(
        resolvedMax,
        Math.max(minHeight, drag.startHeight - delta),
      );
      onHeightChange(next);
    },
    [minHeight, resolvedMax, onHeightChange],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragStartRef.current = null;
      try {
        (event.target as Element).releasePointerCapture(event.pointerId);
      } catch {
        /* nothing to release */
      }
    },
    [],
  );

  // Re-clamp on viewport resize so a previously valid height does not exceed
  // the new maximum.
  useEffect(() => {
    const onResize = () => {
      const max = Math.round(window.innerHeight * 0.7);
      if (height > max) onHeightChange(max);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [height, onHeightChange]);

  const totalHeight = collapsed ? HEADER_HEIGHT : height;

  return (
    <section
      className="flex flex-col shrink-0 border-t border-slate-300 bg-white"
      style={{ height: totalHeight }}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize code & preview panel"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="h-1.5 cursor-row-resize bg-slate-200 hover:bg-blue-400 transition-colors"
          style={{ touchAction: 'none' }}
        />
      )}
      <header
        className="flex items-center justify-between px-3 border-b border-slate-200 bg-slate-50"
        style={{ height: HEADER_HEIGHT }}
      >
        <span className="text-xs font-mono uppercase tracking-wider text-slate-500">
          {collapsed ? 'Code & Preview (hidden)' : 'Code & Preview'}
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
          title={collapsed ? 'Show code & preview' : 'Hide code & preview'}
          aria-expanded={!collapsed}
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-700"
        >
          {collapsed ? '▲' : '▼'}
        </button>
      </header>
      {!collapsed && <div className="flex-1 flex overflow-hidden">{children}</div>}
    </section>
  );
}
