"use client";
import type { Liff } from "@line/liff";

const loginUrl = process.env.NEXT_PUBLIC_LIFF_LOGIN_URL ?? "/api/line/liff-login";

export type EnsureLiffSessionOptions = {
  liffId?: string;
  loginIfNeeded?: boolean;  // 未ログイン時に login() へ飛ばすか（既定: true）
    redirectUri?: string; // login リダイレクト先（既定: 現在のURL）
};

export type EnsureLiffSessionResult =
  | {
      ok: true; // この呼び出しで新たに Cookie を確立できたか（idToken を使ったか）
      established: boolean; // 取得できた場合に返す（デバッグ用途）
      idToken?: string; // LIFF の sub。取得できた場合のみ
      userId?: string;
    }
  | {
      ok: false; // login() を発火したので処理を中断して良い、の合図
      reason: "login_redirected";
    }
  | {
      ok: false;
      reason: "no_liff_id" | "verify_failed" | "unexpected";
      detail?: string;
    };

// LIFF を初期化し、必要ならログイン→IDトークンをサーバへ送り Cookie を確立する。
// すでに Cookie がある場合は established=false のまま ok:true を返す。
export async function ensureLiffSession(
  options: EnsureLiffSessionOptions = {}
): Promise<EnsureLiffSessionResult> {
  try {
    const liffId =
      options.liffId ?? (process.env.NEXT_PUBLIC_LIFF_ID as string | undefined);
    if (!liffId) {
      return { ok: false, reason: "no_liff_id", detail: "NEXT_PUBLIC_LIFF_ID is empty" };
    }

    const liffMod = await import("@line/liff");
    const liff: Liff = liffMod.default;

    await liff.init({ liffId });

    if (!liff.isLoggedIn()) {
      if (options.loginIfNeeded === false) {
        // ログインせず進む（既存CookieがあればAPIは通る）
      } else {
        const redirectUri = options.redirectUri ?? window.location.href;
        liff.login({ redirectUri });
        return { ok: false, reason: "login_redirected" };
      }
    }

    // IDトークンが取れるなら loginUrl に投げて Cookie を確立
    const idToken = liff.getIDToken();
    if (idToken) {
      const res = await fetch(loginUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) return { ok: false, reason: "verify_failed" };

      const decoded = liff.getDecodedIDToken();
      const userId = decoded?.sub;
      return { ok: true, established: true, idToken, userId };
    }

    // 既に Cookie がある（またはブラウザ直開きで未ログインだが先に進めたい）ケース
    return { ok: true, established: false };
  } catch (e) {
    return {
      ok: false,
      reason: "unexpected",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
