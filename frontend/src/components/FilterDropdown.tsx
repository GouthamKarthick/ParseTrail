/**
 * @fileoverview FilterDropdown — custom multi-select dropdown with checkboxes.
 * Replaces the native select for document-type filtering.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./FilterDropdown.module.scss";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Single selectable filter option. */
export interface FilterOption {
  value: string;
  label: string;
}

interface Props {
  options: FilterOption[];
  selected: string[];
  active: boolean;
  onToggle: (value: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Multi-select dropdown showing a "Filter by" button with a funnel icon.
 * @param props.options - Checkbox options to display
 * @param props.selected - Currently selected values
 * @param props.active - Whether any filter is applied (filled funnel)
 * @param props.onToggle - Called with the toggled option value
 * @returns Filter dropdown element
 * @example <FilterDropdown options={opts} selected={sel} active onToggle={toggle} />
 */
export function FilterDropdown({ options, selected, active, onToggle }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const toggleOpen = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    if (!open) return;

    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles["filter-dropdown"]} ref={ref}>
      <button
        type="button"
        className={
          active
            ? `${styles["filter-dropdown-btn"]} ${styles["filter-dropdown-btn--active"]}`
            : styles["filter-dropdown-btn"]
        }
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          selected.length
            ? `Filter by type, ${selected.length} selected`
            : "Filter by type"
        }
        title="Filter by type"
      >
        <i
          className={active ? "bi bi-funnel-fill" : "bi bi-funnel"}
          aria-hidden
        />
        Filter by
        {selected.length > 0 && (
          <span className={styles["filter-dropdown-count"]}>
            {selected.length}
          </span>
        )}
      </button>
      {open && (
        <div
          className={styles["filter-dropdown-panel"]}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Document types"
        >
          {options.map((o) => (
            <label key={o.value} className={styles["filter-dropdown-option"]}>
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => onToggle(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
