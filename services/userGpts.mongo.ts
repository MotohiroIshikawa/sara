import { randomUUID, createHash } from "crypto";
import { ObjectId, type Filter } from "mongodb";
import type { UserGptsDoc } from "@/types/db";
import { getUserGptsCollection } from "@/utils/mongo";

// 目的:
//  - ユーザーが「保存」を押した instpack をユーザーの GPTS 保管庫に保存
//  - 後で一覧/選択できるように最低限のAPIを提供

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
  
  const doc: (UserGptsDoc & { _id: string }) = {
    _id: id,
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

  const or: Filter<UserGptsDoc>[] = [
    { id: gptsId },      // 旧データ互換: id フィールド
    { _id: gptsId },     // 新データ: _id に文字列を採用
  ];
  if (ObjectId.isValid(gptsId)) {
    or.push({ _id: new ObjectId(gptsId) }); // 念のため ObjectId も許容
  }
  const query = { userId, $or: or } satisfies Filter<UserGptsDoc>;
  return col.findOne(query);
}

export {};