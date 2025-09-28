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
  const [appliedId, setAppliedId] = useState<string | null>(null); // 選択中ハイライト

  // 成功表示用のトースト
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [toastOpen, setToastOpen] = useState(false);
  function openToast(msg: string) {
    setToastMsg(msg);
    setToastOpen(true);
    setTimeout(() => {
      setToastOpen(false);
      setToastMsg(null);
    }, 1600);
  }

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
      if (appliedId === id) setAppliedId(null); // 選択中の場合は選択中を消す
    } catch {
      alert("削除時にエラーが発生しました");
    } finally {
      setBusyId((prev) => (prev === id ? null : prev));
    }
  }

  // 選択中
  async function onApply(id: string) {
    setBusyId(id);
    try {
      const r = await fetch(`/api/gpts/${encodeURIComponent(id)}/use`, {
        method: "POST",
        credentials: "include",
      });
      const j: unknown = await r.json();
      if (!r.ok) {
        alert("選択に失敗しました");
        return;
      }
      if (isGptsApplyResponse(j)) {
        const data: GptsApplyResponse = j;
        setAppliedId(id);
        openToast(`「${data.name || "選択したルール"}」を選択しました。`);
      } else {
        alert("応答形式が不正です");
      }
    } catch {
      alert("選択時にエラーが発生しました");
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
                {/* 選択中バッジ */}
                {applied && (
                  <span className="shrink-0 rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
                    選択中
                  </span>
                )}
              </div>

              {/* ボタン列 */}
              <div className="mt-3 flex items-center gap-2">
                {/* 選択ボタンは「選択中」のとき無効化してグレー表示 */}
                <button
                  className={[
                    "inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-medium",
                    // 見た目：選択中=グレー&無効, それ以外=グリーン
                    applied
                      ? "bg-gray-200 text-gray-500 cursor-not-allowed opacity-70"
                      : (isBusy
                          ? "bg-green-300 text-white"
                          : "bg-green-600 text-white hover:bg-green-700"),
                    "focus:outline-none",
                    applied ? "" : "focus:ring-2 focus:ring-green-500", // 無効時はフォーカス装飾も外す
                  ].join(" ")}
                  // 動作：選択中 or ビジーで無効化
                  disabled={applied || isBusy}
                  aria-disabled={applied || isBusy} // アクセシビリティ
                  onClick={() => {
                    // ガード：念のためクリック無効化
                    if (applied || isBusy) return;
                    void onApply(it.id);
                  }}
                  title={applied ? "このルールは選択中です" : "このチャットで使うルールとして選択します"}
                >
                  {/* ラベル：選択中は「選択中」表示 */}
                  {applied ? "選択中" : isBusy ? "選択中…" : "選択"}
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

      {/* 成功時のみ表示するトースト（下部固定） */}
      {toastOpen && toastMsg && (
        <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
          <div role="status" aria-live="polite"
            className="max-w-screen-sm w-full rounded-2xl bg-black/85 text-white shadow-lg backdrop-blur-sm"
            onClick={() => { setToastOpen(false); setToastMsg(null); }} >
            <div className="p-4 text-sm leading-relaxed">{toastMsg}</div>
          </div>
        </div>
      )}
      {/* ここまでトースト */}
    </main>
  );
}

function Header(props: { appliedId?: string | null }) {
  return (
    <header className="flex items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">チャットルール一覧</h1>
        <p className="text-[13px] text-gray-500">保存済みのルールを編集・選択できます</p>
      </div>
      {props.appliedId ? (
        <span className="hidden rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 sm:inline-block">
          選択中: {props.appliedId}
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
