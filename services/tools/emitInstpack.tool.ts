import { ToolUtility } from "@azure/ai-agents";

export const EMIT_INSTPACK_FN = "emit_instpack" as const;

const parameters = {
  type: "object",
  properties: {
    instpack: {
      type: "string",
      minLength: 80,
      maxLength: 2000,
      // フェンス禁止・疑問文終止禁止
      pattern: "^(?![\\s\\S]*```)(?![\\s\\S]*[?？]\\s*$)[\\s\\S]+$",
      description: "保存用の最終指示。日本語。疑問文で終わらない。コードフェンス禁止。"
    }
  },
  required: ["instpack"],
  additionalProperties: false
} as const;

export const emitInstpackTool = ToolUtility.createFunctionTool({
  name: EMIT_INSTPACK_FN,
  description: "Return only the final instpack (no text output).",
  parameters
});
