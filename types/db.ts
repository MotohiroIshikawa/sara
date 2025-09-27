import type { Document, ObjectId } from "mongodb";
import type { Meta } from "@/types/gpts";

// LINEユーザテーブル（ユニーク）
export interface UserDoc extends Document {
  _id: ObjectId;
  userId: string;
  isBlocked: boolean;
  displayName?: string;
  pictureUrl?: string;
  statusMessage?: string;
  language?: string;
  createdAt: Date;
  updatedAt: Date;
  lastFollowedAt?: Date | null;
  lastUnfollowedAt?: Date | null;
};

// ユーザの一時保存テーブル
export interface UserCycleDoc extends Document {
  _id: ObjectId;
  userId: string;
  cycleId: string;
  startAt: Date;
  endAt?: Date | null;
};

// ユーザがチャットルールを作成している途中で一時保存されるテーブル
// ユーザが保存すると削除される
export interface ThreadInstDoc extends Document {
  _id: ObjectId;
  userId: string;
  threadId: string;
  instpack: string;
  meta?: Meta | null;
  createdAt: Date;
  updatedAt: Date;
}

// チャットルールテーブル
export interface GptsDoc extends Document {
  _id: ObjectId;
  gptsId: string;               // コピー時は新規発番
  userId: string;               // 所有者
  name: string;
  instpack: string;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
  originalGptsId?: string;      // コピー元の gptsId（機能拡張用）
  authorUserId?: string;        // コピー元の作者ユーザID（機能拡張用）
}

// ユーザが保存しているチャットルールのテーブル
export interface UserGptsDoc extends Document {
  _id: ObjectId;
  userId: string;               // 作成者（保存者）
  gptsId: string;               // 論理ID（UUID等）…参照は常にこれ
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

type BindingTargetType = "user" | "group" | "room";
export interface BindingTarget {
  type: BindingTargetType;        // user / group / room
  targetId: string;               // LINE 生ID: Uxxxx / Gxxxx / Rxxxx
}

// どのチャットルールが1対1チャットルーム/グループトークルームに適用されているかを管理するテーブル
export interface GptsBindingDoc extends Document {
  _id: ObjectId;
  targetType: BindingTargetType;  // 例: "user"
  targetId: string;               // 例: "Uxxxxxxxxxxxx"
  gptsId: string;
  instpack: string;               // スナップショット（運用は固定でOK）
  createdAt: Date;
  updatedAt: Date;
}
