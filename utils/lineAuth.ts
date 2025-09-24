/**
 * LIFF/LINE Login の IDトークンを検証し、userId (sub) を返す
 * - 取得元: Authorization: Bearer <id_token> / X-ID-Token / Cookie
 * - 検証先: https://api.line.me/oauth2/v2.1/verify (公式)
 * - 必須env: LINE_CHANNEL_ID (= LIFF/LINE LoginのチャネルID)
 * - 任意env: LINE_ISSUER (既定: https://access.line.me)
 *
 * 使い方（API Route）:
 *   const userId = await requireLineUser(req); // 401/403はthrow
 */

import type { NextRequest } from "next/server";
import { isNumber, isRecord, isString } from "@/utils/types";

// ---- 設定 ----
const LINE_VERIFY_ENDPOINT = "https://api.line.me/oauth2/v2.1/verify";
const LINE_ISSUER = process.env.LINE_ISSUER ?? "https://access.line.me";
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID || "";
const ID_TOKEN_HEADER = "x-id-token";
const ID_TOKEN_COOKIE_NAMES = ["id_token", "liff_id_token"]; // Cookie名の候補

// ---- 簡易キャッシュ（開発/高負荷対策。短時間の再検証を抑制）----
type CacheVal = { userId: string; exp: number };
const cache = new Map<string, CacheVal>();
const CACHE_TTL_SEC = 60; // 1分

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// ---- 公開関数 ----
export async function requireLineUser(req: Request | NextRequest): Promise<string> {

  // IDトークンを取り出す
  const idToken = extractIdToken(req);
  if (!idToken) throw new HttpError(401, "missing_id_token");
  if (!LINE_CHANNEL_ID) throw new Error("LINE_CHANNEL_ID is not set");

  // 簡易キャッシュ
  const nowSec = Math.floor(Date.now() / 1000);
  const c = cache.get(idToken);
  if (c && c.exp > nowSec + 5) return c.userId;

  const payload = await verifyIdTokenWithLINE(idToken);

  // 検証
  if (payload.aud !== LINE_CHANNEL_ID) throw new HttpError(403, "aud_mismatch");
  if (payload.iss !== LINE_ISSUER) throw new HttpError(403, "iss_mismatch");

  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp <= nowSec) throw new HttpError(401, "token_expired");
  if (payload.exp <= nowSec) throw new HttpError(401, "token_expired");

  const userId = payload.sub as string | undefined;
  if (!userId) throw new HttpError(403, "no_sub");

  //キャッシュ
  cache.set(idToken, { userId, exp: Math.min(payload.exp, nowSec + CACHE_TTL_SEC) });

  return userId;
}

// ---- 内部: 検証処理 ----
interface LineVerifyResponse {
  iss: string;        // "https://access.line.me"
  sub: string;        // userId
  aud: string;        // channelId
  exp: number;        // epoch seconds
  iat: number;        // epoch seconds
  nonce?: string;
  amr?: string[];
  name?: string;
  picture?: string;
  email?: string;
};

function isLineVerifyResponse(x: unknown): x is LineVerifyResponse {
  if (!isRecord(x)) return false;
  return (
    isString(x.iss) &&
    isString(x.sub) &&
    isString(x.aud) &&
    isNumber(x.exp) &&
    isNumber(x.iat)
  );
}

async function verifyIdTokenWithLINE(idToken: string): Promise<LineVerifyResponse> {
  const body = new URLSearchParams();
  body.set("id_token", idToken);
  body.set("client_id", LINE_CHANNEL_ID);

  const res = await fetch(LINE_VERIFY_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();

  // 失敗時はエラー応答（JSON想定だが安全にパース）
  if (!res.ok) {
    const errObj = safeJson(text);
    const msg =
      (isRecord(errObj) && isString(errObj.error_description) && errObj.error_description) ||
      (isRecord(errObj) && isString(errObj.error) && errObj.error) ||
      "verify_failed";
    throw new HttpError(401, msg);
  }

  const parsed = safeJson(text);
  if (!isLineVerifyResponse(parsed)) {
    throw new HttpError(401, "invalid_verify_payload");
  }
  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// 内部: トークン抽出
function extractIdToken(req: Request | NextRequest): string | undefined {
  // 1) Authorization: Bearer
  const auth = header(req, "authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  // 2) X-ID-Token ヘッダ
  const idh = header(req, ID_TOKEN_HEADER);
  if (idh) return idh.trim();

  // 3) Cookie
  const cookieHeader = header(req, "cookie");
  if (cookieHeader) {
    const jar = parseCookies(cookieHeader);
    for (const k of ID_TOKEN_COOKIE_NAMES) {
      const v = jar[k];
      if (v) return v;
    }
  }
  return undefined;
}

function header(req: Request | NextRequest, key: string): string | undefined {
  return req.headers.get(key) ?? undefined;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(/; */)) {
    const i = part.indexOf("=");
    if (i > 0) {
      const k = decodeURIComponent(part.slice(0, i).trim());
      const v = decodeURIComponent(part.slice(i + 1).trim());
      out[k] = v;
    }
  }
  return out;
}
