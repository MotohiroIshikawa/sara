import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { getBinding } from '@/services/gptsBindings.mongo';
import type { SourceType } from '@/types/gpts';

const P = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

// 3分割（instpackはbaseなし）したファイルを読み込む
const BASE = P('config/prompts/base.md');
const REPLY = P('config/prompts/reply.md');
const META = P('config/prompts/meta.md');
const INST = P('config/prompts/instpack.md');

export type ReplyInsOrigin = 'binding' | 'base';

export const getBaseReplyInstruction = () => `${BASE}\n\n${REPLY}`.trim();

export function getInstructionsWithInstpack(
  instpack: string
): {
  reply: string;   // BASE + instpack
  meta: string;    // BASE + META
  inst: string;    // INST (BASEは混ぜない)
} {
  const reply = `${BASE}\n\n${instpack}`.trim();
  const meta  = `${BASE}\n\n${META}`.trim();
  const inst  = `${INST}`.trim();
  return { reply, meta, inst };
}

export async function getInstruction(
  sourceType: SourceType,
  sourceId: string,
  kind: "reply" | "meta" | "instpack"
): Promise<{ instruction: string; origin: ReplyInsOrigin }> {
  let origin: ReplyInsOrigin = "base";
  let instpackFromBinding = "";

  // bindingを見にいって、replyのときだけ優先
  if (kind === "reply") {
    try {
      const b = await getBinding(sourceType, sourceId);
      const s = b?.instpack?.trim();
      if (s) {
        origin = "binding";
        instpackFromBinding = s;
      }
    } catch {}
  }

  // 各種instructionを構築
  let instruction: string;
  switch (kind) {
    case "reply":
      instruction =
        origin === "binding"
          ? `${BASE}\n\n${instpackFromBinding}`.trim()
          : `${BASE}\n\n${REPLY}`.trim();
      break;
    case "meta":
      instruction = `${BASE}\n\n${META}`.trim();
      break;
    case "instpack":
      instruction = `${INST}`.trim();
      break;
  }

  return { instruction, origin };
}