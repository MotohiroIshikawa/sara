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
  profile?: ProfileInput;   // 任意（取得できない/しない時は省略でOK）
  now?: Date;               // テスト等で上書きしたい時だけ
}) {
  const { userId, profile, now = new Date() } = params;
  console.info("[followUser] start", { userId, now: now.toISOString() }); //★
  await ensureUserIndexes();

  const [users, cycles] = await Promise.all([
    getUsersCollection(),
    getUserCyclesCollection(),
  ]);
  console.info("[followUser] got collections"); //★

  // 念のため、未終了の古い cycle があれば閉じる（整合性担保）
  try { //★
    const closed = await cycles.findOneAndUpdate( //★
      { userId, endAt: null },
      { $set: { endAt: new Date(now.getTime() - 1) } },
      { sort: { startAt: -1 }, returnDocument: "after" } //★
    );
    console.info("[followUser] closedPreviousIfAny", { //★
      matched: (closed as any)?.lastErrorObject?.n ?? undefined,
      value: closed?.value ? { _id: closed.value._id, startAt: closed.value.startAt, endAt: closed.value.endAt } : null,
    });
  } catch (e) {
    console.warn("[followUser] closePrevious failed (ignored)", String(e)); //★
  }

  // users（現在状態）を upsert（削除はしない）
  const up = await users.updateOne(
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
  console.info("[followUser] users.updateOne", { //★
    acknowledged: up.acknowledged,
    matchedCount: up.matchedCount,
    modifiedCount: up.modifiedCount,
    upsertedId: (up as any).upsertedId ?? null,
  });

  // 履歴に新しい cycle を追加
  const cycleId = randomUUID();
  const cycleDoc: UserCycleDoc = {
    _id: new ObjectId(), // ★DB設計変更: _id は ObjectId
    userId,
    cycleId,             // 文字列の識別子は別フィールドとして保持（運用ログなどで便利）
    startAt: now,
    endAt: null,
  };
  const ins = await cycles.insertOne(cycleDoc); //★
  console.info("[followUser] cycles.insertOne", { insertedId: ins.insertedId?.toString?.() ?? String(ins.insertedId) }); //★

  console.info("[followUser] cycle started", { userId, cycleId, startAt: now.toISOString() });
  return { cycleId };
}

/** unfollow：現在状態を isBlocked=true にし、アクティブな cycle を終了（users は物理削除運用） */
export async function unfollowUser(params: { userId: string; now?: Date }) {
  const t0 = Date.now(); //★
  const { userId, now = new Date() } = params;
  console.info("[unfollowUser] start", { userId, now: now.toISOString() }); //★
  await ensureUserIndexes();

  try { //★
    const [users, cycles] = await Promise.all([
      getUsersCollection(),
      getUserCyclesCollection(),
    ]);
    console.info("[unfollowUser] got collections"); //★

    // 直近の follow 情報（startAt 候補として使う）
    const prev = await users.findOne(
      { userId },
      { projection: { lastFollowedAt: 1 } }
    );
    const startAtCandidate = prev?.lastFollowedAt ?? now;
    console.info("[unfollowUser] prevUser", { lastFollowedAt: prev?.lastFollowedAt ?? null, startAtCandidate }); //★

    // 未終了サイクルがあれば endAt をセット。
    // 無ければ startAt を候補で作って、同時に endAt も now にして“即終了サイクル”を upsert で作る。
    const filter = { userId, endAt: null }; //★
    const update = {
      $set: { endAt: now },
      $setOnInsert: {
        _id: new ObjectId(),
        userId,
        cycleId: randomUUID(),
        startAt: startAtCandidate,
        endAt: now,
      } as Partial<UserCycleDoc>,
    }; //★
    console.info("[unfollowUser] cycles.updateOne.filter/update", { filter, update: { ...update, $setOnInsert: { ...update.$setOnInsert, _id: "<new ObjectId>" } } }); //★

    const r = await cycles.updateOne(filter, update, { upsert: true });
    console.info("[unfollowUser] cycles.updateOne.result", { //★
      acknowledged: r.acknowledged,
      matchedCount: r.matchedCount,
      modifiedCount: r.modifiedCount,
      upsertedId: (r as any).upsertedId ?? null,
    });

    // 直後に確認：最新を読んで endAt が埋まっているかチェック
    const latest = await cycles.findOne(
      { userId },
      { sort: { startAt: -1 }, projection: { _id: 1, startAt: 1, endAt: 1, cycleId: 1 } }
    );
    console.info("[unfollowUser] cycles.latestAfterUpdate", latest); //★
    if (!latest || latest.endAt == null) {
      console.warn("[unfollowUser] WARNING: latest cycle has no endAt!", latest); //★
    }

    // 現在状態のレコードは削除（履歴は cycles に残る運用）
    const del = await users.deleteOne({ userId });
    console.info("[unfollowUser] users.deleteOne", { acknowledged: del.acknowledged, deletedCount: del.deletedCount }); //★

    console.info("[unfollowUser] done", { userId, tookMs: Date.now() - t0 }); //★
  } catch (e) {
    console.error("[unfollowUser] ERROR", { userId, err: String(e) }); //★
    throw e; //★ 伝播させる
  }
}
