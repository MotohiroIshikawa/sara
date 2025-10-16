import React, { type JSX } from "react";

export default function SearchHeader(): JSX.Element {
  return (
    <header className="flex items-end justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">チャットルール検索</h1>
        <p className="text-sm text-gray-500 mt-1">
          他のユーザが作成したルールを自分のリストにコピーできます
        </p>
      </div>
    </header>
  );
}
