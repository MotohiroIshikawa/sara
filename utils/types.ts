import type { ToolDefinitionUnion } from "@azure/ai-agents";

/** null でないオブジェクト判定（基本ガード） */
export function isRecord<T extends Record<string, unknown> = Record<string, unknown>>(
  v: unknown
): v is T {
  return typeof v === "object" && v !== null;
}

export function isString(x: unknown): x is string {
  return typeof x === "string";
}

export function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** createAgent に渡せるツール: そのまま or { definition } ラッパー */
export type ToolLike = ToolDefinitionUnion | { definition: ToolDefinitionUnion };

/** ToolDefinitionUnion らしさの判定（function ツール or type ベースツール） */
export function isToolDefinition(x: unknown): x is ToolDefinitionUnion {
  if (!isRecord(x)) return false;
  return "function" in x || "type" in x;
}

/** { definition } ラッパーの判定 */
export function hasDefinition(x: unknown): x is { definition: ToolDefinitionUnion } {
  if (!isRecord(x)) return false;
  const d = (x as { definition?: unknown }).definition;
  return isToolDefinition(d);
}

/** ToolLike | unknown -> ToolDefinitionUnion へ正規化 */
export function toDefinition(t: ToolLike | unknown): ToolDefinitionUnion {
  if (hasDefinition(t)) return t.definition;
  if (isToolDefinition(t)) return t;
  throw new Error("Invalid tool object (expected ToolDefinitionUnion or { definition })");
}

/** Run の toolCalls 取り回し用の最小型 */
export type NonFunctionToolCall = { id: string; type?: Exclude<string, "function"> };
export type FunctionToolCall = { id: string; type: "function"; function: { name?: string; arguments?: unknown } };
export type ToolCall = FunctionToolCall | NonFunctionToolCall;

export function isFunctionToolCall(tc: ToolCall): tc is FunctionToolCall {
  return tc?.type === "function";
}

/** toolCall らしさの判定（id:string は必須。function 型は function オブジェクト必須） */
export function isToolCallLike(v: unknown): v is ToolCall {
  if (!isRecord(v)) return false;
  const id = v["id"];
  if (typeof id !== "string") return false;
  const type = v["type"];
  if (type === "function") {
    const fn = v["function"];
    return isRecord(fn);
  }
  return true;
}

/** unknown 配列 -> ToolCall[] にフィルタ */
export function toToolCalls(list: unknown): ToolCall[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isToolCallLike);
}