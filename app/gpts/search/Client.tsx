"use client";

import { useEffect, useState, useCallback, useRef, type JSX } from "react";
import { useRouter } from "next/navigation";
import { ensureLiffSession } from "@/utils/line/ensureLiffSession";
import SearchHeader from "./components/SearchHeader";
import SortButtons, { type SortKey } from "./components/SortButtons";
import SearchCard from "./components/SearchCard";
import SearchBox from "@/components/SearchBox";
import styles from "@/app/gpts/Client.module.css";

// クライアントで使用するページサイズ（環境変数化）
function clientEnvInt(name: string, def: number, opts: { min?: number; max?: number } = {}): number {
  const raw: string | undefined = process.env[name] as string | undefined;
  const n: number = raw == null ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  const min: number = opts.min ?? Number.NEGATIVE_INFINITY;
  const max: number = opts.max ?? Number.POSITIVE_INFINITY;
  return Math.floor(Math.min(max, Math.max(min, n)));
}
const CLIENT_PAGE_LIMIT: number = clientEnvInt("NEXT_PUBLIC_SEARCH_PAGE_LIMIT", 20, { min: 1, max: 200 });

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
  hasMore: boolean;
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

  // ページング用
  const [offset, setOffset] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const limit: number = CLIENT_PAGE_LIMIT; // ★ 環境変数から取得した件数を使用

  // 無限スクロール監視用
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const liffId: string | undefined = process.env.NEXT_PUBLIC_LIFF_ID_SEARCH as string | undefined;

  // 1ページ取得（append か replace を選べる）
  const fetchPage = useCallback(
    async (opts: { offset: number; append: boolean }): Promise<void> => {
      try {
        if (!loading) setLoading(true);
        setErr(null);

        const sess = await ensureLiffSession({ liffId });
        if (!sess.ok) {
          if (sess.reason === "login_redirected") return;
          setErr("ログインに失敗しました");
          setLoading(false);
          return;
        }

        const sp: URLSearchParams = new URLSearchParams();
        sp.set("sort", sort);
        sp.set("limit", String(limit)); // ★ env 由来の件数
        sp.set("offset", String(opts.offset));

        const url: string = `/api/gpts/search?${sp.toString()}`;
        const r: Response = await fetch(url, { credentials: "include" });
        const j: unknown = await r.json();

        if (!r.ok) {
          const msg: string =
            (typeof (j as ApiErrorResponse)?.error === "string" && (j as ApiErrorResponse).error) ||
            "検索に失敗しました";
          setErr(msg);
          if (!opts.append) {
            setItemsAll([]);
            setItems([]);
            setHasMore(false);
            setOffset(0);
          }
          setLoading(false);
          return;
        }

        const ok: boolean =
          typeof j === "object" &&
          j !== null &&
          Array.isArray((j as PublicSearchResponse).items) &&
          typeof (j as PublicSearchResponse).hasMore === "boolean";

        if (!ok) {
          setErr("予期しない応答形式です");
          if (!opts.append) {
            setItemsAll([]);
            setItems([]);
            setHasMore(false);
            setOffset(0);
          }
          setLoading(false);
          return;
        }

        const body: PublicSearchResponse = j as PublicSearchResponse;

        if (opts.append) {
          setItemsAll((prev: PublicSearchItem[]) => [...prev, ...body.items]);
        } else {
          setItemsAll(body.items);
        }
        setHasMore(body.hasMore);
        setOffset(opts.offset + body.items.length);
      } catch {
        setErr("検索に失敗しました");
        if (!opts.append) {
          setItemsAll([]);
          setItems([]);
          setHasMore(false);
          setOffset(0);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [liffId, sort, limit, loading]
  );

  // 初回・ソート変更時に最初のページを取得
  useEffect(() => {
    setItemsAll([]);
    setItems([]);
    setOffset(0);
    setHasMore(false);
    setLoading(true);
    setLoadingMore(false);
    void fetchPage({ offset: 0, append: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sort, liffId]); // limit は固定想定（env）なので依存に含めない

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

  // 無限スクロール：最下部の sentinel が見えたら次ページ読み込み
  useEffect(() => {
    if (!sentinelRef.current) return;

    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    const onIntersect: IntersectionObserverCallback = (entries: IntersectionObserverEntry[]) => {
      const entry: IntersectionObserverEntry | undefined = entries[0];
      if (!entry) return;

      if (entry.isIntersecting) {
        if (hasMore && !loadingMore) {
          setLoadingMore(true);
          void fetchPage({ offset, append: true });
        }
      }
    };

    const obs: IntersectionObserver = new IntersectionObserver(onIntersect, {
      root: null,
      rootMargin: "200px", // 手前で先読み
      threshold: 0.01,
    });
    observerRef.current = obs;
    obs.observe(sentinelRef.current);

    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
  }, [hasMore, loadingMore, offset, fetchPage]);

  // ローディング（初回）
  if (loading && itemsAll.length === 0) {
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
        <>
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

          {/* 無限スクロールの監視点（最下部） */}
          <div ref={sentinelRef} className="h-8" />

          {/* 追加読み込み中の簡易表示 */}
          {loadingMore && (
            <div className="mt-4 text-center text-sm text-gray-500">読み込み中…</div>
          )}
        </>
      )}
    </main>
  );
}
