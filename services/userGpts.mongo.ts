import { randomUUID, createHash } from "crypto";
import type { UserGptsDoc } from "@/types/db";
import { getGptsBindingsCollection, getUserGptsCollection, idMatchers } from "@/utils/mongo";

let _indexesReady = false;
async function ensureIndexes(): Promise<void> {
  if (_indexesReady) return;
  const col = await getUserGptsCollection();

  await col.createIndex({ id: 1 }, { name: "idx_id" });
  // よく使う一覧は userId & createdAt 降順
  await col.createIndex({ userId: 1, createdAt: -1 }, { name: "idx_user_created_desc" });

  // /api/gpts/list で使う userId 絞り込み＋ updatedAt 降順ソート用
  await col.createIndex({ userId: 1, updatedAt: -1 }, { name: "idx_user_updated_desc" });

  // 非削除ドキュメント（deletedAt が存在しないもの）向けの部分インデックス
  try {
    await col.createIndex(
      { userId: 1, updatedAt: -1 },
      {
        name: "idx_user_active_updated_desc",
        partialFilterExpression: { deletedAt: { $exists: false } },
      }
    );
  } catch (e) {
    console.warn("[userGpts.ensureIndexes] partial index skipped:", (e as Error)?.message);
  }

  _indexesReady = true;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// 新規作成（重複チェックはせず毎回別IDで保存）
export async function createUserGpts(input: {
  userId: string;
  instpack: string;
  name: string;
  fromThreadId?: string;
  tags?: string[];
}): Promise<{ id: string; name: string }> {
  await ensureIndexes();
  const col = await getUserGptsCollection();
  const id = `gpts_${randomUUID()}`;
  const now = new Date();
  const hash = sha256(input.instpack);
  
  const doc: UserGptsDoc = {
    id,
    userId: input.userId,
    name: input.name,
    instpack: input.instpack,
    fromThreadId: input.fromThreadId,
    createdAt: now,
    updatedAt: now,
    hash,
    tags: input.tags ?? [],
  };

  await col.insertOne(doc);
  return { id, name: doc.name };
}

// 一覧（新しい順:createdAt）
export async function listUserGpts(userId: string): Promise<Array<{ id: string; name: string; createdAt: Date; tags?: string[] }>> {
  await ensureIndexes();
  const col = await getUserGptsCollection();
  const cur = col.find(
    { userId },
    { projection: { id: 1, name: 1, createdAt: 1, tags: 1 } }
  ).sort({ createdAt: -1 });

  const out: Array<{ id: string; name: string; createdAt: Date; tags?: string[] }> = [];
  for await (const d of cur) {
    out.push({ id: d.id, name: d.name, createdAt: d.createdAt, tags: d.tags });
  }
  return out;
}

// 一覧（更新順：updatedAt 降順、未削除のみ）
export async function listUserGptsByUpdatedDesc(
  userId: string
): Promise<Array<{ id: string; name: string; updatedAt: Date; tags?: string[] }>> {
  await ensureIndexes();
  const col = await getUserGptsCollection();

  const cur = col.find(
    { userId, deletedAt: { $exists: false } },
    { projection: { _id: 0, id: 1, name: 1, updatedAt: 1, tags: 1 } }
  ).sort({ updatedAt: -1 });

  const out: Array<{ id: string; name: string; updatedAt: Date; tags?: string[] }> = [];
  for await (const d of cur) {
    out.push({ id: d.id, name: d.name, updatedAt: d.updatedAt, tags: d.tags });
  }
  return out;
}

// 単体取得（所有者スコープで）
export async function getUserGptsById(
  userId: string, 
  gptsId: string
): Promise<UserGptsDoc | null> {
  await ensureIndexes();
  const col = await getUserGptsCollection();

  return col.findOne(
    { userId, $or: idMatchers(gptsId) },
    { projection: { _id: 0 } }
  );
}

export async function updateUserGpts(input: {
  userId: string;
  gptsId: string;
  name?: string;
  instpack?: string;
  tags?: string[];
}) {
  const col = await getUserGptsCollection();

  const $set: Partial<UserGptsDoc> = { updatedAt: new Date() };
  if (input.name !== undefined) $set.name = input.name;
  if (input.tags !== undefined) $set.tags = input.tags;
  if (typeof input.instpack === "string") {
    $set.instpack = input.instpack;
    $set.hash = sha256(input.instpack);
  }

  const res = await col.updateOne(
    { userId: input.userId, $or: idMatchers(input.gptsId) },
    { $set: {
      ...(input.name ? { name: input.name } : {}), 
      ...(input.instpack ? { instpack: input.instpack } : {}), 
      ...(input.tags ? { tags: input.tags } : {}), 
      updatedAt: new Date() 
    }}
  );
  return (res.modifiedCount ?? 0) > 0;
}

export async function hardDeleteUserGpts(userId: string, gptsId: string) {
  const col = await getUserGptsCollection();
  const res = await col.deleteOne({ userId, $or: idMatchers(gptsId) });
  return (res.deletedCount ?? 0) > 0;
}

export async function softDeleteUserGpts(userId: string, gptsId: string) {
  const col = await getUserGptsCollection();
  const res = await col.updateOne(
    { userId, $or: idMatchers<UserGptsDoc>(gptsId), deletedAt: { $exists: false }, }, // 既に削除済みなら更新しない
    { $set: { deletedAt: new Date(), updatedAt: new Date() } },
  );
  return (res.modifiedCount ?? 0) > 0;
}

export async function clearBindingIfMatches(
  scopedId: string,
  gptsId: string,
  ctx?: { rid?: string }
) {
  const rid = ctx?.rid ?? crypto.randomUUID().slice(0, 8);
  const col = await getGptsBindingsCollection();
  const cur = await col.findOne({ scopedId });

  if (cur?.gptsId !== gptsId) {
    console.info(`[gpts.unbind:${rid}] skip_not_bound`, { scopedId, gptsId });
    return;
  }
  await col.deleteOne({ scopedId });
  console.info(`[gpts.unbind:${rid}] cleared_on_delete`, { scopedId, gptsId });
}