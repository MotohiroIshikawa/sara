"use client";

import { useCallback, useId, type KeyboardEvent } from "react";
import styles from "./SegmentedSwitch.module.css";

export type SegmentedSwitchOption = {
  /** 内部値（true/false の2択に限定） */
  value: boolean;
  /** 表示ラベル（例: "登録ずみ", "未登録" / "実施中", "停止中"） */
  label: string;
  /** アクセシビリティ用補足（任意） */
  ariaLabel?: string;
};

export type SegmentedSwitchProps = {
  /** 現在の値（左/右のどちらがONか） */
  value: boolean;
  /** 値変更時に呼ばれるハンドラ */
  onChange: (next: boolean) => void;
  /** ラジオグループ全体のラベル（例: "スケジュール"） */
  groupLabel?: string;
  /** オプション配列（左/右の2要素） */
  options: [SegmentedSwitchOption, SegmentedSwitchOption];
  /** 非活性（任意） */
  disabled?: boolean;
  /** 追加クラス（任意） */
  className?: string;
};

/**
 * セグメントスイッチ（2択・単一選択）
 * - 角丸のコンテナ内に2つのボタンを並べ、選択中を黄緑、未選択をグレーで表示
 * - role="radiogroup" / role="radio" によるアクセシビリティ対応
 * - ←/→ で左右切替、Space/Enter で選択反転
 *
 * 使用例：
 * <SegmentedSwitch
 *   value={hasSchedule}
 *   onChange={(v) => setHasSchedule(v)}
 *   groupLabel="スケジュール"
 *   options={[
 *     { value: true,  label: "登録ずみ" },
 *     { value: false, label: "未登録" },
 *   ]}
 * />
 */
export default function SegmentedSwitch(props: SegmentedSwitchProps) {
  const {
    value,
    onChange,
    groupLabel,
    options,
    disabled = false,
    className = "",
  } = props;

  const groupId: string = useId();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;

      // ← / → で選択を切り替え
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const next: boolean = e.key === "ArrowLeft" ? options[0].value : options[1].value;
        if (next !== value) onChange(next);
      }

      // Space / Enter で反転
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onChange(!value);
      }
    },
    [disabled, onChange, options, value]
  );

  const ariaLabel: string = groupLabel ?? "切替";

  return (
    <div className={className}>
      {/* コンテナ */}
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className={[styles.segGroup, disabled ? styles.segGroupDisabled : ""].join(" ")}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
        aria-disabled={disabled}
      >
        {/* スクリーンリーダ関連付け用の不可視ラベル */}
        {groupLabel ? <span id={groupId} className="sr-only">{groupLabel}</span> : null}

        {options.map((opt) => {
          const active: boolean = value === opt.value;
          return (
            <button
              key={`${String(opt.value)}`}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={opt.ariaLabel ?? opt.label}
              disabled={disabled}
              onClick={() => {
                if (!disabled && !active) onChange(opt.value);
              }}
              className={[
                styles.segBtn,
                active ? styles.segBtnActive : styles.segBtnInactive,
                disabled ? styles.segBtnDisabled : "",
              ].join(" ")}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
