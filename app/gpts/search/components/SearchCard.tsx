import React, { type JSX, type KeyboardEvent } from "react";
import { formatIsoToJa } from "@/utils/ui/formatIsoToJa";
import styles from "@/app/gpts/Client.module.css";

interface SearchCardProps {
  id: string;
  name: string;
  updatedAt: string;
  usageCount: number;
  authorName: string;
  isPopular: boolean;
  isNew: boolean;
  onOpen: (id: string) => void;
}

/** 検索結果1件カード */
export default function SearchCard(props: SearchCardProps): JSX.Element {
  const { id, name, updatedAt, usageCount, authorName, isPopular, isNew, onOpen } = props;

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
      <div className={styles.itemHeader}>
        <div className="min-w-0 w-full">
          {/* タイトル */}
          <div className={styles.itemTitle} title={name}>
            {name || "(無題)"}
          </div>

          {/* 引用数 + 人気バッジ */}
          <div className="mt-1 flex justify-between text-xs text-gray-600">
            <span>引用数: {usageCount}</span>
            {isPopular && <span className={styles.itemBadgePopular}>人気</span>}
          </div>

          {/* 更新日 + NEWバッジ */}
          <div className="mt-0.5 flex justify-between text-xs text-gray-600">
            <span>更新: {formatIsoToJa(updatedAt)}</span>
            {isNew && <span className={styles.itemBadgeNew}>NEW</span>}
          </div>

          {/* 作成者 */}
          <div className="mt-0.5 text-xs text-gray-600">
            作成者: {authorName}
          </div>
        </div>
      </div>
    </li>
  );
}
