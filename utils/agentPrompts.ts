import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

const P = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');

// 4分割したファイルを読み込む
const BASE = P('config/prompts/base.md');
const REPLY = P('config/prompts/reply.md');
const META = P('config/prompts/meta.md');
const INST = P('config/prompts/instpack.md');

// それぞれを結合して“完成した instructions”を返す
export const buildReplyInstructions = () => `${BASE}\n\n${REPLY}`.trim();
export const buildMetaInstructions = () => `${BASE}\n\n${META}`.trim();
  // instpack 生成時は base を混ぜない（差分だけ出させる）
export const buildInstpackInstructions = () => `${INST}`.trim();
// 保存済み instpack を実行時に使うときは base + instpack を合成
export const buildReplyWithUserInstpack = (userInstpack: string) => `${BASE}\n\n${userInstpack}`.trim();