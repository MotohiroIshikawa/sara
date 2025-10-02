import React from "react";
import styles from "../Client.module.css";

export interface FooterActionsProps {
  onBack: () => void;
  onConfirm: () => void;
}

export default function FooterActions(props: FooterActionsProps): JSX.Element {
  const { onBack, onConfirm } = props;

  return (
    <div className={styles.footer}>
      <button className={styles.footerBtnGray} onClick={onBack}>
        戻る
      </button>
      <button className={styles.footerBtnGreen} onClick={onConfirm}>
        確認
      </button>
    </div>
  );
}
