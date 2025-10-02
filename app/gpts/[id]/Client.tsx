"use client";
import { useEffect, useMemo, useState, useCallback } from "react";
import { type GptsDetailResponse, type GptsUpdateRequest, isGptsDetailResponse } from "@/utils/types";
import { ensureLiffSession } from "@/utils/ensureLiffSession";
import { type ScheduleDto, type ScheduleFreq, type SchedulePatch } from "@/types/schedule";
import { isScheduleDto, isScheduleList } from "@/utils/scheduleGuards";
import { canEnableSchedule } from "@/utils/scheduleValidators";
import styles from "./Client.module.css"; // ★
import NameSection from "./components/NameSection"; // ★
import RuleSection from "./components/RuleSection"; // ★
import ScheduleEditor from "./components/ScheduleEditor"; // ★
import FooterActions from "./components/FooterActions"; // ★
import ConfirmModal from "./components/ConfirmModal"; // ★

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

    console.info("[readServerError] response", {
      status: res.status,
      statusText: res.statusText,
      url: (res as { url?: string }).url ?? undefined,
      body: o,
    });

    if (detail) {
      return `${fallback}\n詳細: ${detail}`;
    }
  } catch (e) {
    console.info("[readServerError] parse_error", {
      status: res.status,
      statusText: res.statusText,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return `${fallback}\n詳細: ${String(res.status)} ${res.statusText}`;
}

export default function Client({ id }: { id: string }) {
  const [name, setName] = useState<string>("");
  const [inst, setInst] = useState<string>("");
  const [sched, setSched] = useState<ScheduleDto | null>(null);
  const [schedToggle, setSchedToggle] = useState<boolean>(false); // 「登録ずみ｜未登録」の左（登録ずみ）= true
  const [loading, setLoading] = useState<boolean>(true);
  const [confirming, setConfirming] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  // スケジュール一覧の再取得
  const refreshSchedules = useCallback(async (opts?: { preserveToggle?: boolean }): Promise<void> => {
    const sres = await fetch(`/api/schedules?gptsId=${encodeURIComponent(id)}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (sres.ok) {
      const sj: unknown = await sres.json();
      if (isScheduleList(sj)) {
        const items: ScheduleDto[] = (sj as { items: ScheduleDto[] }).items;
        const first: ScheduleDto | null = items[0] ?? null;
        setSched(first);
        if (!opts?.preserveToggle) {
          setSchedToggle(Boolean(first));
        }
      }
    }
  }, [id]);

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

        // スケジュールは一覧を取得→先頭を編集対象に
        await refreshSchedules();
      } catch {
        setErr("読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, refreshSchedules]);

  // 保存時の最終確定ロジックを追加（スケジュール → GPTS本体の順で確定）
  async function onSave(): Promise<void> {
    try {
      // 1. 未登録の場合：レコードがあればソフト削除
      if (!schedToggle) {
        if (sched?._id) {
          const payload: { deletedAt: string; enabled: boolean; nextRunAt: null } = {
            deletedAt: new Date().toISOString(),
            enabled: false,  // 保険
            nextRunAt: null, // 保険
          };
          const delRes = await fetch(`/api/schedules/${sched._id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(payload),
          });
          if (!delRes.ok) {
            const msg: string = await readServerError(delRes, "スケジュールを未登録にできませんでした。通信環境をご確認のうえ、再度お試しください。");
            alert(msg);
            return;
          }
        }
      } else {
        // 2. 登録ずみの場合：レコードを確実に用意し、実施中/停止中で最終確定
        let current: ScheduleDto | null = sched ?? null;

        // （稀ケース）レコードが無い場合は作成してから続行
        if (!current?._id) {
          interface ScheduleCreateBody {
            gptsId: string;
            freq: ScheduleFreq;
            hour: number;
            minute: number;
            enabled: boolean;
            timezone: string;
          }
          const createBody: ScheduleCreateBody = {
            gptsId: id,
            freq: "daily" as ScheduleFreq,
            hour: 9,
            minute: 0,
            enabled: false,
            timezone: process.env.NEXT_PUBLIC_SCHEDULE_TZ_DEFAULT ?? "Asia/Tokyo",
          };
          const cRes = await fetch(`/api/schedules`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(createBody),
          });
          if (!cRes.ok) {
            const msg: string = await readServerError(cRes, "スケジュールの作成に失敗しました。通信環境をご確認のうえ、再度お試しください。");
            alert(msg);
            return;
          }
          const createdJson: unknown = await cRes.json();
          if (!isScheduleDto(createdJson)) {
            alert("サーバ応答が不正です（スケジュール作成）");
            return;
          }
          current = createdJson as ScheduleDto;
        }

        // 実施中/停止中で確定（/enable は丸め&nextRunAt再計算、/disable は nextRunAt=null）
        if (current.enabled) {
          const chk = canEnableSchedule(current);
          if (!chk.ok) {
            alert(chk.message);
            return;
          }
          const eRes = await fetch(`/api/schedules/${current._id}/enable`, {
            method: "POST",
            credentials: "include",
          });
          if (!eRes.ok) {
            const msg: string = await readServerError(eRes, "スケジュールの有効化に失敗しました。設定内容をご確認のうえ、再度お試しください。");
            alert(msg);
            return;
          }
          const eJson: unknown = await eRes.json();
          if (!isScheduleDto(eJson)) {
            alert("サーバ応答が不正です（有効化）");
            return;
          }
        } else {
          const dRes = await fetch(`/api/schedules/${current._id}/disable`, {
            method: "POST",
            credentials: "include",
          });
          if (!dRes.ok) {
            const msg: string = await readServerError(dRes, "スケジュールの無効化に失敗しました。通信環境をご確認のうえ、再度お試しください。");
            alert(msg);
            return;
          }
          const dJson: unknown = await dRes.json();
          if (!isScheduleDto(dJson)) {
            alert("サーバ応答が不正です（無効化）");
            return;
          }
        }
      }

      // 3. GPTS本体を保存（名前・ルール）
      const body: GptsUpdateRequest = { name, instpack: inst };
      const r = await fetch(`/api/gpts/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const msg: string = await readServerError(r, "チャットルールの保存に失敗しました。通信環境をご確認のうえ、再度お試しください。");
        alert(msg);
        return;
      }

      // 完了 → 一覧へ
      window.location.href = "/gpts/list";
    } catch {
      alert("保存処理中にエラーが発生しました。時間をおいて再度お試しください。");
    }
  }

  interface ScheduleCreateBody {
    gptsId: string;
    freq: ScheduleFreq;
    hour: number;
    minute: number;
    enabled: boolean;
    timezone: string;
  }

  // 「登録ずみ｜未登録」セグメントの切替
  async function onToggleSchedule(nextOn: boolean): Promise<void> {
    try {
      setSchedToggle(nextOn);
      if (nextOn) {
        // 登録ずみ（ON）: なければドラフト作成
        if (!sched) {
          const payload: ScheduleCreateBody = {
            gptsId: id,
            freq: "daily" as ScheduleFreq,
            hour: 9,
            minute: 0,
            enabled: false,
            timezone: process.env.NEXT_PUBLIC_SCHEDULE_TZ_DEFAULT ?? "Asia/Tokyo",
          };
          const res = await fetch(`/api/schedules`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            alert("スケジュールの作成に失敗しました");
            setSchedToggle(false);
            return;
          }
          const created: unknown = await res.json();
          if (!isScheduleDto(created)) {
            alert("スケジュール応答形式が不正です");
            setSchedToggle(false);
            return;
          }
          setSched(created as ScheduleDto);
          await refreshSchedules({ preserveToggle: true });
        } else {
          await refreshSchedules({ preserveToggle: true });
        }
      } else {
        // 未登録（OFF）: 編集UIは畳み、既存は disable（ドラフト保持）
        if (sched?._id) {
          const res = await fetch(`/api/schedules/${sched._id}/disable`, {
            method: "POST",
            credentials: "include",
          });
          if (!res.ok) {
            alert("スケジュールの無効化に失敗しました");
            setSchedToggle(true);
            return;
          }
          const j: unknown = await res.json();
          if (!isScheduleDto(j)) {
            alert("スケジュール応答形式が不正です");
            setSchedToggle(true);
            return;
          }
          setSched(j as ScheduleDto);
          await refreshSchedules({ preserveToggle: true });
        } else {
          await refreshSchedules({ preserveToggle: true });
        }
      }
    } catch {
      alert("スケジュール切替に失敗しました");
      setSchedToggle(Boolean(sched));
    }
  }

  // スケジュール部分更新（サーバ側で丸め＆nextRunAt再計算）
  async function patchSchedule(patch: SchedulePatch): Promise<void> {
    if (!sched?._id) return;
    try {
      const res = await fetch(`/api/schedules/${sched._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        alert("更新に失敗しました");
        return;
      }
      const j: unknown = await res.json();
      if (!isScheduleDto(j)) {
        alert("スケジュール応答形式が不正です");
        return;
      }
      setSched(j as ScheduleDto);
      await refreshSchedules({ preserveToggle: true });
    } catch {
      alert("スケジュール更新時にエラーが発生しました");
    }
  }

  // 実施中（有効化）
  async function enableSchedule(): Promise<void> {
    if (!sched?._id) return;
    try {
      const res = await fetch(`/api/schedules/${sched._id}/enable`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        alert("有効化に失敗しました");
        return;
      }
      const j: unknown = await res.json();
      if (!isScheduleDto(j)) {
        alert("スケジュール応答形式が不正です");
        return;
      }
      setSched(j as ScheduleDto);
      await refreshSchedules({ preserveToggle: true });
    } catch {
      alert("有効化でエラーが発生しました");
    }
  }

  // 停止中（無効化）※登録ずみは維持してUIは開いたまま
  async function disableScheduleOnly(): Promise<void> {
    if (!sched?._id) return;
    try {
      const res = await fetch(`/api/schedules/${sched._id}/disable`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        alert("無効化に失敗しました");
        return;
      }
      const j: unknown = await res.json();
      if (!isScheduleDto(j)) {
        alert("スケジュール応答形式が不正です");
        return;
      }
      setSched(j as ScheduleDto);
      await refreshSchedules({ preserveToggle: true });
    } catch {
      alert("無効化でエラーが発生しました");
    }
  }

  const counts = useMemo(() => ({
    name: name.length,
    inst: inst.length,
  }), [name, inst]);

  if (loading) return <main className="p-4">読み込み中…</main>;
  if (err) return <main className="p-4 text-red-600">{err}</main>;

  return (
    // ★ 変更: 直書きTailwindを CSS Modules( container ) に置換
    <main className={styles.container}> {/* ★ */}
      {/* === 名前 === */}
      <NameSection name={name} onChange={setName} count={counts.name} /> {/* ★ */}

      {/* === ルール === */}
      <RuleSection inst={inst} onChange={setInst} count={counts.inst} /> {/* ★ */}

      {/* === スケジュール === */}
      <ScheduleEditor
        sched={sched}
        schedToggle={schedToggle}
        onToggleSchedule={onToggleSchedule}
        patchSchedule={patchSchedule}
        enableSchedule={enableSchedule}
        disableScheduleOnly={disableScheduleOnly}
      /> {/* ★ */}

      {/* フッター操作 */}
      <FooterActions
        onBack={() => window.history.back()}
        onConfirm={() => setConfirming(true)}
      /> {/* ★ */}

      {/* 確認モーダル */}
      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onSave={() => void onSave()}
        name={name}
        inst={inst}
        schedToggle={schedToggle}
        sched={sched}
      /> {/* ★ */}
    </main>
  );
}
