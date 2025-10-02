import React from "react";
import styles from "../Client.module.css";
import { type GptsListItem } from "@/utils/types";

export interface ListItemProps {
  item: GptsListItem;
  applied: boolean;
  busy: boolean;
  onEdit: (id: string) => void;   // ★ 親で router.push などを実行
  onApply: (id: string) => void;  // ★ 親で fetch /use を実行
  onDelete: (id: string) => void; // ★ 親で fetch DELETE を実行
}

export default function ListItem(props: ListItemProps): JSX.Element {
  const { item, applied, busy, onEdit, onApply, onDelete } = props;

  return (
    <li className={[styles.item, applied ? styles.itemApplied : ""].join(" ").trim()}>
      {/* タイトル行 */}
      <div className={styles.itemHeader}>
        <div className="min-w-0">
          <div className={styles.itemTitle} title={item.name}>
            {item.name}
          </div>
          <div className={styles.itemUpdated}>更新: {new Date(item.updatedAt).toLocaleString()}</div>
        </div>
        {/* 選択中バッジ */}
        {applied && <span className={styles.itemBadgeApplied}>選択中</span>}
      </div>

      {/* ボタン列 */}
      <div className="mt-3 flex items-center gap-2">
        {applied ? (
          <>
            {/* 編集（選択中のみ表示） */}
            <button
              className={[styles.btn, busy ? styles.btnBlueBusy : styles.btnBlue].join(" ")}
              disabled={busy}
              onClick={() => { if (!busy) onEdit(item.id); }}
              title="ルールを編集します（選択中）"
            >
              編集
            </button>

            {/* 削除（共通） */}
            <button
              className={[styles.btn, busy ? styles.btnGrayBusy : styles.btnGray].join(" ")}
              disabled={busy}
              onClick={() => onDelete(item.id)}
            >
              削除
            </button>
          </>
        ) : (
          <>
            {/* 選択（未選択のみ表示） */}
            <button
              className={[styles.btn, busy ? styles.btnPrimaryBusy : styles.btnPrimary].join(" ")}
              disabled={busy}
              aria-disabled={busy}
              onClick={() => { if (!busy) onApply(item.id); }}
              title="このチャットで使うルールとして選択します"
            >
              {busy ? "選択中…" : "選択"}
            </button>

            {/* 削除（共通） */}
            <button
              className={[styles.btn, busy ? styles.btnGrayBusy : styles.btnGray].join(" ")}
              disabled={busy}
              onClick={() => onDelete(item.id)}
            >
              削除
            </button>
          </>
        )}
      </div>
    </li>
  );
}
