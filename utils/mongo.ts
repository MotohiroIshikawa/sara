// utils/mongo.ts
import { MongoClient, type Collection, type Document } from "mongodb";
import type { UserDoc, UserCycleDoc } from "@/types/db";

let _clientPromise: Promise<MongoClient> | null = null;

function assertUri(uri?: string): string {
  if (!uri) throw new Error("MONGODB_URI is missing");
  if (!/retryWrites=false/i.test(uri)) {
    console.warn("[mongo] Hint: add 'retryWrites=false' to Cosmos Mongo RU URI");
  }
  if (!/(ssl|tls)=true/i.test(uri)) {
    console.warn("[mongo] Hint: add 'ssl=true' (or 'tls=true') to URI");
  }
  return uri;
}

async function getClient(): Promise<MongoClient> {
  if (_clientPromise) return _clientPromise;
  const uri = assertUri(process.env.MONGODB_URI);
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: parseInt(process.env.DB_SERVER_SELECTION_TIMEOUT_MS ?? "6000", 10),
    socketTimeoutMS: parseInt(process.env.DB_SOCKET_TIMEOUT_MS ?? "45000", 10),
    appName: process.env.DB_APP_NAME ?? "lineai-dev",
  });
  _clientPromise = client.connect();
  return _clientPromise;
}

export async function getCollection<T extends Document = Document>( name: string ): Promise<Collection<T>> {
  const dbName = process.env.MONGODB_DB!;
  const client = await getClient();
  return client.db(dbName).collection<T>(name);
}

export async function getUsersCollection(): Promise<Collection<UserDoc>> {
  const name = process.env.MONGODB_USERS_COLLECTION ?? "users";
  return getCollection<UserDoc>(name);
}

export async function getUserCyclesCollection(): Promise<Collection<UserCycleDoc>> {
  const name = process.env.MONGODB_USER_CYCLES_COLLECTION ?? "user_cycles";
  return getCollection<UserCycleDoc>(name);
}

// 任意: 開発時のクリーンアップ
export async function closeMongoForDev() {
  if (_clientPromise) {
    const client = await _clientPromise;
    await client.close();
    _clientPromise = null;
  }
}
