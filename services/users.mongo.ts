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

/** unfollow：現在状態を削除し、アクティブな cycle を終了（無ければ即終了サイクルを作成） */
export async function unfollowUser(params: { userId: string; now?: Date }) {
  const { userId, now = new Date() } = params;
  console.info("[unfollowUser] start", { userId, now: now.toISOString() });

  type UnfollowSummary = {
    gotCollections: boolean;
    prevLastFollowedAt: Date | null;
    startAtCandidate: Date | null;
    cyclesUpdate?: {
      acknowledged: boolean;
      matchedCount: number;
      modifiedCount: number;
      upsertedId: ObjectId | null;
      upsertedCount: number;
    };
    cyclesFallbackInsertId?: ObjectId | null;
    usersDeletedCount: number | null;
    errors: Array<{ where: string; err: string }>;
  };

  const summary: UnfollowSummary = {
    gotCollections: false,
    prevLastFollowedAt: null,
    startAtCandidate: null,
    usersDeletedCount: null,
    errors: [],
  };

  try {
    await ensureUserIndexes();
  } catch (e) {
    summary.errors.push({ where: "ensureUserIndexes", err: String(e) });
    console.error("[unfollowUser] ensureUserIndexes error", e);
    // 続行（多くの環境で index 無くても動作はする）
  }

  const [users, cycles] = await Promise.all([
    getUsersCollection(),
    getUserCyclesCollection(),
  ]).catch((e) => {
    summary.errors.push({ where: "getCollections", err: String(e) });
    console.error("[unfollowUser] getCollections error", e);
    return [undefined, undefined] as const;
  });

  if (!users || !cycles) {
    console.info("[unfollowUser] summary", summary);
    return;
  }
  summary.gotCollections = true;
  console.info("[unfollowUser] got collections");

  // 直近の follow 情報（startAt 候補として使う）
  try {
    const prev = await users.findOne(
      { userId },
      { projection: { lastFollowedAt: 1 } }
    );
    const last =
      prev && prev.lastFollowedAt instanceof Date ? prev.lastFollowedAt : null;
    summary.prevLastFollowedAt = last;
    summary.startAtCandidate = last ?? now;
    console.info("[unfollowUser] prevUser", {
      lastFollowedAt: summary.prevLastFollowedAt,
      startAtCandidate: summary.startAtCandidate,
    });
  } catch (e) {
    summary.errors.push({ where: "users.findOne", err: String(e) });
    console.error("[unfollowUser] users.findOne error", e);
    summary.startAtCandidate = now; // フォールバック
  }

  const startAt = summary.startAtCandidate ?? now;

  // 未終了サイクルがあれば endAt をセット。
  // 無ければ startAt を候補で作って、同時に endAt も now にして“即終了サイクル”を upsert で作る。
  try {
    const filter = { userId, endAt: null as Date | null };
    const update = {
      $set: { endAt: now },
      $setOnInsert: {
        _id: new ObjectId(),
        userId,
        cycleId: randomUUID(),
        startAt,
        endAt: now,
      } as Partial<UserCycleDoc>,
    };
    console.info("[unfollowUser] cycles.updateOne.filter/update", { filter, update });

    const r = await cycles.updateOne(filter, update, { upsert: true });
    const upsertedId: ObjectId | null =
      (r as { upsertedId?: ObjectId }).upsertedId ?? null;
    const upsertedCount = upsertedId ? 1 : 0;

    summary.cyclesUpdate = {
      acknowledged: r.acknowledged,
      matchedCount: r.matchedCount,
      modifiedCount: r.modifiedCount,
      upsertedId,
      upsertedCount,
    };
    console.info("[unfollowUser] cycles.updateOne.result", summary.cyclesUpdate);

    // まれに matched 0 かつ upsertedId も無い場合に備えて保険
    if (r.matchedCount === 0 && !upsertedId) {
      const ins = await cycles.insertOne({
        _id: new ObjectId(),
        userId,
        cycleId: randomUUID(),
        startAt,
        endAt: now,
      });
      summary.cyclesFallbackInsertId = ins.insertedId;
      console.warn("[unfollowUser] fallback inserted ended cycle", {
        insertedId: ins.insertedId,
      });
    }
  } catch (e) {
    summary.errors.push({ where: "cycles.updateOne", err: String(e) });
    console.error("[unfollowUser] cycles.updateOne error", e);
    // 最低限のフォールバック
    try {
      const ins = await cycles.insertOne({
        _id: new ObjectId(),
        userId,
        cycleId: randomUUID(),
        startAt,
        endAt: now,
      });
      summary.cyclesFallbackInsertId = ins.insertedId;
      console.warn(
        "[unfollowUser] fallback inserted ended cycle (after update error)",
        { insertedId: ins.insertedId }
      );
    } catch (ee) {
      summary.errors.push({ where: "cycles.insertOne.fallback", err: String(ee) });
      console.error("[unfollowUser] cycles.insertOne fallback error", ee);
    }
  }

  // 現在状態(users)は削除（履歴は cycles に残す）
  try {
    const del = await users.deleteOne({ userId });
    summary.usersDeletedCount = del.deletedCount ?? 0;
    console.info("[unfollowUser] users.deleteOne", {
      deletedCount: del.deletedCount,
    });
  } catch (e) {
    summary.errors.push({ where: "users.deleteOne", err: String(e) });
    console.error("[unfollowUser] users.deleteOne error", e);
  }

  console.info("[unfollowUser] summary", summary);
}
