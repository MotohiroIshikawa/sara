"use client";

import { useEffect, useMemo, useState, useRef, useCallback, type JSX } from "react";
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

function clientEnvInt(name: string, def: number, opts: { min?: number; max?: number } = {}): number {
  const raw: string | undefined = process.env[name] as string | undefined;
  const n: number = raw == null ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  const min: number = opts.min ?? Number.NEGATIVE_INFINITY;
  const max: number = opts.max ?? Number.POSITIVE_INFINITY;
  return Math.floor(Math.min(max, Math.max(min, n)));
}
const CLIENT_PAGE_LIMIT: number = clientEnvInt("NEXT_PUBLIC_LIST_PAGE_LIMIT", 20, { min: 1, max: 200 });

type GptsListResponseWithMore = GptsListResponse & { hasMore: boolean };
function isGptsListResponseWithMore(x: unknown): x is GptsListResponseWithMore {
  if (!isGptsListResponse(x)) return false;
  const m = x as { hasMore?: unknown };
  return typeof m.hasMore === "boolean";
}

export default function Client(): JSX.Element {
  const router = useRouter();
  const [items, setItems] = useState<GptsListItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [keyword, setKeyword] = useState<string>(""); // 検索キーワード
  const [appliedId, setAppliedId] = useState<string | null>(null); // 適用中ハイライト

  // ページング状態
  const [offset, setOffset] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const limit: number = CLIENT_PAGE_LIMIT; // ★ クライアント環境変数

  // 無限スクロール監視
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const liffId: string | undefined = process.env.NEXT_PUBLIC_LIFF_ID_LIST as string | undefined;

  // 1ページ取得（append: 追加 or 置換）
  const fetchPage = useCallback(
    async (opts: { offset: number; append: boolean }): Promise<void> => {
      try {
        if (!opts.append) setLoading(true);
        setErr(null);

        const sess = await ensureLiffSession({ liffId });
        if (!sess.ok) {
          if (sess.reason === "login_redirected") return;
          setErr("ログインに失敗しました");
          setLoading(false);
          return;
        }

        const sp: URLSearchParams = new URLSearchParams();
        sp.set("limit", String(limit));
        sp.set("offset", String(opts.offset));

        const r: Response = await fetch(`/api/gpts/list?${sp.toString()}`, { credentials: "include" });
        const j: unknown = await r.json();

        if (!r.ok) {
          setErr("読み込みに失敗しました");
          if (!opts.append) {
            setItems([]);
            setAppliedId(null);
            setHasMore(false);
            setOffset(0);
          }
          setLoading(false);
          return;
        }

        if (!isGptsListResponseWithMore(j)) {
          setErr("予期しない応答形式です");
          if (!opts.append) {
            setItems([]);
            setAppliedId(null);
            setHasMore(false);
            setOffset(0);
          }
          setLoading(false);
          return;
        }

        const data: GptsListResponseWithMore = j;

        if (opts.append) {
          setItems((prev: GptsListItem[]) => [...prev, ...data.items]);
        } else {
          setItems(data.items);
        }
        setAppliedId(data.appliedId ?? null);
        setHasMore(data.hasMore);
        setOffset(opts.offset + data.items.length);
      } catch {
        setErr("読み込みに失敗しました");
        if (!opts.append) {
          setItems([]);
          setAppliedId(null);
          setHasMore(false);
          setOffset(0);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [liffId, limit]
  );

  // 初回読み込み
  useEffect(() => {
    void (async () => {
      try {
        // キーワード復元は先に
        const savedKw: string | null = sessionStorage.getItem(STORE_KEYWORD);
        if (typeof savedKw === "string") setKeyword(savedKw);

        // 最初のページ
        setItems([]);
        setOffset(0);
        setHasMore(false);
        setAppliedId(null);
        setLoading(true);
        await fetchPage({ offset: 0, append: false });
      } finally {
        // 何もしない（loading は fetchPage 内で制御）
      }
    })();
  }, [fetchPage]);

  // スクロール位置復元（loading解除後 & items反映後）
  useEffect(() => {
    if (loading) return;
    const yStr: string | null = sessionStorage.getItem(STORE_SCROLLY);
    const y: number = yStr ? Number(yStr) : 0;
    if (!Number.isNaN(y) && y > 0) {
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

  // 無限スクロール：最下部 sentinel に入ったら次ページ読み込み
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
      rootMargin: "200px",
      threshold: 0.01,
    });
    observerRef.current = obs;
    obs.observe(sentinelRef.current);

    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
  }, [hasMore, loadingMore, offset, fetchPage]);

  // ローディング
  if (loading && items.length === 0) {
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

  // 未登録（初回）
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

      {/* 無限スクロール監視点 */}
      <div ref={sentinelRef} className="h-8" />

      {/* 追加読み込み中の簡易表示 */}
      {loadingMore && (
        <div className="mt-4 text-center text-sm text-gray-500">読み込み中…</div>
      )}
    </main>
  );
}
