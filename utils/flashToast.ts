const FLASH_KEY: string = "gpts:flash";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

// 遷移前にフラッシュメッセージを保存（次の1回だけ表示）
export function setFlash(message: string): void {
  if (!isBrowser()) return;
  const s: string = message.trim();
  if (s.length === 0) return;
  try {
    window.sessionStorage.setItem(FLASH_KEY, s);
  } catch {
    // sessionStorage が使用不可な場合は何もしない
  }
}

// 遷移後にフラッシュメッセージを取得（取得と同時に破棄）
export function takeFlash(): string | null {
  if (!isBrowser()) return null;
  try {
    const msg: string | null = window.sessionStorage.getItem(FLASH_KEY);
    if (msg !== null) {
      window.sessionStorage.removeItem(FLASH_KEY); // ★ 一度きり
    }
    return msg;
  } catch {
    return null;
  }
}

// 明示的にフラッシュメッセージを破棄したい場合に使用（任意）
export function clearFlash(): void {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.removeItem(FLASH_KEY);
  } catch {
    // noop
  }
}

// 即時トースト（一覧以外でも利用可能）
export function showToastNow(message: string, ms: number = 2800): void {
  const wrap: HTMLDivElement = document.createElement("div");
  wrap.className = "fixed inset-x-0 bottom-4 z-[9999] flex justify-center px-4";
  wrap.innerHTML = `
    <div class="max-w-screen-sm w-full rounded-2xl bg-black/85 text-white shadow-lg backdrop-blur-sm animate-fade-in">
      <div class="p-4 text-sm leading-relaxed">${message}</div>
    </div>
  `;
  document.body.appendChild(wrap);
  window.setTimeout(() => {
    wrap.style.opacity = "0";
    wrap.style.transition = "opacity 300ms";
    window.setTimeout(() => wrap.remove(), 350);
  }, ms);
}