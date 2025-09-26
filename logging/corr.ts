import { AsyncLocalStorage } from "node:async_hooks";

type Corr = {
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
