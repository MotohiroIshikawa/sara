"use client";

import { useEffect, useState, type JSX } from "react";
import Image from "next/image";
import { ensureLiffSession } from "@/utils/ensureLiffSession";

type HelpOkResponse = { ok: true; rid: string; subMasked: string; now: string;};
type HelpErrorResponse = { error: string; rid: string; };

type SectionPalette = { bg: string; border: string; };

const ICONS: Record<string, string> = {
  intro: "/help/help-01_intro.png",
  save: "/help/help-02_save.png",
  schedule: "/help/help-03_schedule.png",
  share: "/help/help-04_share.png",
  edit: "/help/help-05_edit.png",
  trouble: "/help/help-06_trouble.png",
  safe: "/help/help-07_safe.png",
};

const PALETTES: Record<string, SectionPalette> = {
  intro:   { bg: "rgb(255, 235, 241)", border: "rgb(241, 170, 190)" }, // Blossom Pink
  save:    { bg: "rgb(231, 247, 239)", border: "rgb(150, 214, 188)" }, // Mint
  schedule:{ bg: "rgb(233, 241, 255)", border: "rgb(162, 193, 244)" }, // Sky
  share:   { bg: "rgb(240, 235, 252)", border: "rgb(183, 166, 224)" }, // Lavender
  edit:    { bg: "rgb(255, 242, 232)", border: "rgb(248, 190, 150)" }, // Peach
  trouble: { bg: "rgb(255, 252, 230)", border: "rgb(244, 225, 129)" }, // Butter
  safe:    { bg: "rgb(238, 245, 236)", border: "rgb(176, 202, 172)" }, // Sage
};

// 画面状態
export default function Client(): JSX.Element {
  const [loading, setLoading] = useState<boolean>(true);
  const [err, setErr] = useState<string | null>(null);

  const liffId: string | undefined = process.env.NEXT_PUBLIC_LIFF_ID_HELP as string | undefined;

  // 初回：LIFFセッション→/api/help
  useEffect(() => {
    void (async () => {
      try {
        const sess = await ensureLiffSession({ liffId });
        if (!sess.ok) {
          if (sess.reason === "login_redirected") return;
          setErr("ログインに失敗しました");
          return;
        }
        const r: Response = await fetch("/api/help", { credentials: "include" });
        const body: unknown = await r.json();
        if (!r.ok) {
          const ej: HelpErrorResponse | undefined =
            typeof body === "object" && body !== null ? (body as HelpErrorResponse) : undefined;
          setErr("読み込みに失敗しました" + ej?.error);
          return;
        }
        const ok: HelpOkResponse | undefined =
          typeof body === "object" && body !== null ? (body as HelpOkResponse) : undefined;
        if (!ok?.ok) {
          setErr("予期しない応答形式です");
          return;
        }
      } catch {
        setErr("読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  }, [liffId]);

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
          <h1 className="text-2xl font-bold">SARA | 使い方</h1>
        </header>
      </main>
    );
  }
 
  // ===== 本文 =====
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8">
      {/* 1. はじめまして！ */}
      <Section 
        index={1} 
        title="はじめまして！" 
        iconSrc={ICONS.intro} 
        iconAlt="はじめまして"
        palette={PALETTES.intro}
      >
        <ul className="list-inside" style={{ listStyleType: "circle" }}>
          <li>
            この公式アカウントではトークルームで話しかけると、
            あなたの代わりに情報を集めたり、友だちと共有できるアシスタントを作成できます。
          </li>
          <li>
            「東京の天気」「週末のイベント」など、
            知りたい情報・共有したい情報を短く話しかけてください。
          </li>
        </ul>
      </Section>

      {/* 2. ルールを保存する */}
      <Section 
        index={2} 
        title="ルールを保存する"
        iconSrc={ICONS.save}
        iconAlt="ルールを保存する"
        palette={PALETTES.save}
      >
        <ul className="list-inside" style={{ listStyleType: "circle" }}>
          <li>知りたい情報・共有したい情報を「チャットルール」として保存できます。</li>
          <li>
            「保存しますか？」と出たとき、その内容でよろしければチャットルールを保存してください。
          </li>
        </ul>
      </Section>

      {/* 3. スケジュールを決める */}
      <Section 
        index={3} 
        title="スケジュールを決める"
        iconSrc={ICONS.schedule}
        iconAlt="スケジュールを決める"
        palette={PALETTES.schedule}
      >
        <ul className="list-inside" style={{ listStyleType: "circle" }}>
          <li>保存したルールの最新情報を定期的にお知らせすることができます。</li>
          <li>毎日、毎週、毎月から選んでスケジュールを作成してください。</li>
        </ul>
      </Section>

      {/* 4. グループで共有する */}
      <Section 
        index={4} 
        title="グループで共有する"
        iconSrc={ICONS.share}
        iconAlt="グループで共有する"
        palette={PALETTES.share}
      >
        <ul className="list-inside" style={{ listStyleType: "circle" }}>
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
      <Section 
        index={5} 
        title="編集・確認する"
        iconSrc={ICONS.edit}
        iconAlt="編集・確認する"
        palette={PALETTES.edit}
      >
        <ul className="list-inside" style={{ listStyleType: "circle" }}>
          <li>画面下のメニュー「編集・選択」から、これまでに作ったルールを確認できます。</li>
          <li>ルールの内容を変更したり、使うルールを切り替えたり、スケジュールの時間を調整することもできます。</li>
        </ul>
      </Section>

      {/* 6. 困ったときは */}
      <Section 
        index={6} 
        title="困ったときは"
        iconSrc={ICONS.trouble}
        iconAlt="困ったときは"
        palette={PALETTES.trouble}
      >
        <ul className="list-inside" style={{ listStyleType: "circle" }}>
          <li>返信がこない場合は、少し時間をおいてもう一度話しかけてみてください。</li>
          <li>スケジュールを保存したばかりのときは、次の実行時間から配信されます。</li>
          <li>
            内容が少し違うと感じたら、もう一度話しかけてみてください。わたしが内容を理解し直して、より合った情報をお届けします。
          </li>
        </ul>
      </Section>

      {/* 7. 安心して使ってください */}
      <Section 
        index={7} 
        title="安心して使ってください"
        iconSrc={ICONS.safe}
        iconAlt="安心して使ってください"
        palette={PALETTES.safe}
      >
        <ul className="list-inside" style={{ listStyleType: "circle" }}>
          <li>あなたが話しかけた内容は、よりよいお手伝いをするために使います。</li>
          <li>個人情報や大事な内容は送らないように気をつけてくださいね。</li>
          <li>トークを削除したり、友だち解除をすれば、いつでも利用をやめられます。</li>
        </ul>
      </Section>
    </main>
  );
}

// ===== 小さめのプレゼンテーショナル部品 =====
type SectionProps = {
  index: number;
  title: string;
  children: React.ReactNode;
  iconSrc?: string;
  iconAlt?: string;
  palette?: SectionPalette;
};

function Section(props: SectionProps): JSX.Element {
  const { index, title, children, iconSrc, iconAlt, palette } = props;
  return (
    <section id={`step-${index}`} className="scroll-mt-24">
      {/* タイトル行（アイコン + タイトル） */}
      <div className="mt-10 mb-3 flex items-center gap-3">
        {iconSrc ? (
          <Image
            src={iconSrc}
            alt={iconAlt ?? title}
            width={64}
            height={64}
            className="rounded-2xl shrink-0"
            priority={index <= 3}
          />
        ) : null}
        <h3 className="text-lg font-semibold">
          <span
            className="rounded-lg px-2 py-1"
            style={{
              backgroundColor: palette?.bg ?? "transparent"
            }}
          >
          {index}. {title}
          </span>
        </h3>
      </div>

      {/* 角丸ボックス（背景＆枠にパレット適用） */}
      <div
        className="rounded-2xl border p-4 md:p-5 text-sm leading-7"
        style={{
          backgroundColor: palette?.bg ?? "transparent",
          borderColor: palette?.border ?? "rgb(229,231,235)", // gray-200 fallback
          color: "rgb(56,66,82)", // 可読性の高いダークグレー
        }}
      >
        {children}
      </div>
    </section>
  );
}
