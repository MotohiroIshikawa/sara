"use client";

import React, { useEffect, useState, type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";

interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export default function SearchBox(props: SearchBoxProps): JSX.Element {
  const { value, onChange, placeholder } = props;
  const [local, setLocal] = useState<string>(value);

  // 親valueが外部から更新されたときは同期
  useEffect(() => {
    setLocal(value);
  }, [value]);

  // 入力→0.3秒停止で親へ反映（debounce）
  useEffect(() => {
    const h = window.setTimeout(() => {
      if (local !== value) onChange(local);
    }, 300);
    return () => window.clearTimeout(h);
  }, [local, value, onChange]); // 依存を明示して警告を解消

  return (
    <div className={styles.searchWrap}>
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder ?? "チャットルール名で検索"}
        className={styles.searchInput}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        inputMode="search"
      />
      <span className={styles.searchIcon}>🔎</span>
    </div>
  );
}