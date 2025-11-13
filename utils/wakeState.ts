import { createHash } from "crypto";
import { redis } from "@/utils/redis";
import { escapeRegExp } from "@/utils/msgCatalog";
import { envCsv } from "@/utils/env";
import type { SourceType } from "@/types/gpts";

// 呼びかけ語に続く「敬称」
const HONORIFICS: readonly string[] = envCsv(
  "WAKE_HONORIFICS",
  "ちゃん,さん,様,さま,先生,くん,君"
);
// 区切り文字クラス
const SEP_CLASS: string = String.raw`[\s,，、.。:：;；!?！？\-‐ー—–~〜・()（）\[\]【】「」『』…]`;
// 文頭呼びかけの区切り
export const DEFAULT_WAKE_SEP_RE: RegExp = /^[\s,，、.。:：;；!?！？\-‐ー—–~〜・()（）[\]【】「」『』…]+/;

/* ========================== 呼び出し側の使い方メモ ==========================
1) 呼びかけ成立時（単発「さら」や文頭「サラ、…」など）:
2) メッセージ受信時（本文に呼びかけが無いケースのフォロー）:
   consumeReplyModeIfActiveでの判定
   false: 反応しない（呼びかけ要求）
   true: 「呼びかけの続き」として META/REPLY へ
3) 割り込み（他ユーザが話したら解除したい場合）:
============================================================================ */

type WakeScope = string;
export type ReplyMode = // 返信モードの型
    "next-only" // 呼びかけ後の1通のみ
  | "session";  // 呼びかけ後に発言するとTTLが延長される

type ReplyModeRecord = {
  by: string;        // 呼びかけたユーザID（"U..."）
  mode: ReplyMode;
  expiresAt: number;
  ttlSec: number;
};

function epochSec(): number {
  return Math.floor(Date.now() / 1000);
}

// スコープからRedisキーを生成（"awake:" + SHA256( scope )）
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
    const r = obj as Partial<ReplyModeRecord>;

    if (typeof r.by !== "string") return null;
    if (typeof r.mode !== "string") return null;
    if (r.mode !== "next-only" && r.mode !== "session") return null;
    if (typeof r.expiresAt !== "number") return null;
    if (typeof r.ttlSec !== "number" || r.ttlSec <= 0) return null;

    return {
      by: r.by,
      mode: r.mode,
      expiresAt: r.expiresAt,
      ttlSec: r.ttlSec,
    };
  } catch {
    return null;
  }
}

// 返信モードを有効化（次の1通のみ自動フォロー）。既存状態は上書き。
export async function activateReplyMode(
  sourceType: SourceType,
  ownerId: string,
  speakerUserId: string, 
  ttlSec: number,
  mode: ReplyMode = "session"   // 既定はTTL延長モード
): Promise<void> {
  const scope: string = `${sourceType}:${ownerId}`;
  const k: string = keyOf(scope);
  const rec: ReplyModeRecord = {
    by: speakerUserId, // 呼びかけ実行者
    mode,
    expiresAt: epochSec() + ttlSec,
    ttlSec,
  };
  // Redis: SET key val EX ttl
  await redis.set(k, encode(rec), "EX", Math.max(1, ttlSec));
}

// 呼びかけ語が本文に無いケース
export async function consumeReplyModeIfActive(
  sourceType: SourceType,
  ownerId: string,
  speakerUserId: string
): Promise<boolean> {
  const scope: string = `${sourceType}:${ownerId}`;
  const k: string = keyOf(scope);
  const raw: string | null = await redis.get(k);
  const rec: ReplyModeRecord | null = decode(raw);
  if (rec === null) return false;
  if (rec.by !== speakerUserId) return false;

  const now: number = epochSec();
  // TTL切れの場合はredis削除(念のため)
  if (rec.expiresAt <= now) {
    await redis.del(k);
    return false;
  }
  // modeがnext-onlyの場合はredis削除
  if (rec.mode === "next-only") {
    await redis.del(k);
    return true;
  }
  // modeがsessionの場合はTTL延長
  if (rec.mode === "session") {
    const newExpires: number = now + rec.ttlSec;
    const newRec: ReplyModeRecord = { ...rec, expiresAt: newExpires };
    await redis.set(k, encode(newRec), "EX", rec.ttlSec);
    return true;
  }
  return false;
}

// 他ユーザの発話割り込みで 返信モードを解除
// 設定で「割り込みで解除」ポリシーが有効な場合に呼ぶ。
// グループ内の別ユーザが話した場合に、保留中の next-only をクリアして誤反応を抑止
// ただし呼びかけ本人の連投は割り込みとみなさず維持する
export async function breakReplyModeOnInterrupt(
  sourceType: SourceType,
  ownerId: string,
  speakerUserId: string
): Promise<void> {
  const scope: string = `${sourceType}:${ownerId}`;
  const k: string = keyOf(scope);
  const raw: string | null = await redis.get(k);
  const rec: ReplyModeRecord | null = decode(raw);
  if (rec === null) return;
  if (rec.by === speakerUserId) return; // 呼びかけ本人の連投は割込とみなさない
  await redis.del(k);
}

// 日本語向け簡易正規化
function normalizeJaLite(s: string): string {
  const nfkc: string = s.normalize("NFKC");
  const t: string = nfkc.trim();
  return t.replace(/[A-Z]/g, (ch: string): string => ch.toLowerCase());
}

// 単発呼びかけ判定（例：「さら」「サラ？」「sara！」のみ）or 敬称付き
// 末尾に「区切り文字」しか無いケースを許容
// 敬称を付けた「さらちゃん」「さらさん」等も単発呼びかけとして認識する。
export function isSingleWordWake(raw: string, aliases: readonly string[]): boolean {
  // 末尾は区切りのみを許容（0回以上）
  // 表記ゆれを吸収
  const s: string = normalizeJaLite(raw);
  // 起動語のORパターンを生成
  const aliasAlt: string = aliases.map((a: string): string => escapeRegExp(normalizeJaLite(a))).join("|");
  // 敬称のORパターンを生成（有無どちらも可）
  const honoAlt: string = HONORIFICS.length > 0
    ? `(?:${HONORIFICS.map((h: string): string => escapeRegExp(normalizeJaLite(h))).join("|")})?`
    : "";
  const re: RegExp = new RegExp(`^(?:${aliasAlt})${honoAlt}(?:${SEP_CLASS})*$`, "u");
  return re.test(s);
}

// sepRe から「連続許容」用の正規表現断片を作る
function buildSepSeq(sepRe?: RegExp): string {
  if (!sepRe) return `(?:${SEP_CLASS})*`;
  const src: string = sepRe.source.replace(/^\^/, ""); // 先頭の ^ を外す
  return `(?:${src})*`; // 連続許容
}

// 文頭呼びかけ判定（例：「サラ、天気」「sara: help」）
// 一致した場合、先頭の呼びかけ＋区切りを除去した本文を返す。
export function startsWithWake(
  raw: string,
  aliases: readonly string[],
  sepRe?: RegExp
): { matched: boolean; cleaned?: string } {
  // 表記ゆれを吸収
  const s: string = normalizeJaLite(raw);
  // 起動語のORパターンを生成
  const aliasAlt: string = aliases.map((a: string): string => escapeRegExp(normalizeJaLite(a))).join("|");
  // 敬称のORパターンを生成（有無どちらも可）
  const honoAlt: string = HONORIFICS.length > 0
    ? `(?:${HONORIFICS.map((h: string): string => escapeRegExp(normalizeJaLite(h))).join("|")})?`
    : "";
  // 区切りの「連続許容」パターンの生成
  const sepSeq: string = buildSepSeq(sepRe);
  // 文頭に「起動語＋(敬称)?＋(区切り*)」が来るかを正規表現で判定
  const re: RegExp = new RegExp(`^(?:${aliasAlt})${honoAlt}${sepSeq}`, "u");
  // マッチしたら、該当部分を取り除いた残りが本文
  const m: RegExpMatchArray | null = s.match(re);
  if (!m) return { matched: false };
  const cleaned: string = s.slice(m[0].length).trim();
  return { matched: true, cleaned };
}