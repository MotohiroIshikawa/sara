// app/gpts/search/Client.tsx
"use client";

import { useEffect, useState, useCallback, type JSX } from "react";
import { useRouter } from "next/navigation";
import { ensureLiffSession } from "@/utils/ensureLiffSession";
import SearchHeader from "./components/SearchHeader";
import SortButtons, { type SortKey } from "./components/SortButtons";
import SearchCard from "./components/SearchCard";
import SearchBox from "@/components/SearchBox";
import styles from "@/app/gpts/Client.module.css";

// 検索レスポンス1件
type PublicSearchItem = {
  id: string;
  name: string;
  updatedAt: string; // ISO8601
  isPublic: boolean;
  usageCount: number;
  authorName: string;
  isPopular: boolean;
  isNew: boolean;
};

// レスポンス
type PublicSearchResponse = {
  items: PublicSearchItem[];
};

// fetch 失敗時のエラー用
type ApiErrorResponse = {
  error?: string;
};

// 画面
export default function Client(): JSX.Element {
  const router = useRouter();

  // UI state
  const [keyword, setKeyword] = useState<string>("");
  const [sort, setSort] = useState<SortKey>("latest");
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  // API結果（原本）とフィルタ後
  const [itemsAll, setItemsAll] = useState<PublicSearchItem[]>([]);
  const [items, setItems] = useState<PublicSearchItem[]>([]);

  const liffId: string | undefined = process.env.NEXT_PUBLIC_LIFF_ID_SEARCH as string | undefined;

  // 初回・ソート変更時にだけAPI呼び出し（キーワードでは呼ばない）
  useEffect(() => {
    void (async () => {
      setLoading(true);
      setErr(null);

      try {
        const sess = await ensureLiffSession({ liffId });
        if (!sess.ok) {
          if (sess.reason === "login_redirected") return;
          setErr("ログインに失敗しました");
          setLoading(false);
          return;
        }

        const sp: URLSearchParams = new URLSearchParams();
        sp.set("sort", sort);
        sp.set("limit", "50");
        sp.set("offset", "0");

        const url: string = `/api/gpts/search?${sp.toString()}`;
        const r: Response = await fetch(url, { credentials: "include" });
        const j: unknown = await r.json();

        if (!r.ok) {
          const msg: string =
            (typeof (j as ApiErrorResponse)?.error === "string" && (j as ApiErrorResponse).error) ||
            "検索に失敗しました";
          setErr(msg);
          setItemsAll([]);
          setItems([]);
          setLoading(false);
          return;
        }

        const ok: boolean =
          typeof j === "object" &&
          j !== null &&
          Array.isArray((j as PublicSearchResponse).items);

        if (!ok) {
          setErr("予期しない応答形式です");
          setItemsAll([]);
          setItems([]);
          setLoading(false);
          return;
        }

        const body: PublicSearchResponse = j as PublicSearchResponse;
        setItemsAll(body.items);
        setItems(body.items); // 初期は全件表示
      } catch {
        setErr("検索に失敗しました");
        setItemsAll([]);
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [liffId, sort]);

  // 内部フィルタ処理（API呼び出しなし）
  useEffect(() => {
    const k: string = keyword.trim().toLowerCase();
    if (k.length === 0) {
      setItems(itemsAll);
      return;
    }

    const filtered: PublicSearchItem[] = itemsAll.filter((it: PublicSearchItem) => {
      const pool: string[] = [
        it.name ?? "",
        it.id ?? "",
        it.authorName ?? "",
      ];
      return pool.some((v: string) => v.toLowerCase().includes(k));
    });
    setItems(filtered);
  }, [keyword, itemsAll]);

  // カードの「開く」→ 詳細へ
  const onOpen = useCallback((id: string): void => {
    const href: string = `/gpts/search/${encodeURIComponent(id)}`;
    router.push(href);
  }, [router]);

  // ローディング
  if (loading) {
    return (
      <main className={styles.container}>
        <SearchHeader />
        <SearchBox value={keyword} onChange={setKeyword} placeholder="チャットルール名で検索" />
        <div className={styles.sortRow}>
          <SortButtons value={sort} onChange={setSort} />
        </div>
        <ul className={styles.listGrid}>
          {Array.from({ length: 5 }).map((_, i: number) => (
            <li key={i} className={styles.skeleton}>
              <div className="h-4 w-1/3 bg-gray-200 rounded mb-2" />
              <div className="h-3 w-1/2 bg-gray-200 rounded" />
            </li>
          ))}
        </ul>
      </main>
    );
  }

  // エラー
  if (err) {
    return (
      <main className={styles.container}>
        <SearchHeader />
        <div className={styles.alertError}>{err}</div>
      </main>
    );
  }

  // 本体
  return (
    <main className={styles.container}>
      <SearchHeader />
      <SearchBox value={keyword} onChange={setKeyword} placeholder="チャットルール名で検索" />
      <div className={styles.sortRow}>
        <SortButtons value={sort} onChange={setSort} />
      </div>

      {items.length === 0 ? (
        <div className={styles.empty}>見つかりませんでした。キーワードやソートを変更してお試しください。</div>
      ) : (
        <ul className={styles.listGrid}>
          {items.map((it: PublicSearchItem) => (
            <SearchCard
              key={it.id}
              id={it.id}
              name={it.name}
              updatedAt={it.updatedAt}
              usageCount={it.usageCount}
              authorName={it.authorName}
              isPopular={it.isPopular}
              isNew={it.isNew}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </main>
  );
}