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
import styles from "./Client.module.css";
import Header from "./components/Header";
import SkeletonCard from "./components/SkeletonCard";
import EmptyCard from "./components/EmptyCard";
import ListItem from "./components/ListItem";

export default function Client() {
  const router = useRouter();
  const [items, setItems] = useState<GptsListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // 連打防止
  const [keyword, setKeyword] = useState(""); // 検索キーワード
  const [appliedId, setAppliedId] = useState<string | null>(null); // 選択中ハイライト

  const liffId: string | undefined = process.env.NEXT_PUBLIC_LIFF_ID_LIST as string | undefined;

  // 成功表示用のトースト
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [toastOpen, setToastOpen] = useState(false);
  function openToast(msg: string): void {
    setToastMsg(msg);
    setToastOpen(true);
    setTimeout(() => {
      setToastOpen(false);
      setToastMsg(null);
    }, 1600);
  }

  // 自前の削除確認モーダル用ステート
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState<boolean>(false);
  const confirmName: string = useMemo<string>(() => {
    if (!confirmId) return "";
    const it = items.find((x) => x.id === confirmId);
    return it?.name ?? "";
  }, [confirmId, items]); 

  useEffect(() => {
    void (async () => {
      try {
        const sess = await ensureLiffSession({ liffId });

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
  }, [liffId]);

  // 検索フィルタ（名前・ID・タグ）
  const filtered = useMemo<GptsListItem[]>(() => {
    if (!keyword.trim()) return items;
    const k: string = keyword.trim().toLowerCase();
    return items.filter((it) => {
      const pool: Array<string | undefined> = [it.name, it.id];
      return pool.some((v) => v?.toLowerCase?.().includes(k) ?? false);
    });
  }, [items, keyword]);

  // 編集（親で遷移実行）
  function onEdit(id: string): void {
    const href: string = `/gpts/${encodeURIComponent(id)}`;
    router.push(href);
  }
  
  // 削除モーダルを開く
  async function onDelete(id: string): Promise<void> {
    setConfirmId(id);
  }

  // 削除
  async function doDelete(): Promise<void> {
    const id: string | null = confirmId;
    if (!id) return;
    setConfirmBusy(true);
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
      setConfirmBusy(false);
      setConfirmId(null);
    }
  }

  // 選択中
  async function onApply(id: string): Promise<void> {
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

  // 未登録
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
      <div className={styles.searchWrap}>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="名前・IDで絞り込み"
          className={styles.searchInput}
        />
        <span className={styles.searchIcon}>🔎</span>
      </div>

      {/* リスト */}
      <ul className={styles.list}>
        {filtered.map((it) => {
          const isBusy: boolean = busyId === it.id;
          const applied: boolean = appliedId === it.id;
          return (
            <ListItem
              key={it.id}
              item={it}
              applied={applied}
              busy={isBusy}
              onEdit={onEdit}
              onApply={onApply}
              onDelete={onDelete}
            />
          );
        })}
      </ul>

      {/* 削除モーダル */}
      {confirmId && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          className={styles.toastWrap}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={() => { if (!confirmBusy) setConfirmId(null); }}
        >
          <div
            className={styles.toast}
            style={{
              background: "#fff",
              color: "#111",
              minWidth: "280px",
              maxWidth: "90vw",
              borderRadius: "12px",
              boxShadow: "0 10px 30px rgba(0,0,0,0.2)",
              padding: "16px",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="confirm-title" className={styles.toastBody} style={{ fontWeight: 600, marginBottom: 8 }}>
              このチャットルールを削除します。よろしいですか？
            </h2>
            <p className={styles.toastBody} style={{ marginBottom: 16, wordBreak: "break-word" }}>
              {confirmName ? `対象: 「${confirmName}」` : `ID: ${confirmId}`}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                type="button"
                disabled={confirmBusy}
                onClick={() => setConfirmId(null)}
                className={styles.searchInput}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #ddd",
                  background: "#fff",
                  cursor: "pointer",
                  opacity: confirmBusy ? 0.6 : 1,
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => { void doDelete(); }}
                disabled={confirmBusy}
                className={styles.searchInput}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #0ea5a4",
                  background: "#10b981",
                  color: "#fff",
                  cursor: "pointer",
                  opacity: confirmBusy ? 0.7 : 1,
                }}
              >
                {confirmBusy ? "削除中…" : "削除する"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 成功時のみ表示するトースト（下部固定） */}
      {toastOpen && toastMsg && (
        <div className={styles.toastWrap} onClick={() => { setToastOpen(false); setToastMsg(null); }}>
          <div role="status" aria-live="polite" className={styles.toast}>
            <div className={styles.toastBody}>{toastMsg}</div>
          </div>
        </div>
      )}
      {/* ここまでトースト */}
    </main>
  );
}
