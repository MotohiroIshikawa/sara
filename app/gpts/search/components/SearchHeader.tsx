import React, { type JSX } from "react";

export default function SearchHeader(): JSX.Element {
  return (
    <header className="flex items-end justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">チャットルール検索</h1>
        <p className="text-sm text-gray-500 mt-1">
          検索 → 詳細 → 「コピーする」で自分のリストに保存（※コピーは非公開）
        </p>
      </div>
    </header>
  );
}
