"use client";

import { useEffect, useMemo, useState, useCallback, type JSX } from "react";
import { useRouter } from "next/navigation";
import { ensureLiffSession } from "@/utils/ensureLiffSession";
import SearchHeader from "./components/SearchHeader";
import SearchBox from "./components/SearchBox";
import SortButtons, { type SortKey } from "./components/SortButtons";
import SearchCard from "./components/SearchCard";
import styles from "@/app/gpts/Client.module.css";

// 検索レスポンス1件
type PublicSearchItem = {
  id: string;
  name: string;
  updatedAt: string;   // ISO8601
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
  const [items, setItems] = useState<PublicSearchItem[]>([]);
  const [qApplied, setQApplied] = useState<string>(""); // 実際にAPIへ投げたキーワード表示用

  const liffId: string | undefined = process.env.NEXT_PUBLIC_LIFF_ID_SEARCH as string | undefined;

  const [pendingQ, setPendingQ] = useState<string>("");
  useEffect(() => {
    setPendingQ(keyword);
    const h: number = window.setTimeout(() => {
      setQApplied((prev) => (prev !== pendingQ ? pendingQ : prev)); // 変更時のみ更新
    }, 300);
    return () => window.clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword]);

  // 初回 & 条件変更時のロード
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
        if (qApplied.trim().length > 0) sp.set("q", qApplied.trim());
        sp.set("sort", sort);
        sp.set("limit", "30");
        sp.set("offset", "0");

        const url: string = `/api/gpts/search?${sp.toString()}`;
        const r: Response = await fetch(url, { credentials: "include" });
        const j: unknown = await r.json();

        if (!r.ok) {
          const msg: string =
            (typeof (j as ApiErrorResponse)?.error === "string" && (j as ApiErrorResponse).error) ||
            "検索に失敗しました";
          setErr(msg);
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
          setItems([]);
          setLoading(false);
          return;
        }

        const body: PublicSearchResponse = j as PublicSearchResponse;
        setItems(body.items);
      } catch {
        setErr("検索に失敗しました");
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [liffId, qApplied, sort]);

  // カードの「開く」→ 詳細へ
  const onOpen = useCallback((id: string): void => {
    const href: string = `/gpts/search/${encodeURIComponent(id)}`;
    router.push(href);
  }, [router]);

  // 検索ボックスのプレースホルダ（ヒント表示）
  const placeholder: string = useMemo<string>(() => {
    return sort === "popular" ? "タイトルで検索（人気順）" : "タイトルで検索（新着順）";
  }, [sort]);

   // ローディング表示
  if (loading) {
    return (
      <main className={styles.container}>
        <SearchHeader />
        {/* 検索ボックス */}
        <div className={styles.searchWrap}>
          <SearchBox value={keyword} onChange={setKeyword} placeholder={placeholder} />
        </div>
        {/* ソートボタン */}
        <div className={styles.sortRow}>
          <SortButtons value={sort} onChange={setSort} />
        </div>
        {/* Skeleton 的な簡易プレースホルダ */}
        <ul className={styles.listGrid}>
          {Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className={styles.skeleton}>
              <div className="h-4 w-1/3 bg-gray-200 rounded mb-2" />
              <div className="h-3 w-1/2 bg-gray-200 rounded" />
            </li>
          ))}
        </ul>
      </main>
    );
  }

  // エラー表示
  if (err) {
    return (
      <main className={styles.container}>
        <SearchHeader />
        <div className={styles.alertError}>{err}</div>
      </main>
    );
  }

  return (
    <main className={styles.container}>
      <SearchHeader />
      {/* 検索ボックス */}
      <SearchBox
        value={keyword}
        onChange={(v) => setKeyword(v)}
        placeholder="チャットルール名で検索"
      />

      {/* ソートボタン */}
      <div className={styles.sortRow}>
        <SortButtons value={sort} onChange={setSort} />
      </div>

      {/* 結果カード */}
      {items.length === 0 ? (
        <div className={styles.empty}>
          見つかりませんでした。キーワードやソートを変更してお試しください。
        </div>
      ) : (
        <ul className={styles.listGrid}>
          {items.map((it) => (
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