import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { requireLineUser, HttpError } from "@/utils/lineAuth";
import { getGptsSchedulesCollection } from "@/utils/mongo";
import { updateScheduleById } from "@/services/gptsSchedules.mongo";
import type { GptsScheduleDoc } from "@/types/db";
import {
  isWeekdayKey,
  type WeekdayKey,
  type ScheduleFreq,
} from "@/types/schedule";
import { computeNextRunAt, roundMinutes, toScheduleDto } from "@/utils/schedule/schedulerTime";

// PATCH /api/schedules/[id] サーバ側で分丸め＆次回実行時刻を再計算（enabled=false の場合は null）
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    const { id } = await params;

    const _id = new ObjectId(id);
    const col = await getGptsSchedulesCollection();

    // 現在ドキュメント取得（ソフト削除は対象外）
    const cur = await col.findOne({ _id, deletedAt: null });
    if (!cur) {
      console.warn(`[schedules.patch:${rid}] not_found`, { userId, id });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (cur.userId !== userId) { // オーナー以外は更新不可
      console.warn(`[schedules.patch:${rid}] forbidden`, { userId, owner: cur.userId, id });
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const bodyUnknown: unknown = await request.json();
  
    // freq：文字列が来ていれば採用、無ければ現在値を引き継ぐ
    const freq: ScheduleFreq =
      typeof (bodyUnknown as { freq?: unknown }).freq === "string"
        ? ((bodyUnknown as { freq: string }).freq as ScheduleFreq)
        : (cur.freq as ScheduleFreq);

    // byWeekday：配列が来ていれば WeekdayKey のみ通す。無ければ現行値を WeekdayKey に絞って利用
    const byWeekdayInput: unknown = (bodyUnknown as { byWeekday?: unknown }).byWeekday;
    const byWeekdayRaw: ReadonlyArray<WeekdayKey> | undefined =
      Array.isArray(byWeekdayInput)
        ? (byWeekdayInput.filter((d): d is WeekdayKey => isWeekdayKey(d)) as ReadonlyArray<WeekdayKey>)
        : (Array.isArray(cur.byWeekday)
            ? (cur.byWeekday.filter((d: unknown): d is WeekdayKey => isWeekdayKey(d)) as ReadonlyArray<WeekdayKey>)
            : undefined);

    // byMonthday：配列が来ていれば 1..31 の整数に丸めてフィルタ。無ければ現行値を利用
    const byMonthdayInput: unknown = (bodyUnknown as { byMonthday?: unknown }).byMonthday;
    const byMonthdayRaw: ReadonlyArray<number> | undefined =
      Array.isArray(byMonthdayInput)
        ? byMonthdayInput
            .map((n) => (typeof n === "number" ? Math.trunc(n) : NaN))
            .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
        : (Array.isArray(cur.byMonthday) ? cur.byMonthday : undefined);

    // hour：数値が来ていれば採用、無ければ現行値→さらに fallback で 9
    const hour: number =
      typeof (bodyUnknown as { hour?: unknown }).hour === "number"
        ? (bodyUnknown as { hour: number }).hour
        : (typeof cur.hour === "number" ? cur.hour : 9);

    // minute：同上。受領後に roundMinutes() で5分刻み（など）に最終丸め
    const minuteRaw: number =
      typeof (bodyUnknown as { minute?: unknown }).minute === "number"
        ? (bodyUnknown as { minute: number }).minute
        : (typeof cur.minute === "number" ? cur.minute : 0);

    const minute = roundMinutes(minuteRaw); // サーバ最終丸め

    // enabled：booleanが来ていれば採用、無ければ現行値
    const enabled: boolean =
      typeof (bodyUnknown as { enabled?: unknown }).enabled === "boolean"
        ? (bodyUnknown as { enabled: boolean }).enabled
        : Boolean(cur.enabled);

    // timezone：文字列が来ていれば採用、無ければ現行値→fallback "Asia/Tokyo"
    const timezone: string =
      typeof (bodyUnknown as { timezone?: unknown }).timezone === "string"
        ? (bodyUnknown as { timezone: string }).timezone
        : (cur.timezone ?? "Asia/Tokyo");
    
    // freqに応じた相互排他＆デフォルト補完
    let byWeekday: ReadonlyArray<WeekdayKey> | undefined = byWeekdayRaw;
    let byMonthday: ReadonlyArray<number> | undefined = byMonthdayRaw;

    if (freq === "daily") {
      byWeekday  = [];
      byMonthday = [];
    } else if (freq === "weekly") {
      const base: ReadonlyArray<WeekdayKey> = Array.isArray(byWeekdayRaw) ? byWeekdayRaw : [];
      byWeekday  = base.length > 0 ? base : (["MO"] as ReadonlyArray<WeekdayKey>);
      byMonthday = [];
    } else if (freq === "monthly") {
      const base: ReadonlyArray<number> = Array.isArray(byMonthdayRaw) ? byMonthdayRaw : [];
      byMonthday = base.length > 0 ? base : ([1] as ReadonlyArray<number>);
      byWeekday  = [];
    }       

    // バリデーション
    if (freq === "weekly" && (!byWeekday || byWeekday.length < 1)) {
      return NextResponse.json({ error: "weekday_required" }, { status: 400 });
    }
    if (freq === "monthly" && (!byMonthday || byMonthday.length < 1)) {
      return NextResponse.json({ error: "monthday_required" }, { status: 400 });
    }

    // 次回実行時間再計算（enabled=false の場合は null）
    let nextRunAt: Date | null = null;
    if (enabled) {
      try {
        nextRunAt = computeNextRunAt({
          timezone,
          freq,
          byWeekday: byWeekday ? [...byWeekday] : null,
          byMonthday: byMonthday ? [...byMonthday] : null,
          hour,
          minute,
          second: 0,
          from: new Date(),
        });
      } catch (e) {
        console.warn(`[schedules.patch:${rid}] compute_next_failed`, { reason: (e as Error).message });
        nextRunAt = null;
      }
    }

    // DB 更新
    await updateScheduleById(_id, {
      freq,
      byWeekday: (byWeekday as ReadonlyArray<WeekdayKey>) as unknown as string[],
      byMonthday: byMonthday as number[] | undefined,
      hour,
      minute,
      timezone,
      enabled,
      nextRunAt,
    });

    // 返却用（合成）— ここでのnextRunAtは再計算結果
    const merged: GptsScheduleDoc = {
      ...(cur as GptsScheduleDoc),
      freq,
      byWeekday: ((byWeekday as ReadonlyArray<WeekdayKey>) as unknown as string[]) ?? null,
      byMonthday: (byMonthday as number[] | undefined) ?? null,
      hour,
      minute,
      timezone,
      enabled,
      nextRunAt,
      updatedAt: new Date(),
    };

    console.info(`[schedules.patch:${rid}] ok`, {
      userId,
      id,
      freq,
      byWeekday: byWeekday ?? [],
      byMonthday: byMonthday ?? [],
      enabled,
      nextRunAt: merged.nextRunAt ?? null,
    });

    return NextResponse.json(toScheduleDto(merged));
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(`[schedules.patch] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}