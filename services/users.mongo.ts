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
  console.info("[users.ensureUserIndexes] ensured"); //★
}

/** follow：現在状態を upsert ＋ 新しいフォロー期間（cycle）を開始 */ 
export async function followUser(params: { 
  userId: string;
  profile?: ProfileInput;
  now?: Date;
}) { 
  const { userId, profile, now = new Date() } = params; 
  await ensureUserIndexes(); 

  const [users, cycles] = await Promise.all([ 
    getUsersCollection(), 
    getUserCyclesCollection(), 
  ]); 
  
  // 念のため、未終了の古い cycle があれば閉じる（整合性担保） 
  await cycles.findOneAndUpdate( { 
    userId, 
    endAt: null 
  }, { 
    $set: { 
      endAt: new Date(now.getTime() - 1) 
    } 
  }, { 
    sort: { startAt: -1 } 
  } ); 

  // users（現在状態）を upsert（削除はしない） 
  await users.updateOne( 
    { userId }, { 
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
  }, { upsert: true } ); 

  // 履歴に新しい cycle を追加 
  const cycleId = randomUUID(); 
  const cycleDoc: UserCycleDoc = { 
    _id: new ObjectId(),
    userId, 
    cycleId,
    startAt: now, 
    endAt: null, 
  }; 
  await cycles.insertOne(cycleDoc); 

  console.info("[followUser] cycle started", { userId, cycleId, startAt: now.toISOString() }); 
  return { cycleId }; 
}

/** unfollow：usersは削除、cyclesは確実にクローズ */
export async function unfollowUser(params: { userId: string; now?: Date }) {
  const { userId, now = new Date() } = params;
  await ensureUserIndexes();

  const [users, cycles] = await Promise.all([
    getUsersCollection(),
    getUserCyclesCollection(),
  ]);

  // 直近の follow 時刻を取得（無ければ now を使用）
  const prev = await users.findOne(
    { userId },
    { projection: { lastFollowedAt: 1 } }
  );
  const startAt = prev?.lastFollowedAt instanceof Date ? prev.lastFollowedAt : now;

  // アクティブ cycle を終了。無ければ「即終了サイクル」を upsert。
  const newCycleId = randomUUID();
  const r = await cycles.updateOne(
    { userId, endAt: null },
    {
      $set: { endAt: now },
      $setOnInsert: {
        _id: new ObjectId(),
        userId,
        cycleId: newCycleId,
        startAt,
      } as Partial<UserCycleDoc>,
    },
    { upsert: true }
  );

  const upsertedId = (r as { upsertedId?: ObjectId }).upsertedId ?? null;

  if (r.matchedCount > 0) {
    console.info("[unfollowUser] cycle closed (existing active found)", {
      userId, matchedCount: r.matchedCount, modifiedCount: r.modifiedCount, endAt: now.toISOString()
    });
  } else if (upsertedId) {
    console.info("[unfollowUser] cycle created-and-closed (no active found)", {
      userId, upsertedId, cycleId: newCycleId, startAt: startAt.toISOString(), endAt: now.toISOString()
    });
  } else {
    // まれに matched=0 かつ upsertedId 無しのケースに備えて保険の insert
    const ins = await cycles.insertOne({
      _id: new ObjectId(),
      userId,
      cycleId: newCycleId,
      startAt,
      endAt: now,
    });
    console.warn("[unfollowUser] fallback inserted ended cycle", {
      userId, insertedId: ins.insertedId, cycleId: newCycleId
    });
  }

  // 現在状態(users)は物理削除
  const del = await users.deleteOne({ userId });
  console.info("[unfollowUser] users.deleteOne", { userId, deletedCount: del.deletedCount ?? 0 });
}

