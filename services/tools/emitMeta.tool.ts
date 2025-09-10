// services/tools/emitMeta.tool.ts
import { ToolUtility } from "@azure/ai-agents";

// モデルから受け取る引数の JSON Schema（最小でOK）
const parameters = {
  type: "object",
  properties: {
    meta: {
      type: "object",
      properties: {
        intent: { type: "string", enum: ["event", "news", "buy", "generic"] },
        slots: {
          type: "object",
          properties: {
            topic: { type: "string" },
            place: { type: ["string", "null"] },
            date_range: { type: "string" },
            official_only: { type: "boolean" }
          },
          additionalProperties: true
        },
        complete: { type: "boolean" },
        followups: { type: "array", items: { type: "string" } }
      },
      additionalProperties: true
    },
    instpack: { type: "string" }
  },
  required: [],
  additionalProperties: false
} as const;

// ★ named export（default にしない）
// ToolUtility.createFunctionTool は .definition を持つ形を返す
export const emitMetaTool = ToolUtility.createFunctionTool({
  name: "emit_meta",
  description:
    "Emit meta slots and instpack to the host. The host inspects the arguments; return value is ignored.",
  parameters
});
