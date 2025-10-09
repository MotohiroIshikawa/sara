import type { UpdateFilter } from "mongodb";
import type { UserGptsDoc } from "@/types/db";
import { getUserGptsCollection } from "@/utils/mongo";
import { isNonEmptyString } from "@/utils/types";

let _indexesReady = false;

async function ensureIndexes(): Promise<void> {
  if (_indexesReady) return;
  const col = await getUserGptsCollection();

  await col.createIndex({ gptsId: 1 }, { name: "uniq_gptsId", unique: true }).catch(() => {});
  await col.createIndex({ userId: 1, createdAt: -1 }, { name: "idx_user_created_desc" }).catch(() => {});
  await col.createIndex({ userId: 1, updatedAt: 1 },  { name: "idx_user_updated_asc"  }).catch(() => {});
  await col.createIndex({ userId: 1, updatedAt: -1 }, { name: "idx_user_updated_desc" }).catch(() => {});

  _indexesReady = true;
}

/** ユーザに gpts リンクを作成 */
/*
export async function linkUserGpts(input: { userId: string; gptsId: string }): Promise<void> {
  await ensureIndexes();
  const col = await getUserGptsCollection();

  const base = withTimestampsForCreate({
    userId: input.userId,
    gptsId: input.gptsId,
  });

  const update: UpdateFilter<UserGptsDoc> = {
    $setOnInsert: base,
    $unset: { deletedAt: "" } as Record<keyof Partial<UserGptsDoc>, "">, // 復帰
    $set: touchForUpdate({}) as Partial<UserGptsDoc>, // updatedAt を更新
  };

  await col.updateOne(
    { userId: input.userId, gptsId: input.gptsId },
    update,
    { upsert: true }
  );
}
*/

/** 論理削除（非表示にする） */
/*
export async function unlinkUserGptsSoft(input: { userId: string; gptsId: string }): Promise<boolean> {
  await ensureIndexes();
  const col = await getUserGptsCollection();

  const update: UpdateFilter<UserGptsDoc> = {
    $set: {
      deletedAt: new Date(),
      updatedAt: new Date(),
    } as Pick<UserGptsDoc, "deletedAt" | "updatedAt">,
  };

  const r = await col.updateOne(
    { userId: input.userId, gptsId: input.gptsId, deletedAt: { $exists: false } },
    update
  );
  return (r.modifiedCount ?? 0) > 0;
}
*/

/** 物理削除（通常は使用しない） */
/*
export async function unlinkUserGptsHard(input: { userId: string; gptsId: string }): Promise<boolean> {
  await ensureIndexes();
  const col = await getUserGptsCollection();
  const r = await col.deleteOne({ userId: input.userId, gptsId: input.gptsId });
  return (r.deletedCount ?? 0) > 0;
}
*/

/** アクティブなリンクの gptsId 一覧（updatedAt 降順） */
/*
export async function listActiveUserGptsIds(userId: string): Promise<string[]> {
  await ensureIndexes();
  const col = await getUserGptsCollection();

  const cur = col
    .find(
      { userId, deletedAt: { $exists: false } },
      { projection: { _id: 0, gptsId: 1 } }
    )
    .sort({ updatedAt: -1 });

  const ids: string[] = [];
  for await (const d of cur) ids.push(d.gptsId);
  return ids;
}
*/

/** リンク存在チェック（アクティブのみ） */
export async function hasUserGptsLink(userId: string, gptsId: string): Promise<boolean> {
  await ensureIndexes();
  const col = await getUserGptsCollection();
  const found = await col.findOne(
    { userId, gptsId, deletedAt: { $exists: false } },
    { projection: { _id: 1 } }
  );
  return !!found;
}

/** 論理削除（ユーザーの所持リンクだけを非表示にする。正本 gpts は残す） */
export async function softDeleteUserGpts(input: { userId: string; gptsId: string }): Promise<boolean> {
  await ensureIndexes();
  const col = await getUserGptsCollection();

  const update: UpdateFilter<UserGptsDoc> = {
    $set: {
      deletedAt: new Date(),
      updatedAt: new Date(),
    } as Pick<UserGptsDoc, "deletedAt" | "updatedAt">,
  };

  const r = await col.updateOne(
    { userId: input.userId, gptsId: input.gptsId, deletedAt: { $exists: false } },
    update
  );
  return (r.modifiedCount ?? 0) > 0;
}

export async function listUserGptsByUpdatedDesc(
  userId: string
): Promise<Array<{ gptsId: string; name: string; updatedAt: Date; isPublic: boolean }>> {
  await ensureIndexes();
  const userCol = await getUserGptsCollection();

  type AggOut = Pick<UserGptsDoc, "gptsId" | "updatedAt"> & { name: string; isPublic: boolean };

  const pipeline: object[] = [
    { $match: { userId, deletedAt: { $exists: false } } },
    {
      $lookup: {
        from: "gpts",
        localField: "gptsId",
        foreignField: "gptsId",
        as: "gpts"
      },
    },
    { $unwind: "$gpts" },
    { $project: { _id: 0, gptsId: 1, updatedAt: 1, name: "$gpts.name", isPublic: "$gpts.isPublic" } },
    { $match: { name: { $type: "string", $ne: "" } } },
  ];

  const docs = await userCol.aggregate<AggOut>(pipeline).toArray();

  type Listed = { gptsId: string; name: string; updatedAt: Date; isPublic: boolean };
  
  const out: Listed[] = docs.map((d) => {
    if (!isNonEmptyString(d.name)) {
      throw new Error(`[listUserGptsByUpdatedDesc] gpts.name missing (gptsId=${d.gptsId})`);
    }
    const updatedAt = d.updatedAt instanceof Date ? d.updatedAt : new Date(d.updatedAt);
    return { gptsId: d.gptsId, name: d.name, updatedAt, isPublic: d.isPublic };
  });

  out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return out;
}

// 論理削除（ユーザのすべてのリンク）
export async function softDeleteAllUserGptsByUser(userId: string): Promise<number> {
  await ensureIndexes();
  const col = await getUserGptsCollection();

  const now = new Date();
  const update: UpdateFilter<UserGptsDoc> = {
    $set: {
      deletedAt: now,
      updatedAt: now,
    } as Pick<UserGptsDoc, "deletedAt" | "updatedAt">,
  };

  const r = await col.updateMany({ userId, deletedAt: { $exists: false } }, update);
  return r?.modifiedCount ?? 0;
}