import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import type { BindingTarget } from '@/types/db';
import { getBinding } from '@/services/gptsBindings.mongo';

const P = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

// 4分割したファイルを読み込む
const BASE = P('config/prompts/base.md');
const REPLY = P('config/prompts/reply.md');
const META = P('config/prompts/meta.md');
const INST = P('config/prompts/instpack.md');

export type ReplyInsOrigin = 'binding' | 'base';

export const getBaseReplyInstruction = () => `${BASE}\n\n${REPLY}`.trim();

export function getInstructionsWithInstpack(instpack: string): {
  reply: string;   // BASE + instpack
  meta: string;    // BASE + META
  inst: string;    // INST (BASEは混ぜない)
} {
  const reply = `${BASE}\n\n${instpack}`.trim();
  const meta  = `${BASE}\n\n${META}`.trim();
  const inst  = `${INST}`.trim();
  return { reply, meta, inst };
}

export async function getInstructions(
  target: BindingTarget
): Promise<{
  reply: string;
  meta: string;
  instpack: string;
  origin: ReplyInsOrigin;
}> {
  let origin: ReplyInsOrigin = 'base';
  let instpackFromBinding = '';

  // binding を見にいって、あれば優先
  try {
    const b = await getBinding(target);
    const s = b?.instpack?.trim();
    if (s) {
      origin = 'binding';
      instpackFromBinding = s;
    }
  } catch {}

  // reply
  const reply =
    origin === 'binding'
      ? `${BASE}\n\n${instpackFromBinding}`.trim()
      : `${BASE}\n\n${REPLY}`.trim();

  // meta
  const meta = `${BASE}\n\n${META}`.trim();
  // instpack
  const instpack = `${INST}`.trim();

  return { reply, meta, instpack, origin };
}