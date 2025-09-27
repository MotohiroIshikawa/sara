"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type GptsListItem,
  type GptsListResponse,
  type GptsApplyResponse,
  isGptsListResponse,
  isGptsApplyResponse,
} from "@/utils/types";
import { ensureLiffSession } from "@/utils/ensureLiffSession";

export default function Client() {
  const router = useRouter();
  const [items, setItems] = useState<GptsListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // 連打防止
  const [keyword, setKeyword] = useState(""); // 検索キーワード
  const [appliedId, setAppliedId] = useState<string | null>(null); // 適用中ハイライト

  useEffect(() => {
    void (async () => {
      try {
        const sess = await ensureLiffSession();
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
      }
    })();
  }, []);

  // 検索フィルタ（名前・ID・タグ）
  const filtered = useMemo(() => {
    if (!keyword.trim()) return items;
    const k = keyword.trim().toLowerCase();
    return items.filter((it) => {
      const pool = [it.name, it.id];
      return pool.some((v) => v?.toLowerCase?.().includes(k));
    });
  }, [items, keyword]);
  
  // 削除
  async function onDelete(id: string) {
    if (!confirm("このチャットルールを削除します。よろしいですか？")) return;
    setBusyId(id);
    try {
      const r = await fetch(`/api/gpts/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        alert("削除に失敗しました");
        return;
      }
      setItems((prev) => prev.filter((x) => x.id !== id));
      if (appliedId === id) setAppliedId(null); // 適用中の場合は適用中を消す
    } catch {
      alert("削除時にエラーが発生しました");
    } finally {
      setBusyId((prev) => (prev === id ? null : prev));
    }
  }

  // 適用中
  async function onApply(id: string) {
    setBusyId(id);
    try {
      const r = await fetch(`/api/gpts/${encodeURIComponent(id)}/use`, {
        method: "POST",
        credentials: "include",
      });
      const j: unknown = await r.json();
      if (!r.ok) {
        alert("適用に失敗しました");
        return;
      }
      if (isGptsApplyResponse(j)) {
        const data: GptsApplyResponse = j;
        setAppliedId(id);
        alert(`「${data.name || "選択したルール"}」を適用しました。`);
      } else {
        alert("応答形式が不正です");
      }
    } catch {
      alert("適用時にエラーが発生しました");
    } finally {
      setBusyId((prev) => (prev === id ? null : prev));
    }
  }

  // ローディング
  if (loading) {
    return (
      <main className="mx-auto max-w-screen-sm p-4 space-y-4">
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
      <main className="mx-auto max-w-screen-sm p-4 space-y-3">
        <Header />
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-3">
          {err}
        </div>
      </main>
    );
  }

  // 未登録
  if (items.length === 0) {
    return (
      <main className="mx-auto max-w-screen-sm p-4 space-y-4">
        <Header />
        <EmptyCard />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-screen-sm p-4 space-y-4">
      <Header appliedId={appliedId} />
      {/* 検索ボックス */}
      <div className="relative">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="名前・IDで絞り込み"
          className="w-full rounded-xl border px-4 py-3 pr-10 text-[15px] outline-none focus:ring-2 focus:ring-blue-500"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
          🔎
        </span>
      </div>

      {/* リスト */}
      <ul className="space-y-3">
        {filtered.map((it) => {
          const isBusy = busyId === it.id;
          const href = `/gpts/${encodeURIComponent(it.id)}`;
          const applied = appliedId === it.id;
          return (
            <li
              key={it.id}
              className={[
                "rounded-2xl border border-gray-200 bg-white p-4 shadow-sm transition hover:shadow-md active:scale-[0.995]",
                applied ? "border-green-500 ring-1 ring-green-200" : "border-gray-200",
              ].join(" ")}
            >
              {/* タイトル行 */}
              <div className="flex items-start justify-between gap-3 min-w-0">
                <div className="min-w-0">
                  <div className="font-medium max-w-full truncate" title={it.name}>
                    {it.name}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    更新: {new Date(it.updatedAt).toLocaleString()}
                  </div>
                </div>
                {/* 適用中バッジ */}
                {applied && (
                  <span className="shrink-0 rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
                    適用中
                  </span>
                )}
              </div>

              {/* ボタン列 */}
              <div className="mt-3 flex items-center gap-2">
                {/* 適用 */}
                <button
                  className={[
                    "inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-medium text-white",
                    isBusy ? "bg-green-300" : "bg-green-600 hover:bg-green-700",
                    "focus:outline-none focus:ring-2 focus:ring-green-500",
                  ].join(" ")}
                  disabled={isBusy}
                  onClick={() => void onApply(it.id)}
                  title="このチャットで使うルールとして適用します"
                >
                  {isBusy ? "適用中…" : "適用"}
                </button>

                {/* 編集 */}
                <button
                  className={[
                    "inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-medium",
                    isBusy ? "bg-blue-300 text-white" : "bg-blue-600 text-white hover:bg-blue-700",
                    "focus:outline-none focus:ring-2 focus:ring-blue-500",
                  ].join(" ")}
                  disabled={isBusy}
                  onClick={() => { if (!isBusy) router.push(href); }}
                  title="ルールを編集します"
                >
                  編集
                </button>

                {/* 削除 */}
                <button
                  className={[
                    "inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-medium",
                    isBusy ? "bg-gray-300 text-gray-600" : "bg-gray-200 hover:bg-gray-300",
                    "focus:outline-none focus:ring-2 focus:ring-gray-400",
                  ].join(" ")}
                  disabled={isBusy}
                  onClick={() => void onDelete(it.id)}
                >
                  削除
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

function Header(props: { appliedId?: string | null }) {
  return (
    <header className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">チャットルール一覧</h1>
        <p className="text-[13px] text-gray-500">保存済みのルールを編集・適用できます</p>
      </div>
      {props.appliedId ? (
        <span className="hidden rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 sm:inline-block">
          適用中: {props.appliedId}
        </span>
      ) : null}
    </header>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="h-4 w-40 animate-pulse rounded bg-gray-200" />
      <div className="mt-2 h-3 w-24 animate-pulse rounded bg-gray-200" />
      <div className="mt-3 h-8 w-full animate-pulse rounded bg-gray-200" />
    </div>
  );
}

function EmptyCard() {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-6 text-center">
      <div className="text-base font-medium">チャットルールは未登録</div>
      <p className="mt-1 text-sm text-gray-500">
        LINEで会話して「保存しますか？」で保存するとチャットルールが表示されます。
      </p>
    </div>
  );
}
