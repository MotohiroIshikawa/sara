import React, { type JSX } from "react";
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

  return (
    <li className={[styles.card, styles.cardHover].join(" ")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-gray-900">{name || "(無題)"}</div>
          <div className="mt-1 text-xs text-gray-500">
            更新: {formatIsoToJa(updatedAt)} ／ コピー数: {usageCount}
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={() => onOpen(id)}
          className="px-3 py-1.5 rounded-md border border-emerald-600 text-emerald-700 hover:bg-emerald-50 text-sm"
          aria-label={`「${name || "(無題)"}」の詳細を開く`}
        >
          開く
        </button>
      </div>
    </li>
  );
}
