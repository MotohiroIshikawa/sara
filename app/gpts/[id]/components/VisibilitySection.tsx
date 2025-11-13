"use client";

import React, { type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";

interface VisibilitySectionProps {
  isPublic: boolean;
  onChange: (next: boolean) => void;
}

export default function VisibilitySection(props: VisibilitySectionProps): JSX.Element {
  const { isPublic, onChange } = props;

  return (
    <section className={styles.card}>
      <h2 className={styles.title}>公開設定</h2>

      {/* 公開｜非公開 */}
      <div className="mt-3">
        <div className={styles.freqGroup} role="radiogroup" aria-label="公開設定">
          {([
            { val: true as boolean, label: "公開" },
            { val: false as boolean, label: "非公開" },
          ] as ReadonlyArray<{ val: boolean; label: string }>).map((opt) => {
            const active: boolean = isPublic === opt.val;
            return (
              <button
                key={String(opt.val)}
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
      </div>
    </section>
  );
}
