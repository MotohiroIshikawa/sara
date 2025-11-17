import { messagingApi } from "@line/bot-sdk";
import { WD } from "@/types/schedule";
import { encodePostback } from "@/utils/line/postback";
import { getMsg, formatMsg } from "@/utils/line/msgCatalog";

// 「保存しました＋定期実施しますか？」Confirm
export function uiSavedAndAskSchedule(gptsId: string, savedName: string): messagingApi.Message  {
  return {
    type: "template",
    altText: getMsg("UI_SAVEDASK_ALT"),
    template: {
      type: "confirm",
      text: formatMsg(getMsg("UI_SAVEDASK_TEXT_TPL"), { NAME: savedName }),
      actions: [
        {
          type: "postback",
          label: getMsg("UI_SAVEDASK_YES"),
          data: encodePostback("sched", "start", { gptsId, ans: "yes" }),
          displayText: getMsg("UI_SAVEDASK_YES"),
        },
        {
          type: "postback",
          label: getMsg("UI_SAVEDASK_NO"),
          data: encodePostback("sched", "start", { gptsId, ans: "no" }),
          displayText: getMsg("UI_SAVEDASK_NO"),
        },
      ],
    },
  } as messagingApi.Message;
}

// 頻度選択（毎日/毎週/毎月） 
export function uiChooseFreq(gptsId: string): messagingApi.Message {
  return {
    type: "template",
    altText: getMsg("UI_FREQ_ALT"),
    template: {
      type: "buttons",
      text: getMsg("UI_FREQ_TEXT"),
      actions: [
        { type: "postback", label: getMsg("UI_FREQ_DAILY"),   data: encodePostback("sched", "freq", { gptsId, freq: "daily"  }), displayText: getMsg("UI_FREQ_DAILY") },
        { type: "postback", label: getMsg("UI_FREQ_WEEKLY"),  data: encodePostback("sched", "freq", { gptsId, freq: "weekly" }), displayText: getMsg("UI_FREQ_WEEKLY") },
        { type: "postback", label: getMsg("UI_FREQ_MONTHLY"), data: encodePostback("sched", "freq", { gptsId, freq: "monthly"}), displayText: getMsg("UI_FREQ_MONTHLY") },
      ],
    },
  } as messagingApi.Message;
}

// 日付ピッカー（毎月用）
export function uiPickMonthday(gptsId: string): messagingApi.Message {
  return {
    type: "template",
    altText: getMsg("UI_PICKDATE_ALT"),
    template: {
      type: "buttons",
      text: getMsg("UI_PICKDATE_TEXT"),
      actions: [
        {
          type: "datetimepicker",
          label: getMsg("UI_PICKDATE_LABEL"),
          data: encodePostback("sched", "pickDate", { gptsId }),
          mode: "date",
          initial: new Date().toISOString().slice(0, 10),
        },
      ],
    },
  } as messagingApi.Message;
}

// 時刻ピッカー（共通）
export function uiPickTime(gptsId: string, opts?: { text?: string; initial?: string }): messagingApi.Message {
  return {
    type: "template",
    altText: getMsg("UI_PICKTIME_ALT"),
    template: {
      type: "buttons",
      text: opts?.text ?? getMsg("UI_PICKTIME_TEXT"),
      actions: [
        {
          type: "datetimepicker",
          label: getMsg("UI_PICKTIME_LABEL"),
          data: encodePostback("sched", "pickTime", { gptsId }),
          mode: "time",
          initial: opts?.initial ?? getMsg("UI_PICKTIME_INITIAL"),
          min: "00:00",
          max: "23:59",
        },
      ],
    },
  } as messagingApi.Message;
}

// 曜日選択Flex（毎週用）
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
        data: encodePostback("sched", "wdayToggle", { gptsId, wd: d.key }),
        displayText: d.label,
      },
    })),
  }));

  const selectedLabel =
    selected.length > 0
      ? `${getMsg("UI_WDAY_SELECTED_PREFIX")}${WD.filter(w => selectedSet.has(w.key)).map(w => w.label).join("・")}`
      : getMsg("UI_WDAY_SELECTED_NONE");

  return {
    type: "flex",
    altText: getMsg("UI_WDAY_ALT"),
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: getMsg("UI_WDAY_TITLE"), weight: "bold", size: "md" },
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
                action: { type: "postback", label: getMsg("UI_WDAY_NEXT"), data: encodePostback("sched", "wdayNext", { gptsId }), displayText: getMsg("UI_WDAY_NEXT") },
              },
              {
                type: "button",
                style: "link",
                height: "sm",
                action: { 
                  type: "postback", 
                  label: getMsg("UI_WDAY_PRESET_CLEAR"),
                  data: encodePostback("sched", "wdayPreset", { gptsId, preset: "clear" }), 
                  displayText: getMsg("UI_WDAY_PRESET_CLEAR"),
                },
              },
            ],
          },
        ],
      },
    },
  } as messagingApi.Message;
}

// 最終確認（有効化）
export function uiFinalEnableConfirm(gptsId: string, text: string): messagingApi.Message {
  return {
    type: "template",
    altText: getMsg("UI_FINAL_ALT"),
    template: {
      type: "confirm",
      text,
      actions: [
        { type: "postback", label: getMsg("UI_FINAL_ENABLE"), data: encodePostback("sched", "enable",  { gptsId }), displayText: getMsg("UI_FINAL_ALT") },
        { type: "postback", label: getMsg("UI_FINAL_RESTART"), data: encodePostback("sched", "restart", { gptsId }), displayText: getMsg("UI_FINAL_RESTART") },
      ],
    },
  } as messagingApi.Message;
}

// 分丸め確認
export function uiTimeRoundingConfirm(
  gptsId: string, 
  hour: number, 
  minuteOrig: number, 
  minuteRounded: number, 
  step: number
): messagingApi.Message {
  const hh: string = String(hour).padStart(2, "0");
  const mm: string = String(minuteOrig).padStart(2, "0");
  const mmr: string = String(minuteRounded).padStart(2, "0");
  const changed: boolean = minuteOrig !== minuteRounded;

  return {
    type: "template",
    altText: getMsg("UI_ROUND_ALT"),
    template: {
      type: "confirm",
      text: changed
        ? formatMsg(getMsg("UI_ROUND_TEXT_CHANGED_TPL"), { HH: hh, MM: mm, STEP: step, MMR: mmr })
        : formatMsg(getMsg("UI_ROUND_TEXT_OK_TPL"), { HH: hh, MM: mm }),
      actions: [
        {
          type: "postback",
          label: getMsg("UI_ROUND_OK"),
          data: encodePostback("sched", "timeOk", { gptsId, hour: String(hour), minute: String(minuteRounded) }),
          displayText: getMsg("UI_ROUND_OK"),
        },
        {
          type: "postback",
          label: getMsg("UI_ROUND_REDO"),
          data: encodePostback("sched", "timeRedo", { gptsId }),
          displayText: getMsg("UI_ROUND_REDO"),
        },
      ],
    },
  } as messagingApi.Message;
}

export { WD };
