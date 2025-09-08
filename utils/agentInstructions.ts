import 'server-only';
import fs from 'node:fs';
import path from 'node:path';

const agentInstructionsDefault = 'config/prompts/agent.instructions.md';

function readText(p: string) {
  return fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
}

export const agentInstructions: string = (() => {
  const file = process.env.AGENT_INSTRUCTIONS_FILE ?? agentInstructionsDefault;
  return readText(file);
})();
