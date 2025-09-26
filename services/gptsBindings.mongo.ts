import type { GptsBindingDoc, BindingTarget } from "@/types/db";
import { getGptsBindingsCollection } from "@/utils/mongo";

// コレクションのインデックスを1回だけ作成
let indexesReady = false;
async function ensureIndexes() {
  if (indexesReady) return;
  const col = await getGptsBindingsCollection();

  await col.createIndex(
    { targetType: 1, targetId: 1 }, { unique: true, name: "uniq_target" }
  ).catch(() => {});

  await col.createIndex(
    { gptsId: 1 }, { name: "gptsId_1" }
  ).catch(() => {});

  await col.createIndex(
    { updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90, name: "ttl_updatedAt_90d" }
  ).catch(() => {});

  indexesReady = true;
}

/** 適用（新規 or 更新） */
export async function setBinding(target: BindingTarget, gptsId: string, instpack: string): Promise<void> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const now = new Date();

const $set: Omit<GptsBindingDoc, "_id" | "createdAt"> = {
    targetType: target.type,
    targetId: target.targetId,
    gptsId,
    instpack,
    updatedAt: now,
  };

  await col.updateOne(
    { targetType: target.type, targetId: target.targetId },
    { $set, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}

/** 取得（存在しなければ null） */
export async function getBinding(target: BindingTarget): Promise<GptsBindingDoc | null> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  return col.findOne({ targetType: target.type, targetId: target.targetId });
}

/** 解除（削除） */
export async function clearBinding(target: BindingTarget): Promise<boolean> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const r = await col.deleteOne({ targetType: target.type, targetId: target.targetId });
  return (r?.deletedCount ?? 0) > 0;
}

/** 指定 gptsId が適用中のときだけ解除（安全解除） */
export async function clearBindingIfMatches(target: BindingTarget, gptsId: string): Promise<boolean> {  await ensureIndexes();
  await ensureIndexes();
  const col = await getGptsBindingsCollection();

  const cur = await col.findOne(
    { targetType: target.type, targetId: target.targetId },
    { projection: { _id: 1, gptsId: 1 } }
  );

  if (!cur || cur.gptsId !== gptsId) return false;

  const r = await col.deleteOne({ _id: cur._id });
  return (r?.deletedCount ?? 0) > 0;
}