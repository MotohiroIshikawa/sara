import type { JSX } from "react";
import type { Metadata } from "next";
import Client from "./Client";

export const metadata: Metadata = {

  title: "Sara | 使い方",
  description:
    "このチャットBOTの始め方、チャットルールの作成・編集・選択、スケジュール自動配信、グループ適用方法、トラブルシュートを説明します。",
};

export default function Page(): JSX.Element {
  return <Client />;
}
