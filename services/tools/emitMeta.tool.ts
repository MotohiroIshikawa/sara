import { ToolUtility } from "@azure/ai-agents";

export const EMIT_META_FN = "emit_meta" as const;


const parameters = {
  type: "object",
  properties: {
    meta: {
      type: "object",
      properties: {
        intent: { type: "string" },
        modality: { type: "string" },
        domain: { type: ["string", "null"] },
        slots: {
          type: "object",
          additionalProperties: true
        },
        procedure: {
          type: "object",
          properties: {
            kind: { type: "string" },
            rule: { type: ["string", "null"] },
            interaction: { type: ["string", "null"] }
          },
          additionalProperties: true
        }
      },
      required: ["intent", "modality"],
      additionalProperties: true
    }
  },
  required: ["meta"],
  additionalProperties: true
} as const;

// ToolUtility.createFunctionTool は .definition を持つ形を返す
export const emitMetaTool = ToolUtility.createFunctionTool({
  name: EMIT_META_FN,
  description: "Return conversation meta only (no text output).",  
  parameters
});