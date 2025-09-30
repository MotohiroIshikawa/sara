import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireLineUser, HttpError } from "@/utils/lineAuth";
import { createDraftSchedule, findSchedules, updateScheduleById } from "@/services/gptsSchedules.mongo";
import type { GptsScheduleDoc } from "@/types/db";
import { type ScheduleFreq } from "@/types/schedule";
import { roundMinutes, toScheduleDto } from "@/utils/schedulerTime";

// スケジュールのドラフトを新規作成（enabled は false 想定）
export async function POST(request: Request) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    const bodyUnknown: unknown = await request.json();

    const gptsId =
      typeof (bodyUnknown as { gptsId?: unknown }).gptsId === "string"
        ? (bodyUnknown as { gptsId: string }).gptsId
        : undefined;

    const freq =
      typeof (bodyUnknown as { freq?: unknown }).freq === "string"
        ? ((bodyUnknown as { freq: string }).freq as ScheduleFreq)
        : ("daily" as ScheduleFreq);

    const hour =
      typeof (bodyUnknown as { hour?: unknown }).hour === "number"
        ? (bodyUnknown as { hour: number }).hour
        : 9;

    const minuteInput =
      typeof (bodyUnknown as { minute?: unknown }).minute === "number"
        ? (bodyUnknown as { minute: number }).minute
        : 0;

    const enabled =
      typeof (bodyUnknown as { enabled?: unknown }).enabled === "boolean"
        ? (bodyUnknown as { enabled: boolean }).enabled
        : false;

    const timezone =
      typeof (bodyUnknown as { timezone?: unknown }).timezone === "string"
        ? (bodyUnknown as { timezone: string }).timezone
        : process.env.SCHEDULE_TZ_DEFAULT ?? "Asia/Tokyo";

    if (!gptsId) {
      console.warn(`[schedules.post:${rid}] missing_gptsId`, { userId });
      return NextResponse.json({ error: "missing_gptsId" }, { status: 400 });
    }

    const minute = roundMinutes(minuteInput); // ★ 分丸め

    // ドラフトを作成（target は操作ユーザに紐付け）
    const created = await createDraftSchedule({
      userId,
      gptsId,
      targetType: "user",
      targetId: userId,
      timezone,
      freq,
    });

    const updatedOk = await updateScheduleById((created as GptsScheduleDoc)._id, {
      hour,
      minute,
      enabled: Boolean(enabled),
    });
    
    const finalDoc: GptsScheduleDoc = {
      ...(created as GptsScheduleDoc),
      hour,
      minute,
      enabled: Boolean(enabled),
    };

    console.info(`[schedules.post:${rid}] created`, {
      userId,
      gptsId,
      _id: created?._id?.toString?.(),
      enabled: created?.enabled,
      updatedOk,
    });

    return NextResponse.json(toScheduleDto(finalDoc));
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(`[schedules.post:${rid}] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const rid = randomUUID().slice(0, 8);
  try {
    const userId = await requireLineUser(request);
    const { searchParams } = new URL(request.url);

    const gptsId = searchParams.get("gptsId") ?? undefined;
    const targetType = searchParams.get("targetType") ?? undefined;
    const targetId = searchParams.get("targetId") ?? undefined;

    const filter: Record<string, unknown> = { deletedAt: null };
    if (gptsId) filter.gptsId = gptsId;
    if (targetType) filter.targetType = targetType;
    if (targetId) filter.targetId = targetId;

    const docs = await findSchedules(filter);

    const items = (docs as ReadonlyArray<GptsScheduleDoc>).map(toScheduleDto);
    console.info(`[schedules.get:${rid}] ok`, {
      userId,
      gptsId,
      targetType,
      targetId,
      count: items.length,
    });

    return NextResponse.json({ items });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(`[schedules.get:${rid}] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

