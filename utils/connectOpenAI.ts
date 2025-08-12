import { AzureOpenAI } from "openai";

export const connectOpenAI = async (message: string) => {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
  const apiKey = process.env.AZURE_OPENAI_API_KEY || "";
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "";
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "";
  const modelName = process.env.AZURE_OPENAI_MODEL_NAME || "";
  const client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });

  const words = `
    以下のキーワードを含む情報をWeb検索をしてください。
    キーワード:
    ${message}
    注意
    ・返信する内容は、"{"title": "xxx", "detail": "xxx"}"のようにjson形式で返してください。jsonのキーとバリューは、必ず{"key1": "value1", "key2": "value2", "key3": "value3"}のように、各キーとバリューをダブルクオーテーション("")で囲んでください。
    ・返信する内容のタイトル(title)は、50文字以内としてください。
    ・返信する内容の詳細(detail)は、200文字以内としてください。
    `;
  const messages = [
    { role: "system", content: "あなたは丁寧な日本語が得意です。" },
    { role: "user", content: words },
  ];

  try{
    const result = await client.chat.completions.create({
      messages: messages,
      max_tokens: 4096,
      temperature: 1,
      top_p: 0.95,
      model: modelName,
    });
    console.log("text generated: ", message);
    const resContent = result.choices[0].message.content;
    console.log(resContent);
    return JSON.parse(resContent);
  } catch (error) {
    console.log("ERROR text generating: ", error);
  }
}