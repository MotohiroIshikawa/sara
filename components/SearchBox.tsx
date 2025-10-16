"use client";

import React, { useEffect, useState, type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";

export interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

export default function SearchBox(props: SearchBoxProps): JSX.Element {
  const { value, onChange, placeholder } = props;
  const [local, setLocal] = useState<string>(value);

  // 入力→遅延で親に反映（IME制御をやめてタイマーで吸収）
  useEffect(() => {
    const h = window.setTimeout(() => {
      if (local !== value) onChange(local);
    }, 300); // ★ 300ms 停止したら反映
    return () => window.clearTimeout(h);
  }, [local]);

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
