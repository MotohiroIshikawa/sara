type Intent = "event" | "news" | "buy" | "generic";

// Meta.slotsの中身
type MetaSlots = {
  topic?: string;
  place?: string | null;
  date_range?: string | null;
  official_only?: boolean | null;
};

// Metaの中身
export type Meta = {
  intent?: Intent;
  slots?: MetaSlots;
  complete?: boolean;
  followups?: string[];
};

// 確認ダイアログなどUI判定用（余計なプロパティを持たない軽量版）
export type MetaForConfirm = Pick<Meta, "intent" | "complete" | "slots">;

// Bing接続の戻り値
export type ConnectBingResult = {
  texts: string[];         // ユーザーへ返す本文（instpack/meta を除去済み）
  meta?: Meta;             // 末尾の meta JSON
  instpack?: string;       // 末尾の instpack（コンパイル済み指示）
  agentId: string;
  threadId: string;
  runId?: string;
};
