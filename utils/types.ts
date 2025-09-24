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

/** 動的ルートの params（/gpts/[id]） */
export type GptsIdParam = { id: string };

/** 個別アイテム詳細 */
export type GptsItemDetail = {
  id: string;
  name: string;
  instpack: string;
  updatedAt: string; // ISO8601
};

/** 詳細取得レスポンス */
export type GptsDetailResponse = {
  item: GptsItemDetail;
};

/** 更新リクエスト（POST /api/gpts/[id]） */
export type GptsUpdateRequest = {
  name?: string;
  instpack?: string;
};

/** 型ガード */
export function isGptsItemDetail(v: unknown): v is GptsItemDetail {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.name) &&
    isString(v.instpack) &&
    isString(v.updatedAt)
  );
}

export function isGptsDetailResponse(v: unknown): v is GptsDetailResponse {
  return isRecord(v) && isGptsItemDetail(v.item);
}

/** 一覧アイテム */
export type GptsListItem = {
  id: string;
  name: string;
  updatedAt: string; // ISO8601
};

/** 一覧レスポンス */
export type GptsListResponse = {
  items: GptsListItem[];
};

/** 適用レスポンス（POST /api/gpts/[id]/use） */
export type GptsApplyResponse = {
  ok: true;
  appliedId: string;
  name: string;
};

/** 型ガード */
export function isGptsListItem(v: unknown): v is GptsListItem {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.name) &&
    isString(v.updatedAt)
  );
}

export function isGptsListResponse(v: unknown): v is GptsListResponse {
  return (
    isRecord(v) &&
    Array.isArray(v.items) &&
    v.items.every(isGptsListItem)
  );
}

export function isGptsApplyResponse(v: unknown): v is GptsApplyResponse {
  return (
    isRecord(v) &&
    v.ok === true &&
    isString(v.appliedId) &&
    isString(v.name)
  );
}
