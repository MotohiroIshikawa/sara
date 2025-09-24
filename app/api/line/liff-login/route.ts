import { NextResponse } from "next/server";

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "lineUserId";
const CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID!;

// LINEのIDトークン検証エンドポイント（サーバ側から呼ぶ）
async function verifyIdToken(idToken: string) {
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      id_token: idToken,
      client_id: CHANNEL_ID, // = Channel ID
    }),
  });
  if (!res.ok) return null;
  // 返ってくる JSON は { iss, sub, aud, exp, iat, amr, name?, picture?, ... }
  return (await res.json()) as { sub?: string } | null;
}

export async function POST(req: Request) {
  try {
    const { idToken } = (await req.json()) as { idToken?: string };
    if (!idToken) return NextResponse.json({ error: "no_id_token" }, { status: 400 });

    const verified = await verifyIdToken(idToken);
    const userId = verified?.sub;
    if (!userId) return NextResponse.json({ error: "invalid_token" }, { status: 401 });

    // セッションCookie発行（30日）
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE_NAME, userId, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  } catch (e) {
    console.error("[liff-login] error", e);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
