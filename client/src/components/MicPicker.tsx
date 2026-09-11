import React, { useEffect, useMemo, useRef, useLayoutEffect, useState } from 'react';

interface MicPickerProps {
  devices: MediaDeviceInfo[];
  selectedId: string;
  onSelect: (deviceId: string) => void;
  onClose: () => void;
}

const SPREAD = 44;
const CONN_GAP = 34;

function arcPath(r: number): string {
  return `M 0 ${-r} A ${r} ${r} 0 0 1 0 ${r}`;
}

const MicPicker: React.FC<MicPickerProps> = ({ devices, selectedId, onSelect, onClose }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [textWidths, setTextWidths] = useState<number[]>([]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const options = useMemo(() => [
    { id: '', label: 'Default' },
    ...devices.map((d) => ({
      id: d.deviceId,
      label: d.label || `Microphone ${d.deviceId.slice(0, 8)}`,
    })),
  ], [devices]);

  useLayoutEffect(() => {
    if (!svgRef.current) return;
    const texts = svgRef.current.querySelectorAll<SVGTextElement>('.mic-picker-text');
    const widths = Array.from(texts).map((t) => t.getComputedTextLength());
    if (widths.length > 0) setTextWidths(widths);
  }, [options]);

  const count = options.length;
  const totalSpread = Math.min(SPREAD * (count - 1), 160);
  const halfSpread = totalSpread / 2;
  const step = count > 1 ? totalSpread / (count - 1) : 0;
  const arcR = halfSpread + 14;
  const svgH = (halfSpread + 30) * 2;
  const centerY = svgH / 2;

  return (
    <>
      <div className="mode-picker-backdrop" onClick={onClose} />
      <svg
        ref={svgRef}
        className="mic-picker-svg"
        style={{ height: `${svgH}px` }}
        aria-label="Select microphone"
        role="menu"
      >
        <g transform={`translate(${CONN_GAP}, ${centerY})`}>
          <line x1={-CONN_GAP} y1={0} x2={arcR} y2={0} className="mic-picker-conn" />

          <path d={arcPath(arcR)} className="mic-picker-arc" />

          {options.map((opt, i) => {
            const y = -halfSpread + i * step;
            const arcX = Math.sqrt(Math.max(0, arcR * arcR - y * y));
            const lineStartX = arcX + 12;
            const measured = textWidths[i];
            const lineEndX = measured
              ? lineStartX + measured + 16
              : lineStartX + opt.label.length * 6.5 + 16;
            const isActive = selectedId === opt.id;

            return (
              <g
                key={opt.id}
                className={`mic-picker-row${isActive ? ' mic-picker-row--active' : ''}`}
                onClick={(e) => { e.stopPropagation(); onSelect(opt.id); }}
                role="menuitem"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(opt.id); } }}
                style={{ cursor: 'pointer', animationDelay: `${0.5 + i * 0.08}s` }}
              >
                <line
                  x1={lineStartX}
                  y1={y}
                  x2={lineEndX}
                  y2={y}
                  className="mic-picker-line"
                />
                <text
                  x={lineStartX + 6}
                  y={y - 5}
                  className="mic-picker-text"
                >
                  {opt.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </>
  );
};

export default MicPicker;
