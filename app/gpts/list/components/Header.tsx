import React, { type JSX } from "react";
import styles from "../Client.module.css";

export interface HeaderProps {
  appliedId?: string | null;
}

export default function Header(props: HeaderProps): JSX.Element {
  const { appliedId } = props;

  return (
    <header className={styles.header}>
      <div>
        <h1 className={styles.headerTitle}>チャットルール一覧</h1>
        <p className={styles.headerSub}>保存済みのルールを編集・選択できます</p>
      </div>
      {appliedId ? (
        <span className={styles.headerBadge}>
          選択中: {appliedId}
        </span>
      ) : null}
    </header>
  );
}
