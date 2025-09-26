import Redis from "ioredis";
import Redlock from "redlock";
import { REDIS } from "@/utils/env";

let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      host: REDIS.HOST,
      port: REDIS.PORT,
      username: REDIS.USERNAME,
      password: REDIS.PASSWORD,
      tls: REDIS.TLS ? { servername: REDIS.TLS_SERVERNAME } : undefined,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
    _redis.on("error", (e) => console.error("[redis] error:", e));
    _redis.on("connect", () => console.info("[redis] connected"));
    _redis.on("close", () => console.warn("[redis] closed"));
  }
  return _redis;
}

export const redis = getRedis();

const redlock = new Redlock([redis], {
  retryCount: 6,
  retryDelay: 250,
  retryJitter: 150,
});
redlock.on("error", (err: unknown) => {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.warn("[redlock] error:", msg);
});

// ヘルパ
export async function setNxEx(key: string, val: string, ttlSec: number): Promise<boolean> {
  const res = await redis.set(key, val, "EX", ttlSec, "NX");
  return res === "OK";
}
export async function withLock<T>(resource: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const lock = await redlock.acquire([`lock:${resource}`], ttlMs);
  try { return await fn(); } finally { await lock.release().catch(() => {}); }
}
