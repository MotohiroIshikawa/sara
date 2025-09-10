import type { ThreadInstDoc } from "@/types/db";
import { getThreadInstCollection } from "@/utils/mongo";

// TTL日数（既定7日）。必要なら環境変数で上書き: THREAD_INST_TTL_DAYS=14 など
const TTL_DAYS = Math.max(1, Number.parseInt(process.env.THREAD_INST_TTL_DAYS ?? "7", 10) || 7);

// 目的:
//  - Azure Run から抽出した instpack/meta を「ユーザ×Thread」単位で一時保存
//  - 保存ボタン押下時にここから読み出して user_gpts へ昇格

let _indexesReady = false;
// コレクションのインデックスを一度だけ作成
async function ensureIndexes(): Promise<void> {
  if (_indexesReady) return;
  const col = await getThreadInstCollection();

  // userId + threadId のユニーク制約（毎回上書き）
  await col.createIndex(
    { userId: 1, threadId: 1 },
    { unique: true, name: "uniq_user_thread" }
  );

  // TTL: updatedAt から N日 で自動削除（デフォルト7日）
  //    ※ updatedAt が無いドキュメントは対象外
  await col.createIndex(
    { updatedAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * TTL_DAYS, name: "ttl_updatedAt" }
  );

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