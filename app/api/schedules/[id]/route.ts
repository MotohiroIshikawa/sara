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
import { computeNextRunAt, roundMinutes, toScheduleDto } from "@/utils/schedulerTime";

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

    const cur = await col.findOne({ _id, deletedAt: null });
    if (!cur) {
      console.warn(`[schedules.patch:${rid}] not_found`, { userId, id });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (cur.userId !== userId) {
      console.warn(`[schedules.patch:${rid}] forbidden`, { userId, owner: cur.userId, id });
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const bodyUnknown: unknown = await request.json();

    const freq =
      typeof (bodyUnknown as { freq?: unknown }).freq === "string"
        ? ((bodyUnknown as { freq: string }).freq as ScheduleFreq)
        : (cur.freq as ScheduleFreq);

    // weekday: string[] を WeekdayKey[] に絞る
    const byWeekdayInput = (bodyUnknown as { byWeekday?: unknown }).byWeekday;
    const byWeekday: ReadonlyArray<WeekdayKey> | undefined =
      Array.isArray(byWeekdayInput)
        ? (byWeekdayInput.filter((d): d is WeekdayKey => isWeekdayKey(d)) as ReadonlyArray<WeekdayKey>)
        : (Array.isArray(cur.byWeekday)
            ? (cur.byWeekday.filter((d: unknown): d is WeekdayKey => isWeekdayKey(d)) as ReadonlyArray<WeekdayKey>)
            : undefined);

    // monthday: number[]（1..31 のみ）
    const byMonthdayInput = (bodyUnknown as { byMonthday?: unknown }).byMonthday;
    const byMonthday: ReadonlyArray<number> | undefined =
      Array.isArray(byMonthdayInput)
        ? byMonthdayInput
            .map((n) => (typeof n === "number" ? Math.trunc(n) : NaN))
            .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
        : (Array.isArray(cur.byMonthday) ? cur.byMonthday : undefined);

    const hour =
      typeof (bodyUnknown as { hour?: unknown }).hour === "number"
        ? (bodyUnknown as { hour: number }).hour
        : (typeof cur.hour === "number" ? cur.hour : 9);

    const minuteRaw =
      typeof (bodyUnknown as { minute?: unknown }).minute === "number"
        ? (bodyUnknown as { minute: number }).minute
        : (typeof cur.minute === "number" ? cur.minute : 0);

    const minute = roundMinutes(minuteRaw); // サーバ最終丸め

    const enabled =
      typeof (bodyUnknown as { enabled?: unknown }).enabled === "boolean"
        ? (bodyUnknown as { enabled: boolean }).enabled
        : Boolean(cur.enabled);

    const timezone =
      typeof (bodyUnknown as { timezone?: unknown }).timezone === "string"
        ? (bodyUnknown as { timezone: string }).timezone
        : (cur.timezone ?? "Asia/Tokyo");

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
      byWeekday: byWeekday as unknown as string[], // DBは string[] 前提
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
      byWeekday: byWeekday as unknown as string[] | null,
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