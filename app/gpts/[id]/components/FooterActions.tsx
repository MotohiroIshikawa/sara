import React, { type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";

export interface FooterActionsProps {
  onBack: () => void;
  onEdit: () => void;
  onSelect?: () => void;
  onDelete: () => void;
  isApplied: boolean;
  busy?: boolean;
}

export default function FooterActions(props: FooterActionsProps): JSX.Element {
  const { onBack, onEdit, onSelect, onDelete, isApplied, busy = false } = props; // ★

  return (
    <div className={styles.footer}>
      {/* 編集 */} 
      <button
        className={styles.footerBtnGreen}
        onClick={() => { if (!busy) onEdit(); }}
        disabled={busy}
        aria-disabled={busy}
        title="このチャットルールを編集します"
      >
        編集
      </button>

      {/* 選択 or 選択中 */}
      {isApplied ? (
        <button
          className={styles.footerBtnYellowDisabled}
          disabled
          aria-disabled
          title="現在、選択中のチャットルールです"
        >
          選択中
        </button>
      ) : (
        <button
          className={styles.footerBtnGreen}
          onClick={() => { if (!busy && onSelect) onSelect(); }}
          disabled={busy || !onSelect}
          aria-disabled={busy || !onSelect}
          title="このチャットルールを選択中にします"
        >
          選択
        </button>
      )}

      {/* 削除 */}
      <button
        className={styles.footerBtnDanger}
        onClick={() => { if (!busy) onDelete(); }}
        disabled={busy}
        aria-disabled={busy}
        title="このチャットルールを削除します"
      >
        削除
      </button>

      {/* 戻る */} 
      <button
        className={styles.footerBtnBack}
        onClick={onBack}
        disabled={busy}
        aria-disabled={busy}
        title="一覧に戻ります"
      >
        戻る
      </button>
    </div>
  );
}
