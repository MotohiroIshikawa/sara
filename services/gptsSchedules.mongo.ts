import { ObjectId, type Filter, type UpdateFilter, type WithId } from "mongodb";
import { getGptsSchedulesCollection, withTimestampsForCreate, touchForUpdate } from "@/utils/mongo";
import type { GptsScheduleDoc } from "@/types/db";
import type { SourceType } from "@/types/gpts";
import { findOneAndUpdateCompat } from "@/utils/mongoCompat";
import { computeNextRunAtWithGrace, type WeekdayKey } from "@/utils/schedulerTime";
import { isWeekdayKey } from "@/utils/scheduleGuards";

export interface FindSchedulesFilter {
  gptsId?: string;
  targetType?: GptsScheduleDoc["targetType"]; // "user" | "group" | "room"
  targetId?: string;
  userId?: string;
}

// 下書き作成
// TODO: status / stage を入れているが、GptsScheduleDoc にそのフィールドが無いので型不一致（as で抑え込み中）。
// TODO: 将来的に扱うなら types/db.ts に追加するか、今回はフィールドを入れない運用に寄せるのが安全
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

// TODO: 配列引数をやめる
export async function softDeleteSchedulesByGpts(input: {
  userId?: string;                 // あれば優先
  gptsId?: string;                 // 任意（指定時のみフィルタ）
  targetType?: "user" | "group" | "room"; // userId が無いときに使用
  targetId?: string;               // 同上
}): Promise<number> {
  const col = await getGptsSchedulesCollection();
  const filter: Filter<GptsScheduleDoc> = { deletedAt: null };
  if (input.userId) {
    filter.userId = input.userId;
    if (input.gptsId) filter.gptsId = input.gptsId;
  } else if (input.targetType && input.targetId) {
    filter.targetType = input.targetType;
    filter.targetId = input.targetId;
    if (input.gptsId) filter.gptsId = input.gptsId; // 任意
  } else {
    // どちらも無ければ何もしない（誤爆防止）
    return 0;
  }
  const res = await col.updateMany(
    filter,
    { $set: { deletedAt: new Date(), enabled: false, nextRunAt: null, updatedAt: new Date() } }
  );
  return res.modifiedCount ?? 0;
}

// targetType/targetId 指定でのソフト削除
export async function softDeleteSchedulesByTarget(
  sourceType: SourceType,
  sourceId: string,
  gptsId?: string
): Promise<number> {
  const col = await getGptsSchedulesCollection();
  const filter: Filter<GptsScheduleDoc> = {
    deletedAt: null,
    targetType: sourceType,
    targetId: sourceId,
  };
  if (typeof gptsId === "string" && gptsId.length > 0) {
    filter.gptsId = gptsId;
  }
  const res = await col.updateMany(
    filter,
    { $set: { deletedAt: new Date(), enabled: false, nextRunAt: null, updatedAt: new Date() } }
  );
  return res.modifiedCount ?? 0;
}

// ユーザ側（target=user）スケジュールを group/room へ複製し、GRACEを加味した nextRunAt を設定
export async function cloneUserSchedulesToTarget(
  userId: string,
  gptsId: string,
  sourceType: SourceType,   // "group" | "room"
  sourceId: string,         // Gxxxx / Rxxxx
  graceSec?: number
): Promise<number> {
  const col = await getGptsSchedulesCollection();
  // 元になる「ユーザ自身の」有効スケジュールのみ複製
  const srcFilter: Filter<GptsScheduleDoc> = {
    userId,
    gptsId,
    targetType: "user",
    targetId: userId,
    deletedAt: null,
    enabled: true,
  };
  const srcDocs: GptsScheduleDoc[] = await col.find(srcFilter).toArray() as unknown as GptsScheduleDoc[];
  let upserted: number = 0;

  for (const s of srcDocs) {
    const timezone: string = s.timezone ?? "Asia/Tokyo";
    const freq: GptsScheduleDoc["freq"] = s.freq ?? "daily";
    const hour: number = typeof s.hour === "number" ? s.hour : 9;
    const minute: number = typeof s.minute === "number" ? s.minute : 0;
    const second: number = typeof s.second === "number" ? s.second : 0;

    const byWeekday: WeekdayKey[] | null = Array.isArray(s.byWeekday)
      ? (s.byWeekday.filter(isWeekdayKey) as WeekdayKey[])
      : null;
    const byMonthday: number[] | null = Array.isArray(s.byMonthday)
      ? [...s.byMonthday]
          .map((n: number) => Math.trunc(Number(n)))
          .filter((n: number) => Number.isFinite(n) && n >= 1 && n <= 31)
          .sort((a: number, b: number) => a - b)
      : null;

    const next: Date | null = computeNextRunAtWithGrace(
      { timezone, freq, byWeekday, byMonthday, hour, minute, second, from: new Date() },
      graceSec
    );

    const filter: Filter<GptsScheduleDoc> = {
      userId,
      gptsId,
      targetType: sourceType,
      targetId: sourceId,
      timezone,
      freq,
      hour,
      minute,
      second,
      byWeekday: byWeekday ?? null,
      byMonthday: byMonthday ?? null,
      deletedAt: null,
    };

    const setDoc: Partial<GptsScheduleDoc> = {
      userId,
      gptsId,
      targetType: sourceType,
      targetId: sourceId,
      timezone,
      freq,
      hour,
      minute,
      second,
      byWeekday: byWeekday ?? null,
      byMonthday: byMonthday ?? null,
      enabled: true,
      nextRunAt: next,
      lastRunAt: null,
      claimedAt: null,
      lastError: null,
      errorCount: 0,
    };

    const update: UpdateFilter<GptsScheduleDoc> = {
      $set: touchForUpdate(setDoc),
      $setOnInsert: { createdAt: new Date() } as Record<string, unknown>,
    };

    const r = await findOneAndUpdateCompat(col, filter, update, {
      upsert: true,
      returnDocument: "after",
    });
    if (r?.ok) upserted++;
  }

  return upserted;
}

// ユーザ側の当該GPTスケジュールを一括停止（enabled=false）のみ
// TODO: 配列引数をやめる
export async function disableUserSchedulesByGpts(input: {
  userId: string;
  gptsId: string;
}): Promise<number> {
  const col = await getGptsSchedulesCollection();
  const res = await col.updateMany(
    {
      userId: input.userId,
      gptsId: input.gptsId,
      targetType: "user",
      targetId: input.userId,
      deletedAt: null,
      enabled: true,
    },
    { $set: { enabled: false, nextRunAt: null, updatedAt: new Date() } }
  );
  return res.modifiedCount ?? 0;
}

/** スケジューラ用 */

export type ClaimedSchedule = WithId<GptsScheduleDoc>;

// 配信すべき1件を取得
// 条件: enabled=true, deletedAt=null, nextRunAt<=now, claimedAt が null or 未定義
// claimedAt: ジョブ中にnowが入って、終了後にnullになる。ジョブ中に他が掴まないようにするため
export async function claimOneDueSchedule(
  now: Date
): Promise<ClaimedSchedule | null> {
  const col = await getGptsSchedulesCollection();

  const filter: Filter<GptsScheduleDoc> = {
    enabled: true,
    deletedAt: null,
    nextRunAt: { $lte: now },
  };
  const update: UpdateFilter<GptsScheduleDoc> = {
    $set: { claimedAt: new Date(), updatedAt: new Date() },
  };
  const optimisticFilter: Filter<GptsScheduleDoc> = {
    $or: [{ claimedAt: null }, { claimedAt: { $exists: false } }],
  };
  const res = await findOneAndUpdateCompat(col, filter, update, {
    sort: { nextRunAt: 1 },
    returnDocument: "after",
    optimisticFilter,
  });

  const v = res?.value ?? null;
  /** 
  // TODO: あとで消す
  // 取得できたかどうか、そして中身をログに出す
  if (v) {
    console.info("[claimOneDueSchedule] got", {
      id: String(v._id),
      gptsId: v.gptsId,
      nextRunAt: v.nextRunAt?.toISOString?.() ?? null,
      claimedAt: v.claimedAt?.toISOString?.() ?? null,
      enabled: v.enabled,
      deletedAt: v.deletedAt,
    });
  } else {
    console.info("[claimOneDueSchedule] no match", {
      now: now.toISOString(),
      criteria: {
        enabled: true,
        deletedAt: null,
        nextRunAt_lte: now.toISOString(),
        claimedAt: "null or !exists",
      },
    });
  }
  */
  return v;
}

// 実行成功時の更新
export async function markRunSuccess(
  id: ObjectId, 
  at: Date, 
  next: Date | null
): Promise<void> {
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
      } as Record<string, unknown>,
    }
  );
}

export async function countDueCandidates(
  now: Date
): Promise<number> {
  const col = await getGptsSchedulesCollection();
  return col.countDocuments({
    enabled: true,
    deletedAt: null,
    nextRunAt: { $lte: now },
    $or: [{ claimedAt: null }, { claimedAt: { $exists: false } }],
  });
}
