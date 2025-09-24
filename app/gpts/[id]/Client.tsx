"use client";
import { useEffect, useState } from "react";
import {
  type GptsDetailResponse,
  type GptsUpdateRequest,
  isGptsDetailResponse
} from "@/utils/types";

export default function Client({ id }: { id: string }) {
  const [name, setName] = useState("");
  const [inst, setInst] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/gpts/${encodeURIComponent(id)}`, {
          credentials: "include",
        });
        const j: unknown = await r.json();
        if (!r.ok) {
          setErr("読み込みに失敗しました");
          return;
        }
        if (!isGptsDetailResponse(j)) {
          setErr("予期しない応答形式です");
          return;
        }
        const data: GptsDetailResponse = j;
        setName(data.item.name);
        setInst(data.item.instpack);
      } catch {
        setErr("読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  async function onSave() {
    try {
      const body: GptsUpdateRequest = { name, instpack: inst };
      const r = await fetch(`/api/gpts/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        alert("保存に失敗しました");
        return;
      }
      window.location.href = "/gpts/list";
    } catch {
      alert("保存時にエラーが発生しました");
    }
  }

  if (loading) return <main className="p-4">読み込み中…</main>;
  if (err) return <main className="p-4 text-red-600">{err}</main>;

  return (
    <main className="p-4 space-y-4">
      <h1 className="text-lg font-semibold">チャットルールの編集</h1>

      {!confirming ? (
        <>
          <label className="block text-sm font-medium">名称</label>
          <input
            className="w-full border rounded p-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <label className="block text-sm font-medium mt-3">
            本文（instpack）
          </label>
          <textarea
            className="w-full border rounded p-2 h-64"
            value={inst}
            onChange={(e) => setInst(e.target.value)}
          />

          <div className="flex gap-2 mt-3">
            <button
              className="px-4 py-2 bg-gray-200 rounded"
              onClick={() => window.history.back()}
            >
              戻る
            </button>
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded"
              onClick={() => setConfirming(true)}
            >
              確認
            </button>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <div className="border rounded p-3">
            <div className="text-sm text-gray-500">保存内容の確認</div>
            <div className="font-medium">名称</div>
            <div>{name || "(無題)"}</div>
            <div className="font-medium mt-2">本文</div>
            <pre className="whitespace-pre-wrap break-words">{inst}</pre>
          </div>
          <div className="flex gap-2">
            <button
              className="px-4 py-2 bg-gray-200 rounded"
              onClick={() => setConfirming(false)}
            >
              修正する
            </button>
            <button
              className="px-4 py-2 bg-blue-600 text-white rounded"
              onClick={() => void onSave()}
            >
              保存
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
