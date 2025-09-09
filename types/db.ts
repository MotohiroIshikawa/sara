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
