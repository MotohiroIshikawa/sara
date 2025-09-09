import { randomUUID } from "crypto";
import { getUsersCollection, getUserCyclesCollection } from "@/utils/mongo";

export type ProfileInput = {
  displayName?: string;
  pictureUrl?: string;
  statusMessage?: string;
  language?: string;
};

export type UserDoc = {
  _id: string;            // = userId
  userId: string;
  entityType: "user";
  isBlocked: boolean;
  displayName?: string;
  pictureUrl?: string;
  statusMessage?: string;
  language?: string;
  createdAt?: Date;
  updatedAt?: Date;
  lastFollowedAt?: Date | null;
  lastUnfollowedAt?: Date | null;
};

export type UserCycleDoc = {
  _id: string;            // = cycleId
  userId: string;
  cycleId: string;        // = _id と同じでもOK
  startAt: Date;
  endAt?: Date | null;    // unfollow 時にセット
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
  await users.createIndex({ userId: 1 }).catch(swallow);
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
    { _id: userId },
    {
      $set: {
        userId,
        entityType: "user",
        isBlocked: false,
        displayName: profile?.displayName,
        pictureUrl: profile?.pictureUrl,
        statusMessage: profile?.statusMessage,
        language: profile?.language,
        lastFollowedAt: now,
      },
      $setOnInsert: { createdAt: now },
      $currentDate: { updatedAt: true },
    },
    { upsert: true }
  );

  // 履歴に新しい cycle を追加（userId + cycleId で連結 unique）
  const cycleId = randomUUID();
  await cycles.insertOne({
    _id: cycleId,
    userId,
    cycleId,
    startAt: now,
    endAt: null,
  });

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

  await users.updateOne(
    { _id: userId },
    {
      $set: { userId, entityType: "user", isBlocked: true, lastUnfollowedAt: now },
      $setOnInsert: { createdAt: now, lastFollowedAt: null },
      $currentDate: { updatedAt: true },
    },
    { upsert: true }
  );

  await cycles.findOneAndUpdate(
    { userId, endAt: null },
    { $set: { endAt: now } },
    { sort: { startAt: -1 } }
  );
}
