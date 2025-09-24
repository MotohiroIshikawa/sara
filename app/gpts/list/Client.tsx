"use client";

import { useEffect, useState } from "react";
import {
  type GptsListItem,
  type GptsListResponse,
  type GptsApplyResponse,
  isGptsListResponse,
  isGptsApplyResponse,
} from "@/utils/types";

export default function Client() {
  const [items, setItems] = useState<GptsListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // 連打防止

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/gpts/list", { credentials: "include" });
        const j: unknown = await r.json();
        if (!r.ok) {
          setErr("読み込みに失敗しました");
          return;
        }
        if (isGptsListResponse(j)) {
          const data: GptsListResponse = j;
          setItems(data.items);
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
    } catch {
      alert("削除時にエラーが発生しました");
    } finally {
      setBusyId((prev) => (prev === id ? null : prev));
    }
  }

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

  if (loading) return <main className="p-4">読み込み中…</main>;
  if (err) return <main className="p-4 text-red-600">{err}</main>;

  if (items.length === 0) {
    return (
      <main className="p-4 space-y-3">
        <h1 className="text-lg font-semibold">チャットルール一覧</h1>
        <p>作成済みのチャットルールはありません。</p>
      </main>
    );
  }

  return (
    <main className="p-4 space-y-4">
      <h1 className="text-lg font-semibold">チャットルール一覧</h1>
      <ul className="space-y-3">
        {items.map((it) => {
          const isBusy = busyId === it.id;
          const href = `/gpts/${encodeURIComponent(it.id)}`;
          return (
            <li key={it.id} className="border rounded p-3">
              <div className="font-medium">{it.name}</div>
              <div className="text-xs text-gray-500">
                更新: {new Date(it.updatedAt).toLocaleString()}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <a
                  className={`px-3 py-1 rounded text-white ${
                    isBusy ? "bg-blue-300" : "bg-blue-600"
                  }`}
                  aria-disabled={isBusy}
                  href={isBusy ? undefined : href}
                  onClick={(e) => {
                    if (isBusy) e.preventDefault();
                  }}
                >
                  編集
                </a>
                <button
                  className={`px-3 py-1 rounded ${
                    isBusy ? "bg-gray-300" : "bg-gray-200"
                  }`}
                  disabled={isBusy}
                  onClick={() => void onDelete(it.id)}
                >
                  削除
                </button>
                <button
                  className={`px-3 py-1 rounded ${
                    isBusy ? "bg-green-300 text-white" : "bg-green-600 text-white"
                  }`}
                  disabled={isBusy}
                  onClick={() => void onApply(it.id)}
                  title="このチャットで使うルールとして適用します"
                >
                  適用
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
