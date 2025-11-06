import type { GptsBindingDoc } from "@/types/db";
import type { SourceType } from "@/types/gpts";
import { envInt } from "@/utils/env";
import { getGptsBindingsCollection } from "@/utils/mongo";

// TTL（日数）。未設定なら 30 日に。
const BINDINGS_TTL_DAYS = envInt("GPTS_BINDINGS_TTL_DAYS", 14, { min: 1, max: 365 });

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

  const seconds: number = BINDINGS_TTL_DAYS * 24 * 60 * 60;
  const ttlName: string = `ttl_updatedAt_${BINDINGS_TTL_DAYS}d`;
  try {
    await col.createIndex(
      { updatedAt: 1 },
      { expireAfterSeconds: seconds, name: ttlName }
    );
  } catch (e) {
    const msg = String((e as Error)?.message ?? "");
    if (msg.includes("already exists") || msg.includes("cannot be created") || msg.includes("cannot be modified")) {
      console.warn(
        `[gpts_bindings] TTL index create/modify skipped. existing TTL may differ. ` +
        `If you need to change it, drop the old TTL index manually then restart. ` +
        `(requested=${BINDINGS_TTL_DAYS}d, name=${ttlName})`
      );
    } else {
      throw e;
    }
  }

  indexesReady = true;
}

// join直後のドラフトbindingを upsert（既存値があれば保持、無ければ空で作成）
export async function upsertDraftBinding(
  sourceType: SourceType,
  sourceId: string
): Promise<void> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const now: Date = new Date();

  // 既存があれば gptsId/instpack を保持、無ければ空文字でプレースホルダ 
  const cur = await col.findOne(
    { targetType: sourceType, targetId: sourceId },
    { projection: { _id: 1, gptsId: 1, instpack: 1 } }
  );

  const $set: Omit<GptsBindingDoc, "_id" | "createdAt"> = {
    targetType: sourceType,
    targetId: sourceId,
    gptsId: cur?.gptsId ?? "",
    instpack: cur?.instpack ?? "",
    isPendingApply: true,
    updatedAt: now,
  };

  await col.updateOne(
    { targetType: sourceType, targetId: sourceId },
    { $set, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}

// 適用（新規 or 更新）
export async function setBinding(
  sourceType: SourceType,
  sourceId: string,
  gptsId: string, 
  instpack: string
): Promise<void> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const now: Date = new Date();

const $set: Omit<GptsBindingDoc, "_id" | "createdAt"> = {
    targetType: sourceType,
    targetId: sourceId,
    gptsId,
    instpack,
    updatedAt: now,
    isPendingApply: false, // joinで追加されたときは初期false
  };

  await col.updateOne(
    { targetType: sourceType, targetId: sourceId },
    { $set, $setOnInsert: { createdAt: now } },
    { upsert: true }
  );
}

// 取得（存在しなければ null）
export async function getBinding(
  sourceType: SourceType,
  sourceId: string
): Promise<GptsBindingDoc | null> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  return col.findOne({ targetType: sourceType, targetId: sourceId });
}

// 解除（削除）
export async function clearBinding(
  sourceType: SourceType,
  sourceId: string
): Promise<boolean> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();
  const r = await col.deleteOne({ targetType: sourceType, targetId: sourceId });
  return (r?.deletedCount ?? 0) > 0;
}

// 指定 gptsId が適用中のときだけ解除（安全解除）
export async function clearBindingIfMatches(
  sourceType: SourceType,
  sourceId: string,
  gptsId: string
): Promise<boolean> {
  await ensureIndexes();
  const col = await getGptsBindingsCollection();

  const cur = await col.findOne(
    { targetType: sourceType, targetId: sourceId },
    { projection: { _id: 1, gptsId: 1 } }
  );

  if (!cur || cur.gptsId !== gptsId) return false;

  const r = await col.deleteOne({ _id: cur._id });
  return (r?.deletedCount ?? 0) > 0;
}

interface GptsAppliedTarget {
  targetType: "group" | "room";
  targetId: string;
  gptsId: string;
  instpack: string;
}

// ユーザ所有GPTS（gptsId群）を適用中の group/room ターゲット一覧を取得 -> グループ作成後のunfollow対応
export async function listTargetsByGptsIds(
  gptsIds: ReadonlyArray<string>
): Promise<GptsAppliedTarget[]> {
  await ensureIndexes();
  const ids: string[] = (gptsIds ?? []).filter((s: string) => typeof s === "string" && s.length > 0);
  if (ids.length === 0) return [];

  const col = await getGptsBindingsCollection();
  const cursor = col.find(
    {
      targetType: { $in: ["group", "room"] },
      gptsId: { $in: ids },
    },
    { projection: { _id: 0, targetType: 1, targetId: 1, gptsId: 1, instpack: 1 } }
  );

  const docs = await cursor.toArray();
  const out: GptsAppliedTarget[] = docs.map((d: unknown) => {
    const o = d as { targetType: "group" | "room"; targetId: string; gptsId: string; instpack?: string };
    return {
      targetType: o.targetType,
      targetId: o.targetId,
      gptsId: o.gptsId,
      instpack: typeof o.instpack === "string" ? o.instpack : "",
    };
  });

  // 念のため重複除去（gptsId×targetType×targetId）
  const uniqKey = (t: GptsAppliedTarget): string => `${t.gptsId}::${t.targetType}:${t.targetId}`;
  const seen = new Set<string>();
  const dedup: GptsAppliedTarget[] = [];
  for (const t of out) {
    const k = uniqKey(t);
    if (!seen.has(k)) {
      seen.add(k);
      dedup.push(t);
    }
  }
  return dedup;
}

// 現在のbindingの取得
export async function findActiveBinding(
  sourceType: SourceType,
  sourceId: string
): Promise<GptsBindingDoc | null> {
  await ensureIndexes();
  const doc = await getBinding(sourceType, sourceId);
  if (!doc) return null;

  const ok =
    doc.isPendingApply === false &&
    typeof doc.instpack === "string" &&
    doc.instpack.trim().length > 0;
  return ok ? doc : null;
}