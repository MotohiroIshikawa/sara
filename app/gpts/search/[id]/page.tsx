import type { JSX } from "react";
import type { Metadata } from "next";
import Client from "./Client";

// タイトル
export const metadata: Metadata = {
  title: "Sara | チャットルール詳細",
};

export default function Page(): JSX.Element {
  return <Client />;
}
