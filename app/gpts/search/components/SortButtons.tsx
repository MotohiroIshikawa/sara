import React, { type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";

export type SortKey = "latest" | "popular";

export interface SortButtonsProps {
  value: SortKey;
  onChange: (next: SortKey) => void;
}

export default function SortButtons(props: SortButtonsProps): JSX.Element {
  const { value, onChange } = props;

  const options: Array<{ val: SortKey; label: string }> = [
    { val: "latest", label: "新着順" },
    { val: "popular", label: "人気順" },
  ];

return (
    <div className={styles.freqGroup} role="radiogroup" aria-label="ソート順">
      {options.map((opt) => {
        const active: boolean = value === opt.val;
        return (
          <button
            key={opt.val}
            type="button"
            role="radio"
            aria-checked={active}
            className={`${styles.pill} ${active ? styles.pillOn : styles.pillOff}`}
            onClick={() => {
              if (!active) onChange(opt.val);
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
