// AUG-205: collapsed state may be set by the store's fitting rule (auto); expanding a rail keeps this column open and collapses another if needed.
// AUG-199: shell of a side column next to the live transcript: header (title, count, shortcut, collapse, hide),
// left splitter (drag to resize, double-click to reset), 28 px rail when collapsed, nothing when hidden.
import React, { useRef } from 'react';
import { CANVAS_MIN_WIDTH, COLUMN_MAX_WIDTH, COLUMN_MIN_WIDTH, COLUMN_TITLES, liveColumnsStore, useLiveColumns, type ColumnKey } from '../../services/liveColumnsStore';

interface LiveColumnProps {
  colKey: ColumnKey;
  count?: number | string;
  /// e.g. 'Ctrl+3'; shown next to the title.
  shortcut?: string;
  /// false: the count shows on the collapsed rail only.
  headCount?: boolean;
  children: React.ReactNode;
}

const LiveColumn: React.FC<LiveColumnProps> = ({ colKey, count, shortcut, headCount = true, children }) => {
  const { columns } = useLiveColumns();
  const layout = columns[colKey];
  const sectionRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startX: number; startW: number; max: number } | null>(null);
  const title = COLUMN_TITLES[colKey];

  if (!layout.show) return null;

  if (layout.collapsed) {
    return (
      <button type="button" className="live-rail" onClick={() => liveColumnsStore.expand(colKey)} aria-label={`Expand ${title}`} title={`Expand ${title}`}>
        {count !== undefined && <span className="live-rail-badge">{count}</span>}
        <span className="live-rail-title">{title}</span>
      </button>
    );
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const main = sectionRef.current?.parentElement;
    if (!main) return;
    // The transcript canvas keeps at least CANVAS_MIN_WIDTH: cap this column by what the others leave free.
    let others = 0;
    main.querySelectorAll<HTMLElement>(':scope > .live-col, :scope > .live-rail').forEach((el) => {
      if (el !== sectionRef.current) others += el.offsetWidth;
    });
    const room = main.getBoundingClientRect().width - others - CANVAS_MIN_WIDTH;
    dragRef.current = { startX: e.clientX, startW: layout.width, max: Math.max(COLUMN_MIN_WIDTH, Math.min(COLUMN_MAX_WIDTH, room)) };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.classList.add('live-col-splitter--drag');
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const w = Math.min(d.max, Math.max(COLUMN_MIN_WIDTH, d.startW + (d.startX - e.clientX)));
    liveColumnsStore.setWidth(colKey, w);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    e.currentTarget.classList.remove('live-col-splitter--drag');
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <section ref={sectionRef} className={`live-col live-col--${colKey}`} style={{ width: layout.width }} aria-label={title}>
      <div
        className="live-col-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title}`}
        title="Drag to resize · double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => liveColumnsStore.resetWidth(colKey)}
      />
      <div className="live-col-inner">
        <div className="live-col-head">
          <b className="live-col-title">{title}</b>
          {headCount && count !== undefined && count !== '' && <span className="live-col-count">{count}</span>}
          {shortcut && <span className="live-col-kb">{shortcut}</span>}
          <span className="live-col-spacer" />
          <button type="button" className="live-col-x" onClick={() => liveColumnsStore.collapse(colKey)} aria-label={`Collapse ${title}`} title="Collapse">&ndash;</button>
          <button type="button" className="live-col-x" onClick={() => liveColumnsStore.hide(colKey)} aria-label={`Hide ${title}`} title="Hide">&times;</button>
        </div>
        {children}
      </div>
    </section>
  );
};

export default LiveColumn;
