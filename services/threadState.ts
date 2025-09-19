import { AgentsClient } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";
import { AZURE, THREAD } from "@/utils/env";
import { redis } from "@/utils/redis";

const endpoint = AZURE.AI_PRJ_ENDPOINT;
const threadTTL = THREAD.TTL_HOURS;
const credential = new DefaultAzureCredential();
const client = new AgentsClient(endpoint, credential);

 // ThreadのKey作成用
export function threadKey(userId: string) {
  // ENDPOINT毎
  const ns = Buffer.from(endpoint).toString("base64url");
  return `thread:${ns}:${userId}`;
}

// ユーザー単位の会話スレッドの永続化/TTL延長/削除
export async function getOrCreateThreadId(userId: string, ttlHours = threadTTL): Promise<string> {
  const k = threadKey(userId);
  const tid = await redis.get(k);
  if (tid){
    // 使われたらTTLを延長
    await redis.expire(k, ttlHours * 3600);
    return tid;
  }
  // なければcreate
  const th = await client.threads.create();
  await redis.setex(k, ttlHours * 3600, th.id);
  return th.id;
}

// Threadの削除用
export async function resetThread(userId: string) {
  const k = threadKey(userId);
  const tid = await redis.get(k);
  if (tid) {
    try {
      await client.threads.delete(tid);
    } catch {
      // 既に無ければ無視
    }
    await redis.del(k);
  }
}
