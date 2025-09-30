import { type ScheduleFreq, type WeekdayKey, type ScheduleDto, isScheduleFreq } from "@/types/schedule";

// Freq 判定
export function isFreq(v: unknown): v is ScheduleFreq {
  return v === "daily" || v === "weekly" || v === "monthly";
}

// WeekdayKey 判定
export function isWeekdayKey(v: unknown): v is WeekdayKey {
  return v === "MO" || v === "TU" || v === "WE" || v === "TH" || v === "FR" || v === "SA" || v === "SU";
}

// ScheduleDto 判定
export function isScheduleDto(x: unknown): x is ScheduleDto {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o._id === "string" &&
    typeof o.gptsId === "string" &&
    (o.targetType === "user" || o.targetType === "group" || o.targetType === "room") &&
    typeof o.targetId === "string" &&
    typeof o.timezone === "string" &&
    isScheduleFreq(o.freq) &&
    typeof o.hour === "number" && Number.isFinite(o.hour) &&
    typeof o.minute === "number" && Number.isFinite(o.minute) &&
    typeof o.enabled === "boolean"
  );
}

// ScheduleDto 配列レスポンス判定
export function isScheduleList(x: unknown): x is { items: ScheduleDto[] } {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return Array.isArray(o.items) && o.items.every(isScheduleDto);
}
