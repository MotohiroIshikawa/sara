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

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    if (composing) return; // IME変換中はスキップ
    onChange(e.target.value);
  };

  const handleCompositionStart = (): void => {
    setComposing(true);
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>): void => {
    setComposing(false);
    onChange(e.currentTarget.value); // IME確定後に値を送る
  };

  return (
    <div className={styles.searchWrap}>
      <input
        value={value}
        onChange={handleChange}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder={placeholder ?? "チャットルール名で検索"}
        className={styles.searchInput}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <span className={styles.searchIcon}>🔎</span>
    </div>
  );
}
