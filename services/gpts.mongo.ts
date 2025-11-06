import { randomUUID, createHash } from "crypto";
import type { UpdateFilter, Document } from "mongodb";
import type { GptsDoc, UserGptsDoc } from "@/types/db";
import { 
  getGptsCollection, 
  getUserGptsCollection,
  getUsersCollection,
  touchForUpdate,
  withTimestampsForCreate
} from "@/utils/mongo";
import { envInt } from "@/utils/env";

// チャットルール検索の閾値定義
const POPULAR_TOP_N: number = envInt("SEARCH_POPULAR_TOP", 10);
const NEW_DAYS: number = envInt("SEARCH_NEW_DAYS", 3);

// ページング既定（20）と上限（.env 未設定時は 50）
const PAGE_DEFAULT_LIMIT: number = envInt("SEARCH_PAGE_LIMIT", 20, { min: 1, max: 1000 });
const PAGE_MAX_LIMIT_ENV: number = envInt("SEARCH_PAGE_LIMIT_MAX", 50, { min: 1, max: 1000 });
const PAGE_MAX_LIMIT: number = Math.max(PAGE_MAX_LIMIT_ENV, PAGE_DEFAULT_LIMIT);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function newGptsId() {
  return "gpts_" + randomUUID().replace(/-/g, "");
}

// 作成
export async function createGpts(
  userId: string,
  name: string,
  instpack: string
): Promise<GptsDoc> {
  const colGpts = await getGptsCollection();
  const colUserGpts = await getUserGptsCollection();
  const gptsId = newGptsId();
  const doc: Omit<GptsDoc, "_id"> = withTimestampsForCreate({
    gptsId,
    userId,
    name,
    instpack,
    hash: sha256(instpack),
    // originalGptsId / authorUserId は作成時は未設定
    isPublic: true,
  });

  const res = await colGpts.insertOne(doc as GptsDoc);

  // user_gpts はリンクのみ（冗長データは持たない）
  const link: Omit<UserGptsDoc, "_id"> = withTimestampsForCreate({
    userId,
    gptsId,
  });
  await colUserGpts.updateOne(
    { userId, gptsId },
    { $setOnInsert: link },
    { upsert: true }
  );

  return { ...(doc as GptsDoc), _id: res.insertedId };
}

// 単一取得（存在しなければ null）
export async function getGptsById(
  gptsId: string
): Promise<GptsDoc | null> {
  const colGpts = await getGptsCollection();
  return colGpts.findOne({ gptsId });
}

// 更新
export async function updateGpts(
  gptsId: string,
  userId: string, // 所有者
  name?: string,
  instpack?: string,
  isPublic?: boolean
): Promise<GptsDoc | null> {
  const colGpts = await getGptsCollection();

  const $set: Partial<GptsDoc> = {};
  if (typeof name === "string") $set.name = name;
  if (typeof instpack === "string") {
    $set.instpack = instpack;
    $set.hash = sha256(instpack);
  }
  if (typeof isPublic === "boolean") {
    $set.isPublic = isPublic;
  }
  if (Object.keys($set).length === 0) {
    return colGpts.findOne({ gptsId, userId });
  }

  const res = await colGpts.findOneAndUpdate(
    { gptsId, userId },
    { $set: touchForUpdate($set) },
    { returnDocument: "after" }
  );

  return res;
}

// 指定ユーザのgptsをすべて論理削除
export async function softDeleteAllGptsByUser(
  userId: string
): Promise<number> {
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
export async function listGptsIdsByUser(
  userId: string
): Promise<string[]> {
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
export async function copyGpts(
  originalGptsId: string,       // コピー元
  userId: string,               // コピーする人
  renameTo?: string
): Promise<GptsDoc | null> {
  const colGpts = await getGptsCollection();
  const colUserGpts = await getUserGptsCollection();

  // 公開されている & 削除されていない元を許可
  const src = await colGpts.findOne(
    { gptsId: originalGptsId, isPublic: true, deletedAt: { $exists: false } },
    { projection: { _id: 0 } }
  );
  if (!src) return null;

  const gptsId = newGptsId();
  const cloned: Omit<GptsDoc, "_id"> = withTimestampsForCreate({
    gptsId,
    userId,
    name: typeof renameTo === "string" && renameTo.trim().length > 0
      ? renameTo
      : (src as Pick<GptsDoc, "name">).name,
    instpack: (src as Pick<GptsDoc, "instpack">).instpack,
    hash: (src as Partial<GptsDoc>).hash ?? sha256((src as Pick<GptsDoc, "instpack">).instpack),
    originalGptsId,
    authorUserId: (src as Pick<GptsDoc, "userId">).userId,
    isPublic: false, // コピーは常に非公開
  });

  const res = await colGpts.insertOne(cloned as GptsDoc);

  // user_gpts にリンク作成
  const link: Omit<UserGptsDoc, "_id"> = withTimestampsForCreate({
    userId,
    gptsId,
  });
  await colUserGpts.updateOne(
    { userId, gptsId },
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
export async function searchPublicGpts(
  q?: string,
  sort?: PublicGptsSort,
  limit?: number,
  offset?: number
): Promise<PublicGptsSearchItem[]> {
  const colGpts = await getGptsCollection();

  q = q?.trim() || undefined;
  sort = sort ?? "latest";

  const reqLimit = typeof limit === "number" ? Math.trunc(limit) : PAGE_DEFAULT_LIMIT;
  limit = Math.min(Math.max(reqLimit, 1), PAGE_MAX_LIMIT + 1);

  const offsetRaw = typeof offset === "number" ? Math.trunc(offset) : 0;
  offset = Math.max(offsetRaw, 0);

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
      ? [{ $sort: { usageCount: -1, updatedAt: -1, gptsId: -1 } } as Document]
      : [{ $sort: { updatedAt: -1, gptsId: -1 } } as Document]
    ),
    { $skip: offset },
    { $limit: limit },
  ];

  const docs = await colGpts.aggregate(pipeline).toArray();

  return docs.map((d) => ({
    gptsId: d.gptsId,
    name: d.name,
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt : new Date(d.updatedAt),
    isPublic: !!d.isPublic,
    usageCount: d.usageCount,
  }));
}

// 公開GPTSの詳細
export async function getPublicGptsDetail(gptsId: string): Promise<Pick<GptsDoc, "gptsId" | "name" | "instpack" | "updatedAt" | "isPublic"> | null>{
  const colGpts = await getGptsCollection(); 
  const doc = await colGpts.findOne( 
    { gptsId, isPublic: true, deletedAt: { $exists: false } }, 
    { projection: { _id: 0, gptsId: 1, name: 1, instpack: 1, updatedAt: 1, isPublic: 1 } }
  );
  return doc ?? null;
}

// 公開GPTSを検索（作者名・人気・NEWバッジ付きの拡張版）
export async function searchPublicGptsWithAuthor(
  q?: string,
  sort?: PublicGptsSort,
  limit?: number,
  offset?: number,
  excludeUserId?: string
): Promise<
  Array<
    PublicGptsSearchItem & {
      authorName: string;
      isPopular: boolean;
      isNew: boolean;
    }
  >
> {
  const gptsCol = await getGptsCollection();
  const usersCol = await getUsersCollection();

  q = q?.trim() || undefined;
  const qEscaped = q ? escapeRegexFragment(q) : undefined;
  sort = sort ?? "latest";

  const reqLimit = typeof limit === "number" ? Math.trunc(limit) : PAGE_DEFAULT_LIMIT;
  limit = Math.min(Math.max(reqLimit, 1), PAGE_MAX_LIMIT + 1);

  const offsetRaw = typeof offset === "number" ? Math.trunc(offset) : 0;
  offset = Math.max(offsetRaw, 0);

  // 検索条件
  const match: Record<string, unknown> = {
    isPublic: true,
    deletedAt: { $exists: false },
    name: { $type: "string", $ne: "" },
  };
  if (qEscaped) match.name = { $regex: qEscaped, $options: "i" };
  if (excludeUserId) match.userId = { $ne: excludeUserId };

  const pipeline: Document[] = [
    { $match: match },
    {
      $lookup: {
        from: "gpts",
        localField: "gptsId",
        foreignField: "originalGptsId",
        as: "children",
      },
    },
    {
      $addFields: {
        usageCount: {
          $size: {
            $filter: {
              input: { $ifNull: ["$children", []] },
              as: "c",
              cond: { $eq: [{ $ifNull: ["$$c.deletedAt", null] }, null] },
            },
          },
        },
      },
    },
    { $project: { _id: 0, gptsId: 1, name: 1, updatedAt: 1, isPublic: 1, usageCount: 1, userId: 1 } },
    ...(sort === "popular"
      ? [{ $sort: { usageCount: -1, updatedAt: -1, gptsId: -1 } } as Document]
      : [{ $sort: { updatedAt: -1, gptsId: -1 } } as Document]
    ),
    { $skip: offset },
    { $limit: limit },
  ];

  const rows = await gptsCol.aggregate(pipeline).toArray();
  const now = Date.now();
  const newLimitMs = NEW_DAYS * 24 * 60 * 60 * 1000;

  // 人気判定用 threshold
  const counts = rows.map((d) => d.usageCount);
  const popularThreshold = counts.sort((a, b) => b - a)[POPULAR_TOP_N - 1] ?? Math.max(...counts, 0);

  return Promise.all(
    rows.map(async (d) => {
      const user = await usersCol.findOne({ userId: d.userId });
      return {
        gptsId: d.gptsId,
        name: d.name,
        updatedAt: d.updatedAt instanceof Date ? d.updatedAt : new Date(d.updatedAt),
        isPublic: !!d.isPublic,
        usageCount: d.usageCount,
        authorName: user?.displayName ?? "不明",
        isPopular: d.usageCount >= popularThreshold && d.usageCount > 0,
        isNew: now - new Date(d.updatedAt).getTime() < newLimitMs,
      };
    })
  );
}