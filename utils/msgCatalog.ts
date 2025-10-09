export type MsgKey =
  // gpts.ts関係
  | "GROUP_SAVE_DENY"
  | "TAP_LATER"
  | "SAVE_TARGET_NOT_FOUND"
  | "CONTINUE_OK"
  | "NEW_INTRO_1"
  | "NEW_INTRO_2"
  | "ACTIVATE_FAIL"
  | "ACTIVATE_OK"
  | "APPLY_OWNER_FAIL_NOUSER"
  | "APPLY_OWNER_FAIL_NOBIND"
  | "APPLY_OWNER_OK"
  | "APPLY_OWNER_OK_NAME" // {name}
  // lineEvent.ts関係
  | "FOLLOW_GREETING"
  | "JOIN_GREETING_1"
  | "JOIN_GREETING_2"
  | "MEMBERLEFT_NOTIFY"
  | "UNFOLLOW_TARGET_NOTIFY"
  | "MESSAGE_EMPTY_WARN"
  | "INTERNAL_ERROR"
  // sched.ts関係
  | "SCHED_START_NO"
  | "SCHED_START_YES_CONFIRM"
  | "SCHED_START_INVALID"
  | "SCHED_FREQ_INVALID"
  | "SCHED_FREQ_CONFIRM_TPL" // {LABEL}
  | "SCHED_PICKDATE_ERROR"
  | "SCHED_PICKDATE_NODRAFT"
  | "SCHED_PICKDATE_CONFIRM_TPL" // {DAY}
  | "SCHED_PICKDATE_NOTE"
  | "SCHED_WEEKLY_NEEDONE"
  | "SCHED_WEEKLY_CONFIRM_TPL" // {PICKED}
  | "SCHED_PICKTIME_PROMPT"
  | "SCHED_TIME_REDO_PROMPT"
  | "SCHED_TIME_ERROR"
  | "SCHED_TIME_FINALCONFIRM_TPL" // {FREQLABEL}, {HHM}
  | "SCHED_ENABLE_NODRAFT"
  | "SCHED_ENABLE_SUCCESS"
  // ui.ts関係
  | "UI_SAVEDASK_ALT"
  | "UI_SAVEDASK_TEXT_TPL" // {NAME}
  | "UI_SAVEDASK_YES"
  | "UI_SAVEDASK_NO"
  | "UI_FREQ_ALT"
  | "UI_FREQ_TEXT"
  | "UI_FREQ_DAILY"
  | "UI_FREQ_WEEKLY"
  | "UI_FREQ_MONTHLY"
  | "UI_PICKDATE_ALT"
  | "UI_PICKDATE_TEXT"
  | "UI_PICKDATE_LABEL"
  | "UI_PICKTIME_ALT"
  | "UI_PICKTIME_TEXT"
  | "UI_PICKTIME_LABEL"
  | "UI_PICKTIME_INITIAL"
  | "UI_WDAY_ALT"
  | "UI_WDAY_TITLE"
  | "UI_WDAY_SELECTED_PREFIX"
  | "UI_WDAY_SELECTED_NONE"
  | "UI_WDAY_NEXT"
  | "UI_WDAY_PRESET_CLEAR"
  | "UI_FINAL_ALT"
  | "UI_FINAL_ENABLE"
  | "UI_FINAL_RESTART"
  | "UI_ROUND_ALT"
  | "UI_ROUND_TEXT_CHANGED_TPL" // {HH},{MM},{STEP},{MMR}
  | "UI_ROUND_TEXT_OK_TPL"      // {HH},{MM}
  | "UI_ROUND_OK"
  | "UI_ROUND_REDO";

// デフォルトの日本語文言（環境変数が無い場合に使用）
const DEFAULT_MSGS: Readonly<Record<MsgKey, string>> = {
  // gpts.ts関係
  GROUP_SAVE_DENY: "グループルームではチャットルールの保存はできません。",
  TAP_LATER: "少し待ってからお試しください。",
  SAVE_TARGET_NOT_FOUND: "保存対象が見つかりませんでした。もう一度お試しください。",
  CONTINUE_OK: "了解しました。続けましょう！",
  NEW_INTRO_1: "新しいチャットルールを作りましょう。",
  NEW_INTRO_2: "ルールの内容、用途や対象をひと言で教えてください。",
  ACTIVATE_FAIL: "⚠️有効化できませんでした。対象が見つからないか内容が空です。",
  ACTIVATE_OK: "選択したチャットルールを有効化しました。",
  APPLY_OWNER_FAIL_NOUSER: "操作したユーザーが特定できませんでした。もう一度お試しください。",
  APPLY_OWNER_FAIL_NOBIND: "適用できるルールが見つかりませんでした。まずは自分のトークでルールを保存してください。",
  APPLY_OWNER_OK: "このトークルームにルールを適用しました。スケジュールに沿って配信します！",
  APPLY_OWNER_OK_NAME: "「{name}」を適用しました。スケジュールに沿って配信します！",

  // lineEvent.ts関係
  FOLLOW_GREETING: "友だち追加ありがとうございます！\n（使い方の説明文）\n質問をどうぞ🙌",
  JOIN_GREETING_1: "グループに参加させていただきありがとうございます！",
  JOIN_GREETING_2: "このグループにチャットルールを適用しますか？",
  MEMBERLEFT_NOTIFY:
    "このルームのチャットルールの作成者が退出されたので退室しますね。またこんど誘ってください！",
  UNFOLLOW_TARGET_NOTIFY:
    "このルームのチャットルールの作成者に友だち解除されちゃったので退室しますね。またこんど誘ってください！",
  MESSAGE_EMPTY_WARN: "⚠️メッセージが空です。",
  INTERNAL_ERROR: "⚠️内部エラーが発生しました。時間をおいてもう一度お試しください。",

  // sched.ts関係
  //// start
  SCHED_START_NO: "了解しました！\n定期実施は設定しません。\n\nもし必要になりましたらメニューの「編集・選択」からも変更できます！",
  SCHED_START_YES_CONFIRM: "了解しました！\n定期実施ですね！",
  SCHED_START_INVALID: "すみません、選択を認識できませんでした。もう一度お試しください。",
  //// freq
  SCHED_FREQ_INVALID: "すみません、選択内容を認識できませんでした。もう一度お試しください。",
  SCHED_FREQ_CONFIRM_TPL: "「{LABEL}」実施ですね！",
  //// pickDate
  SCHED_PICKDATE_ERROR: "うまく日付を受け取れませんでした。もう一度お試しください。",
  SCHED_PICKDATE_NODRAFT: "スケジュールの下書きが見つかりませんでした。最初からやり直してください。",
  SCHED_PICKDATE_CONFIRM_TPL: "了解しました！\n毎月{DAY}日ですね！",
  SCHED_PICKDATE_NOTE: "※ 29/30/31日など、存在しない月はその月はスキップします。",
  //// weekly
  SCHED_WEEKLY_NEEDONE: "少なくとも1つ、曜日を選んでください。",
  SCHED_WEEKLY_CONFIRM_TPL: "了解しました！\n毎週（{PICKED}）ですね！",
  //// time
  SCHED_PICKTIME_PROMPT: "では実施する何時を選んでください。",
  SCHED_TIME_REDO_PROMPT: "実施する何時を選んでください。",
  SCHED_TIME_ERROR: "うまく時刻を受け取れませんでした。\nもう一度お試しください。",
  SCHED_TIME_FINALCONFIRM_TPL: "了解しました！\n{FREQLABEL} の {HHM} に実施します。\nこれでよろしいですか？",
  //// enable
  SCHED_ENABLE_NODRAFT: "有効化できませんでした。下書きが見つかりません。",
  SCHED_ENABLE_SUCCESS: "スケジュールを設定しました。",

  // ui.ts関係 ここから
  //// 保存→定期実施確認
  UI_SAVEDASK_ALT: "定期実施の設定",
  UI_SAVEDASK_TEXT_TPL:
    "保存しました：{NAME}\nこのトークではこのルールを使います。\n\nこのルールを自動で定期的に実施しますか？",
  UI_SAVEDASK_YES: "定期実施する",
  UI_SAVEDASK_NO: "しない",
  //// 頻度選択
  UI_FREQ_ALT: "実施タイミングを選択",
  UI_FREQ_TEXT: "まずは実施タイミングを選んでください",
  UI_FREQ_DAILY: "毎日",
  UI_FREQ_WEEKLY: "毎週",
  UI_FREQ_MONTHLY: "毎月",
  //// 日付ピッカー
  UI_PICKDATE_ALT: "日付を選択",
  UI_PICKDATE_TEXT: "何日にしますか？ 日付を選んでください",
  UI_PICKDATE_LABEL: "日付を選ぶ",
  //// 時刻ピッカー
  UI_PICKTIME_ALT: "時間を選択",
  UI_PICKTIME_TEXT: "何時にしますか？ 時間を選んでください",
  UI_PICKTIME_LABEL: "時間を選択",
  UI_PICKTIME_INITIAL: "09:00",
  //// 曜日Flex
  UI_WDAY_ALT: "曜日を選択",
  UI_WDAY_TITLE: "毎週の実施曜日を選んでください",
  UI_WDAY_SELECTED_PREFIX: "選択中: ",
  UI_WDAY_SELECTED_NONE: "選択中: なし",
  UI_WDAY_NEXT: "次へ（時刻）",
  //// UI_WDAY_PRESET_WEEKDAYS / UI_WDAY_PRESET_WEEKEND は現状未使用のため未定義
  UI_WDAY_PRESET_CLEAR: "クリア",
  //// 最終確認
  UI_FINAL_ALT: "最終確認",
  UI_FINAL_ENABLE: "OK",
  UI_FINAL_RESTART: "修正",
  //// 分丸め確認
  UI_ROUND_ALT: "分丸めの確認",
  UI_ROUND_TEXT_CHANGED_TPL:
    "「{HH}:{MM}」で受け取りましたが、{STEP}分単位に丸めて「{HH}:{MMR}」で実施します。よろしいですか？",
  UI_ROUND_TEXT_OK_TPL: "「{HH}:{MM}」で実施します。よろしいですか？",
  UI_ROUND_OK: "OK",
  UI_ROUND_REDO: "修正",
} as const;

// メッセージ本文を取得。
//   環境変数 MSG_<KEY> があればそれを優先。
//   例: MSG_JOIN_GREETING_1="ようこそ！"
export function getMsg(key: MsgKey): string {
  const envKey: string = `MSG_${key}`;
  const fromEnv: string | undefined = process.env[envKey];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return DEFAULT_MSGS[key];
}

// 簡易テンプレート置換。「{name}」のようなトークンを埋め込み。
//   例: formatMsg(getMsg("APPLY_OWNER_OK_NAME"), { name: "朝活ニュース" })
export function formatMsg(template: string, tokens: Readonly<Record<string, string | number>>): string {
  let out: string = template;
  for (const [k, v] of Object.entries(tokens)) {
    const re: RegExp = new RegExp(`\\{${escapeRegExp(String(k))}\\}`, "g");
    out = out.replace(re, String(v));
  }
  return out;
}

// 正規表現用エスケープ
function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}