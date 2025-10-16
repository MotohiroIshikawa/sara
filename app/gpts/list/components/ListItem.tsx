import React, { type JSX, type KeyboardEvent } from "react";
import styles from "@/app/gpts/Client.module.css";
import { type GptsListItem } from "@/utils/types";

export interface ListItemProps {
  item: GptsListItem;
  applied: boolean;
  onOpen: (id: string) => void; // カードタップで詳細を開く
}

export default function ListItem(props: ListItemProps): JSX.Element {
  const { item, applied, onOpen } = props;

  // Enter/Spaceで開けるアクセシビリティ対応
  const handleKeyOpen = (e: KeyboardEvent<HTMLLIElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(item.id);
    }
  };

  return (
    <li
      className={[styles.item, applied ? styles.itemApplied : ""].join(" ").trim()}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item.id)}
      onKeyDown={handleKeyOpen}
      aria-label={`${item.name} の詳細を開く`}
    >
      {/* タイトル行 */}
      <div className={styles.itemHeader}>
        <div className="min-w-0">
          <div className={styles.itemTitle} title={item.name}>
            {item.name}
          </div>
          <div className={styles.itemUpdated}>
            更新: {new Date(item.updatedAt).toLocaleString()}
          </div>
        </div>
        {/* バッジ */}
        <div className={styles.itemBadges}>
          {applied && <span className={styles.itemBadgeApplied}>選択中</span>}
          {!item.isPublic && <span className={styles.itemBadgePrivate}>非公開</span>}
        </div>
      </div>
    </li>
  );
}
