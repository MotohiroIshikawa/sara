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

// ADDED: 重複/不正データを除去してから unique index を張るための前処理
async function dedupeAndSanitize(): Promise<{ removed: number }> {
  const col = await getThreadInstCollection();
  const cursor = col.find(
    {},
    { projection: { _id: 1, userId: 1, threadId: 1, updatedAt: 1 } }
  );

  const keepLatestByKey = new Map<string, { _id: unknown; updatedAt: number }>();
  const toDeleteIds: unknown[] = [];

  // まず、不正ドキュメント（userId/threadId が文字列でない）を除去対象へ
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;

    const u = doc.userId;
    const t = doc.threadId;
    const isValid = typeof u === "string" && u.length > 0 && typeof t === "string" && t.length > 0;

    if (!isValid) {
      toDeleteIds.push(doc._id);
      continue;
    }

    const key = `${u}::${t}`;
    const cur = keepLatestByKey.get(key);
    const ts = (doc.updatedAt instanceof Date) ? doc.updatedAt.getTime() : (Number(new Date(doc.updatedAt)) || 0);

    if (!cur) {
      keepLatestByKey.set(key, { _id: doc._id, updatedAt: ts });
    } else {
      // 同一 (userId, threadId) が複数ある場合は、updatedAt が新しい方を残す
      if (ts > cur.updatedAt) {
        toDeleteIds.push(cur._id);
        keepLatestByKey.set(key, { _id: doc._id, updatedAt: ts });
      } else {
        toDeleteIds.push(doc._id);
      }
    }
  }

  let removed = 0;
  if (toDeleteIds.length) {
    const res = await (await getThreadInstCollection()).deleteMany({ _id: { $in: toDeleteIds } });
    removed = res?.deletedCount ?? 0;
  }
  return { removed };
}

// ADDED: エラーチェック（重複で unique index を作れないケース）
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
    try {
      await col.createIndex(targetKey, { unique: true, name: "uniq_user_thread" });
    } catch (e) {
      const msg = String((e as Error).message || "");
      // 既存ドキュメントの重複で作れないケース → データ整理して再試行
      if (isCannotCreateUniqueIndexError(e)) { // ADDED
        console.warn("[thread_inst] Found duplicates or invalid docs. Sanitizing before creating unique index...");
        const { removed } = await dedupeAndSanitize(); // ADDED
        console.warn(`[thread_inst] Sanitized documents removed: ${removed}`); // ADDED
        // 再試行
        try {
          await col.createIndex(targetKey, { unique: true, name: "uniq_user_thread" }); // ADDED
        } catch (e2) {
          // それでも作れないなら諦めて警告のみ（運用でコレクション再作成を案内）
          console.warn("[thread_inst] Failed to create unique index after sanitize. Consider dropping & recreating the collection.", e2); // ADDED
        }
      } else if (msg.includes("The unique index cannot be modified")) {
        console.warn("[thread_inst] Index already exists with different options. Skip creating. To change it, drop & recreate collection `thread_inst`.");
      } else {
        throw e;
      }
    }
  } else if (exists.unique !== true) {
    console.warn("[thread_inst] Found NON-unique index on {userId,threadId}. Cosmos Mongo cannot alter to unique. Consider recreating collection if strict uniqueness is required.");
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