import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Lightweight windowed list (issue #612). Renders only the visible slice of a long
 * newest-first timeline so five-year session histories stay responsive without a
 * virtualization dependency.
 */
export function VirtualList<T>({
  items,
  estimateHeight = 96,
  overscan = 4,
  maxHeight = 480,
  className,
  children,
}: {
  items: readonly T[];
  estimateHeight?: number;
  overscan?: number;
  maxHeight?: number | string;
  className?: string;
  children: (item: T, index: number) => ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 24 });

  const updateRange = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const start = Math.floor(el.scrollTop / estimateHeight);
    const visible = Math.ceil(el.clientHeight / estimateHeight);
    const nextStart = Math.max(0, start - overscan);
    const nextEnd = Math.min(items.length, start + visible + overscan);
    setRange((prev) => (prev.start === nextStart && prev.end === nextEnd ? prev : { start: nextStart, end: nextEnd }));
  }, [estimateHeight, items.length, overscan]);

  useEffect(() => {
    updateRange();
  }, [items.length, updateRange]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateRange, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateRange) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', updateRange);
      observer?.disconnect();
    };
  }, [updateRange]);

  const topSpacer = range.start * estimateHeight;
  const bottomSpacer = Math.max(0, (items.length - range.end) * estimateHeight);

  return (
    <div ref={scrollRef} className={className} style={{ maxHeight, overflow: 'auto' }}>
      <div style={{ height: topSpacer }} aria-hidden />
      {items.slice(range.start, range.end).map((item, i) => children(item, range.start + i))}
      <div style={{ height: bottomSpacer }} aria-hidden />
    </div>
  );
}
