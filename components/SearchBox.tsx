// /components/SearchBox.tsx
"use client";

import React, { useRef, useState, type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";

export interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

/**
 * IME安全版 SearchBox
 * - LIFF(WebView) で composition 系イベントが不安定なケースに対応
 * - 判定の優先順:
 *   1) local state(ref) での composing フラグ
 *   2) e.nativeEvent.isComposing (ブラウザが載せてくれる場合)
 *   3) inputType が "insertCompositionText" / "insertFromComposition"
 */
export default function SearchBox(props: SearchBoxProps): JSX.Element {
  const { value, onChange, placeholder } = props;

  const [composing, setComposing] = useState<boolean>(false);
  const composingRef = useRef<boolean>(false); // onInput からも参照できるように ref を併用

  // IME中かどうかの総合判定
  function isDuringIME<E extends { nativeEvent: unknown }>(e: E): boolean {
    // 2) isComposing があれば最優先
    const ne: unknown = e.nativeEvent;
    const hasIsComposing: boolean =
      typeof (ne as { isComposing?: unknown })?.isComposing !== "undefined";
    if (hasIsComposing) {
      const ic: boolean = Boolean((ne as { isComposing?: boolean }).isComposing);
      if (ic) return true;
    }

    // 3) inputType が composition 系かどうか
    const inputType: string | undefined = (ne as { inputType?: unknown })?.inputType as
      | string
      | undefined;
    if (typeof inputType === "string") {
      if (
        inputType === "insertCompositionText" ||
        inputType === "insertFromComposition"
      ) {
        return true;
      }
    }

    // 1) 自前のフラグ（compositionstart/end が来ない環境対策で最後に参照）
    if (composingRef.current || composing) return true;

    return false;
  }

  // onChange: 通常はここで反映。IME中はスキップ
  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    if (isDuringIME(e)) return;
    onChange(e.target.value);
  }

  // onInput: 一部 WebView では onChange タイミングが合わないため保険で同じロジックを適用
  function handleInput(e: React.FormEvent<HTMLInputElement>): void {
    if (isDuringIME(e)) return;
    const target: EventTarget & HTMLInputElement = e.currentTarget;
    // onChange と重複更新になる可能性があるが、値が同じ場合は state 側で弾かれる
    onChange(target.value);
  }

  function handleCompositionStart(): void {
    setComposing(true);
    composingRef.current = true; // ref も ON
  }

  function handleCompositionEnd(e: React.CompositionEvent<HTMLInputElement>): void {
    setComposing(false);
    composingRef.current = false; // ref も OFF
    // 確定後の最終文字列を必ず反映（LIFFで onChange が来ない場合の担保）
    onChange(e.currentTarget.value);
  }

  return (
    <div className={styles.searchWrap}>
      <input
        value={value}
        onChange={handleChange}
        onInput={handleInput}                 // フォールバック
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
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
