import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { claimOneDueSchedule, markRunSuccess, markRunFailure, type ClaimedSchedule } from "@/services/gptsSchedules.mongo";
import { runGptsAndPush } from "@/services/gptsRunner";
import { computeNextRunAt, type WeekdayKey } from "@/utils/schedulerTime";
import { isWeekdayKey } from "@/utils/scheduleGuards";

function assertInternalAuth(req: Request): void | never {
  const got = req.headers.get("x-internal-token") ?? "";
  const expect = process.env.INTERNAL_JOB_TOKEN ?? "";
  if (!expect || got !== expect) {
    throw new Response("forbidden", { status: 403 });
  }
}

export async function POST(request: Request) {
  const rid = request.headers.get("x-tick-rid") ?? randomUUID().slice(0, 8);
  const now = new Date();
  try {
    assertInternalAuth(request);

    let count = 0;
    while (true) {
      const s: ClaimedSchedule | null = await claimOneDueSchedule(now);
      if (!s) break;
      count++;

      try {
        const res = await runGptsAndPush({
          gptsId: s.gptsId,
          userId: s.userId,
          targetType: s.targetType,
          targetId: s.targetId,
        });

        if (res.ok) {
          const next = computeNextRunAt({
            timezone: s.timezone ?? "Asia/Tokyo",
            freq: s.freq ?? "daily",
            byWeekday: s.byWeekday?.filter((d): d is WeekdayKey => isWeekdayKey(d)) ?? null,
            byMonthday: s.byMonthday ?? null,
            hour: s.hour ?? 9,
            minute: s.minute ?? 0,
            second: s.second ?? 0,
            from: now,
          });
          await markRunSuccess(s._id, now, next);
          console.info(`[tick:${rid}] run_ok schedule=${s._id} next=${next?.toISOString()}`);
        } else {
          await markRunFailure(s._id, now, res.reason);
          console.warn(`[tick:${rid}] run_fail schedule=${s._id} reason=${res.reason}`);
        }
      } catch (e) {
        await markRunFailure(s._id, now, (e as Error).message);
        console.error(`[tick:${rid}] run_err schedule=${s._id} err=${(e as Error).message}`);
      }
    }

    return NextResponse.json({ ok: true, rid, processed: count });
  } catch (e) {
    console.error(`[tick:${rid}] fatal`, e);
    return NextResponse.json({ ok: false, rid, error: (e as Error).message }, { status: 500 });
  }
}
