import { randomUUID, createHash } from "crypto";
import type { UserGptsDoc } from "@/types/db";
import { getUserGptsCollection, idMatchers } from "@/utils/mongo";

let _indexesReady = false;
async function ensureIndexes(): Promise<void> {
  if (_indexesReady) return;
  const col = await getUserGptsCollection();

  await col.createIndex({ id: 1 }, { name: "idx_id" });
  // よく使う一覧は userId & createdAt 降順
  await col.createIndex({ userId: 1, createdAt: -1 }, { name: "idx_user_created_desc" });

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

// 一覧（新しい順）
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
    { userId, $or: [{ id: gptsId }, { _id: gptsId }] },
    { $set: { deletedAt: new Date(), updatedAt: new Date() } },
  );
  return (res.modifiedCount ?? 0) > 0;
}