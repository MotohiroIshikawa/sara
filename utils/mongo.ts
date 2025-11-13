import { MongoClient, type Collection, type Document } from "mongodb";
import type { 
  UserDoc, 
  UserCycleDoc, 
  ThreadInstDoc, 
  UserGptsDoc, 
  GptsBindingDoc,
  GptsDoc,
  GptsScheduleDoc,
} from "@/types/db";

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

export async function pingMongo(): Promise<boolean> {
  try {
    const client = await getClient();
    const res = await client.db("admin").command({ ping: 1 });
    return !!res?.ok;
  } catch (e) {
    console.error("[mongo] ping failed:", (e as Error)?.message || e);
    return false;
  }
}

async function getCollection<T extends Document = Document>( name: string ): Promise<Collection<T>> {
  const dbName = process.env.MONGODB_DB!;
  const client = await getClient();
  return client.db(dbName).collection<T>(name);
}

/* === Collections === */

export async function getUsersCollection(): Promise<Collection<UserDoc>> {
  const name = process.env.MONGODB_USERS_COLLECTION ?? "users";
  return getCollection<UserDoc>(name);
}

export async function getUserCyclesCollection(): Promise<Collection<UserCycleDoc>> {
  const name = process.env.MONGODB_USER_CYCLES_COLLECTION ?? "user_cycles";
  return getCollection<UserCycleDoc>(name);
}

export async function getThreadInstCollection(): Promise<Collection<ThreadInstDoc>> {
  const name = process.env.MONGODB_THREAD_INST_COLLECTION ?? "thread_inst";
  return getCollection<ThreadInstDoc>(name);
}

export async function getGptsCollection(): Promise<Collection<GptsDoc>> {
  const name = process.env.MONGODB_GPTS_COLLECTION ?? "gpts";
  return getCollection<GptsDoc>(name);
}

export async function getUserGptsCollection(): Promise<Collection<UserGptsDoc>> {
  const name = process.env.MONGODB_USER_GPTS_COLLECTION ?? "user_gpts";
  return getCollection<UserGptsDoc>(name);
}

export async function getGptsBindingsCollection(): Promise<Collection<GptsBindingDoc>> {
  const name = process.env.MONGODB_GPTS_BINDINGS_COLLECTION ?? "gpts_bindings";
  return getCollection<GptsBindingDoc>(name);
}

export async function getGptsSchedulesCollection(): Promise<Collection<GptsScheduleDoc>> {
  const name = process.env.MONGODB_GPTS_SCHEDULES_COLLECTION ?? "gpts_schedules";
  return getCollection<GptsScheduleDoc>(name);
}

export const withTimestampsForCreate = <T extends Record<string, unknown>>(doc: T) => ({
  ...doc,
  createdAt: new Date(),
  updatedAt: new Date(),
});

export const touchForUpdate = <T extends Record<string, unknown>>(patch: T) => ({
  ...patch,
  updatedAt: new Date(),
});
