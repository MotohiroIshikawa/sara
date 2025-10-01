import { messagingApi } from "@line/bot-sdk";
import { WD } from "@/types/schedule";
import { encodePostback } from "@/utils/postback";

const DEFAULT_MSGS = {
  // 保存→定期実施確認
  UI_SAVEDASK_ALT: "定期実施の設定",
  UI_SAVEDASK_TEXT_TPL:
    "保存しました：${NAME}\nこのトークではこの設定を使います。\n\nこのチャットルールを自動で定期的に実施しますか？",
  UI_SAVEDASK_YES: "定期実施する",
  UI_SAVEDASK_NO: "しない",
  // 頻度選択
  UI_FREQ_ALT: "実施タイミングを選択",
  UI_FREQ_TEXT: "まずは実施タイミングを選んでください",
  UI_FREQ_DAILY: "毎日",
  UI_FREQ_WEEKLY: "毎週",
  UI_FREQ_MONTHLY: "毎月",
  // 日付ピッカー
  UI_PICKDATE_ALT: "日付を選択",
  UI_PICKDATE_TEXT: "何日にしますか？日付を選んでください",
  UI_PICKDATE_LABEL: "日付を選ぶ",
  // 時刻ピッカー
  UI_PICKTIME_ALT: "時間を選択",
  UI_PICKTIME_TEXT: "何時にしますか？時間を選んでください",
  UI_PICKTIME_LABEL: "時間を選択",
  UI_PICKTIME_INITIAL: "09:00",
  // 曜日Flex
  UI_WDAY_ALT: "曜日を選択",
  UI_WDAY_TITLE: "毎週の実施曜日を選んでください",
  UI_WDAY_SELECTED_PREFIX: "選択中: ",
  UI_WDAY_SELECTED_NONE: "選択中: なし",
  UI_WDAY_NEXT: "次へ（時刻）",
  UI_WDAY_PRESET_WEEKDAYS: "平日",
  UI_WDAY_PRESET_WEEKEND: "週末",
  UI_WDAY_PRESET_CLEAR: "クリア",
  // 最終確認
  UI_FINAL_ALT: "最終確認",
  UI_FINAL_ENABLE: "有効化する",
  UI_FINAL_RESTART: "修正する",
  // 分丸め確認
  UI_ROUND_ALT: "分丸めの確認",
  UI_ROUND_TEXT_CHANGED_TPL:
    "「${HH}:${MM}」で受け取りましたが、${STEP}分単位に丸めて「${HH}:${MMR}」で実施します。よろしいですか？",
  UI_ROUND_TEXT_OK_TPL: "「${HH}:${MM}」で実施します。よろしいですか？",
  UI_ROUND_OK: "OK",
  UI_ROUND_REDO: "別の時刻にする",
} as const;
type MsgKey = keyof typeof DEFAULT_MSGS;
const msg = (k: MsgKey): string => process.env[`MSG_${k}`] ?? DEFAULT_MSGS[k];
const fmt = (k: MsgKey, vars: Record<string, string | number>): string => {
  let s = msg(k);
  for (const [key, val] of Object.entries(vars)) {
    s = s.replaceAll(`\${${key}}`, String(val));
  }
  return s;
};

/* ===== 「保存しました＋定期実施しますか？」Confirm ===== */
export function uiSavedAndAskSchedule(gptsId: string, savedName: string): messagingApi.Message  {
  return {
    type: "template",
    altText: msg("UI_SAVEDASK_ALT"),
    template: {
      type: "confirm",
      text: fmt("UI_SAVEDASK_TEXT_TPL", { NAME: savedName }),
      actions: [
        {
          type: "postback",
          label: msg("UI_SAVEDASK_YES"),
          data: encodePostback("sched", "start", { gptsId, ans: "yes" }),
          displayText: msg("UI_SAVEDASK_YES"),
        },
        {
          type: "postback",
          label: msg("UI_SAVEDASK_NO"),
          data: encodePostback("sched", "start", { gptsId, ans: "no" }),
          displayText: msg("UI_SAVEDASK_NO"),
        },
      ],
    },
  } as messagingApi.Message;
}

/* ===== 頻度選択（毎日/毎週/毎月） ===== */
export function uiChooseFreq(gptsId: string): messagingApi.Message {
  return {
    type: "template",
    altText: msg("UI_FREQ_ALT"),
    template: {
      type: "buttons",
      text: msg("UI_FREQ_TEXT"),
      actions: [
        { type: "postback", label: msg("UI_FREQ_DAILY"),   data: encodePostback("sched", "freq", { gptsId, freq: "daily"  }), displayText: msg("UI_FREQ_DAILY") },
        { type: "postback", label: msg("UI_FREQ_WEEKLY"),   data: encodePostback("sched", "freq", { gptsId, freq: "weekly" }), displayText: msg("UI_FREQ_WEEKLY") },
        { type: "postback", label: msg("UI_FREQ_MONTHLY"),   data: encodePostback("sched", "freq", { gptsId, freq: "monthly"}), displayText: msg("UI_FREQ_MONTHLY") },
      ],
    },
  } as messagingApi.Message;
}

/* ===== 日付ピッカー（毎月用） ===== */
export function uiPickMonthday(gptsId: string): messagingApi.Message {
  return {
    type: "template",
    altText: msg("UI_PICKDATE_ALT"),
    template: {
      type: "buttons",
      text: msg("UI_PICKDATE_TEXT"),
      actions: [
        {
          type: "datetimepicker",
          label: msg("UI_PICKDATE_LABEL"),
          data: encodePostback("sched", "pickDate", { gptsId }),
          mode: "date",
          initial: new Date().toISOString().slice(0, 10),
        },
      ],
    },
  } as messagingApi.Message;
}

/* ===== 時刻ピッカー（共通） ===== */
export function uiPickTime(gptsId: string, opts?: { text?: string; initial?: string }): messagingApi.Message {
  return {
    type: "template",
    altText: msg("UI_PICKTIME_ALT"),
    template: {
      type: "buttons",
      text: opts?.text ?? msg("UI_PICKTIME_TEXT"),
      actions: [
        {
          type: "datetimepicker",
          label: msg("UI_PICKTIME_LABEL"),
          data: encodePostback("sched", "pickTime", { gptsId }),
          mode: "time",
          initial: opts?.initial ?? msg("UI_PICKTIME_INITIAL"),
          min: "00:00",
          max: "23:59",
        },
      ],
    },
  } as messagingApi.Message;
}

/* ===== 曜日選択Flex（毎週用） ===== */
export function uiWeekdayFlex(gptsId: string, selected: ReadonlyArray<string>): messagingApi.Message {
  const selectedSet = new Set(selected);
  const chunks: Array<Array<typeof WD[number]>> = [[WD[0], WD[1], WD[2], WD[3]], [WD[4], WD[5], WD[6]]];

  const rows = chunks.map((row) => ({
    type: "box" as const,
    layout: "horizontal" as const,
    spacing: "sm" as const,
    contents: row.map((d) => ({
      type: "button" as const,
      style: selectedSet.has(d.key) ? ("primary" as const) : ("secondary" as const),
      height: "sm" as const,
      action: {
        type: "postback" as const,
        label: d.label,
        data: encodePostback("sched", "wdayToggle", { gptsId, v: d.key }),
        displayText: d.label,
      },
    })),
  }));

  const selectedLabel =
    selected.length > 0
      ? `${msg("UI_WDAY_SELECTED_PREFIX")}${WD.filter(w => selectedSet.has(w.key)).map(w => w.label).join("・")}`
      : msg("UI_WDAY_SELECTED_NONE");

  return {
    type: "flex",
    altText: msg("UI_WDAY_ALT"),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: msg("UI_WDAY_TITLE"), weight: "bold", size: "md" },
          { type: "text", text: selectedLabel, size: "sm", color: "#888888" },
          ...rows,
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            margin: "md",
            contents: [
              {
                type: "button",
                style: "primary",
                height: "sm",
                action: { type: "postback", label: msg("UI_WDAY_NEXT"), data: encodePostback("sched", "wdayNext", { gptsId }), displayText: msg("UI_WDAY_NEXT") },
              },
              {
                type: "button",
                style: "link",
                height: "sm",
                action: { type: "postback", label: msg("UI_WDAY_PRESET_WEEKDAYS"), data: encodePostback("sched", "wdayPreset", { gptsId, v: "weekdays" }), displayText: msg("UI_WDAY_PRESET_WEEKDAYS") },
              },
              {
                type: "button",
                style: "link",
                height: "sm",
                action: { type: "postback", label: msg("UI_WDAY_PRESET_WEEKEND"), data: encodePostback("sched", "wdayPreset", { gptsId, v: "weekend" }), displayText: msg("UI_WDAY_PRESET_WEEKEND") },
              },
              {
                type: "button",
                style: "link",
                height: "sm",
                action: { type: "postback", label: msg("UI_WDAY_PRESET_CLEAR"), data: encodePostback("sched", "wdayPreset", { gptsId, v: "clear" }), displayText: msg("UI_WDAY_PRESET_CLEAR") },
              },
            ],
          },
        ],
      },
    },
  } as messagingApi.Message;
}

/* ===== 最終確認（有効化） ===== */
export function uiFinalEnableConfirm(gptsId: string, text: string): messagingApi.Message {
  return {
    type: "template",
    altText: "最終確認",
    template: {
      type: "confirm",
      text,
      actions: [
        { type: "postback", label: msg("UI_FINAL_ALT"), data: encodePostback("sched", "enable", { gptsId }), displayText: msg("UI_FINAL_ALT") },
        { type: "postback", label: msg("UI_FINAL_RESTART"), data: encodePostback("sched", "restart", { gptsId }), displayText: msg("UI_FINAL_RESTART") },
      ],
    },
  } as messagingApi.Message;
}

/* ===== 分丸め確認 ===== */
export function uiTimeRoundingConfirm(
  gptsId: string, 
  hour: number, 
  minuteOrig: number, 
  minuteRounded: number, 
  step: number
): messagingApi.Message {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minuteOrig).padStart(2, "0");
  const mmr = String(minuteRounded).padStart(2, "0");
  const changed = minuteOrig !== minuteRounded;

  return {
    type: "template",
    altText: msg("UI_ROUND_ALT"),
    template: {
      type: "confirm",
      text: changed
        ? fmt("UI_ROUND_TEXT_CHANGED_TPL", { HH: hh, MM: mm, STEP: step, MMR: mmr })
        : fmt("UI_ROUND_TEXT_OK_TPL", { HH: hh, MM: mm }),
      actions: [
        {
          type: "postback",
          label: msg("UI_ROUND_OK"),
          data: encodePostback("sched", "timeOk", { gptsId, hour: String(hour), minute: String(minuteRounded) }),
          displayText: msg("UI_ROUND_OK"),
        },
        {
          type: "postback",
          label: msg("UI_ROUND_REDO"),
          data: encodePostback("sched", "timeRedo", { gptsId }),
          displayText: msg("UI_ROUND_REDO"),
        },
      ],
    },
  } as messagingApi.Message;
}

export { WD };
