import React, { useEffect } from 'react';

export type RecordingMode = 'default' | 'live';

interface RecordingModePickerProps {
  onSelect: (mode: RecordingMode) => void;
  onClose: () => void;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const sweep = endAngle - startAngle;
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

const RING_R = 72;
const GAP = 12;

const RecordingModePicker: React.FC<RecordingModePickerProps> = ({ onSelect, onClose }) => {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const leftArc = describeArc(0, 0, RING_R, 180 + GAP / 2, 360 - GAP / 2);
  const rightArc = describeArc(0, 0, RING_R, GAP / 2, 180 - GAP / 2);

  const leftLabelPos = polarToCartesian(0, 0, RING_R + 34, 270);
  const rightLabelPos = polarToCartesian(0, 0, RING_R + 34, 90);

  return (
    <>
      <div className="mode-picker-backdrop" onClick={onClose} />
      <svg
        className="mode-ring-svg"
        viewBox="-130 -130 260 260"
        aria-label="Select recording mode"
        role="menu"
      >
        <path
          d={leftArc}
          className="mode-ring-arc mode-ring-arc--default"
          onClick={(e) => { e.stopPropagation(); onSelect('default'); }}
          role="menuitem"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect('default'); } }}
        />
        <text
          x={leftLabelPos.x}
          y={leftLabelPos.y}
          className="mode-ring-label"
          textAnchor="middle"
          dominantBaseline="middle"
          pointerEvents="none"
        >
          DEFAULT
        </text>

        <path
          d={rightArc}
          className="mode-ring-arc mode-ring-arc--live"
          onClick={(e) => { e.stopPropagation(); onSelect('live'); }}
          role="menuitem"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect('live'); } }}
        />
        <text
          x={rightLabelPos.x}
          y={rightLabelPos.y}
          className="mode-ring-label mode-ring-label--live"
          textAnchor="middle"
          dominantBaseline="middle"
          pointerEvents="none"
        >
          LIVE
        </text>
      </svg>
    </>
  );
};

export default RecordingModePicker;
