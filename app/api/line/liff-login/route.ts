import { NextResponse } from "next/server";
import { verifyIdTokenWithLINE, assertLineVerifyClaims } from "@/utils/line/lineAuth";

const ID_TOKEN_COOKIE_PRIMARY = "liff_id_token";
const ID_TOKEN_COOKIE_COMPAT = "id_token";
const COOKIE_DOMAIN = process.env.SESSION_COOKIE_DOMAIN || undefined;

export async function POST(req: Request) {
  const rid = crypto.randomUUID().slice(0, 8);

  try {
    const { idToken } = (await req.json()) as { idToken?: string };
    console.info(`[liff-login:${rid}] start`, {
      hasIdToken: !!idToken,
      origin: req.headers.get("origin") || "",
      ua: req.headers.get("user-agent") || "",
    });

    if (!idToken){
      console.warn(`[liff-login:${rid}] no_id_token`);
      return NextResponse.json({ error: "no_id_token" }, { status: 400 });
    }

    const payload = await verifyIdTokenWithLINE(idToken);
    // aud/iss/exp/sub検証
    const { userId, exp } = assertLineVerifyClaims(payload);

    const now = Math.floor(Date.now() / 1000);
    const maxAge = Math.max(0, Math.min(60 * 60 * 24 * 30, exp - now));

    const res = NextResponse.json({
      ok: true,
      userIdPreview: `${userId.slice(0, 4)}…${userId.slice(-4)}`,
    });

    const commonCookie = {
      httpOnly: true as const,
      sameSite: "none" as const,
      secure: true,
      path: "/",
      ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
      maxAge,
    };

    // IDトークンを Cookie に保存
    res.cookies.set(ID_TOKEN_COOKIE_PRIMARY, idToken, commonCookie);
    res.cookies.set(ID_TOKEN_COOKIE_COMPAT, idToken, commonCookie);

    console.info(`[liff-login:${rid}] cookie_set`, {
      names: [ID_TOKEN_COOKIE_PRIMARY, ID_TOKEN_COOKIE_COMPAT],
      sameSite: "none",
      secure: true,
      domain: COOKIE_DOMAIN || "(host-default)",
      maxAge,
    });

    return res;
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    console.error(`[liff-login:${rid}] error`, e);
    return NextResponse.json({ error: "internal_error" }, { status });
  }
}
