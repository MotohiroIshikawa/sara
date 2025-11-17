// app/api/schedules/[id]/disable/route.ts
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { requireLineUser, HttpError } from "@/utils/lineAuth";
import { getGptsSchedulesCollection } from "@/utils/mongo";
import { updateScheduleById } from "@/services/gptsSchedules.mongo";
import type { GptsScheduleDoc } from "@/types/db";
import { toScheduleDto } from "@/utils/schedule/schedulerTime";

// enabled=false にして nextRunAt=null に更新して返却
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
      console.warn(`[schedules.disable:${rid}] not_found`, { userId, id });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (cur.userId !== userId) {
      console.warn(`[schedules.disable:${rid}] forbidden`, { userId, owner: cur.userId, id });
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    // DB 更新（無効化＆nextRunAtをnull）
    await updateScheduleById(_id, {
      enabled: false,
      nextRunAt: null,
    });

    // 返却用 合成
    const merged: GptsScheduleDoc = {
      ...(cur as GptsScheduleDoc),
      enabled: false,
      nextRunAt: null,
      updatedAt: new Date(),
    };

    console.info(`[schedules.disable:${rid}] ok`, {
      userId,
      id,
      nextRunAt: null,
    });

    return NextResponse.json(toScheduleDto(merged));
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error(`[schedules.disable] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
