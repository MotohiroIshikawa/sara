import type { ThreadInstDoc } from "@/types/db";
import { getThreadInstCollection } from "@/utils/mongo";

// TTL日数（既定7日）。必要なら環境変数で上書き: THREAD_INST_TTL_DAYS=14 など
const TTL_DAYS = Math.max(1, Number.parseInt(process.env.THREAD_INST_TTL_DAYS ?? "7", 10) || 7);

// 目的:
//  - Azure Run から抽出した instpack/meta を「ユーザ×Thread」単位で一時保存
//  - 保存ボタン押下時にここから読み出して user_gpts へ昇格

let _indexesReady = false;
// コレクションのインデックスを一度だけ作成

type MaybeMongoError = { code?: number; codeName?: string; message?: string };

// エラーチェック（重複で unique index を作れないケース）
function isCannotCreateUniqueIndexError(e: unknown): boolean {
  const me = e as MaybeMongoError;
  const msg = (me?.message ?? "").toLowerCase();
  return (
    me?.code === 67 ||
    me?.codeName === "CannotCreateIndex" ||
    msg.includes("cannot create unique index") ||
    msg.includes("duplicate key") // 念のため
  );
}

// コレクションのインデックスを一度だけ作成
async function ensureIndexes(): Promise<void> {
  if (_indexesReady) return;
  const col = await getThreadInstCollection();

  // userId + threadId のユニーク制約（Cosmos Mongo は後から変更不可）
  type IndexInfo = { name?: string; key?: Record<string, number>; unique?: boolean };
  const indexes = (await col.indexes()) as IndexInfo[];
  const targetKey = { userId: 1, threadId: 1 } as const;
  const exists = indexes.find(ix => JSON.stringify(ix.key) === JSON.stringify(targetKey));
  if (!exists) {
    const docCount =
      (await col.estimatedDocumentCount().catch(() => col.countDocuments({}))) ?? 0;
    if (docCount === 0) {
      // コレクションが空のときだけ unique を試す
      try {
        await col.createIndex(targetKey, { unique: true, name: "uniq_user_thread" });
      } catch (e) {
        // Cosmos 側の制約や互換で unique 失敗 → 非ユニークにフォールバック
        if (isCannotCreateUniqueIndexError(e) ||
            String((e as Error)?.message ?? "").includes("The unique index cannot be modified")) {
          console.warn("[thread_inst] Unique index not available. Creating NON-unique index instead.");
          await col.createIndex(targetKey, { name: "idx_user_thread" }).catch(() => {});
        } else {
          throw e;
        }
      }
    } else {
      // 空でないので unique は作らず、非ユニーク index のみ作成
      console.warn("[thread_inst] Collection has documents. Cosmos Mongo cannot add a UNIQUE index post-hoc. Creating NON-unique index instead.");
      await col.createIndex(targetKey, { name: "idx_user_thread" }).catch(() => {});
    }
  } else if (exists.unique !== true) {
    console.warn("[thread_inst] Found NON-unique index on {userId,threadId}. Cosmos cannot alter to unique. Keep NON-unique.");
  }

  // TTL: updatedAt から N日 で自動削除（デフォルト7日）
  //    ※ updatedAt が無いドキュメントは対象外
  const ttlName = "ttl_updatedAt";
  const hasTTL = indexes.some(ix => ix.name === ttlName);
  if (!hasTTL) {
    try {
      await col.createIndex(
        { updatedAt: 1 },
        { expireAfterSeconds: 60 * 60 * 24 * TTL_DAYS, name: ttlName }
      );
    } catch (e) {
      const msg = String((e as Error).message || "");
      // 既存TTLが別設定で存在する場合など：Cosmos Mongo は変更不可
      if (msg.includes("cannot be modified") || msg.includes("already exists")) {
        console.warn("[thread_inst] TTL index already exists (possibly with different options). To change TTL, drop & recreate the index/collection.");
      } else {
        throw e;
      }
    }
  }
  _indexesReady = true;
}

// upsert（存在すれば更新、無ければ作成）
export async function upsertThreadInst(input: {
  userId: string;
  threadId: string;
  instpack: string;
  meta?: unknown;
  updatedAt?: Date;
}): Promise<void> {
  await ensureIndexes();
  const col = await getThreadInstCollection();
  await col.updateOne(
    { userId: input.userId, threadId: input.threadId },
    {
      $set: {
        instpack: input.instpack,
        meta: input.meta ?? null,
        updatedAt: input.updatedAt ?? new Date(),
      },
    },
    { upsert: true }
  );
}

// 取得（無ければ null）
export async function getThreadInst(
  userId: string,
  threadId: string
): Promise<ThreadInstDoc | null> {
  await ensureIndexes();
  const col = await getThreadInstCollection();
  return col.findOne({ userId, threadId });
}

// 削除（true=削除された / false=該当なし）
export async function deleteThreadInst(
  userId: string,
  threadId: string
): Promise<boolean> {
  await ensureIndexes();
  const col = await getThreadInstCollection();
  const res = await col.deleteOne({ userId, threadId });
  return (res?.deletedCount ?? 0) > 0;
}