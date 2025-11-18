import { sendMessagesReplyThenPush, toTextMessages } from "@/utils/line/lineSend";
import { getSourceId, getSourceType } from "@/utils/line/lineSource";
import { getGptsSchedulesCollection } from "@/utils/mongo";
import { createDraftSchedule, updateScheduleById } from "@/services/gptsSchedules.mongo";
import { computeNextRunAt, roundMinutes } from "@/utils/schedule/schedulerTime";
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
import { getMsg, formatMsg } from "@/utils/line/msgCatalog";
import type { PostbackEvent } from "@line/bot-sdk";
import type { SourceType } from "@/types/gpts";

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
const start: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const sourceType: SourceType | undefined = getSourceType(event);
  if (!sourceId || !sourceType) return;

  const ans: string = String(args["ans"] || "").toLowerCase();
  const gptsId: string = String(args["gptsId"] || "").trim();

  if (ans === "no") {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: sourceId,
      messages: toTextMessages([getMsg("SCHED_START_NO")]),
    });
    return;
  }

  if (ans === "yes") {
    const confirmTexts = toTextMessages([getMsg("SCHED_START_YES_CONFIRM")]);
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, to: sourceId,
      messages: [...confirmTexts, uiChooseFreq(gptsId)],
    });
    return;
  }

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!,
    to: sourceId,
    messages: toTextMessages([getMsg("SCHED_START_INVALID")]),
  });
};

// 「毎日/毎週/毎月」選択
const freq: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const sourceType: SourceType | undefined = getSourceType(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !sourceType || !gptsId) return;

  const f = asFreq(args["freq"] as string | undefined);
  const label: string | null = f === "daily" ? "毎日" : f === "weekly" ? "毎週" : f === "monthly" ? "毎月" : null;
  if (!f || !label) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: sourceId,
      messages: toTextMessages([getMsg("SCHED_FREQ_INVALID")]),
    });
    return;
  }

  const tz = process.env.SCHEDULE_TZ_DEFAULT || "Asia/Tokyo";
  await createDraftSchedule({
    userId: sourceId,
    gptsId,
    targetType: sourceType,
    targetId: sourceId,
    timezone: tz,
    freq: f,
  });

  const confirm = toTextMessages([
    formatMsg(getMsg("SCHED_FREQ_CONFIRM_TPL"), { LABEL: label }),
  ]);

  if (f === "monthly") {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: sourceId,
      messages: [...confirm, uiPickMonthday(gptsId)],
    });
    return;
  }
  if (f === "daily") {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, 
      to: sourceId,
      messages: [...confirm, uiPickTime(gptsId, { text: getMsg("SCHED_PICKTIME_PROMPT"), initial: "09:00" })],
    });
    return;
  }
  // weekly
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!,
    to: sourceId,
    messages: [...confirm, uiWeekdayFlex(gptsId, [])],
  });
};

// 月次: 日付ピック → 時刻ピック
const pickDate: Handler = async (event, args = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !gptsId) return;

  const picked: string | undefined = pickStrParam(event.postback?.params, "date"); // "YYYY-MM-DD"
  const day = picked ? Number(picked.split("-")[2]) : NaN;
  if (!picked || !(day >= 1 && day <= 31)) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: sourceId,
      messages: toTextMessages([getMsg("SCHED_PICKDATE_ERROR")]),
    });
    return;
  }

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId: sourceId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  if (!draft) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!,
      to: sourceId,
      messages: toTextMessages([getMsg("SCHED_PICKDATE_NODRAFT")]),
    });
    return;
  }

  await updateScheduleById(draft._id, { byMonthday: [day] });

  const confirmTexts = toTextMessages([
    formatMsg(getMsg("SCHED_PICKDATE_CONFIRM_TPL"), { DAY: day }),
    getMsg("SCHED_PICKDATE_NOTE"),
  ]);
  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: [...confirmTexts, uiPickTime(gptsId, { text: getMsg("SCHED_PICKTIME_PROMPT"), initial: "09:00" })],
  });
};

// 週次: 初期UI
const wdayStart: Handler = async (event, args = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !gptsId) return;

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!,
    to: sourceId,
    messages: [uiWeekdayFlex(gptsId, [])],
  });
};

// 週次: 曜日トグル
const wdayToggle: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  const v: string = String(args["wd"] || "").toUpperCase();
  if (!sourceId || !gptsId || !WD.find((w) => w.key === v)) return;

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId: sourceId, gptsId, deletedAt: null, enabled: false },
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
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: [uiWeekdayFlex(gptsId, next)],
  });
};

// 週次: プリセット（平日/週末/クリア）
const wdayPreset: Handler = async (event, args = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !gptsId) return;

  const preset: string = String(args["preset"] || "").toLowerCase();
  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId: sourceId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  if (!draft) return;

  let set: string[] = [];
  if (preset === "weekdays") set = ["MO", "TU", "WE", "TH", "FR"];
  else if (preset === "weekend") set = ["SA", "SU"];
  else if (preset === "clear") set = [];

  await updateScheduleById(draft._id, { byWeekday: set });

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: [uiWeekdayFlex(gptsId, set)],
  });
};

// 週次: 曜日確定 → 時刻へ
const wdayNext: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !gptsId) return;

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId: sourceId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  const days = draft?.byWeekday ?? [];

  if (!draft || days.length === 0) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, 
      to: sourceId,
      messages: toTextMessages([getMsg("SCHED_WEEKLY_NEEDONE")]),
    });
    return;
  }

  const pickedLabel = WD.filter((w) => days.includes(w.key))
    .map((w) => w.label)
    .join("・");
  const confirm = toTextMessages([
    formatMsg(getMsg("SCHED_WEEKLY_CONFIRM_TPL"), { PICKED: pickedLabel }),
  ]);

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: [...confirm, uiPickTime(gptsId, { text: getMsg("SCHED_PICKTIME_PROMPT"), initial: "09:00" })],
  });
};

// 時刻ピック（丸め確認へ）
const pickTime: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !gptsId) return;

  const tParam: string | undefined = pickStrParam(event.postback?.params, "time");
  if (!gptsId || !tParam) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, 
      to: sourceId,
      messages: toTextMessages([getMsg("SCHED_TIME_ERROR")]),
    });
    return;
  }

  const [hStr, mStr] = tParam.split(":");
  const hour = Math.max(0, Math.min(23, parseInt(hStr, 10)));
  const minute = Math.max(0, Math.min(59, parseInt(mStr ?? "0", 10)));
  const step = Number(process.env.SCHEDULE_ROUND_MIN ?? 15);
  const rounded = roundMinutes(minute, step);

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: [uiTimeRoundingConfirm(gptsId, hour, minute, rounded, step)],
  });
};

// 時刻選び直し
const timeRedo: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !gptsId) return;

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: [uiPickTime(gptsId, { text: getMsg("SCHED_TIME_REDO_PROMPT"), initial: "09:00" })],
  });
};

// 丸め確定 → 最終確認
const timeOk: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !gptsId) return;

  const hour: number = parseInt(String(args["hour"] || ""), 10);
  const minute: number = parseInt(String(args["minute"] || ""), 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return;

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId: sourceId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  if (!draft) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, 
      to: sourceId,
      messages: toTextMessages([getMsg("SCHED_PICKDATE_NODRAFT")]),
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
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: [uiFinalEnableConfirm(
      gptsId, 
      formatMsg(getMsg("SCHED_TIME_FINALCONFIRM_TPL"), { FREQLABEL: freqLabel, HHM: hhm })
    )],
  });
};

// 有効化（nextRunAt計算）
const enable: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !gptsId) return;

  const col = await getGptsSchedulesCollection();
  const draft = await col.findOne(
    { userId: sourceId, gptsId, deletedAt: null, enabled: false },
    { sort: { _id: -1 } }
  );
  if (!draft) {
    await sendMessagesReplyThenPush({
      replyToken: event.replyToken!, 
      to: sourceId,
      messages: toTextMessages([getMsg("SCHED_ENABLE_NODRAFT")]),
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
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: toTextMessages([getMsg("SCHED_ENABLE_SUCCESS")]),
  });
};

// 修正（やり直し）
const restart: Handler = async (event, args: Record<string, unknown> = {}) => {
  const sourceId: string | undefined = getSourceId(event);
  const gptsId: string = String(args["gptsId"] || "").trim();
  if (!sourceId || !gptsId) return;

  const col = await getGptsSchedulesCollection();
  await col.updateMany(
    { useruserId: sourceId, gptsId, enabled: false, deletedAt: null },
    { $set: { deletedAt: new Date(), updatedAt: new Date() } }
  );

  await sendMessagesReplyThenPush({
    replyToken: event.replyToken!, 
    to: sourceId,
    messages: [uiChooseFreq(gptsId)],
  });
};

export const schedHandlers: Record<string, Handler> = {
  start, freq, pickDate,
  wdayStart, wdayToggle, wdayPreset, wdayNext,
  pickTime, timeRedo, timeOk,
  enable, restart,
};
