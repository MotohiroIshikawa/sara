import { AzureOpenAI } from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type RawMsg = { role: "system" | "user" | "assistant"; content: string; name?: string };

const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
const apiKey = process.env.AZURE_OPENAI_API_KEY || "";
const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "";
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "";
const modelName = process.env.AZURE_OPENAI_MODEL_NAME || "";

const client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });

function toOpenAIMessages(raw: RawMsg[]): ChatCompletionMessageParam[] {
  const allowed = new Set(["system", "user", "assistant"] as const);
  return raw.map((m) => {
    const role = allowed.has(m.role as any) ? (m.role as "system" | "user" | "assistant") : "user";
    return {
      role,
      content: String(m.content ?? ""),
    };
  });
}

const connectGPT = async (message: string) => {
  const prompt = `
    #以下のキーワードを含む情報を返信してください。
    キーワード:
    ${message}
    #返信する内容は、300文字以内としてください。
    `;
  // RawMsg[] として作ってから toOpenAIMessages で正規化
  const rawMessages: RawMsg[] = [
    { role: "system", content: "あなたは丁寧な日本語が得意です。" },
    { role: "user", content: prompt },
  ];
  try{
    const result = await client.chat.completions.create({
      model: deployment || modelName,
      messages: toOpenAIMessages(rawMessages),
      max_tokens: 4096,
      temperature: 1,
      top_p: 0.95,
    });
    console.log("1.GPT text generated: ", message);
    return result.choices[0].message.content || "";
  } catch (error) {
    console.log("ERROR 1.GPT text generating: ", error);
  }
}

export async function callGPT(messages: RawMsg[]) {
  try {
    const result = await client.chat.completions.create({
      model: deployment || modelName,            // デプロイ名を渡す
      messages: toOpenAIMessages(messages),
      max_tokens: 4096,
      temperature: 1,
      top_p: 0.95,
    });
    return result;
  } catch (err) {
    throw err;
  }
}
