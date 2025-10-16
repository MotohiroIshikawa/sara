import React, { type JSX, type KeyboardEvent } from "react";
import { formatIsoToJa } from "@/utils/formatIsoToJa";
import styles from "@/app/gpts/Client.module.css";

export interface SearchCardProps {
  id: string;
  name: string;
  updatedAt: string;
  usageCount: number;
  onOpen: (id: string) => void;
}

/** 検索結果1件カード */
export default function SearchCard(props: SearchCardProps): JSX.Element {
  const { id, name, updatedAt, usageCount, onOpen } = props;

  // Enter/Spaceで開けるアクセシビリティ対応
  const handleKeyOpen = (e: KeyboardEvent<HTMLLIElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(id);
    }
  };

  return (
    <li 
      className={[styles.item, styles.itemHover].join(" ").trim()}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(id)}
      onKeyDown={handleKeyOpen}
      aria-label={`${name} の詳細を開く`}
    >
      {/* タイトル行 */}
      <div className={styles.itemHeader}>
        <div className="min-w-0">
          <div className={styles.itemTitle} title={name}>
            {name || "(無題)"}
          </div>
        </div>
        <div className={styles.itemUpdated}>
          更新: {formatIsoToJa(updatedAt)} ／ コピー数: {usageCount}
        </div>
        {/* 検索結果用の簡易バッジエリア（必要なら） */}
        <div className={styles.itemBadges}>
          <span className={styles.itemBadgePublic}>公開</span>
        </div>
      </div>
    </li>
  );
}
