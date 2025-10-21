import type { WebhookEvent } from "@line/bot-sdk";
import { getBinding, clearBinding } from "@/services/gptsBindings.mongo";
import { softDeleteSchedulesByTarget } from "@/services/gptsSchedules.mongo";
import { delete3AgentsForInstpack } from "@/utils/agents";
import { resetThread } from "@/services/threadState";

// leaveイベント
export async function handleLeaveEvent(
  event: Extract<WebhookEvent, { type: "leave" }>,
  bindingTarget: { type: "group" | "room"; targetId: string }
): Promise<void> {
  const targetType: "group" | "room" = bindingTarget.type;
  const targetId: string = bindingTarget.targetId;
  const ownerScope: string = `${targetType}:${targetId}`;

  try {
    // 現在の binding を確認（あれば instpack を使って Agent を整理）
    const binding = await getBinding({ type: targetType, targetId }).catch(() => null);
    const instpack: string | undefined = binding?.instpack ? String(binding.instpack) : undefined;

    // 1. Agent/Thread cleanup
    try {
      if (instpack && instpack.length > 0) {
        await delete3AgentsForInstpack(instpack);
      }
    } catch (e) {
      console.warn("[leave] delete3AgentsForInstpack failed", { ownerScope, err: String(e) });
    }
    try {
      await resetThread(ownerScope); // スコープIDでリセット
    } catch (e) {
      console.warn("[leave] resetThread failed", { ownerScope, err: String(e) });
    }

    // 2. binding を削除（hard delete）
    try {
      await clearBinding({ type: targetType, targetId });
    } catch (e) {
      console.warn("[leave] clearBinding failed", { ownerScope, err: String(e) });
    }

    // 3. スケジュールを soft delete（target 指定）
    try {
      const n: number = await softDeleteSchedulesByTarget({ targetType, targetId });
      console.info("[leave] schedules soft-deleted", { ownerScope, count: n });
    } catch (e) {
      console.warn("[leave] softDeleteSchedulesByTarget failed", { ownerScope, err: String(e) });
    }

    // 4. 通知は不可（BOTは既に退室済み）
    console.info("[leave] cleanup done (no notify, already left)", { ownerScope });
  } catch (e) {
    console.warn("[leave] handler error", { targetType, targetId, err: String(e) });
  }
}
