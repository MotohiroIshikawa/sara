"use client";

import { useEffect, useMemo, useState, type JSX } from "react";
import { useRouter } from "next/navigation";
import styles from "@/app/gpts/Client.module.css";
import FooterActions from "../components/FooterActions";
import { ensureLiffSession } from "@/utils/ensureLiffSession";
import {
  isGptsDetailResponse,
  type GptsDetailResponse,
  type GptsListResponse,
  isGptsListResponse,
} from "@/utils/types";
import { setFlash, showToastNow } from "@/utils/flashToast";

// サーバエラーの読み取り（any禁止）
interface ApiErrorJson {
  error?: string;
  message?: string;
}

async function readServerError(res: Response, fallback: string): Promise<string> {
  try {
    const j: unknown = await res.json();
    const o: ApiErrorJson = (typeof j === "object" && j !== null) ? (j as ApiErrorJson) : {};
    const detail: string | undefined =
      typeof o.message === "string" ? o.message :
      (typeof o.error === "string" ? o.error : undefined);
    if (detail) return `${fallback}\n詳細: ${detail}`;
  } catch {}
  return `${fallback}\n詳細: ${String(res.status)} ${res.statusText}`;
}

// 詳細画面（閲覧専用）
export default function Client({ id }: { id: string }): JSX.Element {
  const router = useRouter();

  // 表示データ
  const [name, setName] = useState<string>("");
  const [inst, setInst] = useState<string>("");
  const [isPublic, setIsPublic] = useState<boolean>(false);
  const [updatedAt, setUpdatedAt] = useState<string>("");

  // 状態
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);

  // LIFF（一覧と同一のIDを使用）
  const liffId: string | undefined = process.env.NEXT_PUBLIC_LIFF_ID_LIST as string | undefined;

  // 選択中判定
  const isApplied: boolean = useMemo<boolean>(() => appliedId === id, [appliedId, id]);

  useEffect(() => {
    void (async () => {
      try {
        // 認証
        const sess = await ensureLiffSession({ liffId });
        if (!sess.ok) {
          if (sess.reason === "login_redirected") return;
          setErr("ログインに失敗しました");
          return;
        }

        // 詳細取得
        const r = await fetch(`/api/gpts/${encodeURIComponent(id)}`, { credentials: "include" });
        const j: unknown = await r.json();
        if (!r.ok || !isGptsDetailResponse(j)) {
          setErr("詳細の取得に失敗しました");
          return;
        }
        const data: GptsDetailResponse = j;
        setName(data.item.name);
        setInst(data.item.instpack);
        setIsPublic(data.item.isPublic);
        setUpdatedAt(data.item.updatedAt ?? "");

        // 選択中ID（一覧API）
        const rList = await fetch("/api/gpts/list", { credentials: "include", cache: "no-store" });
        const jList: unknown = await rList.json();
        if (rList.ok && isGptsListResponse(jList)) {
          const listData: GptsListResponse = jList;
          setAppliedId(listData.appliedId ?? null);
        }
      } catch {
        setErr("読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, liffId]);

  // 編集へ
  function onEdit(): void {
    const href: string = `/gpts/${encodeURIComponent(id)}`;
    router.push(href);
  }

  // 選択（Binding作成）
  async function onSelect(): Promise<void> {
    setBusy(true);
    try {
      const r = await fetch(`/api/gpts/${encodeURIComponent(id)}/use`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) {
        const msg: string = await readServerError(r, "選択に失敗しました。通信環境をご確認のうえ、再度お試しください。");
        showToastNow(msg);
        return;
      }
      setFlash("このトークルームにルールを適用しました。");
      router.push("/gpts/list");
    } catch {
      showToastNow("選択時にエラーが発生しました。時間をおいて再度お試しください。");
    } finally {
      setBusy(false);
    }
  }

  // 削除
  function onDelete(): void {
    setConfirmOpen(true);
  }

  async function doDelete(): Promise<void> {
    setBusy(true);
    try {
      const r = await fetch(`/api/gpts/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        const msg: string = await readServerError(r, "削除に失敗しました。通信環境をご確認のうえ、再度お試しください。");
        showToastNow(msg);
        return;
      }
      setFlash("チャットルールを削除しました。");
      router.push("/gpts/list");
    } catch {
      showToastNow("削除時にエラーが発生しました。時間をおいて再度お試しください。");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  }

  // 戻る
  function onBack(): void {
    window.history.back();
  }

  if (loading) return <main className="p-4">読み込み中…</main>;
  if (err) return <main className="p-4 text-red-600">{err}</main>;

  return (
    <main className={styles.container}>
      {/* タイトル/メタ */}
      <section className={styles.card}>
        <div className={styles.title}>{name || "(無題)"}</div>
        <div className="mt-1 text-[12px] text-gray-500">
          更新: {updatedAt ? new Date(updatedAt).toLocaleString() : "-"} / {isPublic ? "公開" : "非公開"}
        </div>
      </section>

      {/* ルール表示（読み取り専用） */}
      <section className={styles.card}>
        <div className={styles.title}>ルール</div>
        <pre className={styles.codeBlock}>{inst}</pre>
      </section>

      {/* フッター：編集／選択 or 選択中（黄・無効）／削除／戻る */}
      <FooterActions
        onBack={onBack}
        onEdit={onEdit}
        onSelect={isApplied ? undefined : onSelect}
        onDelete={onDelete}
        isApplied={isApplied}
        busy={busy}
      />

      {/* 削除ダイアログ */}
      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          className={styles.modal}
          onClick={() => { if (!busy) setConfirmOpen(false); }}
        >
          <div
            className="mx-auto my-10 max-w-screen-sm rounded-2xl border border-gray-200 bg-white p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div id="confirm-title" className="text-base font-semibold">
              このチャットルールを削除します。よろしいですか？
            </div>
            {isApplied && (
              <p className={styles.dialogNote}>
                ※現在選択中のチャットルールを削除します
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className={styles.footerBtnBack}
                disabled={busy}
                aria-disabled={busy}
                onClick={() => setConfirmOpen(false)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className={styles.footerBtnDanger}
                disabled={busy}
                aria-disabled={busy}
                onClick={() => { void doDelete(); }}
              >
                {busy ? "削除中…" : "削除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
