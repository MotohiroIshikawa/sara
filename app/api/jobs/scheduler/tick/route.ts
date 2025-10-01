import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { claimOneDueSchedule, countDueCandidates, markRunSuccess, type ClaimedSchedule } from "@/services/gptsSchedules.mongo";
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

  const fromHdr = request.headers.get("x-from") ?? undefined;
  let fromBody: string | undefined = undefined;
  try {
    const cloned = request.clone();
    const text = await cloned.text().catch(() => "");
    if (text) {
      try {
        const j = JSON.parse(text) as { from?: string };
        if (j && typeof j.from === "string") fromBody = j.from;
      } catch {}
    }
  } catch {}

  try {
    assertInternalAuth(request);

    console.info(`[tick:${rid}] start`, { at: now.toISOString(), fromHdr, fromBody });
    const candidates = await countDueCandidates(now);
    console.info(`[tick:${rid}] candidates`, { count: candidates });
    
    let count = 0;
    while (true) {
      const s: ClaimedSchedule | null = await claimOneDueSchedule(now);
      if (!s) break;
      count++;

      console.info(`[tick:${rid}] claimed`, {
        scheduleId: String(s._id),
        gptsId: s.gptsId,
        targetType: s.targetType,
        targetId: s.targetId,
        nextRunAt: s.nextRunAt?.toISOString?.() ?? null,
      });

      try {
        const res = await runGptsAndPush({
          gptsId: s.gptsId,
          userId: s.userId,
          targetType: s.targetType,
          targetId: s.targetId,
        });

        if (res.ok) {
          let next: Date | null = null;
          try {
            next = computeNextRunAt({
              timezone: s.timezone ?? "Asia/Tokyo",
              freq: s.freq ?? "daily",
              byWeekday: s.byWeekday?.filter((d): d is WeekdayKey => isWeekdayKey(d)) ?? null,
              byMonthday: s.byMonthday ?? null,
              hour: s.hour ?? 9,
              minute: s.minute ?? 0,
              second: s.second ?? 0,
              from: now,
            });
          } catch (e) {
            // await markRunFailure(s._id, now, `computeNextRunAt error: ${msg}`); // claimedAtはnullにしない
            const msg: string = (e as Error).message ?? String(e);
            console.error(`[tick:${rid}] next_calc_err (kept claimedAt)`, {
              scheduleId: String(s._id),
              err: msg,
            });
            continue;
          }

          await markRunSuccess(s._id, now, next);
          console.info(`[tick:${rid}] run_ok`, {
            scheduleId: String(s._id),
            next: next?.toISOString?.() ?? null,
          });
        } else {
          // await markRunFailure(s._id, now, res.reason); // claimedAtはnullにしない
          console.warn(`[tick:${rid}] run_fail (kept claimedAt)`, {
            scheduleId: String(s._id),
            reason: res.reason,
          });
          continue;
        }
      } catch (e) {
        // await markRunFailure(s._id, now, reason); // claimedAtはnullにしない
        const err = e as Error;
        const reason = `${err.name ?? "Error"}: ${err.message ?? String(err)}`;
        console.error(`[tick:${rid}] run_err (kept claimedAt)`, {
          scheduleId: String(s._id),
          reason,
          stack: err.stack ?? null,
        });
        continue;
      }
    } 

    console.info(`[tick:${rid}] done`, { processed: count });
    return NextResponse.json({ ok: true, rid, processed: count });
  } catch (e) {
    const err = e as Error;
    console.error(`[tick:${rid}] fatal`, { message: err.message, stack: err.stack ?? null });
    return NextResponse.json({ ok: false, rid, error: (e as Error).message }, { status: 500 });
  }
}
