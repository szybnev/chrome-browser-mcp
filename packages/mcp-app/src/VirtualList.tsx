import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  maxHeight?: number;
  fillHeight?: boolean;
  overscan?: number;
  getKey: (item: T) => string | number;
  renderRow: (item: T) => ReactNode;
  emptyState?: ReactNode;
}

/**
 * Adaptive zero-dependency windowed virtual list.
 * When fillHeight=true, expands dynamically to fill remaining viewport height via ResizeObserver
 * (never leaving wasted space when many tabs exist, while shrinking naturally when few items exist).
 */
export function VirtualList<T>({
  items,
  rowHeight,
  maxHeight,
  fillHeight = false,
  overscan = 5,
  getKey,
  renderRow,
  emptyState,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const [measuredHeight, setMeasuredHeight] = useState(maxHeight ?? 360);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!fillHeight) return;
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const h = el.clientHeight;
      if (h > 0) setMeasuredHeight(h);
    };
    update();
    const obs = new ResizeObserver(update);
    obs.observe(el);
    return () => obs.disconnect();
  }, [fillHeight]);

  const totalHeight = items.length * rowHeight;
  const viewportHeight = fillHeight
    ? Math.max(rowHeight, measuredHeight)
    : Math.min(maxHeight ?? 360, Math.max(rowHeight, totalHeight));

  const { startIndex, endIndex } = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
    const end = Math.min(items.length, start + visibleCount);
    return { startIndex: start, endIndex: end };
  }, [scrollTop, rowHeight, viewportHeight, overscan, items.length]);

  if (items.length === 0) {
    return <>{emptyState ?? null}</>;
  }

  const visibleItems = items.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      className={`scroller virtual-list ${fillHeight ? 'virtual-list-fill' : ''}`}
      style={
        fillHeight
          ? { maxHeight: totalHeight }
          : { height: viewportHeight, maxHeight }
      }
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ position: 'relative', height: totalHeight, width: '100%' }}>
        {visibleItems.map((item, idx) => {
          const absoluteIndex = startIndex + idx;
          return (
            <div
              key={getKey(item)}
              style={{
                position: 'absolute',
                top: absoluteIndex * rowHeight,
                left: 0,
                right: 0,
                height: rowHeight - 6,
              }}
            >
              {renderRow(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
