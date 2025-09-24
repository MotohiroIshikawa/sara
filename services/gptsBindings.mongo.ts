import type { GptsBindingDoc } from "@/types/db";
import { getGptsBindingsCollection } from "@/utils/mongo";

let indexesReady = false;
// コレクションのインデックスを1回だけ作成
async function ensureIndexes() {
  if (indexesReady) return;
  const col = await getGptsBindingsCollection();
  try {
    await col.createIndex(
      { updatedAt: 1 },
      { expireAfterSeconds: 60 * 60 * 24 * 90, name: "ttl_updatedAt_90d" }
    );
  } catch {
    /* 既存あり等は無視 */
  }
  indexesReady = true;
}

// 紐づけ作成
export async function setBinding(userId: string, gptsId: string, instpack: string) {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const doc: GptsBindingDoc = { userId, gptsId, instpack, updatedAt: new Date() };
  try {
    await col.updateOne({ userId }, { $set: doc }, { upsert: true });
  } catch (e) {
    console.error("[gptsBindings.setBinding] updateOne failed:", e);
    throw e;
  }
}

// 紐づけ取得
export async function getBinding(userId: string): Promise<GptsBindingDoc | null> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  return col.findOne({ userId }, { projection: { _id: 0 } });
}

// 紐づけ削除
export async function clearBinding(userId: string): Promise<boolean> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const res = await col.deleteOne({ userId });
  return (res?.deletedCount ?? 0) > 0;
}