"use client";

import { useEffect, useMemo, useState, useCallback, type JSX } from "react";
import { useRouter } from "next/navigation";
import { ensureLiffSession } from "@/utils/ensureLiffSession";

// ソート種別（API仕様に合わせる）
type SortKey = "latest" | "popular";

// 検索レスポンス1件
type PublicSearchItem = {
  id: string;
  name: string;
  updatedAt: string;   // ISO8601
  isPublic: boolean;
  usageCount: number;
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

  // 一覧クリック → 詳細へ
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
      <main className="p-4 space-y-4">
        <header className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">チャットルール検索</h1>
            <p className="text-sm text-gray-500 mt-1">公開ルールを検索してコピーできます</p>
          </div>
        </header>

        {/* 検索ボックス */}
        <div className="relative">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-md border border-gray-300 pl-10 pr-3 py-2 text-[14px] outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">🔎</span>
        </div>

        {/* ソートボタン */}
        <div className="flex gap-2">
          <SortButton active={sort === "latest"} onClick={() => setSort("latest")}>新着順</SortButton>
          <SortButton active={sort === "popular"} onClick={() => setSort("popular")}>人気順</SortButton>
        </div>

        {/* Skeleton 的な簡易プレースホルダ */}
        <ul className="grid gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm animate-pulse">
              <div className="h-4 w-1/3 bg-gray-200 rounded mb-2" />
              <div className="h-3 w-1/2 bg-gray-200 rounded" />
            </li>
          ))}
        </ul>
      </main>
    );
  }

  // ★ エラー表示
  if (err) {
    return (
      <main className="p-4 space-y-4">
        <header className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">チャットルール検索</h1>
          </div>
        </header>
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      </main>
    );
  }

  return (
    <main className="p-4 space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">チャットルール検索</h1>{/* ★ タイトル */}
          <p className="text-sm text-gray-500 mt-1">
            検索 → 詳細 → 「コピーする」で自分のリストに保存（※コピーは非公開）
          </p>
        </div>
      </header>

      {/* 検索入力 */}
      <div className="relative">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-gray-300 pl-10 pr-3 py-2 text-[14px] outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">🔎</span>
      </div>

      {/* ソートボタン */}
      <div className="flex gap-2">
        <SortButton active={sort === "latest"} onClick={() => setSort("latest")}>新着順</SortButton>
        <SortButton active={sort === "popular"} onClick={() => setSort("popular")}>人気順</SortButton>
      </div>

      {/* 結果カード */}
      {items.length === 0 ? (
        <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-8 text-center text-sm text-gray-500">
          見つかりませんでした。キーワードやソートを変更してお試しください。
        </div>
      ) : (
        <ul className="grid gap-3">
          {items.map((it) => (
            <li key={it.id} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{it.name || "(無題)"}</div>
                  <div className="mt-1 text-xs text-gray-500">
                    更新: {formatIsoToJa(it.updatedAt)} ／ コピー数: {it.usageCount}
                  </div>
                </div>
                {/* 空スペーサ */}
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => onOpen(it.id)}
                  className="px-3 py-1.5 rounded-md border border-emerald-600 text-emerald-700 hover:bg-emerald-50 text-sm"
                  aria-label={`「${it.name || "(無題)"}」の詳細を開く`}
                >
                  開く
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// 押しボタン
function SortButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  const { active, onClick, children } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-2 rounded-md text-sm border " +
        (active
          ? "bg-emerald-600 text-white border-emerald-600"
          : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")
      }
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

// 日付表示（簡易）
function formatIsoToJa(iso: string): string {
  try {
    const d: Date = new Date(iso);
    const y: number = d.getFullYear();
    const m: number = d.getMonth() + 1;
    const dd: number = d.getDate();
    const hh: number = d.getHours();
    const mm: number = d.getMinutes();
    const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));
    return `${y}/${pad2(m)}/${pad2(dd)} ${pad2(hh)}:${pad2(mm)}`;
  } catch {
    return iso;
  }
}