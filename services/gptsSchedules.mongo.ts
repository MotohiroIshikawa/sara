import { ObjectId, type WithId } from "mongodb";
import { getGptsSchedulesCollection, withTimestampsForCreate, touchForUpdate } from "@/utils/mongo";
import type { GptsScheduleDoc } from "@/types/db";
import type { SourceType } from "@/types/gpts";

export interface FindSchedulesFilter {
  gptsId?: string;
  targetType?: GptsScheduleDoc["targetType"]; // "user" | "group" | "room"
  targetId?: string;
  userId?: string;
}

// 下書き作成
export async function createDraftSchedule(input: {
  userId: string;
  gptsId: string;
  targetType: SourceType;
  targetId: string;
  timezone: string;           // e.g. "Asia/Tokyo"
  freq: GptsScheduleDoc["freq"];
}): Promise<WithId<GptsScheduleDoc>> {
  const col = await getGptsSchedulesCollection();
  const doc: Omit<GptsScheduleDoc, "_id"> = withTimestampsForCreate({
    userId: input.userId,
    gptsId: input.gptsId,
    targetType: input.targetType,
    targetId: input.targetId,
    timezone: input.timezone,
    freq: input.freq,
    enabled: false,
    deletedAt: null,
    byWeekday: null,
    byMonthday: null,
    hour: null,
    minute: null,
    second: 0,
    nextRunAt: null,
    lastRunAt: null,
    status: "draft",
    stage: "freq",
  });
  const res = await col.insertOne(doc as GptsScheduleDoc);
  return { ...(doc as GptsScheduleDoc), _id: res.insertedId };
}

// _id 指定で部分更新（handlers から呼ばれる）
export async function updateScheduleById(id: ObjectId, patch: Partial<GptsScheduleDoc>): Promise<boolean> {
  const col = await getGptsSchedulesCollection();
  const res = await col.updateOne(
    { _id: id, deletedAt: null },
    { $set: touchForUpdate(patch) }
  );
  return res.matchedCount > 0;
}

// 最新のスケジュール（enabled の有無は任意指定）
export async function getLatestSchedule(params: {
  userId: string;
  gptsId: string;
  enabled?: boolean; // 省略時はどちらでも
}): Promise<WithId<GptsScheduleDoc> | null> {
  const col = await getGptsSchedulesCollection();
  const q: Record<string, unknown> = {
    userId: params.userId,
    gptsId: params.gptsId,
    deletedAt: null,
  };
  if (typeof params.enabled === "boolean") q.enabled = params.enabled;
  return col.findOne(q, { sort: { createdAt: -1 } });
}

// 実行後の next/last 更新（runner 用）
export async function bumpAfterRun(id: ObjectId, nextRunAt: Date | null): Promise<void> {
  const col = await getGptsSchedulesCollection();
  await col.updateOne(
    { _id: id, deletedAt: null, enabled: true },
    { $set: { lastRunAt: new Date(), nextRunAt, updatedAt: new Date() } }
  );
}

export async function findSchedules(
  filter: Readonly<FindSchedulesFilter>
): Promise<GptsScheduleDoc[]> {
  const col = await getGptsSchedulesCollection();
  const query: Record<string, unknown> = { deletedAt: null };

  if (typeof filter.gptsId === "string") query.gptsId = filter.gptsId;
  if (typeof filter.targetType === "string") query.targetType = filter.targetType;
  if (typeof filter.targetId === "string") query.targetId = filter.targetId;
  if (typeof filter.userId === "string") query.userId = filter.userId;

  const cursor = col.find(query).sort({ _id: -1 }).limit(50);
  const docs = (await cursor.toArray()) as unknown as GptsScheduleDoc[];
  return docs;
}