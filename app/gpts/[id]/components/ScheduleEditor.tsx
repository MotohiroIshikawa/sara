import React, { type JSX } from "react";
import styles from "../Client.module.css";
import { WD, type ScheduleDto, type ScheduleFreq, type SchedulePatch } from "@/types/schedule";
import { canEnableSchedule, safeTimeHHMM, summarizeScheduleJa } from "@/utils/scheduleValidators";
import { formatNextRunJa } from "@/utils/schedulerTime";

export interface ScheduleEditorProps {
  sched: ScheduleDto | null;
  schedToggle: boolean;
  onToggleSchedule: (nextOn: boolean) => Promise<void>;
  patchSchedule: (patch: SchedulePatch) => Promise<void>;
  enableSchedule: () => Promise<void>;
  disableScheduleOnly: () => Promise<void>;
}

const ROUND_STEP_MIN: number = Math.max(
1,
  Math.min(30, Math.trunc(Number(process.env.NEXT_PUBLIC_SCHEDULE_ROUND_MIN ?? 5)))
);

export default function ScheduleEditor(props: ScheduleEditorProps): JSX.Element {
  const { sched, schedToggle, onToggleSchedule, patchSchedule, enableSchedule, disableScheduleOnly } = props;

  return (
    <section className={styles.card}>
      <h2 className={styles.title}>スケジュール</h2>

      {/* 登録ずみ｜未登録 */}
      <div className="mt-3">
        <div className={styles.freqGroup} role="radiogroup" aria-label="スケジュール">
          {([
            { val: true as boolean, label: "登録ずみ" },
            { val: false as boolean, label: "未登録" },
          ] as ReadonlyArray<{ val: boolean; label: string }>).map((o) => {
            const on: boolean = schedToggle === o.val;
            return (
              <button
                key={String(o.val)}
                type="button"
                role="radio"
                aria-checked={on}
                className={`${styles.pill} ${on ? styles.pillOn : styles.pillOff}`}
                onClick={() => void onToggleSchedule(o.val)}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 登録ずみ（ON）のときのみ編集UIを表示 */}
      {schedToggle && sched && (
        <div className="mt-4 space-y-4">
          {/* 頻度 */}
          <div>
            <div className={styles.fieldLabel}>頻度</div>
            <div className={styles.freqGroup}>
              {([
                { key: "daily" as ScheduleFreq, label: "毎日" },
                { key: "weekly" as ScheduleFreq, label: "毎週" },
                { key: "monthly" as ScheduleFreq, label: "毎月" },
              ] as ReadonlyArray<{ key: ScheduleFreq; label: string }>).map((o) => {
                const on: boolean = sched.freq === o.key;
                return (
                  <button
                    key={o.key}
                    className={`${styles.pill} ${on ? styles.pillOn : styles.pillOff}`}
                    onClick={() => void patchSchedule({ freq: o.key })}
                  >
                    {o.label}
                  </button>
                );
              })}
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
                      className={`${styles.pill} ${on ? styles.pillOn : styles.pillOff}`}
                      onClick={() => {
                        type Weekday = NonNullable<ScheduleDto["byWeekday"]>[number];
                        const cur: Set<Weekday> = new Set<Weekday>((sched.byWeekday ?? []) as Weekday[]);
                        if (cur.has(d.key as Weekday)) { cur.delete(d.key as Weekday); } else { cur.add(d.key as Weekday); }
                        void patchSchedule({ byWeekday: Array.from(cur) as Weekday[] });
                      }}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex gap-2 text-xs">
                <button
                  className="px-2 py-1 rounded border"
                  onClick={() => void patchSchedule({ byWeekday: ["MO", "TU", "WE", "TH", "FR"] as const })}
                >
                  平日
                </button>
                <button
                  className="px-2 py-1 rounded border"
                  onClick={() => void patchSchedule({ byWeekday: ["SA", "SU"] as const })}
                >
                  週末
                </button>
                <button
                  className="px-2 py-1 rounded border"
                  onClick={() => void patchSchedule({ byWeekday: [] as const })}
                >
                  クリア
                </button>
              </div>
            </div>
          )}

          {/* 月次: 日付 */}
          {sched.freq === "monthly" && (
            <div>
              <div className="text-sm font-medium">日付（存在しない月はスキップします）</div>
              <div className="mt-2">
                <input
                  type="number"
                  min={1}
                  max={31}
                  className={styles.numberInput}
                  value={sched.byMonthday?.[0] ?? 1}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    void patchSchedule({ byMonthday: [Number(e.target.value)] })
                  }
                />
              </div>
            </div>
          )}

          {/* 時刻 */}
          <div>
            <div className={styles.fieldLabel}>時刻（{ROUND_STEP_MIN}分ごとに丸められます）</div>
            <div className="mt-2">
              <input
                type="time"
                className={styles.timeInput}
                step={ROUND_STEP_MIN * 60}
                value={safeTimeHHMM(sched)}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  const [hStr, mStr] = e.target.value.split(":");
                  const h: number = Number(hStr);
                  const m: number = Number(mStr);
                  if (Number.isFinite(h) && Number.isFinite(m)) {
                    void patchSchedule({ hour: h, minute: m });
                  }
                }}
              />
            </div>
          </div>

          {/* 実施中｜停止中 */}
          <div className="mt-1">
            <div className={styles.freqGroup} role="radiogroup" aria-label="状態">
              {([
                { val: true as boolean, label: "実施中" },
                { val: false as boolean, label: "停止中" },
              ] as ReadonlyArray<{ val: boolean; label: string }>).map((o) => {
                const on: boolean = Boolean(sched.enabled) === o.val;
                return (
                  <button
                    key={String(o.val)}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`${styles.pill} ${on ? styles.pillOn : styles.pillOff}`}
                    onClick={() => {
                      if (o.val) {
                        const chk = canEnableSchedule(sched);
                        if (!chk.ok) {
                          alert(chk.message);
                          return;
                        }
                        void enableSchedule();
                      } else {
                        void disableScheduleOnly();
                      }
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 要約（未設定を明示） */}
          <p className={styles.helpText}>
            {summarizeScheduleJa(sched)} ・ {sched.enabled ? "実施中" : "停止中"}
          </p>

          {/* 次回実施時間（変更のたびにサーバ再計算→sched.nextRunAt を表示） */}
          <div className="text-sm">
            <div className="font-medium">次回実施時間</div>
            <div className="mt-1">
              {formatNextRunJa(sched.nextRunAt ?? null, sched.timezone)}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
