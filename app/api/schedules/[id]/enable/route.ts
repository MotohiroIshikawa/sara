import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { requireLineUser, HttpError } from "@/utils/line/lineAuth";
import { getGptsSchedulesCollection } from "@/utils/mongo";
import { updateScheduleById } from "@/services/gptsSchedules.mongo";
import type { GptsScheduleDoc } from "@/types/db";
import {
  isWeekdayKey,
  type WeekdayKey,
  type ScheduleFreq,
} from "@/types/schedule";
import { computeNextRunAt, roundMinutes, toScheduleDto } from "@/utils/schedule/schedulerTime";

// enabled=true にして nextRunAt を再計算（最終丸めも実施）
export async function POST(
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
      console.warn(`[schedules.enable:${rid}] not_found`, { userId, id });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (cur.userId !== userId) {
      console.warn(`[schedules.enable:${rid}] forbidden`, { userId, owner: cur.userId, id });
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const freq: ScheduleFreq = (cur.freq ?? "daily") as ScheduleFreq;
    const tz = cur.timezone ?? process.env.SCHEDULE_TZ_DEFAULT ?? "Asia/Tokyo";
    const hour =
      typeof cur.hour === "number" && Number.isFinite(cur.hour) ? cur.hour : null;
    const minuteRaw =
      typeof cur.minute === "number" && Number.isFinite(cur.minute) ? cur.minute : null;

    if (hour === null || minuteRaw === null) {
      return NextResponse.json({ error: "time_required" }, { status: 400 });
    }
    const minute = roundMinutes(minuteRaw);

    // byWeekday/byMonthday のサニタイズ
    const byWeekdayArr = Array.isArray(cur.byWeekday)
      ? (cur.byWeekday.filter((d): d is WeekdayKey => isWeekdayKey(d)) as WeekdayKey[])
      : [];
    const byMonthdayArr = Array.isArray(cur.byMonthday)
      ? cur.byMonthday.filter((n) => Number.isFinite(n) && n >= 1 && n <= 31)
      : [];

    // freq ごとの必須チェック
    if (freq === "weekly" && byWeekdayArr.length < 1) {
      return NextResponse.json({ error: "weekday_required" }, { status: 400 });
    }
    if (freq === "monthly" && byMonthdayArr.length < 1) {
      return NextResponse.json({ error: "monthday_required" }, { status: 400 });
    }

    // 次回実行時間を計算（同期関数・配列は可変で渡す）
    const nextRunAt = computeNextRunAt({
      timezone: tz,
      freq,
      byWeekday: byWeekdayArr.length ? [...byWeekdayArr] : null,
      byMonthday: byMonthdayArr.length ? [...byMonthdayArr] : null,
      hour,
      minute,
      second: 0,
      from: new Date(),
    });

    if (!nextRunAt) {
      console.warn(`[schedules.enable:${rid}] next_uncomputable`, { userId, id, freq });
      return NextResponse.json({ error: "next_uncomputable" }, { status: 400 });
    }

    // DB 更新（enabled=true / minute は丸め後を保存 / nextRunAt 反映）
    await updateScheduleById(_id, {
      enabled: true,
      hour,
      minute,
      nextRunAt,
      timezone: tz,
    });

    // 返却用（合成）
    const merged: GptsScheduleDoc = {
      ...(cur as GptsScheduleDoc),
      enabled: true,
      hour,
      minute,
      timezone: tz,
      nextRunAt,
      updatedAt: new Date(),
    };

    console.info(`[schedules.enable:${rid}] ok`, {
      userId,
      id,
      nextRunAt: merged.nextRunAt?.toISOString?.() ?? null,
    });

    return NextResponse.json(toScheduleDto(merged));
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(`[schedules.enable] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
