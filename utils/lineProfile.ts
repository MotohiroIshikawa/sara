export type LineProfile = {
  displayName?: string;
  pictureUrl?: string;
  statusMessage?: string;
  language?: string;
};

export async function fetchLineUserProfile(userId: string): Promise<LineProfile | null> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is missing");

  const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    // グループ/ルームなど1:1以外や権限不足時はここに来る想定
    const body = await res.text().catch(() => "");
    console.warn(`[lineProfile] fetch failed ${res.status} ${res.statusText} ${body}`);
    return null;
  }

  const j = (await res.json()) as unknown;
  return {
    displayName: j.displayName,
    pictureUrl: j.pictureUrl,
    statusMessage: j.statusMessage,
    language: j.language,
  };
}