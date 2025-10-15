import { randomUUID, createHash } from "crypto";
import type { UpdateFilter, Document } from "mongodb";
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
    // originalGptsId / authorUserId は作成時は未設定
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
  if (Object.keys($set).length === 0) {
    return colGpts.findOne({ gptsId: params.gptsId, userId: params.userId });
  }

  const res = await colGpts.findOneAndUpdate(
    { gptsId: params.gptsId, userId: params.userId },
    { $set: touchForUpdate($set) },
    { returnDocument: "after" }
  );

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

// コピー：正本を複製し、originalGptsId / authorUserId を付与。user_gpts にリンク作成
export async function copyGpts(params: {
  originalGptsId: string;       // コピー元
  userId: string;               // コピーする人
  renameTo?: string;
}): Promise<GptsDoc | null> {
  const colGpts = await getGptsCollection();
  const colUserGpts = await getUserGptsCollection();

  // 公開されている & 削除されていない元を許可
  const src = await colGpts.findOne(
    { gptsId: params.originalGptsId, isPublic: true, deletedAt: { $exists: false } },
    { projection: { _id: 0 } }
  );
  if (!src) return null;

  const gptsId = newGptsId();
  const cloned: Omit<GptsDoc, "_id"> = withTimestampsForCreate({
    gptsId,
    userId: params.userId,
    name: typeof params.renameTo === "string" && params.renameTo.trim().length > 0
      ? params.renameTo
      : (src as Pick<GptsDoc, "name">).name,
    instpack: (src as Pick<GptsDoc, "instpack">).instpack,
    hash: (src as Partial<GptsDoc>).hash ?? sha256((src as Pick<GptsDoc, "instpack">).instpack),
    originalGptsId: (src as Pick<GptsDoc, "gptsId">).gptsId,
    authorUserId: (src as Pick<GptsDoc, "userId">).userId,
    isPublic: false, // コピーは常に非公開
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

// 検索ソート種別
export type PublicGptsSort = "latest" | "popular";

// 検索1件の出力
export type PublicGptsSearchItem = {
  gptsId: string;
  name: string;
  updatedAt: Date;
  isPublic: boolean;
  usageCount: number; // user_gpts での参照数
};

// 正規表現の特殊文字をエスケープ（部分一致用）
function escapeRegexFragment(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 公開GPTSを検索（タイトル部分一致、最新順 or 利用数順）
export async function searchPublicGpts(params: {
  q?: string;
  sort?: PublicGptsSort;
  limit?: number;
  offset?: number;
}): Promise<PublicGptsSearchItem[]> {
  const colGpts = await getGptsCollection();

  const q: string | undefined = typeof params.q === "string" && params.q.trim() ? params.q.trim() : undefined;
  const sort: PublicGptsSort = params.sort ?? "latest";
  const limit: number = Math.min(Math.max(params.limit ?? 20, 1), 50); // 1..50
  const offset: number = Math.max(params.offset ?? 0, 0);

  const match: Record<string, unknown> = {
    isPublic: true,
    deletedAt: { $exists: false },
    name: { $type: "string", $ne: "" },
  };
  if (q) {
    match.name = { $regex: escapeRegexFragment(q), $options: "i" };
  }

  const pipeline: Document[] = [
    { $match: match },
    // 自己参照 $lookup：元(gpts) → 子コピー(gpts.originalGptsId == 親の gptsId)
    {
      $lookup: {
        from: "gpts",
        localField: "gptsId",
        foreignField: "originalGptsId",
        as: "children"
      }
    },
    // 子コピーのうち deletedAt が未設定のものだけカウント
    {
      $addFields: {
        usageCount: {
          $size: {
            $filter: {
              input: { $ifNull: ["$children", []] },
              as: "c",
              cond: { $eq: [ { $ifNull: ["$$c.deletedAt", null] }, null ] } // deletedAt が null/未設定なら true
            }
          }
        }
      }
    },
    { $project: { _id: 0, gptsId: 1, name: 1, updatedAt: 1, isPublic: 1, usageCount: 1 } },
    ...(sort === "popular"
      ? [{ $sort: { usageCount: -1, updatedAt: -1 } } as Document]
      : [{ $sort: { updatedAt: -1 } } as Document]),
    { $skip: offset },
    { $limit: limit },
  ];

  type PublicGptsRow = Pick<GptsDoc, "gptsId" | "name" | "updatedAt" | "isPublic"> & { usageCount: number };
  const docs = await colGpts.aggregate<PublicGptsRow>(pipeline).toArray();

  const out: PublicGptsSearchItem[] = docs.map((d) => { // users 参照を削除
    const updatedAt: Date = d.updatedAt instanceof Date ? d.updatedAt : new Date(d.updatedAt as unknown as string);
    const name: string = typeof d.name === "string" ? d.name : "";
    const usageCount: number = d.usageCount; // 集計で必ず付与される
    return {
      gptsId: d.gptsId,
      name,
      updatedAt,
      isPublic: !!d.isPublic,
      usageCount,
    };
  });

  return out;
}

// 公開GPTSの詳細（存在しない/非公開/削除済みは null） 
export async function getPublicGptsDetail(gptsId: string): Promise<Pick<GptsDoc, "gptsId" | "name" | "instpack" | "updatedAt" | "isPublic"> | null> {
  const colGpts = await getGptsCollection();
  const doc = await colGpts.findOne(
    { gptsId, isPublic: true, deletedAt: { $exists: false } },
    { projection: { _id: 0, gptsId: 1, name: 1, instpack: 1, updatedAt: 1, isPublic: 1 } }
  );
  return doc ?? null;
}