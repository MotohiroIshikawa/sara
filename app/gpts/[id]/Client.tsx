"use client";
import { useEffect, useMemo, useState, useCallback } from "react";
import {
  type GptsDetailResponse,
  type GptsUpdateRequest,
  isGptsDetailResponse
} from "@/utils/types";
import { ensureLiffSession } from "@/utils/ensureLiffSession";
import { WD, type ScheduleDto, type ScheduleFreq, type SchedulePatch } from "@/types/schedule";
import { isScheduleDto, isScheduleList } from "@/utils/scheduleGuards";
import SegmentedSwitch from "@/components/SegmentedSwitch";

export default function Client({ id }: { id: string }) {
  const [name, setName] = useState<string>("");
  const [inst, setInst] = useState<string>("");
  const [sched, setSched] = useState<ScheduleDto | null>(null);
  const [schedToggle, setSchedToggle] = useState<boolean>(false); // 「登録ずみ｜未登録」の左（登録ずみ）= true
  const [loading, setLoading] = useState<boolean>(true);
  const [confirming, setConfirming] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  // 曜日の日本語短縮
  const wdayLabel: Record<NonNullable<ScheduleDto["byWeekday"]>[number], string> = {
    MO: "月", TU: "火", WE: "水", TH: "木", FR: "金", SA: "土", SU: "日",
  };

  // スケジュール要約
  function summarizeSchedule(s: ScheduleDto): string {
    const hh: string = String(s.hour).padStart(2, "0");
    const mm: string = String(s.minute).padStart(2, "0");
    if (s.freq === "daily") return `毎日 ${hh}:${mm}`;
    if (s.freq === "weekly") {
      const wd: string = (s.byWeekday ?? []).map((k) => wdayLabel[k]).join("・") || "—";
      return `毎週 ${wd} ${hh}:${mm}`;
    }
    if (s.freq === "monthly") {
      const day: number = s.byMonthday?.[0] ?? 1;
      return `毎月 ${day}日 ${hh}:${mm}`;
    }
    return `${hh}:${mm}`;
  }

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

  async function onSave(): Promise<void> {
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
    <main className="mx-auto max-w-screen-sm p-4 space-y-5">
      {/* === 名前 === */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold">名前</h2>
        <input
          className="mt-2 w-full rounded-xl border px-4 py-3 text-[15px] outline-none focus:ring-2 focus:ring-emerald-600"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ルールの名前を入力..."
        />
        <div className="mt-1 text-right text-[11px] text-gray-500">{counts.name} 文字</div>
      </section>

      {/* === ルール === */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold">ルール</h2>
        <textarea
          className="mt-2 w-full rounded-2xl border px-4 py-3 text-[15px] leading-relaxed outline-none focus:ring-2 focus:ring-emerald-600
                     min-h-[55vh] md:min-h-[60vh] resize-y"
          value={inst}
          onChange={(e) => setInst(e.target.value)}
          placeholder="チャットルールを入力..."
        />
        <div className="mt-1 text-right text-[11px] text-gray-500">{counts.inst} 文字</div>
      </section>

      {/* === スケジュール === */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold">スケジュール</h2>

        {/* セグメント①：登録ずみ｜未登録 */}
        <SegmentedSwitch
          className="mt-3"
          value={schedToggle}
          onChange={(v) => void onToggleSchedule(v)}
          options={[
            { value: true, label: "登録ずみ" },
            { value: false, label: "未登録" },
          ]}
        />

        {/* 登録ずみ（ON）のときのみ編集UIを表示 */}
        {schedToggle && sched && (
          <div className="mt-4 space-y-4">

            {/* 頻度 */}
            <div>
              <div className="mt-2 flex gap-2">
                {([
                  { key: "daily" as ScheduleFreq, label: "毎日" },
                  { key: "weekly" as ScheduleFreq, label: "毎週" },
                  { key: "monthly" as ScheduleFreq, label: "毎月" },
                ] as ReadonlyArray<{ key: ScheduleFreq; label: string }>).map((o) => (
                  <button
                    key={o.key}
                    className={`px-3 py-1 rounded-full border ${sched.freq === o.key ? "bg-emerald-700 text-white border-emerald-700" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
                    onClick={() => void patchSchedule({ freq: o.key })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 週次: 曜日 */}
            {sched.freq === "weekly" && (
              <div>
                <div className="text-sm font-medium">曜日</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {WD.map((d) => {
                    const on: boolean = (sched.byWeekday ?? []).includes(d.key);
                    return (
                      <button
                        key={d.key}
                        className={`px-3 py-1 rounded-full border ${on ? "bg-emerald-700 text-white border-emerald-700" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}
                        onClick={() => {
                          const cur = new Set(sched.byWeekday ?? []);
                          if (cur.has(d.key)) { cur.delete(d.key); } else { cur.add(d.key); }
                          void patchSchedule({ byWeekday: Array.from(cur) });
                        }}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex gap-2 text-xs">
                  <button className="px-2 py-1 rounded border" onClick={() => void patchSchedule({ byWeekday: ["MO","TU","WE","TH","FR"] })}>平日</button>
                  <button className="px-2 py-1 rounded border" onClick={() => void patchSchedule({ byWeekday: ["SA","SU"] })}>週末</button>
                  <button className="px-2 py-1 rounded border" onClick={() => void patchSchedule({ byWeekday: [] })}>クリア</button>
                </div>
              </div>
            )}

            {/* 月次: 日付 */}
            {sched.freq === "monthly" && (
              <div>
                <div className="text-sm font-medium">日付（存在しない月はスキップ）</div>
                <input
                  type="number"
                  min={1}
                  max={31}
                  className="mt-2 w-24 px-3 py-2 border rounded-lg"
                  value={sched.byMonthday?.[0] ?? 1}
                  onChange={(e) => void patchSchedule({ byMonthday: [Number(e.target.value)] })}
                />
              </div>
            )}

            {/* 時刻（1行表示） */}
            <div className="flex items-center gap-3">
              <div className="text-sm font-medium">時刻</div>
              <input
                type="time"
                className="px-3 py-2 border rounded-lg"
                step={5 * 60}
                value={`${String(sched.hour).padStart(2,"0")}:${String(sched.minute).padStart(2,"0")}`}
                onChange={(e) => {
                  const [hStr, mStr] = e.target.value.split(":");
                  const h: number = Number(hStr);
                  const m: number = Number(mStr);
                  if (Number.isFinite(h) && Number.isFinite(m)) {
                    void patchSchedule({ hour: h, minute: m });
                  }
                }}
              />
            </div>

            {/* セグメント②：実施中｜停止中 */}
            <SegmentedSwitch
              className="mt-1"
              value={Boolean(sched.enabled)}
              onChange={(v: boolean) => {
                if (v) {
                  void enableSchedule();
                } else {
                  void disableScheduleOnly();
                }
              }}
              options={[
                { value: true, label: "実施中" },
                { value: false, label: "停止中" },
              ]}
            />
          </div>
        )}
      </section>

      {/* フッター操作 */}
      <div className="sticky bottom-2 z-10 mt-2 flex gap-2">
        <button
          className="flex-1 rounded-full bg-gray-200 px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-gray-400"
          onClick={() => window.history.back()}
        >
          戻る
        </button>
        <button
          className="flex-1 rounded-full bg-emerald-700 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-600"
          onClick={() => setConfirming(true)}
        >
          確認
        </button>
      </div>

      {/* 確認モーダル相当（既存ロジック） */}
      {confirming && (
        <div className="fixed inset-0 z-50 bg-white overflow-auto"> 
          <section className="mx-auto max-w-screen-sm p-4 space-y-4">
            <div className="text-base font-semibold pt-2">保存内容の確認</div>

            <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="text-sm font-medium">名前</div>
              <div className="mt-1 break-words">{name || "(無題)"}</div>

              <div className="mt-4 text-sm font-medium">ルール</div>
              <pre
                className="mt-1 max-h-[60vh] overflow-auto rounded-md bg-gray-50 p-3 text-[14px] leading-relaxed
                           whitespace-pre-wrap break-words overflow-x-hidden"
              >
                {inst}
              </pre>

              <div className="mt-4 text-sm font-medium">スケジュール</div>
              {schedToggle && sched ? (
                <div className="mt-1 text-sm">
                  <div>
                    {summarizeSchedule(sched)} ・ {sched.enabled ? "実施中" : "停止中"}
                  </div>
                  {sched.enabled && (
                    <div className="mt-1 text-xs text-gray-600">
                      次回実施日時: {sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : "-"} {/* ★ ラベル変更 */}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mt-1 text-sm text-gray-600">未登録</div>
              )}
            </div>

            <div className="sticky bottom-2 z-10 mt-2 flex gap-2">
              <button
                className="flex-1 rounded-full bg-gray-200 px-4 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-gray-400"
                onClick={() => setConfirming(false)}
              >
                修正する
              </button>
              <button
                className="flex-1 rounded-full bg-emerald-700 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-600" // ★ 濃い緑
                onClick={() => void onSave()}
              >
                保存
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
