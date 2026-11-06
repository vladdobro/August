// AUG-199: pin-bar toggles for the live columns; rendered inside OverlayLayer's .pin-toggles and only while the live panel is mounted.
import React from 'react';
import { COLUMN_TITLES, liveColumnsStore, useLiveColumns, type ColumnKey } from '../../services/liveColumnsStore';
import { shortcutLabel } from './platform';

const ITEMS: Array<{ key: ColumnKey; hint?: string }> = [
  { key: 'ai' },
  { key: 'cp', hint: '4' },
  { key: 'as', hint: '3' },
];

const LiveColumnToggles: React.FC = () => {
  const { columns, liveVisible, transcript } = useLiveColumns();
  if (!liveVisible) return null;
  return (
    <>
      <span className="pin-sep" aria-hidden="true" />
      {ITEMS.filter(({ key }) => key !== 'cp' || transcript).map(({ key, hint }) => (
        <button
          key={key}
          type="button"
          className={`pin-btn${columns[key].show ? ' pin-btn--active' : ''}`}
          aria-pressed={columns[key].show}
          title={hint ? `${COLUMN_TITLES[key]} (${shortcutLabel(hint)})` : COLUMN_TITLES[key]}
          onClick={() => liveColumnsStore.toggle(key)}
        >
          [ {COLUMN_TITLES[key]} ]
        </button>
      ))}
    </>
  );
};

export default LiveColumnToggles;
