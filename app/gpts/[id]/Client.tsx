"use client";
import { useEffect, useMemo, useState, useCallback } from "react";
import { type GptsDetailResponse, type GptsUpdateRequest, isGptsDetailResponse } from "@/utils/types";
import { ensureLiffSession } from "@/utils/ensureLiffSession";
import { WD, type ScheduleDto, type ScheduleFreq, type SchedulePatch } from "@/types/schedule";
import { isScheduleDto, isScheduleList } from "@/utils/scheduleGuards";
import SegmentedSwitch from "@/components/SegmentedSwitch";
import { canEnableSchedule, safeTimeHHMM, summarizeScheduleJa } from "@/utils/scheduleValidators";

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
    <main className="mx-auto max-w-screen-sm p-4 space-y-5">
      {/* === 名前 === */}
      <section className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold">名前</h2>
        <input
          className="mt-2 w-full rounded-xl border px-4 py-3 text-[15px] outline-none focus:ring-2 focus:ring-green-500"
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
          className="mt-2 w-full rounded-2xl border px-4 py-3 text-[15px] leading-relaxed outline-none focus:ring-2 focus:ring-green-500
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
          groupLabel="スケジュールの有無"
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
                value={safeTimeHHMM(sched)}
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
                  const chk = canEnableSchedule(sched); // 未設定なら有効化しない
                  if (!chk.ok) {
                    alert(chk.message);
                    return;
                  }
                  void enableSchedule();
                } else {
                  void disableScheduleOnly();
                }
              }}
              groupLabel="実行状態"
              options={[
                { value: true, label: "実施中" },
                { value: false, label: "停止中" },
              ]}
            />

            {/* 要約（未設定を明示） */}
            <p className="text-sm text-gray-600">
              {summarizeScheduleJa(sched)} ・ {sched.enabled ? "実施中" : "停止中"}
            </p>

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

      {/* 確認モーダル */}
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
                    {summarizeScheduleJa(sched)} ・ {sched.enabled ? "実施中" : "停止中"}
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
