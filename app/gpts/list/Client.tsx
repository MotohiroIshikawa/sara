"use client";

import { useEffect, useMemo, useState, type JSX } from "react";
import { useRouter } from "next/navigation";
import {
  type GptsListItem,
  type GptsListResponse,
  isGptsListResponse,
} from "@/utils/types";
import { ensureLiffSession } from "@/utils/ensureLiffSession";
import styles from "@/app/gpts/Client.module.css";
import Header from "./components/Header";
import SkeletonCard from "./components/SkeletonCard";
import EmptyCard from "./components/EmptyCard";
import ListItem from "./components/ListItem";
import SearchBox from "@/components/SearchBox";

const STORE_KEYWORD: string = "gptsList.keyword";
const STORE_SCROLLY: string = "gptsList.scrollY";

export default function Client(): JSX.Element {
  const router = useRouter();
  const [items, setItems] = useState<GptsListItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [keyword, setKeyword] = useState<string>(""); // 検索キーワード
  const [appliedId, setAppliedId] = useState<string | null>(null); // 選択中ハイライト

  const liffId: string | undefined = process.env.NEXT_PUBLIC_LIFF_ID_LIST as string | undefined;

  useEffect(() => {
    void (async () => {
      try {
        const sess = await ensureLiffSession({ liffId });

        if (!sess.ok) {
          if (sess.reason === "login_redirected") return; // ここで終了（復帰後に再実行される）
          setErr("ログインに失敗しました");
          return;
        }
        const r = await fetch("/api/gpts/list", { credentials: "include" });
        const j: unknown = await r.json();
        if (!r.ok) {
          setErr("読み込みに失敗しました");
          return;
        }
        if (isGptsListResponse(j)) {
          const data: GptsListResponse = j;
          setItems(data.items);
          setAppliedId(data.appliedId ?? null);
        } else {
          setErr("予期しない応答形式です");
        }
      } catch {
        setErr("読み込みに失敗しました");
      } finally {
        setLoading(false);

        const savedKw: string | null = sessionStorage.getItem(STORE_KEYWORD);
        if (typeof savedKw === "string") {
          setKeyword(savedKw);
        }
      }
    })();
  }, [liffId]);

  // スクロール位置復元（loading解除後 & items反映後）
  useEffect(() => {
    if (loading) return;
    const yStr: string | null = sessionStorage.getItem(STORE_SCROLLY);
    const y: number = yStr ? Number(yStr) : 0;
    if (!Number.isNaN(y) && y > 0) {
      // DOM描画完了後に復元
      requestAnimationFrame(() => {
        window.scrollTo({ top: y, behavior: "auto" });
      });
    }
  }, [loading, items.length]);

  // 検索フィルタ（名前・ID）
  const filtered = useMemo<GptsListItem[]>(() => {
    if (!keyword.trim()) return items;
    const k: string = keyword.trim().toLowerCase();
    return items.filter((it) => {
      const pool: Array<string | undefined> = [it.name, it.id];
      return pool.some((v) => v?.toLowerCase?.().includes(k) ?? false);
    });
  }, [items, keyword]);

  // カードタップで詳細へ遷移
  function onOpen(id: string): void {
    sessionStorage.setItem(STORE_SCROLLY, String(window.scrollY));
    const href: string = `/gpts/${encodeURIComponent(id)}/detail`;
    router.push(href);
  }

  // ローディング
  if (loading) {
    return (
      <main className={styles.container}>
        <Header />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </main>
    );
  }

  // エラー
  if (err) {
    return (
      <main className={styles.container}>
        <Header />
        <div className={styles.alertError}>
          {err}
        </div>
      </main>
    );
  }

  // 未登録
  if (items.length === 0) {
    return (
      <main className={styles.container}>
        <Header />
        <EmptyCard />
      </main>
    );
  }

  return (
    <main className={styles.container}>
      <Header appliedId={appliedId} />
      {/* 検索ボックス */}
      <SearchBox
        value={keyword}
        onChange={(v) => {
          setKeyword(v);
          sessionStorage.setItem(STORE_KEYWORD, v);
        }}
        placeholder="チャットルール名で検索"
      />

      {/* リスト */}
      <ul className={styles.list}>
        {filtered.map((it) => {
          const applied: boolean = appliedId === it.id;
          return (
            <ListItem
              key={it.id}
              item={it}
              applied={applied}
              onOpen={onOpen}
            />
          );
        })}
      </ul>
    </main>
  );
}
