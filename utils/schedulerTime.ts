import type { GptsScheduleDoc } from "@/types/db";
import { 
  isWeekdayKey, 
  type ScheduleDto, 
  type ScheduleFreq, 
  type SchedulePatch 
} from "@/types/schedule";

export type WeekdayKey = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface NextRunOpts {
  timezone: string;          // 例: "Asia/Tokyo"
  rrule?: string | null;     // いまは未使用（将来拡張）
  freq?: "daily" | "weekly" | "monthly"; // 無い場合は daily 相当で計算
  byWeekday?: WeekdayKey[] | null;
  byMonthday?: number[] | null;
  hour?: number;              // 0-23
  minute?: number;            // 0-59
  second?: number;           // 0-59
  from?: Date;               // 既定: new Date()
}

/**
 * シンプルな nextRunAt 計算
 * - Timezone は Asia/Tokyo を前提（DSTなし）。他TZは近似。
 * - freq が:
 *   - daily: 今日の実施時刻が未来なら今日、過ぎていれば翌日
 *   - weekly: byWeekday の次の該当曜日
 *   - monthly: byMonthday の「次に来る日」。存在しない月はスキップ。
 */
export function computeNextRunAt(opts: NextRunOpts): Date | null {
  const tz = opts.timezone || "Asia/Tokyo";
  const now = opts.from ? new Date(opts.from) : new Date();
  const second = opts.second ?? 0;
  const hour = opts.hour ?? 9;
  const minute = opts.minute ?? 0;
  const freq = opts.freq ?? inferFreqFromFields(opts);

  // とりあえず固定 +09:00（Tokyo）。他TZは best-effort（将来拡張）
  const tzOffsetMinutes = tz === "Asia/Tokyo" ? 9 * 60 : -now.getTimezoneOffset();

  // ヘルパ：ローカル(=TZ)日付でDate作成 → UTCに直す
  const makeAt = (y: number, m1: number, d: number, h: number, mi: number, s: number): Date => {
    // m1: 1-12
    const utcMs = Date.UTC(y, m1 - 1, d, h, mi, s);
    // tzローカルの時刻をUTCにするには offset を引く（UTC = local - offset）
    return new Date(utcMs - tzOffsetMinutes * 60 * 1000);
  };

  // now を tz ローカルのカレンダー値に
  const toTzParts = (d: Date) => {
    const utcMs = d.getTime();
    const localMs = utcMs + tzOffsetMinutes * 60 * 1000; // local = UTC + offset
    const ld = new Date(localMs);
    return {
      y: ld.getUTCFullYear(),
      m: ld.getUTCMonth() + 1,
      dd: ld.getUTCDate(),
      hh: ld.getUTCHours(),
      mm: ld.getUTCMinutes(),
      ss: ld.getUTCSeconds(),
      wd: ((ld.getUTCDay() + 6) % 7) as 0|1|2|3|4|5|6, // 0=Mon ... 6=Sun
    };
  };

  const parts = toTzParts(now);

  if (freq === "daily") {
    // 今日のその時刻 or 明日
    const todayAt = makeAt(parts.y, parts.m, parts.dd, hour, minute, second);
    if (todayAt.getTime() > now.getTime()) return todayAt;
    const tmr = addDays(parts, 1);
    return makeAt(tmr.y, tmr.m, tmr.dd, hour, minute, second);
  }

  if (freq === "weekly") {
    const targetSet = new Set((opts.byWeekday ?? []).map(wkToIndex));
    if (targetSet.size === 0) return null;

    for (let add = 0; add < 14; add++) {
      const p = addDays(parts, add);
      if (targetSet.has(p.wd)) {
        const at = makeAt(p.y, p.m, p.dd, hour, minute, second);
        if (at.getTime() > now.getTime()) return at;
      }
    }
    return null;
  }

  if (freq === "monthly") {
    const days = (opts.byMonthday ?? []).filter((n) => n >= 1 && n <= 31).sort((a, b) => a - b);
    if (days.length === 0) return null;

    // 今月→来月→…で「存在する日」を順に探す（存在しない月はスキップ）
    for (let addM = 0; addM < 18; addM++) {
      const ym = addMonths({ y: parts.y, m: parts.m, dd: 1 }, addM);
      const lastDay = lastDateOfMonth(ym.y, ym.m);
      for (const d of days) {
        if (d > lastDay) continue; // スキップ方針
        const at = makeAt(ym.y, ym.m, d, hour, minute, second);
        if (at.getTime() > now.getTime()) return at;
      }
    }
    return null;
  }

  // デフォルトは daily
  const todayAt = makeAt(parts.y, parts.m, parts.dd, hour, minute, second);
  if (todayAt.getTime() > now.getTime()) return todayAt;
  const tmr = addDays(parts, 1);
  return makeAt(tmr.y, tmr.m, tmr.dd, hour, minute, second);
}

function inferFreqFromFields(o: Pick<NextRunOpts, "byWeekday" | "byMonthday">): "daily" | "weekly" | "monthly" {
  if (o.byMonthday && o.byMonthday.length > 0) return "monthly";
  if (o.byWeekday && o.byWeekday.length > 0) return "weekly";
  return "daily";
}

// 月曜=0 ... 日曜=6
function wkToIndex(w: WeekdayKey): 0|1|2|3|4|5|6 {
  switch (w) {
    case "MO": return 0;
    case "TU": return 1;
    case "WE": return 2;
    case "TH": return 3;
    case "FR": return 4;
    case "SA": return 5;
    case "SU": return 6;
  }
}

function addDays(p: { y: number; m: number; dd: number }, delta: number) {
  const d = new Date(Date.UTC(p.y, p.m - 1, p.dd + delta));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, dd: d.getUTCDate(), wd: ((d.getUTCDay() + 6) % 7) as 0|1|2|3|4|5|6 };
}

function addMonths(p: { y: number; m: number; dd: number }, delta: number) {
  const d = new Date(Date.UTC(p.y, p.m - 1 + delta, p.dd));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, dd: d.getUTCDate() };
}

function lastDateOfMonth(y: number, m1: number): number {
  // 次月の0日目 = 当月末日
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}

// 分丸め（SCHEDULE_ROUND_MIN）
export function roundMinutes(
  min: number, 
  step = Number(process.env.SCHEDULE_ROUND_MIN ?? 5)
): number {
  const r = Math.round(min / step) * step;
  return Math.max(0, Math.min(59, r));
}

// string[] を WeekdayKey[] に安全に絞る
function sanitizeWeekdays(src: unknown): ReadonlyArray<WeekdayKey> | undefined {
  if (!Array.isArray(src)) return undefined;
  return src.filter((d): d is WeekdayKey => isWeekdayKey(d)) as ReadonlyArray<WeekdayKey>;
}

// クライアント/サーバ共通で使える PATCH 正規化ユーティリティ
export function sanitizeSchedulePatch(patch: SchedulePatch, prev: ScheduleDto | null): SchedulePatch {
  const next: SchedulePatch = { ...patch };

  // ユニーク化（順序保持）
  const uniq = <T,>(arr: ReadonlyArray<T>): T[] => Array.from(new Set(arr));

  // 値域正規化（先に行う）
  if (Array.isArray(next.byWeekday)) {
    const filtered: ReadonlyArray<WeekdayKey> = uniq(next.byWeekday).filter(isWeekdayKey) as ReadonlyArray<WeekdayKey>;
    next.byWeekday = filtered;
  }
  if (Array.isArray(next.byMonthday)) {
    const filteredNums: ReadonlyArray<number> = uniq(next.byMonthday)
      .map((n: number) => Math.trunc(Number(n)))
      .filter((n: number) => Number.isFinite(n) && n >= 1 && n <= 31);
    next.byMonthday = filteredNums;
  }

  // freq 依存の相互排他・既定補完
  if (typeof next.freq === "string") {
    const to: ScheduleFreq = next.freq;

    if (to === "daily") {
      // daily：どちらも未使用
      next.byWeekday = [];
      next.byMonthday = [];
    } else if (to === "weekly") {
      // weekly：weekday必須（未指定なら既定["MO"]）。monthdayは未使用に強制
      const base: ReadonlyArray<WeekdayKey> =
        (next.byWeekday as ReadonlyArray<WeekdayKey> | undefined)
        ?? (prev?.byWeekday as ReadonlyArray<WeekdayKey> | undefined)
        ?? [];

      const filtered: ReadonlyArray<WeekdayKey> = base.filter(isWeekdayKey);
      next.byWeekday = filtered.length > 0 ? [...filtered] : (["MO"] as ReadonlyArray<WeekdayKey>);
      next.byMonthday = [];
    } else if (to === "monthly") {
      // monthly：monthday必須（未指定なら既定[1]）。weekdayは未使用に強制
      const baseNums: ReadonlyArray<number> =
        (next.byMonthday as ReadonlyArray<number> | undefined)
        ?? (prev?.byMonthday as ReadonlyArray<number> | undefined)
        ?? [];

      const filteredNums: ReadonlyArray<number> = baseNums
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31);

      next.byMonthday = filteredNums.length > 0 ? [...filteredNums] : ([1] as ReadonlyArray<number>);
      next.byWeekday = [];
    }
  }

  return next;
}

// GptsScheduleDoc → ScheduleDto（ObjectId/Date の正規化＆weekdayの型安全化）
export function toScheduleDto(doc: GptsScheduleDoc): ScheduleDto {
  const byWeekday = sanitizeWeekdays(doc.byWeekday);

  return {
    _id: String(doc._id),
    gptsId: doc.gptsId,
    targetType: doc.targetType,
    targetId: doc.targetId,
    timezone: doc.timezone ?? "Asia/Tokyo",
    // freq 型は ScheduleDto 側に合わせる（ScheduleFreq/Freq どちらでもOK）
    freq: (doc.freq ?? "daily") as ScheduleDto["freq"],
    byWeekday,
    byMonthday: Array.isArray(doc.byMonthday)
      ? (doc.byMonthday as ReadonlyArray<number>)
      : undefined,
    hour: typeof doc.hour === "number" ? doc.hour : 9,
    minute: typeof doc.minute === "number" ? doc.minute : 0,
    enabled: Boolean(doc.enabled),
    nextRunAt: doc.nextRunAt ? new Date(doc.nextRunAt).toISOString() : null,
  };
}
