import type { Document, ObjectId } from "mongodb";
import type { Meta } from "@/types/gpts";

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
  _id?: string;
  userId: string;
  threadId: string;
  instpack: string;
  meta?: Meta | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserGptsDoc extends Document {
  _id?: string | ObjectId;
  id: string;
  userId: string;
  name: string;
  instpack: string;
  fromThreadId?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  tags?: string[];
  hash: string;
}

export interface GptsBindingDoc extends Document {
  _id?: string;
  userId: string;      // "group:xxx" | "room:yyy" | "user:zzz"
  gptsId: string;        // user_gpts.id
  instpack: string;      // スナップショット（運用は固定でOK）
  updatedAt: Date;
}

