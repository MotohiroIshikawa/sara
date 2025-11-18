import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireLineUser, HttpError } from "@/utils/line/lineAuth";
import { createDraftSchedule, findSchedules, updateScheduleById } from "@/services/gptsSchedules.mongo";
import type { GptsScheduleDoc } from "@/types/db";
import { type ScheduleFreq } from "@/types/schedule";
import { roundMinutes, toScheduleDto } from "@/utils/schedule/schedulerTime";
import type { WithId } from "mongodb";
import type { SourceType } from "@/types/gpts";

// スケジュールのドラフトを新規作成（enabled は false 想定）
export async function POST(request: Request) {
  const rid: string = randomUUID().slice(0, 8);
  try {
    const userId: string = await requireLineUser(request);
    const bodyUnknown: unknown = await request.json();

    const gptsId: string | undefined =
      typeof (bodyUnknown as { gptsId?: unknown }).gptsId === "string"
        ? (bodyUnknown as { gptsId: string }).gptsId
        : undefined;

    const freq: ScheduleFreq =
      typeof (bodyUnknown as { freq?: unknown }).freq === "string"
        ? ((bodyUnknown as { freq: string }).freq as ScheduleFreq)
        : ("daily" as ScheduleFreq);

    const hour: number =
      typeof (bodyUnknown as { hour?: unknown }).hour === "number"
        ? (bodyUnknown as { hour: number }).hour
        : 9;

    const minuteInput: number =
      typeof (bodyUnknown as { minute?: unknown }).minute === "number"
        ? (bodyUnknown as { minute: number }).minute
        : 0;

    const enabled: boolean =
      typeof (bodyUnknown as { enabled?: unknown }).enabled === "boolean"
        ? (bodyUnknown as { enabled: boolean }).enabled
        : false;

    const timezone: string =
      typeof (bodyUnknown as { timezone?: unknown }).timezone === "string"
        ? (bodyUnknown as { timezone: string }).timezone
        : process.env.SCHEDULE_TZ_DEFAULT ?? "Asia/Tokyo";

    if (!gptsId) {
      console.warn(`[schedules.post:${rid}] missing_gptsId`, { userId });
      return NextResponse.json({ error: "missing_gptsId" }, { status: 400 });
    }

    const minute: number = roundMinutes(minuteInput); // ★ 分丸め

    // ドラフトを作成（target は操作ユーザに紐付け）
    const created: WithId<GptsScheduleDoc> = await createDraftSchedule({
      userId,
      gptsId,
      targetType: "user",
      targetId: userId,
      timezone,
      freq,
    });

    const updatedOk: boolean = await updateScheduleById(created._id, {
      hour,
      minute,
      enabled: Boolean(enabled),
    });
    
    const finalDoc: GptsScheduleDoc = {
      ...created,
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
  const rid: string = randomUUID().slice(0, 8);
  try {
    const userId: string = await requireLineUser(request);
    const { searchParams } = new URL(request.url);

    const gptsId: string | null = searchParams.get("gptsId");
    const targetTypeRaw: string | null = searchParams.get("targetType");
    const targetIdRaw: string | null = searchParams.get("targetId");

    // 未指定なら「自分（user）」をデフォルトにする
    const effTargetType: SourceType | undefined = (targetTypeRaw as SourceType | null) ?? "user";
    const effTargetId: string | undefined =
      targetIdRaw ?? (effTargetType === "user" ? userId : undefined);
    
    const filter: Readonly<{
      gptsId?: string;
      targetType?: SourceType;
      targetId?: string;
      userId?: string;
    }> = {
      ...(gptsId ? { gptsId } : {}),
      ...(effTargetType ? { targetType: effTargetType } : {}),
      ...(effTargetId ? { targetId: effTargetId } : {}),
    };

    const docs: GptsScheduleDoc[] = await findSchedules(filter);

    const items = (docs as ReadonlyArray<GptsScheduleDoc>).map(toScheduleDto);
    console.info(`[schedules.get:${rid}] ok`, {
      userId,
      gptsId,
      targetType: targetTypeRaw,
      targetId: targetIdRaw,
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

