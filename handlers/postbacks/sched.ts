import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/lineSend";
import { getBindingTarget, getRecipientId, getThreadOwnerId } from "@/utils/lineSource";
import { getGptsSchedulesCollection } from "@/utils/mongo";
import { createDraftSchedule, updateScheduleById } from "@/services/gptsSchedules.mongo";
import { computeNextRunAt, roundMinutes } from "@/utils/schedulerTime";
import {
  uiChooseFreq,
  uiPickMonthday,
  uiPickTime,
  uiWeekdayFlex,
  uiFinalEnableConfirm,
  uiTimeRoundingConfirm,
  WD,
} from "@/handlers/postbacks/ui";
import type { Handler } from "@/handlers/postbacks/shared";

// メッセージ定義
const DEFAULT_MSGS = {
  // start
  SCHED_START_NO: "了解しました。定期実施は設定しません。",
  SCHED_START_YES_CONFIRM: "了解しました！\n定期実施ですね！",
  SCHED_START_INVALID: "すみません、選択を認識できませんでした。もう一度お試しください。",
  // freq
  SCHED_FREQ_INVALID: "すみません、選択内容を認識できませんでした。もう一度お試しください。",
  SCHED_FREQ_CONFIRM_TPL: "「${LABEL}」実施ですね！",
  // pickDate
  SCHED_PICKDATE_ERROR: "うまく日付を受け取れませんでした。もう一度お試しください。",
  SCHED_PICKDATE_NODRAFT: "スケジュールの下書きが見つかりませんでした。最初からやり直してください。",
  SCHED_PICKDATE_CONFIRM_TPL: "毎月${DAY}日ですね！",
  SCHED_PICKDATE_NOTE: "※ 29/30/31日など、存在しない月はその月はスキップします。",
  // weekly
  SCHED_WEEKLY_NEEDONE: "少なくとも1つ、曜日を選んでください。",
  SCHED_WEEKLY_CONFIRM_TPL: "了解しました！\n毎週（${PICKED}）ですね！",
  // time
  SCHED_PICKTIME_PROMPT: "何時にしましょう？（時刻を選んでください）",
  SCHED_TIME_REDO_PROMPT: "もう一度、何時にしましょう？",
  SCHED_TIME_ERROR: "うまく時刻を受け取れませんでした。もう一度お試しください。",
  SCHED_TIME_FINALCONFIRM_TPL: "了解しました！\n${FREQLABEL} の ${HHM} に実施します。これで有効化しますか？",
  // enable
  SCHED_ENABLE_NODRAFT: "有効化できませんでした。下書きが見つかりません。",
  SCHED_ENABLE_SUCCESS: "スケジュールを有効化しました。",
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

function asFreq(v: string | undefined): "daily" | "weekly" | "monthly" | null {
  const x = (v ?? "").toLowerCase();
  return x === "daily" || x === "weekly" || x === "monthly" ? x : null;
}

function pickStrParam(obj: unknown, key: "date" | "time"): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

// ハンドラ本体

// 「定期実施する / しない」
const start: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  const bindingTarget = getBindingTarget(event);
  if (!recipientId || !userId || !bindingTarget) return;

  const ans = (args["ans"] || "").toLowerCase();
  const gptsId = (args["gptsId"] || "").trim();

  if (ans === "no") {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("SCHED_START_NO")]),
    });
    return;
  }

  if (ans === "yes") {
    const confirmTexts = toTextMessages([msg("SCHED_START_YES_CONFIRM")]);
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: [...confirmTexts, uiChooseFreq(gptsId)],
    });
    return;
  }

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: toTextMessages([msg("SCHED_START_INVALID")]),
  });
};

// 「毎日/毎週/毎月」選択
const freq: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  const bindingTarget = getBindingTarget(event);
  if (!recipientId || !userId || !bindingTarget) return;

  const gptsId = (args["gptsId"] || "").trim();
  const f = asFreq(args["freq"]);
  const label = f === "daily" ? "毎日" : f === "weekly" ? "毎週" : f === "monthly" ? "毎月" : null;

  if (!gptsId || !f || !label) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("SCHED_FREQ_INVALID")]),
    });
    return;
  }

  const tz = process.env.SCHEDULE_TZ_DEFAULT || "Asia/Tokyo";
  await createDraftSchedule({
    userId,
    gptsId,
    targetType: bindingTarget.type,
    targetId: bindingTarget.targetId,
    timezone: tz,
    freq: f,
  });

  const confirm = toTextMessages([fmt("SCHED_FREQ_CONFIRM_TPL", { LABEL: label })]);

  if (f === "monthly") {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: [...confirm, uiPickMonthday(gptsId)],
    });
    return;
  }
  if (f === "daily") {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: [...confirm, uiPickTime(gptsId, { text: msg("SCHED_PICKTIME_PROMPT"), initial: "09:00" })],
    });
    return;
  }
  // weekly
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [...confirm, uiWeekdayFlex(gptsId, [])],
  });
};

// 月次: 日付ピック → 時刻ピック
const pickDate: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  if (!recipientId || !userId) return;

  const gptsId = (args["gptsId"] || "").trim();
  const picked = pickStrParam(event.postback?.params, "date"); // "YYYY-MM-DD"
  const day = picked ? Number(picked.split("-")[2]) : NaN;

  if (!gptsId || !picked || !(day >= 1 && day <= 31)) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("SCHED_PICKDATE_ERROR")]),
    });
    return;
  }

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  if (!draft) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("SCHED_PICKDATE_NODRAFT")]),
    });
    return;
  }

  await updateScheduleById(draft._id, { byMonthday: [day] });

  const confirmTexts = toTextMessages([
    fmt("SCHED_PICKDATE_CONFIRM_TPL", { DAY: day }),
    msg("SCHED_PICKDATE_NOTE"),
  ]);
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [...confirmTexts, uiPickTime(gptsId, { text: msg("SCHED_PICKTIME_PROMPT"), initial: "09:00" })],
  });
};

// 週次: 初期UI
const wdayStart: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const gptsId = (args["gptsId"] || "").trim();
  if (!recipientId || !gptsId) return;

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [uiWeekdayFlex(gptsId, [])],
  });
};

// 週次: 曜日トグル
const wdayToggle: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  const gptsId = (args["gptsId"] || "").trim();
  const v = (args["wd"] || "").toUpperCase();
  if (!recipientId || !userId || !gptsId || !WD.find((w) => w.key === v)) return;

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  if (!draft) return;

  const cur = new Set(draft.byWeekday ?? []);
  if (cur.has(v)) {
    cur.delete(v);
  } else {
    cur.add(v);
  }

  const next = Array.from(cur);
  await updateScheduleById(draft._id, { byWeekday: next });

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [uiWeekdayFlex(gptsId, next)],
  });
};

// 週次: プリセット（平日/週末/クリア）
const wdayPreset: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  const gptsId = (args["gptsId"] || "").trim();
  const preset = (args["preset"] || "").toLowerCase();
  if (!recipientId || !userId || !gptsId) return;

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  if (!draft) return;

  let set: string[] = [];
  if (preset === "weekdays") set = ["MO", "TU", "WE", "TH", "FR"];
  else if (preset === "weekend") set = ["SA", "SU"];
  else if (preset === "clear") set = [];

  await updateScheduleById(draft._id, { byWeekday: set });

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [uiWeekdayFlex(gptsId, set)],
  });
};

// 週次: 曜日確定 → 時刻へ
const wdayNext: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  const gptsId = (args["gptsId"] || "").trim();
  if (!recipientId || !userId || !gptsId) return;

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  const days = draft?.byWeekday ?? [];

  if (!draft || days.length === 0) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("SCHED_WEEKLY_NEEDONE")]),
    });
    return;
  }

  const pickedLabel = WD.filter((w) => days.includes(w.key))
    .map((w) => w.label)
    .join("・");
  const confirm = toTextMessages([fmt("SCHED_WEEKLY_CONFIRM_TPL", { PICKED: pickedLabel })]);

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [...confirm, uiPickTime(gptsId, { text: msg("SCHED_PICKTIME_PROMPT"), initial: "09:00" })],
  });
};

// 時刻ピック（丸め確認へ）
const pickTime: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  if (!recipientId || !userId) return;

  const gptsId = (args["gptsId"] || "").trim();
  const tParam = pickStrParam(event.postback?.params, "time");
  if (!gptsId || !tParam) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("SCHED_TIME_ERROR")]),
    });
    return;
  }

  const [hStr, mStr] = tParam.split(":");
  const hour = Math.max(0, Math.min(23, parseInt(hStr, 10)));
  const minute = Math.max(0, Math.min(59, parseInt(mStr ?? "0", 10)));
  const step = Number(process.env.SCHEDULE_ROUND_MIN ?? 15);
  const rounded = roundMinutes(minute, step);

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [uiTimeRoundingConfirm(gptsId, hour, minute, rounded, step)],
  });
};

// 時刻選び直し
const timeRedo: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const gptsId = (args["gptsId"] || "").trim();
  if (!recipientId || !gptsId) return;

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [uiPickTime(gptsId, { text: msg("SCHED_TIME_REDO_PROMPT"), initial: "09:00" })],
  });
};

// 丸め確定 → 最終確認
const timeOk: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  if (!recipientId || !userId) return;

  const gptsId = (args["gptsId"] || "").trim();
  const hour = parseInt(args["hour"] || "", 10);
  const minute = parseInt(args["minute"] || "", 10);
  if (!gptsId || Number.isNaN(hour) || Number.isNaN(minute)) return;

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  if (!draft) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("SCHED_PICKDATE_NODRAFT")]),
    });
    return;
  }

  await updateScheduleById(draft._id, { hour, minute });

  const freqLabel =
    draft.freq === "daily"
      ? "毎日"
      : draft.freq === "weekly"
        ? `毎週（${(draft.byWeekday || [])
            .map((k) => WD.find((w) => w.key === k)?.label ?? k)
            .join("・")}）`
        : draft.freq === "monthly"
          ? `毎月${(draft.byMonthday || [])[0]}日（存在しない月はスキップ）`
          : "（未設定）";

  const hhm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [uiFinalEnableConfirm(gptsId, fmt("SCHED_TIME_FINALCONFIRM_TPL", { FREQLABEL: freqLabel, HHM: hhm }))],
  });
};

// 有効化（nextRunAt計算）
const enable: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  if (!recipientId || !userId) return;

  const gptsId = (args["gptsId"] || "").trim();
  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  if (!draft) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: recipientId,
      messages: toTextMessages([msg("SCHED_ENABLE_NODRAFT")]),
    });
    return;
  }

  const tz = draft.timezone ?? process.env.SCHEDULE_TZ_DEFAULT ?? "Asia/Tokyo";
  const next = computeNextRunAt({
    timezone: tz,
    rrule: draft.rrule ?? undefined,
    hour: draft.hour ?? 9,
    minute: draft.minute ?? 0,
    second: draft.second ?? 0,
    from: new Date(),
  });

  await col.updateOne(
    { _id: draft._id },
    { $set: { enabled: true, nextRunAt: next ?? null, updatedAt: new Date() }, $unset: { status: "", stage: "" } }
  );

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: toTextMessages([msg("SCHED_ENABLE_SUCCESS")]),
  });
};

// 修正（やり直し）
const restart: Handler = async (event, args = {}) => {
  const recipientId = getRecipientId(event);
  const userId = getThreadOwnerId(event, "plain");
  const gptsId = (args["gptsId"] || "").trim();
  if (!recipientId || !userId || !gptsId) return;

  const col = await getGptsSchedulesCollection();
  await col.updateMany(
    { userId, gptsId, enabled: false, deletedAt: null },
    { $set: { deletedAt: new Date(), updatedAt: new Date() } }
  );

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, to: recipientId,
    messages: [uiChooseFreq(gptsId)],
  });
};

export const schedHandlers: Record<string, Handler> = {
  start, freq, pickDate,
  wdayStart, wdayToggle, wdayPreset, wdayNext,
  pickTime, timeRedo, timeOk,
  enable, restart,
};
