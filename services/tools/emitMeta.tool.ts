import { ToolUtility } from "@azure/ai-agents";

export const EMIT_META_FN = "emit_meta" as const;

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
            official_only: { type: "boolean", default: true }
          },
          additionalProperties: true
        },
        complete: { type: "boolean" },
        followups: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 5 } }
      },
      required: ["intent", "complete"],
      additionalProperties: false
    }
  },
  required: ["meta"],
  additionalProperties: false
} as const;

// ToolUtility.createFunctionTool は .definition を持つ形を返す
export const emitMetaTool = ToolUtility.createFunctionTool({
  name: EMIT_META_FN,
  description: "Return conversation meta only (no text output).",  
  parameters
});