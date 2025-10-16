export function formatIsoToJa(iso: string, tz: string = "Asia/Tokyo"): string { // ★ tzを任意指定（既定: Asia/Tokyo）
  try {
    const d: Date = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso; // 無効な日付はそのまま返す

    // タイムゾーン固定で YYYY/MM/DD HH:mm を作る
    const parts: Intl.DateTimeFormatPart[] = new Intl.DateTimeFormat("ja-JP", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);

    // 必要なパーツだけ抜き出して結合
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      (parts.find(p => p.type === type)?.value ?? "");
    const y: string = get("year");
    const m: string = get("month");
    const dd: string = get("day");
    const hh: string = get("hour");
    const mm: string = get("minute");

    return `${y}/${m}/${dd} ${hh}:${mm}`;
  } catch {
    return iso;
  }
}
