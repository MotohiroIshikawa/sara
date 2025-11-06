import { AZURE, THREAD } from "@/utils/env";
import { redis } from "@/utils/redis";
import type { SourceType } from "@/types/gpts";
import { agentsClient } from "@/utils/agents";

const endpoint = AZURE.AI_PRJ_ENDPOINT;
const threadTTL = THREAD.TTL_HOURS;

// ThreadのKey作成用
function threadKey(
  sourceType: SourceType, 
  sourceId: string
) {
  const scope: string = `${sourceType}:${sourceId}`;
  const ns: string = Buffer.from(endpoint).toString("base64url");
  return `thread:${ns}:${scope}`;
}

// ユーザー単位の会話スレッドの永続化/TTL延長/削除
export async function getOrCreateThreadId(
  sourceType: SourceType, 
  sourceId: string,
  ttlHours: number = threadTTL
): Promise<string> {
  const k: string = threadKey(sourceType, sourceId);
  const ttlSec: number = Math.max(60, Math.ceil(ttlHours * 3600));
  const tid: string | null = await redis.get(k);
  if (tid){
    // 使われたらTTLを延長
    await redis.expire(k, ttlSec);
    return tid;
  }
  // なければcreate
  const th = await agentsClient.threads.create();
  await redis.setex(k, ttlSec, th.id);
  return th.id;
}

// Threadの削除用
export async function resetThread(
  sourceType: SourceType, 
  sourceId: string
) {
  const k: string = threadKey(sourceType, sourceId);
  const tid: string | null = await redis.get(k);
  if (tid) {
    try {
      await agentsClient.threads.delete(tid);
    } catch {
      // 既に無ければ無視
    }
    await redis.del(k);
  }
}
