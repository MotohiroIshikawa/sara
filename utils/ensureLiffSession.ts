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

    console.debug("[ensureLiffSession] start", {
      hasLiffId: !!liffId,
      loginIfNeeded: options.loginIfNeeded ?? true,
      loginUrl,
    });

    if (!liffId) {
      console.warn("[ensureLiffSession] no_liff_id");
      return { ok: false, reason: "no_liff_id", detail: "NEXT_PUBLIC_LIFF_ID is empty" };
    }

    const liffMod = await import("@line/liff");
    const liff: Liff = liffMod.default;
    console.debug("[ensureLiffSession] liff module loaded");

    await liff.init({ liffId });
    console.debug("[ensureLiffSession] liff.init done");

    if (!liff.isLoggedIn()) {
      console.debug("[ensureLiffSession] not logged in");
      if (options.loginIfNeeded === false) {
        console.debug("[ensureLiffSession] skip login (loginIfNeeded=false)");
        // ログインせず進む（既存CookieがあればAPIは通る）
      } else {
        const redirectUri = options.redirectUri ?? window.location.href;
        console.debug("[ensureLiffSession] redirecting to liff.login", { redirectUri });
        liff.login({ redirectUri });
        return { ok: false, reason: "login_redirected" };
      }
    } else {
      console.debug("[ensureLiffSession] already logged in");
    }

    // IDトークンが取れるなら loginUrl に投げて Cookie を確立
    const idToken = liff.getIDToken();
    console.debug("[ensureLiffSession] idToken", { present: !!idToken });
    if (idToken) {
      console.debug("[ensureLiffSession] POST", { loginUrl });
      const res = await fetch(loginUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ idToken }),
      });
      console.debug("[ensureLiffSession] liff-login response", { status: res.status });
      
      if (!res.ok){
        console.warn("[ensureLiffSession] verify_failed");
        return { ok: false, reason: "verify_failed" };
      }

      const decoded = liff.getDecodedIDToken();
      const userId = decoded?.sub;
      console.debug("[ensureLiffSession] established", { hasUserId: !!userId });
      return { ok: true, established: true, idToken, userId };
    }

    // 既に Cookie がある（またはブラウザ直開きで未ログインだが先に進めたい）ケース
    console.debug("[ensureLiffSession] proceed without idToken (assume cookie exists)");
    return { ok: true, established: false };
  } catch (e) {
    console.error("[ensureLiffSession] unexpected", e);
    return {
      ok: false,
      reason: "unexpected",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
