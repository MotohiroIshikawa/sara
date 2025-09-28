import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import type { UserCycleDoc, UserDoc } from "@/types/db";
import { getUsersCollection, getUserCyclesCollection } from "@/utils/mongo";

export type ProfileInput = {
  displayName?: string;
  pictureUrl?: string;
  statusMessage?: string;
  language?: string;
};

function swallow(e: unknown) {
  // インデックス衝突や権限で失敗してもウォームアップを止めない
  console.warn("[indexes] skipped:", (e as Error)?.message ?? e);
}

let _indexesEnsured = false;
/** 初回だけインデックス作成（idempotent） */
export async function ensureUserIndexes() {
  if (_indexesEnsured) return;
  const users = await getUsersCollection();
  const cycles = await getUserCyclesCollection();
  await users.createIndex({ userId: 1 }, { unique: true }).catch(swallow);
  await cycles.createIndex({ userId: 1, startAt: -1 }).catch(swallow);
  await cycles.createIndex({ userId: 1, endAt: 1 }).catch(swallow);
  await cycles.createIndex({ userId: 1, cycleId: 1 }).catch(swallow);
  _indexesEnsured = true;
}

/** follow：現在状態を upsert ＋ 新しいフォロー期間（cycle）を開始 */
export async function followUser(params: {
  userId: string;
  profile?: ProfileInput;   // 任意（取得できない/しない時は省略でOK）
  now?: Date;               // テスト等で上書きしたい時だけ
}) {
  const { userId, profile, now = new Date() } = params;
  await ensureUserIndexes();

  const [users, cycles] = await Promise.all([
    getUsersCollection(),
    getUserCyclesCollection(),
  ]);

  // 念のため、未終了の古い cycle があれば閉じる（整合性担保）
  await cycles.findOneAndUpdate(
    { userId, endAt: null },
    { $set: { endAt: new Date(now.getTime() - 1) } },
    { sort: { startAt: -1 } }
  );

  // users（現在状態）を upsert（削除はしない）
  await users.updateOne(
    { userId },
    {
      $set: {
        userId,
        isBlocked: false,
        displayName: profile?.displayName,
        pictureUrl: profile?.pictureUrl,
        statusMessage: profile?.statusMessage,
        language: profile?.language,
        lastFollowedAt: now,
      },
      $setOnInsert: <Partial<UserDoc>>{
        _id: new ObjectId(),
        createdAt: now,
      },
      $currentDate: { updatedAt: true },
    },
    { upsert: true }
  );

  // 履歴に新しい cycle を追加
  const cycleId = randomUUID();
  const cycleDoc: UserCycleDoc = {
    _id: new ObjectId(), // ★DB設計変更: _id は ObjectId
    userId,
    cycleId,             // 文字列の識別子は別フィールドとして保持（運用ログなどで便利）
    startAt: now,
    endAt: null,
  };
  await cycles.insertOne(cycleDoc);

  console.info("[followUser] cycle started", { userId, cycleId, startAt: now.toISOString() });

  return { cycleId };
}

/** unfollow：現在状態を isBlocked=true にし、アクティブな cycle を終了 */
export async function unfollowUser(params: { userId: string; now?: Date }) {
  const { userId, now = new Date() } = params;
  await ensureUserIndexes();

  const [users, cycles] = await Promise.all([
    getUsersCollection(),
    getUserCyclesCollection(),
  ]);

  // 直近の follow 情報（startAt 候補として使う）
  const prev = await users.findOne(
    { userId },
    { projection: { lastFollowedAt: 1 } }
  );
  const startAtCandidate = prev?.lastFollowedAt ?? now;

  // 未終了サイクルがあれば endAt をセット。
  // 無ければ startAt を候補で作って、同時に endAt も now にして“即終了サイクル”を upsert で作る。
  await cycles.updateOne(
    { userId, endAt: null },
    {
      $set: { endAt: now },
      $setOnInsert: {
        _id: new ObjectId(),
        userId,
        cycleId: randomUUID(),
        startAt: startAtCandidate,
        endAt: now,
      } as Partial<UserCycleDoc>,
    },
    { upsert: true }
  );

  // 現在状態のレコードは削除（履歴は cycles に残る運用）
  await users.deleteOne({ userId });
}