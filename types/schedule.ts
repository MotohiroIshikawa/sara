import type { SourceType } from "@/types/gpts";

export type ScheduleFreq = "daily" | "weekly" | "monthly";
export const isScheduleFreq = (v: unknown): v is ScheduleFreq =>
  v === "daily" || v === "weekly" || v === "monthly";

// 曜日キー（RRULE 準拠の2文字）
export const WD = [
  { key: "MO", label: "月" },
  { key: "TU", label: "火" },
  { key: "WE", label: "水" },
  { key: "TH", label: "木" },
  { key: "FR", label: "金" },
  { key: "SA", label: "土" },
  { key: "SU", label: "日" },
] as const;
export type WeekdayKey = (typeof WD)[number]["key"]; // "MO" | ... | "SU"
export const isWeekdayKey = (v: unknown): v is WeekdayKey =>
  WD.some((d) => d.key === v);

export const WEEKDAY_LABEL: Readonly<Record<WeekdayKey, string>> = {
  // ラベル辞書
  MO: "月",
  TU: "火",
  WE: "水",
  TH: "木",
  FR: "金",
  SA: "土",
  SU: "日",
} as const;

// API 返却用 DTO（ObjectId/Date は文字列に正規化して扱う）
export interface ScheduleDto {
  _id: string;
  gptsId: string;
  targetType: SourceType;
  targetId: string;
  timezone: string;
  freq: ScheduleFreq;
  byWeekday?: ReadonlyArray<WeekdayKey>;
  byMonthday?: ReadonlyArray<number>;
  hour: number;
  minute: number;
  enabled: boolean;
  nextRunAt?: string | null; // ISO string
}

// PATCH 用（部分更新）
export type SchedulePatch = Partial<
  Pick<
    ScheduleDto,
    | "freq"
    | "byWeekday"
    | "byMonthday"
    | "hour"
    | "minute"
    | "enabled"
    | "timezone"
  >
>;
