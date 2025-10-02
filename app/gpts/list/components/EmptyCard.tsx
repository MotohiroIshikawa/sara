import React from "react";
import styles from "../Client.module.css";

export default function EmptyCard(): JSX.Element {
  return (
    <div className={styles.emptyCard}>
      <div className={styles.emptyTitle}>チャットルールは未登録</div>
      <p className={styles.emptyHelp}>
        LINEで会話して「保存しますか？」で保存するとチャットルールが表示されます。
      </p>
    </div>
  );
}
