import { getGptsBindingsCollection } from "@/utils/mongo";
import type { GptsBindingDoc } from "@/types/db";

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

export async function setBinding(
  targetId: string, 
  gptsId: string, 
  instpack: string
) {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  try {
    await col.updateOne(
      { _id: targetId },     // 検索キー：_id
      { $set: { gptsId, instpack, updatedAt: new Date() } },    // 上書き内容：gptsId / instpack / 更新日時
      { upsert: true }    // 見つからなければ作成、あれば更新
    );
  } catch (e) {
    console.error("[gptsBindings.setBinding] updateOne failed:", e);
    throw e;
  }
}

// 紐づけ取得
export async function getBinding(targetId: string): Promise<GptsBindingDoc | null> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const byId = await col.findOne({ _id: targetId });
  if (byId) return byId as GptsBindingDoc;
  // 旧データ互換（_id を使っていないレコード）
  return col.findOne({ targetId });   // 現在の紐付けを取得（無ければ null）
}

// 紐づけ削除
export async function clearBinding(targetId: string): Promise<boolean> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const res = await col.deleteOne({ _id: targetId });
  if (!res.deletedCount) {
    await col.deleteMany({ targetId }); // 旧データを掃除
  }
  return (res?.deletedCount ?? 0) > 0;
}

// 紐づけ有無確認
export async function hasBinding(targetId: string): Promise<boolean> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  // まず _id を見る（新フォーマット）
  const byId = await col.findOne({ _id: targetId }, { projection: { _id: 1 } });
  if (byId) return true;
  // 旧フォーマットにフォールバック
  const legacy = await col.findOne({ targetId }, { projection: { _id: 1 } });
  return !!legacy;
}