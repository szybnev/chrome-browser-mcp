import { useMemo, useRef, useState, type ReactNode } from 'react';

interface VirtualListProps<T> {
  items: T[];
  rowHeight: number;
  maxHeight?: number;
  overscan?: number;
  getKey: (item: T) => string | number;
  renderRow: (item: T) => ReactNode;
  emptyState?: ReactNode;
}

export function VirtualList<T>({
  items,
  rowHeight,
  maxHeight = 320,
  overscan = 5,
  getKey,
  renderRow,
  emptyState,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const totalHeight = items.length * rowHeight;
  const effectiveHeight = Math.min(maxHeight, Math.max(rowHeight, totalHeight));

  const { startIndex, endIndex } = useMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visibleCount = Math.ceil(effectiveHeight / rowHeight) + overscan * 2;
    const end = Math.min(items.length, start + visibleCount);
    return { startIndex: start, endIndex: end };
  }, [scrollTop, rowHeight, effectiveHeight, overscan, items.length]);

  if (items.length === 0) {
    return <>{emptyState ?? null}</>;
  }

  const visibleItems = items.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      className="scroller virtual-list"
      style={{ height: effectiveHeight, maxHeight }}
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
