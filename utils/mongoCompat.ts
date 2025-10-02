import type { Collection, Document, Filter, FindOneAndUpdateOptions, UpdateFilter, WithId } from "mongodb";
import { envBool } from "@/utils/env";

const DEBUG = envBool("DEBUG_FIND_ONE_AND_UPDATE_COMPAT", false);

type UpdatePipeline<T extends Document> = UpdateFilter<T> | Document[];

export type CompatModifyResult<T extends Document> = {
  ok: 1;
  lastErrorObject?: { n?: number; updatedExisting?: boolean };
  value: T | null;
};

/** v5/v6 の差異を吸収して value を取り出す */
function normalizeNativeResult<T extends Document>(
  nativeRes: unknown
): CompatModifyResult<T> {
  // v6 (デフォルト): WithId<T> | null
  if (nativeRes && typeof nativeRes === "object" && !("value" in (nativeRes as object))) {
    const val = nativeRes as WithId<T>;
    return { ok: 1, value: (val ?? null) as T | null };
  }
  // v5 or v6(includeResultMetadata: true): { value, ok, lastErrorObject, ... }
  const r = nativeRes as { value?: T | null; ok?: number; lastErrorObject?: { n?: number; updatedExisting?: boolean } };
  return {
    ok: (typeof r?.ok === "number" ? r.ok : 1) as 1,
    lastErrorObject: r?.lastErrorObject,
    value: (r?.value ?? null) as T | null,
  };
}

/**
 * Cosmos Mongo API で「条件付き findOneAndUpdate が null を返す」事象の互換ラッパ。
 *
 * 方針:
 *  1. まず素の findOneAndUpdate を試す（成功なら即返す）
 *  2. value === null のときのみフォールバック:
 *     - filter で findOne → 候補があるか確認
 *     - あれば _id と optimisticFilter（例: claimedAt が null/missing）を AND して updateOne
 *     - returnDocument に応じて before/after のドキュメントを返す
 *
 * 注意:
 *  - フォールバック時は _id が必須。_id を持たない集合では使用しないこと。
 *  - optimisticFilter は「まだ未取得」の条件（null/missing）を想定。
 */
export async function findOneAndUpdateCompat<T extends Document>(
  col: Collection<T>,
  filter: Filter<T>,
  update: UpdatePipeline<T>,
  options: (FindOneAndUpdateOptions & { optimisticFilter?: Filter<T> }) = {},
): Promise<CompatModifyResult<T>> {
  const { optimisticFilter, ...nativeOptsRaw } = options;

  // v6 でメタ付きにする（v5では無視される）
  const nativeOpts: FindOneAndUpdateOptions & { includeResultMetadata?: boolean } = {
    includeResultMetadata: true,
    ...nativeOptsRaw,
  };

  // 1. 元々のfindOneAndUpdateを試す
  try {
    const nativeRes = await col.findOneAndUpdate(filter, update, nativeOpts);
    const norm = normalizeNativeResult<T>(nativeRes);
    if (norm.value) {
      if (DEBUG) console.info("[compat] native hit", { collection: col.collectionName });
      return norm;
    }
    if (DEBUG) {
      console.warn("[compat] native returned null, trying fallback", {
        collection: col.collectionName,
      });
    }
  } catch (e) {
    if (DEBUG) {
      console.warn("[compat] native threw, trying fallback", {
        collection: col.collectionName,
        err: (e as Error).message,
      });
    }
  }

  // 2. フォールバック: まず候補を読む
  const candidate = await col.findOne(filter);
  if (!candidate) {
    if (DEBUG) {
      console.info("[compat] fallback: no candidate by filter", {
        collection: col.collectionName,
      });
    }
    return { ok: 1, lastErrorObject: { n: 0, updatedExisting: false }, value: null };
  }

  // _id 必須（WithId<T>に絞る）
  const c = candidate as WithId<T>;

  // _id + optimistic 条件で updateOne（＝確保）
  const optimistic: Filter<T> = optimisticFilter
    ? ({ _id: c._id, ...optimisticFilter } as unknown as Filter<T>)
    : ({ _id: c._id } as unknown as Filter<T>);

  const upd = await col.updateOne(optimistic, update);
  if (upd.matchedCount === 0 || upd.modifiedCount === 0) {
    if (DEBUG) {
      console.info("[compat] fallback: not modified", {
        collection: col.collectionName,
        matched: upd.matchedCount,
        modified: upd.modifiedCount,
      });
    }
    return { ok: 1, lastErrorObject: { n: 0, updatedExisting: false }, value: null };
  }

  const returnAfter =
    ((nativeOptsRaw.returnDocument ?? "before") as "before" | "after") === "after";
  const value = returnAfter ? await col.findOne({ _id: c._id } as Filter<T>) : (candidate as T);

  if (DEBUG) {
    console.info("[compat] fallback: updated", {
      collection: col.collectionName,
      returnAfter,
    });
  }

  return {
    ok: 1,
    lastErrorObject: { n: 1, updatedExisting: true },
    value: (value ?? null) as T | null,
  };
}
