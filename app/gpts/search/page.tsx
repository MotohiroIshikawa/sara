// app/gpts/search/page.tsx
import type { JSX } from "react";
import type { Metadata } from "next";
import Client from "./Client";

// 画面タイトル（任意）
export const metadata: Metadata = {
  title: "Sara | チャットルール検索",
};

export default function Page(): JSX.Element {
  return <Client />;
}
