import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { getBinding } from '@/services/gptsBindings.mongo';
import type { SourceType } from '@/types/gpts';

const P = (p: string): string => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

const BASE: string = P('utils/prompts/base.md');
const REPLY_TOOL: string = P('utils/prompts/reply_tool.md'); // Tool(Grounding)用
const REPLY_API: string = P('utils/prompts/reply_api.md');   // API用
const META: string  = P('utils/prompts/meta.md');
const INST: string  = P('utils/prompts/instpack.md');
const DECISION: string = P('utils/prompts/decision.md'); // decision用

type ReplyInsOrigin = 'binding' | 'base';
type ReplyMode = 'api' | 'tool';

export function getInstructionsWithInstpack(
  instpack: string
): {
  reply: string;   // BASE + instpack
  meta: string;    // BASE + META
  inst: string;    // INST (BASEは混ぜない)
} {
  const reply: string = `${BASE}\n\n${instpack}`.trim();
  const meta: string  = `${BASE}\n\n${META}`.trim();
  const inst: string  = `${INST}`.trim();
  return { reply, meta, inst };
}

export async function getInstruction(
  sourceType: SourceType,
  sourceId: string,
  kind: 'reply' | 'meta' | 'instpack' | 'decision',
  mode?: ReplyMode,
): Promise<{ instruction: string; origin: ReplyInsOrigin }> {
  let origin: ReplyInsOrigin = 'base';
  let instpackFromBinding: string = '';

  // bindingを見にいって、replyのときだけ優先
  if (kind === 'reply') {
    try {
      const b = await getBinding(sourceType, sourceId);
      const s: string | undefined = b?.instpack?.trim();
      if (s) {
        origin = 'binding';
        instpackFromBinding = s;
      }
    } catch {
      // no-op
    }
  }

  // 各種instructionを構築
  let instruction: string;
  switch (kind) {
    case 'reply': {
      if (origin === 'binding') {
        // binding がある場合 BASE + instpack をそのまま採用
        instruction = `${BASE}\n\n${instpackFromBinding}`.trim();
      } else {
        // instpack がない場合のみ、tool/api 用のプリセットを使い分け
        if (mode === 'api') {
          instruction = `${BASE}\n\n${REPLY_API}`.trim();   // APIモード
        } else {
          instruction = `${BASE}\n\n${REPLY_TOOL}`.trim();  // toolモード（デフォルト）
        }
      }
      break;
    }
    case 'meta':
//      instruction = `${BASE}\n\n${META}`.trim();
      instruction = `${META}`.trim(); 
      break;
    case 'instpack':
      instruction = `${INST}`.trim();
      break;
    case 'decision':
      instruction = `${DECISION}`.trim(); // BASEは混ぜない（判定専用の短いsystem）
      break;
  }

  return { instruction, origin };
}
