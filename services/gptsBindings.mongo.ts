import { getGptsBindingsCollection } from "@/utils/mongo";
import type { GptsBindingDoc } from "@/types/db";

let indexesReady = false;
// コレクションのインデックスを1回だけ作成
async function ensureIndexes() {
  if (indexesReady) return;
  const col = await getGptsBindingsCollection();
  // targetId のユニーク制約（この会話につき1件の紐付け）
  await col.createIndex({ targetId: 1 }, { unique: true, name: "uniq_target" });
  // TTL: updatedAt から 90 日で自動削除（運用に合わせて調整可）
  await col.createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 90, name: "ttl_updatedAt_90d" }
  );
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
      { targetId },     // 検索キー：この会話のID
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
  return col.findOne({ targetId });   // 現在の紐付けを取得（無ければ null）
}

// 紐づけ削除
export async function clearBinding(targetId: string): Promise<boolean> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const res = await col.deleteOne({ targetId });
  return (res?.deletedCount ?? 0) > 0;
}

// 紐づけ有無確認
export async function hasBinding(targetId: string): Promise<boolean> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const doc = await col.findOne({ targetId }, { projection: { _id: 1 } });
  return !!doc;
}