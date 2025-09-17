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
export const buildInstpackInstructions = () => `${BASE}\n\n${INST}`.trim();
