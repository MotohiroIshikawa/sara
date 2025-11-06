export type SourceType = "user" | "group" | "room";

// Meta用
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
  | "image"
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
  has_image?: boolean | null;
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

// 汎用AI実行ユーティリティ向けコンテキスト
export type AiContext = {
  ownerId: string;                   // plain の ownerId（userId/groupId/roomId の本体）
  sourceType: SourceType;            // 発話元
  threadId: string;                  // 既存または新規取得済みのスレッドID
};

// 返信取得の結果
export type AiReplyResult = {
  texts: readonly string[];          // 内部ブロック除去後のLINE表示用テキスト
  agentId: string;                   // 実行に使用したエージェントID
  threadId: string;
  runId: string;
};

// meta取得の結果
export type AiMetaResult = {
  meta?: Meta;                       // emit_meta の生結果
  agentId: string;
  threadId: string;
  runId: string;
};

// instpack取得の結果
export type AiInstpackResult = {
  instpack?: string;                 // emit_instpack の生結果
  agentId: string;
  threadId: string;
  runId: string;
};

// getReply用オプション
export type AiReplyOptions = {
  question?: string;                 // テキスト質問（省略可）
  imageUrls?: readonly string[];     // 画像URL群（省略可）
  temperature?: number;              // 既定0.2（envで上書き想定）
  topP?: number;                     // 既定1
};

// getMeta用オプション
export type AiMetaOptions = {
  maxRetry?: number;                 // 既定2（再試行）
  hasImageHint?: boolean;            // 画像同梱時に slots.has_image を補正するヒント
};

// getInstpack用オプション
export type AiInstpackOptions = {
  temperature?: number;              // 既定0.0
};

export type MetaComputeResult = {
  metaNorm: Meta;                    // 補完済みmeta
  complete_norm: boolean;            // intent・slotsに基づく完全判定
  reply_ok: boolean;                 // 本文長さ80字以上
  saveable: boolean;                 // instpack生成・保存可能
  reasons: readonly string[];        // false理由の説明
};

// emit_* ツール返却は用途ごとに分離
export type EmitMetaArgs = { meta: Meta };           // emit_metaの返却
export type EmitInstpackArgs = { instpack: string }; // emit_instpackの返却

export type AiError = {
  name: string;
  message: string;
  retriable: boolean;
};