"use client";
import { useEffect, useState } from "react";

// 型＆ガード
type GptsListItem = {
  id: string;
  name: string;
  updatedAt: string; // ISO8601
};
type ListResponse = {
  items: GptsListItem[];
};
type ApplyResponse = {
  ok: true;
  appliedId: string;
  name: string;
};
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isItem(v: unknown): v is GptsListItem {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.name) &&
    isString(v.updatedAt)
  );
}
function isListResponse(v: unknown): v is ListResponse {
  return isRecord(v) && Array.isArray(v.items) && v.items.every(isItem);
}
function isApplyResponse(v: unknown): v is ApplyResponse {
  return (
    isRecord(v) &&
    (v as { ok?: unknown }).ok === true &&
    isString((v as { appliedId?: unknown }).appliedId) &&
    isString((v as { name?: unknown }).name)
  );
}

// 画面
export default function GptsListPage() {
  const [items, setItems] = useState<GptsListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // 連打防止

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/gpts/list", { credentials: "include" });
        const j: unknown = await r.json();
        if (!r.ok) {
          setErr("読み込みに失敗しました");
          return;
        }
        if (isListResponse(j)) {
          setItems(j.items);
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
      const r = await fetch(`/gpts/${encodeURIComponent(id)}`, {
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
      const r = await fetch(`/gpts/${encodeURIComponent(id)}/use`, {
        method: "POST",
        credentials: "include",
      });
      const j: unknown = await r.json();
      if (!r.ok) {
        alert("適用に失敗しました");
        return;
      }
      if (isApplyResponse(j)) {
        alert(`「${j.name || "選択したルール"}」を適用しました。`);
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
