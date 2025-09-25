"use client";
import { useEffect, useMemo, useState } from "react";
import {
  type GptsDetailResponse,
  type GptsUpdateRequest,
  isGptsDetailResponse
} from "@/utils/types";
import { ensureLiffSession } from "@/utils/ensureLiffSession";

export default function Client({ id }: { id: string }) {
  const [name, setName] = useState("");
  const [inst, setInst] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const sess = await ensureLiffSession();
        if (!sess.ok) {
          if (sess.reason === "login_redirected") return;
          setErr("ログインに失敗しました");
          return;
        }

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

  const counts = useMemo(() => ({
    name: name.length,
    inst: inst.length,
  }), [name, inst]);

  if (loading) return <main className="p-4">読み込み中…</main>;
  if (err) return <main className="p-4 text-red-600">{err}</main>;

return (
    <main className="mx-auto max-w-screen-sm p-4 space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">チャットルールの編集</h1>
        <p className="text-sm text-gray-500">名前とルールを編集します</p>
      </header>

      {!confirming ? (
        <>
          <label className="block text-sm font-medium">名前</label>
          <input
            className="w-full rounded-xl border px-4 py-3 text-[15px] outline-none focus:ring-2 focus:ring-blue-500"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ルールの名前を入力..."
          />
          <div className="mt-1 text-right text-[11px] text-gray-500">{counts.name} 文字</div>

          <label className="mt-4 block text-sm font-medium">ルール</label>
          <textarea
            className="w-full rounded-2xl border px-4 py-3 text-[15px] leading-relaxed outline-none focus:ring-2 focus:ring-blue-500
                       min-h-[55vh] md:min-h-[60vh] resize-y" // 高さを画面の過半に
            value={inst}
            onChange={(e) => setInst(e.target.value)}
            placeholder="チャットルールを入力..."
          />
          <div className="mt-1 text-right text-[11px] text-gray-500">{counts.inst} 文字</div>

          {/* フッター操作 */}
          <div className="sticky bottom-2 z-10 mt-4 flex gap-2">
            <button
              className="flex-1 rounded-full bg-gray-200 px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-gray-400"
              onClick={() => window.history.back()}
            >
              戻る
            </button>
            <button
              className="flex-1 rounded-full bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              onClick={() => setConfirming(true)}
            >
              確認
            </button>
          </div>
        </>
      ) : (
        // 確認画面
        <section className="space-y-4">
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="text-sm text-gray-500">保存内容の確認</div>

            <div className="mt-2 text-sm font-medium">名前</div>
            <div className="mt-1 break-words">{name || "(無題)"}</div>

            <div className="mt-4 text-sm font-medium">ルール</div>
            <pre
              className="mt-1 max-h-[60vh] overflow-auto rounded-md bg-gray-50 p-3 text-[14px] leading-relaxed
                         whitespace-pre-wrap break-words overflow-x-hidden" // ★ 横幅を出さない
            >
              {inst}
            </pre>
          </div>

          <div className="sticky bottom-2 z-10 mt-2 flex gap-2">
            <button
              className="flex-1 rounded-full bg-gray-200 px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-gray-400"
              onClick={() => setConfirming(false)}
            >
              修正する
            </button>
            <button
              className="flex-1 rounded-full bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              onClick={() => void onSave()}
            >
              保存
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
