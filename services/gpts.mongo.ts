import { randomUUID, createHash } from "crypto";
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

/** 作成 */
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

/** 単一取得（存在しなければ null） */
export async function getGptsById(gptsId: string): Promise<GptsDoc | null> {
  const colGpts = await getGptsCollection();
  return colGpts.findOne({ gptsId });
}

/** 更新 */
export async function updateGpts(params: {
  gptsId: string;
  userId: string; // 所有者
  name?: string;
  instpack?: string;
}): Promise<GptsDoc | null> {
  const colGpts = await getGptsCollection();

  const $set: Partial<GptsDoc> = {};
  if (typeof params.name === "string") $set.name = params.name;
  if (typeof params.instpack === "string") {
    $set.instpack = params.instpack;
    $set.hash = sha256(params.instpack);
  }
  if (Object.keys($set).length === 0) {
    return colGpts.findOne({ gptsId: params.gptsId, userId: params.userId });
  }

  //// for debug
  let res;
  try{  
    res = await colGpts.findOneAndUpdate(
      { gptsId: params.gptsId, userId: params.userId },
      { $set: touchForUpdate($set) },
      { returnDocument: "after" }
    );
    console.info("[gpts.update] raw result", res);
  }catch(e){
    console.info("[gpts.update] error ", e);
  }
  return res?.value;
  //// ここまで
/*
  const res = await colGpts.findOneAndUpdate(
    { gptsId: params.gptsId, userId: params.userId },
    { $set: touchForUpdate($set) },
    { returnDocument: "after" }
  );
  return res?.value;
*/
}

/** コピー：正本を複製し、originalGptsId / autherUserId を付与。user_gpts にリンク作成 */
/* TODO: コピーを作るようになったら復活
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
