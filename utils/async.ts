// thenableを安全にPromiseに包むヘルパー
export function asPromise<T>(p: PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => p.then(resolve, reject));
}

// ネットワーク強制タイムアウトのヘルパー
export async function withTimeout<T>(work: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  return await Promise.race<T>([
    asPromise(work),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}`)), timeoutMs)
    ),
  ]);
}
