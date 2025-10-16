"use client";

import React, { useState, type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";

export interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export default function SearchBox(props: SearchBoxProps): JSX.Element {
  const { value, onChange, placeholder } = props;
  const [composing, setComposing] = useState<boolean>(false);

  return (
    <div className={styles.searchWrap}>
      <input
        value={value}
        onChange={(e) => {
          if (composing) return; // IME中は反応しない
          onChange(e.target.value);
        }}
        onCompositionStart={() => setComposing(true)}  // IME開始
        onCompositionEnd={(e) => {                     // IME確定
          setComposing(false);
          onChange(e.currentTarget.value);
        }}
        placeholder={placeholder ?? "チャットルール名で検索"}
        className={styles.searchInput}
      />
      <span className={styles.searchIcon}>🔎</span>
    </div>
  );
}
