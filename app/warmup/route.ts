import { NextResponse } from "next/server";

export async function GET() {
  try {
    // 動的 import で初回に依存を解決＆“コンパイル”させる
    const { pingMongo } = await import("@/utils/mongo");
    const { ensureUserIndexes } = await import("@/services/users.mongo");

    // DB疎通 & インデックス（idempotent）
    await pingMongo();
    await ensureUserIndexes();

    // ついでに重いモジュールを先読み（必要に応じて増やす）
    await Promise.all([
      import("@/utils/line/lineProfile"),
      // 必要なら /linebot を巻き込んで事前にバンドルさせたい場合：
      // import("@/app/linebot/route"),  // ※開発用途限定推奨
      import("@/app/linebot/route"),
    ]);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[warmup] failed:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
