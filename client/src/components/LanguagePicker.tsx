import React, { useEffect } from 'react';
import type { TranscriptionLanguage } from '../types';

interface LanguagePickerProps {
  current: TranscriptionLanguage;
  onSelect: (lang: TranscriptionLanguage) => void;
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

const RING_R = 52;
const GAP = 10;
const SEGMENT = (360 - GAP * 3) / 3;

const SEGMENTS: { lang: TranscriptionLanguage; label: string; startAngle: number }[] = [
  { lang: 'ru', label: 'RU', startAngle: GAP / 2 },
  { lang: 'en', label: 'EN', startAngle: GAP / 2 + SEGMENT + GAP },
  { lang: 'auto', label: 'AUTO', startAngle: GAP / 2 + (SEGMENT + GAP) * 2 },
];

const LanguagePicker: React.FC<LanguagePickerProps> = ({ current, onSelect, onClose }) => {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <>
      <div className="mode-picker-backdrop" onClick={onClose} />
      <svg
        className="lang-ring-svg"
        viewBox="-100 -100 200 200"
        aria-label="Select language"
        role="menu"
      >
        {SEGMENTS.map((seg) => {
          const endAngle = seg.startAngle + SEGMENT;
          const midAngle = seg.startAngle + SEGMENT / 2;
          const arcPath = describeArc(0, 0, RING_R, seg.startAngle, endAngle);
          const labelPos = polarToCartesian(0, 0, RING_R + 26, midAngle);
          return (
            <React.Fragment key={seg.lang}>
              <path
                d={arcPath}
                className={`lang-ring-arc lang-ring-arc--${seg.lang}${current === seg.lang ? ' lang-ring-arc--active' : ''}`}
                onClick={(e) => { e.stopPropagation(); onSelect(seg.lang); }}
                role="menuitem"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(seg.lang); } }}
              />
              <text
                x={labelPos.x}
                y={labelPos.y}
                className={`lang-ring-label lang-ring-label--${seg.lang}`}
                textAnchor="middle"
                dominantBaseline="middle"
                pointerEvents="none"
              >
                {seg.label}
              </text>
            </React.Fragment>
          );
        })}
      </svg>
    </>
  );
};

export default LanguagePicker;
