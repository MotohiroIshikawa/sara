import type { ThreadInstDoc } from "@/types/db";
import type { Meta } from "@/types/gpts";
import { getThreadInstCollection } from "@/utils/mongo";

// TTL日数（既定7日）。必要なら環境変数で上書き: THREAD_INST_TTL_DAYS=14 など
const TTL_DAYS: number = Math.max(1, Number.parseInt(process.env.THREAD_INST_TTL_DAYS ?? "7", 10) || 7);

// 目的:
//  - Azure Run から抽出した instpack/meta を「ユーザ×Thread」単位で一時保存
//  - 保存ボタン押下時にここから読み出して user_gpts へ昇格
//  - metaCarry（最小meta継承）を「ユーザ×Thread」単位で保存し、次ターンの computeMeta(rawMeta, prevMeta) に渡す

let _indexesReady = false;

// Cosmos 互換向けユーティリティ
type MaybeMongoError = { code?: number; codeName?: string; message?: string };

// metaCarry は extractMetaCarry(metaNorm) の戻りを保存する想定。
// 厳密型が別にあるならそれを使いたいが、ここでは「Meta の部分集合」として Partial<Meta> で保持する。
export type MetaCarry = Partial<Meta>;

// 最小ユーティリティ（Mongo返却の型安全用）
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

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
        if (
          isCannotCreateUniqueIndexError(e) ||
          String((e as Error)?.message ?? "").includes("The unique index cannot be modified")
        ) {
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
export async function upsertThreadInst(
  userId: string,
  threadId: string,
  instpack: string,
  meta?: Meta | null,
  updatedAt?: Date
): Promise<void> {
  await ensureIndexes();
  const col = await getThreadInstCollection();
  const now = updatedAt ?? new Date();

  await col.updateOne(
    { userId, threadId },
    {
      $set: {
        instpack,
        meta: meta ?? null,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}

/**  取得（無ければ null） */
export async function getThreadInst(
  userId: string,
  threadId: string
): Promise<ThreadInstDoc | null> {
  await ensureIndexes();
  const col = await getThreadInstCollection();
  return col.findOne({ userId, threadId });
}

/** 削除（true=削除された / false=該当なし） */
export async function deleteThreadInst(
  userId: string,
  threadId: string
): Promise<boolean> {
  await ensureIndexes();
  const col = await getThreadInstCollection();
  const res = await col.deleteOne({ userId, threadId });
  return (res?.deletedCount ?? 0) > 0;
}

// 対象ユーザのThread一括削除
export async function purgeAllThreadInstByUser(
  userId: string
): Promise<boolean> {
  await ensureIndexes();
  const col = await getThreadInstCollection();
  const res = await col.deleteMany({ userId });
  return (res?.deletedCount ?? 0) > 0;
}

// ============================================================================
// metaCarry（最小meta継承）の保存/取得
// ============================================================================

/**
 * metaCarry 取得（無ければ undefined）
 * - 保存は threadId 紐づけ（このコレクションは userId+threadId で一意/準一意）
 * - TTL は updatedAt に乗る（setMetaCarry で updatedAt 更新）
 */
export async function getMetaCarry(
  userId: string,
  threadId: string
): Promise<MetaCarry | undefined> {
  await ensureIndexes();
  const col = await getThreadInstCollection();

  const doc: unknown = await col.findOne(
    { userId, threadId },
    { projection: { metaCarry: 1 } }
  );

  if (!isRecord(doc)) return undefined;
  const carry = (doc as { metaCarry?: MetaCarry | null }).metaCarry;
  return carry ?? undefined;
}

/**
 * metaCarry 保存（存在すれば更新、無ければ作成）
 * - metaCarry は extractMetaCarry(metaNorm) の戻りをそのまま入れる想定
 * - updatedAt を更新して TTL を延命
 * - instpack/meta 本体は触らない（別経路で更新する）
 */
export async function setMetaCarry(
  userId: string,
  threadId: string,
  metaCarry: MetaCarry,
  updatedAt?: Date
): Promise<void> {
  await ensureIndexes();
  const col = await getThreadInstCollection();
  const now = updatedAt ?? new Date();

  await col.updateOne(
    { userId, threadId },
    {
      $set: {
        metaCarry,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true }
  );
}
