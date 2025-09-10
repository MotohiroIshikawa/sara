import type { Document } from "mongodb";

// src/types/db.ts
export interface UserDoc extends Document {
  _id: string;            // = userId
  userId: string;
  entityType: "user";
  isBlocked: boolean;
  displayName?: string;
  pictureUrl?: string;
  statusMessage?: string;
  language?: string;
  createdAt?: Date;
  updatedAt?: Date;
  lastFollowedAt?: Date | null;
  lastUnfollowedAt?: Date | null;
};

export interface UserCycleDoc extends Document {
  _id: string;            // = cycleId
  userId: string;
  cycleId: string;
  startAt: Date;
  endAt?: Date | null;
};

export interface ThreadInstDoc extends Document {
  _id?: string;           // Mongoが付与
  userId: string;         // "user_..." | "group:..." | "room:..."
  threadId: string;       // Azure Agents threadId
  instpack: string;       // コンパイル済み指示
  meta?: unknown;         // メタ JSON（スキーマ可変なので unknown）
  updatedAt: Date;        // 保存時刻
}

export interface UserGptsDoc extends Document {
  _id?: string;
  id: string;
  userId: string;
  name: string;
  instpack: string;
  fromThreadId?: string;
  createdAt: Date;
  updatedAt: Date;
  tags?: string[];
  hash: string;
}

export interface GptsBindingDoc extends Document {
  _id?: string;
  targetId: string;      // "group:xxx" | "room:yyy" | "user:zzz"
  gptsId: string;        // user_gpts.id
  instpack: string;      // スナップショット（運用は固定でOK）
  updatedAt: Date;
}

