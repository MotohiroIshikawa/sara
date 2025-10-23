export type SourceType = "user" | "group" | "room";

export type Intent =
  | "lookup"
  | "qa"
  | "summarize"
  | "classify"
  | "react";

export type Modality = "text" | "image" | "image+text";

export type Domain = "event" | "news" | "shopping" | "local" | "object" | null;

export type ImageTask = "identify" | "ocr" | "caption" | "summarize" | "detect_faces" | null;

export type FollowupAsk =
  | "topic"
  | "image_task"
  | "date_range"
  | "place"
  | "tone"
  | "output_style";

export type MetaFollowup = {
  ask: FollowupAsk;
  text: string; // 80文字以内・疑問形または命令形（仕様上の制約）
};

export type MetaSlots = {
  topic?: string;
  place?: string | null;
  date_range?: string | null;
  official_only?: boolean | null;
  title?: string | null;
  image_task?: ImageTask;
  tone?: string | null;
  output_style?: string | null;
};

export type Meta = {
  intent?: Intent;
  modality?: Modality;
  domain?: Domain;
  slots?: MetaSlots;
  complete?: boolean;
  followups?: MetaFollowup[];
};

export type MetaForConfirm = Pick<Meta, "intent" | "complete" | "slots" | "modality">;

export type ConnectBingResult = {
  texts: string[];   // ユーザーへ返す本文（instpack/meta を除去済み）
  meta?: Meta;       // 末尾の meta JSON
  instpack?: string; // 末尾の instpack（コンパイル済み指示）
  agentId: string;
  threadId: string;
  runId?: string;
};

export type MetaComputeResult = {
  metaNorm: Meta;           // 補完済みmeta
  complete_norm: boolean;   // intent・slotsに基づく完全判定
  reply_ok: boolean;        // 本文長さ80字以上
  saveable: boolean;        // instpack生成・保存可能
  reasons: readonly string[]; // false理由の説明
};

export type EmitMetaPayload = {
  meta?: Meta;
  instpack?: string;
};