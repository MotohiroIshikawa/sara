import React, { type JSX } from "react";
import styles from "@/app/gpts/Client.module.css";

export interface FooterEditActionsProps {
  onBack: () => void;
  onConfirm: () => void;
  busy?: boolean; // 二重送信防止用
}

export default function FooterEditActions(props: FooterEditActionsProps): JSX.Element {
  const { onBack, onConfirm, busy = false } = props;

  return (
    <div className={styles.footer}>
      <button
        className={styles.footerBtnGreen}
        onClick={() => { if (!busy) onConfirm(); }}
        disabled={busy}
        aria-disabled={busy}
        title="編集内容を確認します"
      >
        確認
      </button>

      <button
        className={styles.footerBtnBack}  // 既存CSS（グレー）を利用
        onClick={() => { if (!busy) onBack(); }}
        disabled={busy}
        aria-disabled={busy}
        title="前の画面に戻ります"
      >
        戻る
      </button>
    </div>
  );
}
