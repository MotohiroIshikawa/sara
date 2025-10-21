import { createHash } from "crypto";
import { redis } from "@/utils/redis";

/* ========================== 呼び出し側の使い方メモ ==========================
1) 呼びかけ成立時（単発「さら」や文頭「サラ、…」など）:
   await activateReplyMode(scope, userId, env.WAKE_NEXT_ONLY_TTL_SEC);

   2) メッセージ受信時（本文に呼びかけが無いケースのフォロー）:
   const ok = await consumeReplyModeIfActive(scope, userId);
   if (!ok) return; // 反応しない（呼びかけ要求）
   // ok === true なら「呼びかけの続き」として META/REPLY へ

   3) 割り込み（他ユーザが話したら解除したい場合）:
   await breakReplyModeOnInterrupt(scope, interrupterUserId);

   ※ グループ/ルームのみで適用。1:1 は常時許可ならこのモジュール不要。
============================================================================ */

// スコープ
export type WakeScope = string;
export type ReplyMode = "next-only";
export type ReplyModeRecordNextOnly = {
  by: string;        // 呼びかけたユーザID（"U..."）
  mode: "next-only";
  expiresAt: number; // epoch seconds（デバッグしやすさのため保持）
};
export type ReplyModeRecord = ReplyModeRecordNextOnly;

function epochSec(): number {
  return Math.floor(Date.now() / 1000);
}

// スコープからRedisキーを生成（固定接頭辞 + SHA256( scope )）
function keyOf(scope: WakeScope): string {
  const h = createHash("sha256").update(scope).digest("hex").slice(0, 32);
  return `awake:${h}`;
}

function encode(rec: ReplyModeRecord): string {
  return JSON.stringify(rec);
}

function decode(s: string | null): ReplyModeRecord | null {
  if (s === null) return null;
  try {
    const obj: unknown = JSON.parse(s);
    if (typeof obj !== "object" || obj === null) return null;
    const mode: unknown = (obj as { mode?: unknown }).mode;
    if (mode === "next-only") {
      const r = obj as ReplyModeRecordNextOnly;
      if (typeof r.by === "string" && typeof r.expiresAt === "number") return r;
    }
    return null;
  } catch {
    return null;
  }
}

// 返信モードを有効化（次の1通のみ自動フォロー）。既存状態は上書き。
export async function activateReplyMode(scope: WakeScope, byUserId: string, ttlSec: number): Promise<void> {
  const k: string = keyOf(scope);
  const rec: ReplyModeRecordNextOnly = {
    by: byUserId,
    mode: "next-only",
    expiresAt: epochSec() + ttlSec,
  };
  // Redis: SET key val EX ttl
  await redis.set(k, encode(rec), "EX", ttlSec);
}

// 呼びかけ語が本文に無いケース
// - 条件：キー存在 && mode=next-only && by===userId
// - 成立時はキー削除（1通で失効）
export async function consumeReplyModeIfActive(scope: WakeScope, userId: string): Promise<boolean> {
  const k: string = keyOf(scope);
  const raw: string | null = await redis.get(k);
  const rec: ReplyModeRecord | null = decode(raw);
  if (rec === null) return false;
  if (rec.mode !== "next-only") return false;
  if (rec.by !== userId) return false;

  // TTLはRedisが担保するが expiresAt も念のため確認
  if (rec.expiresAt <= epochSec()) {
    await redis.del(k); // お掃除
    return false;
  }

  await redis.del(k);
  return true;
}

// 他ユーザの発話割り込みで 返信モードを解除
// 設定で「割り込みで解除」ポリシーが有効な場合に呼ぶ。
export async function breakReplyModeOnInterrupt(scope: WakeScope, interrupterUserId: string): Promise<void> {
  const k: string = keyOf(scope);
  const raw: string | null = await redis.get(k);
  const rec: ReplyModeRecord | null = decode(raw);
  if (rec === null) return;
  if (rec.by === interrupterUserId) return; // 呼びかけ本人の連投は割込とみなさない
  await redis.del(k);
}

// 日本語向け簡易正規化（NFKC + trim、英字のみ小文字化）
export function normalizeJaLite(s: string): string {
  const nfkc: string = s.normalize("NFKC");
  const t: string = nfkc.trim();
  return t.replace(/[A-Z]/g, (ch: string): string => ch.toLowerCase());
}

// 文頭呼びかけの区切りデフォルト（空白・句読点・コロン・ダッシュ・各種括弧類など）
export const DEFAULT_WAKE_SEP_RE: RegExp =
  /^[\s,，、.。:：;；!?！？\-‐ー—–~〜・()（）[\]【】「」『』…]+/;

// 単発呼びかけ判定（例：「さら」「サラ？」「sara！」のみ）
export function isSingleWordWake(raw: string, aliases: readonly string[]): boolean {
  const s: string = normalizeJaLite(raw);
  const stripped: string = s.replace(
    /[\s,，、.。:：;；!?！？\-‐ー—–~〜・()（）[\]【】「」『』…]/g,
    ""
  );
  for (const alias of aliases) {
    if (stripped === normalizeJaLite(alias)) return true;
  }
  return false;
}

// 文頭呼びかけ判定（例：「サラ、天気」「sara: help」）
// 一致した場合、先頭の呼びかけ＋区切りを除去した本文を返す。
export function startsWithWake(
  raw: string,
  aliases: readonly string[],
  sepRe?: RegExp
): { matched: boolean; cleaned?: string } {
  const s: string = normalizeJaLite(raw);
  const re: RegExp = sepRe ?? DEFAULT_WAKE_SEP_RE;

  for (const alias of aliases) {
    const a: string = normalizeJaLite(alias);
    if (s.startsWith(a)) {
      const rest: string = s.slice(a.length);
      if (rest.length === 0) return { matched: true, cleaned: "" };
      const m: RegExpMatchArray | null = rest.match(re);
      if (m) {
        const cleaned: string = rest.slice(m[0].length).trim();
        return { matched: true, cleaned };
      }
    }
  }
  return { matched: false };
}

// 現在の状態を取得（デバッグ用）
export async function getReplyModeState(scope: WakeScope): Promise<ReplyModeRecord | null> {
  const k: string = keyOf(scope);
  const raw: string | null = await redis.get(k);
  return decode(raw);
}

// 明示的に解除（お掃除）
export async function clearReplyModeState(scope: WakeScope): Promise<void> {
  const k: string = keyOf(scope);
  await redis.del(k);
}

// TTL確認（-1: 永久, -2: 存在しない など ioredis 仕様）
export async function ttlReplyMode(scope: WakeScope): Promise<number> {
  const k: string = keyOf(scope);
  const t: number = await redis.ttl(k);
  return t;
}
