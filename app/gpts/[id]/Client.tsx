"use client";
import { useEffect, useMemo, useState } from "react";
import {
  type GptsDetailResponse,
  type GptsUpdateRequest,
  isGptsDetailResponse
} from "@/utils/types";
import { ensureLiffSession } from "@/utils/ensureLiffSession";
import { WD, type ScheduleDto, type ScheduleFreq, type SchedulePatch } from "@/types/schedule";
import { isScheduleDto, isScheduleList } from "@/utils/scheduleGuards";

export default function Client({ id }: { id: string }) {
  const [name, setName] = useState("");
  const [inst, setInst] = useState("");
  const [sched, setSched] = useState<ScheduleDto | null>(null);
  const [schedToggle, setSchedToggle] = useState<boolean>(false);
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

        const sres = await fetch(`/api/schedules?gptsId=${encodeURIComponent(id)}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (sres.ok) {
          const sj: unknown = await sres.json();
          if (isScheduleList(sj)) {
            const first = sj.items[0] ?? null;
            setSched(first);
            setSchedToggle(Boolean(first));
          } else {
            setSched(null);
            setSchedToggle(false);
          }
        } else {
          setSched(null);
          setSchedToggle(false);
        }
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

  interface ScheduleCreateBody {
    gptsId: string;
    freq: ScheduleFreq;
    hour: number;
    minute: number;
    enabled: boolean;
    timezone: string;
  }

  // ★ スケジュールのトグル切替（ONで未存在なら作成、OFFでdisable）
  async function onToggleSchedule(nextOn: boolean): Promise<void> {
    try {
      setSchedToggle(nextOn);
      if (nextOn) {
        if (!sched) {
          const payload: ScheduleCreateBody = {
            gptsId: id,
            freq: "daily" as ScheduleFreq,
            hour: 9,
            minute: 0,
            enabled: false, // 初期は無効（有効化は別操作）
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
          setSched(created);
        }
      } else {
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
          setSched(j);
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
      setSched(j);
    } catch {
      alert("スケジュール更新時にエラーが発生しました");
    }
  }

  // スケジュール有効化（nextRunAt再計算）
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
      setSched(j);
    } catch {
      alert("有効化でエラーが発生しました");
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

          {/* スケジュール UI */}
          <section className="mt-6 rounded-2xl border border-gray-200 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium">スケジュール</h2>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4"
                  checked={schedToggle}
                  onChange={(e) => void onToggleSchedule(e.target.checked)}
                />
                <span>{schedToggle ? "編集する" : "使わない"}</span>
              </label>
            </div>

            {schedToggle && (
              <div className="mt-3 space-y-4">
                {!sched ? (
                  <div className="text-sm text-gray-500">初期ドラフトを作成しています…</div>
                ) : (
                  <>
                    {/* 頻度 */}
                    <div>
                      <div className="text-sm font-medium mb-2"></div>
                      <div className="flex gap-2">
                        {([
                          { key: "daily" as ScheduleFreq, label: "毎日" },
                          { key: "weekly" as ScheduleFreq, label: "毎週" },
                          { key: "monthly" as ScheduleFreq, label: "毎月" },
                        ] as ReadonlyArray<{ key: ScheduleFreq; label: string }>).map((o) => (
                          <button
                            key={o.key}
                            className={`px-3 py-1 rounded-full border ${sched.freq === o.key ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-700"}`}
                            onClick={() => void patchSchedule({ freq: o.key })}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 週次の場合: 曜日 */}
                    {sched.freq === "weekly" && (
                      <div>
                        <div className="text-sm font-medium mb-2">曜日</div>
                        <div className="flex flex-wrap gap-2">
                          {WD.map((d) => {
                            const on = (sched.byWeekday ?? []).includes(d.key);
                            return (
                              <button
                                key={d.key}
                                className={`px-3 py-1 rounded-full border ${on ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-700"}`}
                                onClick={() => {
                                  const cur = new Set(sched.byWeekday ?? []);
                                  if (cur.has(d.key)) cur.delete(d.key); else cur.add(d.key);
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

                    {/* 月次の場合: 日付 */}
                    {sched.freq === "monthly" && (
                      <div>
                        <div className="text-sm font-medium mb-2">日付（存在しない月はスキップ）</div>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          className="w-24 px-3 py-2 border rounded-lg"
                          value={sched.byMonthday?.[0] ?? 1}
                          onChange={(e) => void patchSchedule({ byMonthday: [Number(e.target.value)] })}
                        />
                      </div>
                    )}

                    {/* 時刻 */}
                    <div>
                      <div className="text-sm font-medium mb-2">時刻</div>
                      <input
                        type="time"
                        className="px-3 py-2 border rounded-lg"
                        step={5 * 60}
                        value={`${String(sched.hour).padStart(2,"0")}:${String(sched.minute).padStart(2,"0")}`}
                        onChange={(e) => {
                          const [hStr, mStr] = e.target.value.split(":");
                          const h = Number(hStr);
                          const m = Number(mStr);
                          if (Number.isFinite(h) && Number.isFinite(m)) {
                            void patchSchedule({ hour: h, minute: m });
                          }
                        }}
                      />
                      <p className="text-xs text-gray-500 mt-1">分は 5 分単位に丸められます</p>
                    </div>

                    {/* 有効/無効 次回実施日時 */}
                    <div className="flex items-center justify-between">
                      <div className="text-xs text-gray-600">
                        nextRunAt: {sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : "-"}
                      </div>
                      {sched.enabled ? (
                        <button
                          className="px-3 py-1 rounded-lg bg-gray-600 text-white"
                          onClick={() => void onToggleSchedule(false)}
                        >
                          無効にする
                        </button>
                      ) : (
                        <button
                          className="px-3 py-1 rounded-lg bg-green-600 text-white"
                          onClick={() => void enableSchedule()}
                        >
                          有効にする
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

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
                         whitespace-pre-wrap break-words overflow-x-hidden"
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
