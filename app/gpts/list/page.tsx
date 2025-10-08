import type { Metadata } from "next";
import Client from "./Client";

export const metadata: Metadata = {
  title: "Sara | 編集・選択",
  description: 
    "作成したチャットルールの編集や選択ができます。",
};

export default function Page() {
  // 静的ルートなので params は不要
  return <Client />;
}
