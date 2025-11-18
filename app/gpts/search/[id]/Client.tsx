"use client";

import { useEffect, useMemo, useState, useCallback, type JSX } from "react";
import { useParams, useRouter } from "next/navigation";
import styles from "@/app/gpts/Client.module.css";
import { ensureLiffSession } from "@/utils/line/ensureLiffSession";
import { setFlash, showToastNow, takeFlash } from "@/utils/ui/flashToast";
import { formatIsoToJa } from "@/utils/ui/formatIsoToJa";

// 詳細APIレスポンス
type PublicDetailItem = {
  id: string;
  name: string;
  instpack: string;
  updatedAt: string;   // ISO8601
  isPublic: boolean;
};

type PublicDetailResponse = { item: PublicDetailItem } | { error: string };

// コピーAPI
type CopyRequest = { renameTo?: string };
type CopyResponse = { ok: true; gptsId: string; name: string } | { error: string };

// 画面
export default function Client(): JSX.Element {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id: string = params?.id;

  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);
  const [item, setItem] = useState<PublicDetailItem | null>(null);

  // 確認・コピー関連
  const [confirming, setConfirming] = useState<boolean>(false);
  const [rename, setRename] = useState<string>(""); // 確認画面で編集
  const [saving, setSaving] = useState<boolean>(false);

  // 入力バリデーション
  const renameTrimmed: string = useMemo<string>(() => rename.trim(), [rename]);
  const nameTooLong: boolean = useMemo<boolean>(() => renameTrimmed.length > 100, [renameTrimmed]);
  const nameEmpty: boolean = useMemo<boolean>(() => renameTrimmed.length === 0, [renameTrimmed]);
  const canSave: boolean = useMemo<boolean>(() => !saving && !nameEmpty && !nameTooLong, [saving, nameEmpty, nameTooLong]);

  // トースト
  const [toastOpen, setToastOpen] = useState<boolean>(false);
  const [toastMsg, setToastMsg] = useState<string>("");

  const liffId: string | undefined = process.env.NEXT_PUBLIC_LIFF_ID_SEARCH as string | undefined;

  // 一覧に遷移してきた直後だけ表示する
  useEffect(() => {
    const msg: string | null = takeFlash();
    if (msg && msg.trim().length > 0) {
      setToastMsg(msg);
      setToastOpen(true);
      const h: number = window.setTimeout(() => setToastOpen(false), 2400);
      return () => window.clearTimeout(h);
    }
    return;
  }, []);

  // 読み込み
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
        const r: Response = await fetch(`/api/gpts/public/${encodeURIComponent(id)}`, { credentials: "include" });
        const j: unknown = await r.json();
        if (!r.ok) {
          const msg: string = typeof (j as { error?: string })?.error === "string" ? (j as { error: string }).error : "読み込みに失敗しました";
          setErr(msg);
          setLoading(false);
          return;
        }
        const ok: boolean = typeof j === "object" && j !== null && typeof (j as { item?: unknown }).item === "object" && (j as { item?: unknown }).item !== null;
        if (!ok) {
          setErr("予期しない応答形式です");
          setLoading(false);
          return;
        }
        const body: PublicDetailResponse = j as PublicDetailResponse;
        if ("error" in body) {
          setErr(body.error || "読み込みに失敗しました");
          setLoading(false);
          return;
        }
        setItem(body.item);
        setRename(body.item.name ?? "");
      } catch {
        setErr("読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, liffId]);

  // コピー開始
  const onStartCopy = useCallback((): void => {
    if (!item) return;
    setRename(item.name ?? "");
    setConfirming(true);
  }, [item]);

  // 保存（コピー実行）
  const onSave = useCallback(async (): Promise<void> => {
    if (!item || !canSave) return;
    setSaving(true);
    try {
      const body: CopyRequest = renameTrimmed.length > 0 ? { renameTo: renameTrimmed } : {};
      const r: Response = await fetch(`/api/gpts/${encodeURIComponent(item.id)}/copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const j: unknown = await r.json();
      if (!r.ok || typeof (j as { ok?: boolean })?.ok !== "boolean") {
        const msg: string = typeof (j as { error?: string })?.error === "string" ? (j as { error: string }).error : "コピーに失敗しました";
        showToastNow(msg);
        return;
      }
      const res: CopyResponse = j as CopyResponse;
      if ("ok" in res && res.ok) {
        setFlash(`「${res.name}」を自分のリストにコピーしました。`);
        router.replace("/gpts/list");
      } else {
        showToastNow((res as { error: string }).error || "コピーに失敗しました");
      }
    } catch {
      showToastNow("コピー中にエラーが発生しました");
    } finally {
      setSaving(false);
    }
  }, [item, canSave, renameTrimmed, router]);

  // 戻る
  const onBack = useCallback((): void => {
    router.back();
  }, [router]);

  if (loading) {
    return (
      <main className={styles.container}>
        {/* Skeleton（カード1枚分） */}
        <section className={styles.card}>
          <div className="h-4 w-1/3 bg-gray-200 animate-pulse rounded mb-3" />
          <div className="h-3 w-full bg-gray-200 animate-pulse rounded mb-2" />
          <div className="h-3 w-5/6 bg-gray-200 animate-pulse rounded mb-2" />
          <div className="h-3 w-2/3 bg-gray-200 animate-pulse rounded" />
        </section>
      </main>
    );
  }

  if (err || !item) {
    return (
      <main className={styles.container}>
        <div className={styles.alertError}>
          {err ?? "詳細を取得できませんでした"}
        </div>
        <div>
          <button
            type="button"
            onClick={onBack}
            className={styles.footerBtnBack}
          >
            戻る
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.container}>
      {/* タイトルカード（一覧/詳細トーンに合わせる） */}
      <section className={styles.card}>
        <div className="text-base font-semibold break-words">{item.name || "(無題)"}</div>
        <div className="mt-1 text-[12px] text-gray-500">
          更新: {formatIsoToJa(item.updatedAt)} ／ {item.isPublic ? "公開" : "非公開"}
        </div>
      </section>

      {/* ルール本文（instpack） */}
      <section className={styles.card}>
        <div className="text-sm font-medium">ルール</div>
        <pre
          className="mt-2 max-h-[60vh] overflow-auto rounded-md bg-gray-50 p-3 text-[13px] leading-relaxed whitespace-pre-wrap break-words"
          aria-label="ルールプレビュー"
        >
        {item.instpack}
        </pre>
      </section>

      {/* アクション */}
      <section className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className={styles.footerBtnBack}
        >
          戻る
        </button>
        <button
          type="button"
          onClick={onStartCopy}
          className={styles.footerBtnGreen}
        >
          コピーする
        </button>
      </section>

      {/* 確認パネル（モーダル相当の簡易実装） */}
      {confirming && (
        <section className={styles.card}>
          <div className="text-sm text-gray-500">コピー内容の確認</div>
          <div className="mt-3 text-sm font-medium">名前（編集可・必須）</div>
          <input
            value={rename}
            onChange={(e) => setRename(e.target.value)}
            placeholder="コピー後の名前を入力（必須）"
            maxLength={120}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-[14px] outline-none focus:ring-2 focus:ring-emerald-500"
          />
          {(nameEmpty || nameTooLong) && (
            <p className="mt-1 text-xs text-red-600">
              {nameEmpty ? "名前は必須です" : "名前は100文字以内で入力してください"}
            </p>
          )}

          <div className="mt-4 text-sm font-medium">プレビュー</div>
          <div className="mt-1 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
            「{renameTrimmed || "（未入力）"}」
          </div>

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={saving}
              className={styles.footerBtnBack}
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => { void onSave(); }}
              disabled={!canSave}
              className={canSave ? styles.footerBtnGreen : styles.footerBtnGray}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </section>
      )}

      {/* フラッシュトースト */}
      {toastOpen && (
        <div className={styles.toastWrap}>
          <div className={styles.toast}>
            <div className={styles.toastBody}>{toastMsg}</div>
          </div>
        </div>
      )}
    </main>
  );
}