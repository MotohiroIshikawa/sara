// app/help/Client.tsx
// 「/help」LIFF向け。/api/helpで認証→本文表示
// 形は app/gpts/list/Client.tsx に寄せ、early-return構成・明示型を維持

"use client";

import type { JSX } from "react";
import { useEffect, useState, useMemo } from "react";
import { ensureLiffSession } from "@/utils/ensureLiffSession";

// ===== API Response 型 =====
type HelpOkResponse = {
  ok: true;
  rid: string;
  subMasked: string;
  now: string;
};

type HelpErrorResponse = {
  error: string;
  rid: string;
};

// ===== 画面状態 =====
export default function Client(): JSX.Element {
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  // 追加情報（ヘッダーに小さく表示）
  const [rid, setRid] = useState<string | null>(null);
  const [subMasked, setSubMasked] = useState<string | null>(null);
  const [nowIso, setNowIso] = useState<string | null>(null);

  // 初回：LIFFセッション→/api/help
  useEffect(() => {
    void (async () => {
      try {
        const sess = await ensureLiffSession();
        if (!sess.ok) {
          if (sess.reason === "login_redirected") return;
          setErr("ログインに失敗しました");
          return;
        }
        const r: Response = await fetch("/api/help", { credentials: "include" });
        const j: unknown = await r.json();
        if (!r.ok) {
          const ej: HelpErrorResponse | undefined =
            typeof j === "object" && j !== null ? (j as HelpErrorResponse) : undefined;
          setRid(ej?.rid ?? null);
          setErr("読み込みに失敗しました");
          return;
        }
        const ok: HelpOkResponse | undefined =
          typeof j === "object" && j !== null ? (j as HelpOkResponse) : undefined;
        if (!ok?.ok) {
          setErr("予期しない応答形式です");
          return;
        }
        setRid(ok.rid);
        setSubMasked(ok.subMasked);
        setNowIso(ok.now);
      } catch {
        setErr("読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // 目次（useMemoで安定化）
  const toc = useMemo<Array<{ href: string; label: string }>>(
    () => [
      { href: "#step-1", label: "はじめまして！" },
      { href: "#step-2", label: "ルールを保存する" },
      { href: "#step-3", label: "スケジュールを決める" },
      { href: "#step-4", label: "グループで共有する" },
      { href: "#step-5", label: "編集・確認する" },
      { href: "#step-6", label: "困ったときは" },
      { href: "#step-7", label: "安心して使ってください" },
    ],
    []
  );

  // ===== Skeleton（listのSkeletonCard相当） =====
  if (loading) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8">
        <div className="h-6 w-40 animate-pulse rounded bg-gray-200" />
        <div className="mt-6 space-y-4">
          <div className="h-20 animate-pulse rounded-2xl border border-gray-200 bg-white" />
          <div className="h-28 animate-pulse rounded-2xl border border-gray-200 bg-white" />
          <div className="h-24 animate-pulse rounded-2xl border border-gray-200 bg-white" />
        </div>
      </main>
    );
  }

  // ===== Error（listのalertError相当） =====
  if (err) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold">使い方</h1>
        </header>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {err}
          {rid ? `（rid: ${rid}）` : ""}
        </div>
      </main>
    );
  }

  // ===== 本文 =====
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      {/* Header */}
      <header className="mb-8">
        <h1 className="text-2xl font-bold">使い方</h1>
        <p className="mt-2 text-gray-600 text-sm">
          このページでは、チャットルームでの使い方と、ルールの保存・スケジュール・グループ共有の手順を説明します。
        </p>
        <div className="mt-3 text-xs text-gray-500">
          認証済み: <span className="font-mono">{subMasked ?? "-"}</span>
          {nowIso ? <span className="ml-2">/ {new Date(nowIso).toLocaleString()}</span> : null}
        </div>

        {/* TOC */}
        <nav aria-label="目次" className="mt-6">
          <ol className="list-decimal list-inside space-y-1 text-sm">
            {toc.map((t) => (
              <li key={t.href}>
                <a href={t.href} className="hover:underline">
                  {t.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </header>

      {/* 1. はじめまして！ */}
      <Section index={1} title="はじめまして！">
        <ul className="list-disc list-inside">
          <li>
            こんにちは、この公式アカウントではトークルームで話しかけると、
            あなたの代わりに情報を集めたり、友だちと共有できるアシスタントを作成できます。
          </li>
          <li>
            「東京の天気」「週末のイベント」など、
            知りたい情報・共有したい情報を短く話しかけてください。
          </li>
        </ul>
      </Section>

      {/* 2. ルールを保存する */}
      <Section index={2} title="ルールを保存する">
        <ul className="list-disc list-inside">
          <li>知りたい情報・共有したい情報を「チャットルール」として保存できます。</li>
          <li>
            「保存しますか？」と出たとき、その内容でよろしければチャットルールを保存してください。
          </li>
        </ul>
      </Section>

      {/* 3. スケジュールを決める */}
      <Section index={3} title="スケジュールを決める">
        <ul className="list-disc list-inside">
          <li>保存したルールの最新情報を定期的にお知らせすることができます。</li>
          <li>毎日、毎週、毎月から選んでスケジュールを作成してください。</li>
        </ul>
      </Section>

      {/* 4. グループで共有する */}
      <Section index={4} title="グループで共有する">
        <ul className="list-disc list-inside">
          <li>作成したチャットルールを、ぜひ友だちと共有しましょう！</li>
          <li>
            このトークルームで作ったルールを、友だちと共有したいときは、
            <strong>グループトークルームにこの公式アカウントを招待</strong>してください。
          </li>
          <li>
            グループに追加すると「このグループにチャットルールを適用しますか？」と聞かれるので、
            「<strong>自分のルールを適用</strong>」を選ぶと、
            トークルーム内でチャットルールを共有できます。
          </li>
        </ul>
      </Section>

      {/* 5. 編集・確認する */}
      <Section index={5} title="編集・確認する">
        <ul className="list-disc list-inside">
          <li>画面下のメニュー「編集・選択」から、これまでに作ったルールを確認できます。</li>
          <li>ルールの内容を変更したり、使うルールを切り替えたり、スケジュールの時間を調整することもできます。</li>
        </ul>
      </Section>

      {/* 6. 困ったときは */}
      <Section index={6} title="困ったときは">
        <ul className="list-disc list-inside">
          <li>返信がこない場合は、少し時間をおいてもう一度話しかけてみてください。</li>
          <li>スケジュールを保存したばかりのときは、次の実行時間から配信されます。</li>
          <li>
            内容が少し違うと感じたら、もう一度話しかけてみてください。わたしが内容を理解し直して、より合った情報をお届けします。
          </li>
        </ul>
      </Section>

      {/* 7. 安心して使ってください */}
      <Section index={7} title="安心して使ってください">
        <ul className="list-disc list-inside">
          <li>あなたが話しかけた内容は、よりよいお手伝いをするために使います。</li>
          <li>個人情報や大事な内容は送らないように気をつけてくださいね。</li>
          <li>トークを削除したり、友だち解除をすれば、いつでも利用をやめられます。</li>
        </ul>
      </Section>

      <footer className="mt-12 border-t border-gray-200 pt-6 text-xs text-gray-500">
        <p>© {new Date().getFullYear()} LINE チャットBOT</p>
      </footer>
    </main>
  );
}

// ===== 小さめのプレゼンテーショナル部品 =====
type SectionProps = {
  index: number;
  title: string;
  children: React.ReactNode;
};

function Section(props: SectionProps): JSX.Element {
  const { index, title, children } = props;
  return (
    <section id={`step-${index}`} className="scroll-mt-24">
      <h3 className="mt-10 text-lg font-semibold">
        {index}. {title}
      </h3>
      <div className="mt-3 space-y-2 text-sm leading-7 text-gray-700">{children}</div>
    </section>
  );
}
