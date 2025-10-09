import { randomUUID, createHash } from "crypto";
import type { UpdateFilter } from "mongodb";
import type { GptsDoc, UserGptsDoc } from "@/types/db";
import { 
  getGptsCollection, 
  getUserGptsCollection,
  touchForUpdate,
  withTimestampsForCreate
} from "@/utils/mongo";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function newGptsId() {
  return "gpts_" + randomUUID().replace(/-/g, "");
}

// 作成
export async function createGpts(input: {
  userId: string;
  name: string;
  instpack: string;
}): Promise<GptsDoc> {
  const colGpts = await getGptsCollection();
  const colUserGpts = await getUserGptsCollection();
  const gptsId = newGptsId();
  const doc: Omit<GptsDoc, "_id"> = withTimestampsForCreate({
    gptsId,
    userId: input.userId,
    name: input.name,
    instpack: input.instpack,
    hash: sha256(input.instpack),
    // originalGptsId / autherUserId は作成時は未設定
    isPublic: true,
  });

  const res = await colGpts.insertOne(doc as GptsDoc);

  // user_gpts はリンクのみ（冗長データは持たない）
  const link: Omit<UserGptsDoc, "_id"> = withTimestampsForCreate({
    userId: input.userId,
    gptsId,
  });
  await colUserGpts.updateOne(
    { userId: link.userId, gptsId: link.gptsId },
    { $setOnInsert: link },
    { upsert: true }
  );

  return { ...(doc as GptsDoc), _id: res.insertedId };
}

// 単一取得（存在しなければ null）
export async function getGptsById(gptsId: string): Promise<GptsDoc | null> {
  const colGpts = await getGptsCollection();
  return colGpts.findOne({ gptsId });
}

// 更新
export async function updateGpts(params: {
  gptsId: string;
  userId: string; // 所有者
  name?: string;
  instpack?: string;
  isPublic?: boolean;
}): Promise<GptsDoc | null> {
  const colGpts = await getGptsCollection();

  const $set: Partial<GptsDoc> = {};
  if (typeof params.name === "string") $set.name = params.name;
  if (typeof params.instpack === "string") {
    $set.instpack = params.instpack;
    $set.hash = sha256(params.instpack);
  }
  if (typeof params.isPublic === "boolean") {
    $set.isPublic = params.isPublic;
  }

 // DEBUG
  console.info("[gpts.update:debug] recv_params", {
    gptsId: params.gptsId,
    userId: params.userId,
    hasName: typeof params.name === "string",
    hasInst: typeof params.instpack === "string",
    isPublic: typeof params.isPublic === "boolean" ? params.isPublic : "(unset)",
  });

  if (Object.keys($set).length === 0) {
    return colGpts.findOne({ gptsId: params.gptsId, userId: params.userId });
  }

  // DEBUG
  const before: Pick<GptsDoc, "userId" | "isPublic"> | null = await colGpts.findOne(
    { gptsId: params.gptsId },
    { projection: { _id: 0, userId: 1, isPublic: 1 } }
  );

  // DEBUG
  console.info("[gpts.update:debug] $set", { $set });

  const res = await colGpts.findOneAndUpdate(
    { gptsId: params.gptsId, userId: params.userId },
    { $set: touchForUpdate($set) },
    { returnDocument: "after" }
  );

  // DEBUG
  const rawUnknown: unknown = res;
  const hasWrapper: boolean =
    rawUnknown !== null &&
    typeof rawUnknown === "object" &&
    "value" in (rawUnknown as Record<string, unknown>);
  let updatedIsPublic: boolean | null = null;
  if (hasWrapper) {
    const v: unknown = (rawUnknown as { value: unknown }).value;
    if (v && typeof v === "object" && "isPublic" in (v as Record<string, unknown>)) {
      const ip: unknown = (v as { isPublic?: unknown }).isPublic;
      updatedIsPublic = typeof ip === "boolean" ? ip : null;
    }
  } else if (rawUnknown && typeof rawUnknown === "object" && "isPublic" in (rawUnknown as Record<string, unknown>)) {
    const ip: unknown = (rawUnknown as { isPublic?: unknown }).isPublic;
    updatedIsPublic = typeof ip === "boolean" ? ip : null;
  }
  console.info("[gpts.update:debug] after_update", {
    hasWrapper,
    beforeIsPublic: before?.isPublic ?? null,
    updatedIsPublic,
  });

  // DEBUG
  if (typeof params.isPublic === "boolean" && updatedIsPublic !== null && updatedIsPublic !== params.isPublic) {
    const afterRead: Pick<GptsDoc, "isPublic"> | null = await colGpts.findOne(
      { gptsId: params.gptsId },
      { projection: { _id: 0, isPublic: 1 } }
    );
    console.warn("[gpts.update:debug] mismatch_after_update", {
      expected: params.isPublic,
      updatedIsPublic,
      afterReadIsPublic: afterRead?.isPublic ?? null,
    });
  }

  return res;
}

// 指定ユーザのgptsをすべて論理削除
export async function softDeleteAllGptsByUser(userId: string): Promise<number> {
  const col = await getGptsCollection();
  const now = new Date();
  const update: UpdateFilter<GptsDoc> = {
    $set: {
      deletedAt: now,
      updatedAt: now,
    } as Pick<GptsDoc, "deletedAt" | "updatedAt">,
  };
  const r = await col.updateMany(
    { userId, deletedAt: { $exists: false } },
    update
  );
  return r?.modifiedCount ?? 0;
}

// ユーザ所有の gptsId 一覧を取得 -> グループ作成後のunfollow対応
export async function listGptsIdsByUser(userId: string): Promise<string[]> {
  const col = await getGptsCollection();
  const docs = await col.find(
    { userId, /* deletedAt は見ない（存在していても対象に含めたい）*/ },
    { projection: { _id: 0, gptsId: 1 } }
  ).toArray();
  return docs
    .map((d: { gptsId?: string }) => (typeof d.gptsId === "string" ? d.gptsId : ""))
    .filter((id: string) => id.length > 0);
}

/** コピー：正本を複製し、originalGptsId / autherUserId を付与。user_gpts にリンク作成
 * TODO: コピーを作るようになったら復活
 * ※isPublicをfalseにすること
 *
export async function copyGpts(params: {
  originalGptsId: string;       // コピー元
  userId: string;               // コピーする人
  renameTo?: string;
}): Promise<GptsDoc | null> {
  const colGpts = await getGptsCollection();
  const colUserGpts = await getUserGptsCollection();

  const src = await colGpts.findOne(
    { gptsId: params.originalGptsId },
    { projection: { _id: 0 } }
  );
  if (!src) return null;

  const gptsId = newGptsId();
  const cloned: Omit<GptsDoc, "_id"> = withTimestampsForCreate({
    gptsId,
    userId: params.userId,
    name: params.renameTo ?? src.name,
    instpack: src.instpack,
    hash: src.hash ?? sha256(src.instpack),
    originalGptsId: src.gptsId,
    autherUserId: src.userId,
    isPublic: src.isPublic ?? false,
  });

  const res = await colGpts.insertOne(cloned as GptsDoc);

  // user_gpts にリンク作成
  const link: Omit<UserGptsDoc, "_id"> = withTimestampsForCreate({
    userId: params.userId,
    gptsId,
  });
  await colUserGpts.updateOne(
    { userId: link.userId, gptsId: link.gptsId },
    { $setOnInsert: link },
    { upsert: true }
  );

  return { ...(cloned as GptsDoc), _id: res.insertedId };
}
*/
