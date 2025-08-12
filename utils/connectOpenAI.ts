import { AzureOpenAI } from "openai";

export const connectOpenAI = async (message: string) => {
  const endpoint = "https://lineai-dev.openai.azure.com/";
  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const apiVersion = "2025-01-01-preview";
  const deployment = "lineai-dev";
  const client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });
  const modelName = "gpt-35-turbo";

/*
  const content = `
    #以下のキーワードを含む情報をWeb検索をしてください。
    #キーワード:
    ${message}
    #注意
    #・返信する内容は、"{"title": "xxx", "detail": "xxx"}"のようにjson形式で返してください。jsonのキーとバリューは、必ず{"key1": "value1", "key2": "value2", "key3": "value3"}のように、各キーとバリューをダブルクオーテーション("")で囲んでください。
    #・返信する内容のタイトル(title)は、30文字以内としてください。
    #・返信する内容の詳細(detail)は、120文字以内としてください。
    `;
  console.log(content);
  const messages = [
    { role: "system", content: "You are a brilliant japanese linguist." },
    { role: "user", content },
  ];
*/
  try{
    const result = await client.chat.completions.create({
      messages: [
        { role:"system", content: "You are a helpful assistant." },
        { role:"user", content: "I am going to Paris, what should I see?" }
      ],
      max_tokens: 4096,
      temperature: 0.7,
      top_p: 0.95,
      model: modelName,
      frequency_penalty: 0,
      presence_penalty: 0,
      stop: null
    });
    console.log("テキスト生成：", message);
    console.log(JSON.stringify(result, null, 2));
    return result.choices;
  } catch (error) {
    console.log("テキスト生成エラー：", error);
  }
}