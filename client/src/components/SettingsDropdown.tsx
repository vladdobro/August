import React, { useEffect, useRef, useState } from 'react';

export interface SettingsDropdownOption {
  value: string;
  label: string;
  sublabel?: string;
  disabled?: boolean;
}

export interface SettingsDropdownProps {
  value: string;
  options: SettingsDropdownOption[];
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
}

export const SettingsDropdown: React.FC<SettingsDropdownProps> = ({ value, options, onChange, className, placeholder }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const selectedOption = options.find((o) => o.value === value);

  return (
    <div ref={containerRef} className={`settings-dropdown${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className="settings-dropdown-trigger"
        title={selectedOption?.sublabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{selectedOption ? selectedOption.label : (placeholder ?? value)}</span>
        <svg className="settings-dropdown-chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open && (
        <div className="settings-dropdown-menu">
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              className={`settings-dropdown-item${option.value === value ? ' settings-dropdown-item--active' : ''}${option.disabled ? ' settings-dropdown-item--disabled' : ''}`}
              style={{ animationDelay: `${0.04 + index * 0.04}s` }}
              disabled={option.disabled}
              onClick={() => {
                if (option.disabled) return;
                onChange(option.value);
                setOpen(false);
              }}
            >
              <span className="settings-dropdown-item-label">{option.label}</span>
              {option.sublabel && <span className="settings-dropdown-item-sub">{option.sublabel}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default SettingsDropdown;
