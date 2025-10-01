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

export async function softDeleteSchedulesByGpts(input: {
  userId: string;
  gptsId: string;
}): Promise<number> {
  const col = await getGptsSchedulesCollection();
  const res = await col.updateMany(
    { userId: input.userId, gptsId: input.gptsId, deletedAt: null },
    { $set: { deletedAt: new Date(), enabled: false, nextRunAt: null, updatedAt: new Date() } }
  );
  return res.modifiedCount ?? 0;
}

export async function softDeleteAllSchedulesByUser(input: {
  userId: string;
}): Promise<number> {
  const col = await getGptsSchedulesCollection();
  const res = await col.updateMany(
    { userId: input.userId, deletedAt: null }, // ★ targetType/Id は見ない（作成者基準）
    { $set: { deletedAt: new Date(), enabled: false, nextRunAt: null, updatedAt: new Date() } }
  );
  return res.modifiedCount ?? 0;
}

/** スケジューラ用 */

export type ClaimedSchedule = WithId<GptsScheduleDoc>;

// 配信すべき1件を取得
// 条件: enabled=true, deletedAt=null, nextRunAt<=now, claimedAt が null or 未定義
// claimedAt: ジョブ中にnowが入って、終了後にnullになる。ジョブ中に他が掴まないようにするため
export async function claimOneDueSchedule(now: Date): Promise<ClaimedSchedule | null> {
  const col = await getGptsSchedulesCollection();
  const res = await col.findOneAndUpdate(
    {
      enabled: true,
      deletedAt: null,
      nextRunAt: { $lte: now },
      $or: [{ claimedAt: null }, { claimedAt: { $exists: false } }],
    },
    { $set: { claimedAt: new Date(), updatedAt: new Date() } as Record<string, unknown> },
    { sort: { nextRunAt: 1 }, returnDocument: "after" }
  );
  return res?.value ?? null;
}

// 実行成功時の更新
export async function markRunSuccess(id: ObjectId, at: Date, next: Date | null): Promise<void> {
  const col = await getGptsSchedulesCollection();
  await col.updateOne(
    { _id: id, deletedAt: null, enabled: true },
    {
      $set: {
        lastRunAt: at,
        nextRunAt: next,
        claimedAt: null,
        lastError: null,
        updatedAt: new Date(),
      } as Record<string, unknown>, // ★ 型に無いフィールドがあっても更新できるようにする
    }
  );
}

export async function markRunFailure(
  id: ObjectId,
  at: Date,
  reason: string,
  backoffMs?: number
): Promise<void> {
  const col = await getGptsSchedulesCollection();
  const setObj: Record<string, unknown> = {
    claimedAt: null,
    lastRunAt: at,
    lastError: reason,
    updatedAt: new Date(),
  };
  if (typeof backoffMs === "number" && backoffMs > 0) {
    setObj.nextRunAt = new Date(Date.now() + backoffMs);
  }
  await col.updateOne(
    { _id: id, deletedAt: null },
    {
      $set: setObj,
      $inc: { errorCount: 1 } as Record<string, number>, // ★
    }
  );
}