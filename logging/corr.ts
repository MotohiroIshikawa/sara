import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

export type Corr = {
  requestId: string;
  threadId?: string;
  runId?: string;
  userId?: string;
};

const als = new AsyncLocalStorage<Corr>();

export const CorrContext = {
  run<T>(corr: Corr, fn: () => T): T {
    return als.run(corr, fn);
  },
  get(): Corr | undefined {
    return als.getStore();
  },
};

// 任意: このロガーを使うと ctx が自動で混ざります
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  mixin() {
    const ctx = als.getStore();
    return ctx ? { ctx } : {};
  },
});
