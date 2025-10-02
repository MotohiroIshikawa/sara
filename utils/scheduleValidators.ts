import type { ScheduleDto, ScheduleFreq, WeekdayKey } from "@/types/schedule";
import { isWeekdayKey } from "@/types/schedule";

// 日本語の曜日ラベル（UI要約用）
export const WDAY_LABEL_JA: Record<WeekdayKey, string> = {
  MO: "月",
  TU: "火",
  WE: "水",
  TH: "木",
  FR: "金",
  SA: "土",
  SU: "日",
};

// /enable 直前の必須チェック結果
export type EnableValidation =
  | { ok: true }
  | {
      ok: false;
      code: "time_required" | "weekday_required" | "monthday_required";
      message: string;
    };

/** 時刻の妥当性（0–23 / 0–59） */
export function isValidTime(hour: unknown, minute: unknown): boolean {
  const hNum: boolean = typeof hour === "number" && Number.isFinite(hour);
  const mNum: boolean = typeof minute === "number" && Number.isFinite(minute);
  if (!hNum || !mNum) return false;
  const h: number = hour as number;
  const m: number = minute as number;
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/** 週次の妥当性（曜日が1つ以上 & 値が正しい） */
export function isValidWeekly(byWeekday: unknown): boolean {
  if (!Array.isArray(byWeekday)) return false;
  if (byWeekday.length < 1) return false;
  return (byWeekday as unknown[]).every((k: unknown): boolean => isWeekdayKey(k));
}

/** 月次の妥当性（1–31 の数値が最低1つ） */
export function isValidMonthly(byMonthday: unknown): boolean {
  if (!Array.isArray(byMonthday)) return false;
  if (byMonthday.length < 1) return false;
  return (byMonthday as unknown[]).every((n: unknown): boolean => {
    const ok: boolean = typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 31;
    return ok;
  });
}

/** /enable 実行前の必須チェック（UI用） */
export function canEnableSchedule(s: Readonly<ScheduleDto>): EnableValidation {
  const timeOk: boolean = isValidTime((s as { hour?: unknown }).hour, (s as { minute?: unknown }).minute);
  if (!timeOk) {
    return { ok: false, code: "time_required", message: "時刻が未設定です（HH:MM）。" };
  }

  const freq: ScheduleFreq = s.freq as ScheduleFreq;
  if (freq === "weekly") {
    if (!isValidWeekly((s as { byWeekday?: unknown }).byWeekday)) {
      return { ok: false, code: "weekday_required", message: "曜日が未設定です（毎週の実施には曜日が必要）。" };
    }
  }
  if (freq === "monthly") {
    if (!isValidMonthly((s as { byMonthday?: unknown }).byMonthday)) {
      return { ok: false, code: "monthday_required", message: "日付が未設定です（毎月の実施には日付が必要）。" };
    }
  }
  return { ok: true };
}

/** 時刻の安全フォールバック（未設定なら既定 09:00 を返す） */
export function safeTimeFromSchedule(
  s: Readonly<ScheduleDto>,
  defaults: { hour: number; minute: number } = { hour: 9, minute: 0 }
): { hour: number; minute: number } {
  const rawH: unknown = (s as { hour?: unknown }).hour;
  const rawM: unknown = (s as { minute?: unknown }).minute;
  if (isValidTime(rawH, rawM)) {
    return { hour: rawH as number, minute: rawM as number };
  }
  return { hour: defaults.hour, minute: defaults.minute };
}

/** "HH:MM" 文字列を生成（未設定は defaults でフォールバック） */
export function safeTimeHHMM(
  s: Readonly<ScheduleDto>,
  defaults: { hour: number; minute: number } = { hour: 9, minute: 0 }
): string {
  const t = safeTimeFromSchedule(s, defaults);
  const hh: string = String(t.hour).padStart(2, "0");
  const mm: string = String(t.minute).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** UI向け要約（未設定を明示: "時刻未設定" / "曜日未設定" / "日付未設定"） */
export function summarizeScheduleJa(s: Readonly<ScheduleDto>): string {
  const timeOk: boolean = isValidTime((s as { hour?: unknown }).hour, (s as { minute?: unknown }).minute);
  const timeLabel: string = timeOk ? safeTimeHHMM(s) : "時刻未設定";

  if (s.freq === "daily") {
    return `毎日 ${timeLabel}`;
  }

  if (s.freq === "weekly") {
    const weeklyOk: boolean = isValidWeekly((s as { byWeekday?: unknown }).byWeekday);
    const wdLabel: string = weeklyOk
      ? ((s.byWeekday as ReadonlyArray<WeekdayKey>).map((k: WeekdayKey) => WDAY_LABEL_JA[k]).join("・"))
      : "曜日未設定";
    return `毎週 ${wdLabel} ${timeLabel}`;
  }

  if (s.freq === "monthly") {
    const monthlyOk: boolean = isValidMonthly((s as { byMonthday?: unknown }).byMonthday);
    const dayLabel: string = monthlyOk ? `${(s.byMonthday as ReadonlyArray<number>)[0]}日` : "日付未設定";
    return `毎月 ${dayLabel} ${timeLabel}`;
  }

  // 想定外freqは時刻のみ
  return timeLabel;
}
