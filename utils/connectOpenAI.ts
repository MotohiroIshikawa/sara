import { AzureKeyCredential, OpenAIClient } from "@azure/openai";

export const connectOpenAI = async (message: string) => {
  try{
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
    const azureApiKey = process.env.AZURE_OPENAI_API_KEY || "";
    const deploymentId = process.env.AZURE_OPENAI_DEPLOYMENT_ID || "";
    const content = `
      #以下のキーワードを含む情報をWeb検索をしてください。
      #キーワード:
      ${message}
      #注意
      #・返信する内容は、"{"title": "xxx", "detail": "xxx"}"のようにjson形式で返してください。jsonのキーとバリューは、必ず{"key1": "value1", "key2": "value2", "key3": "value3"}のように、各キーとバリューをダブルクオーテーション("")で囲んでください。
      #・返信する内容のタイトル(title)は、30文字以内としてください。
      #・返信する内容の詳細(detail)は、120文字以内としてください。
      `;
    const messages = [
      { role: "system", content: "You are a brilliant japanese linguist." },
      { role: "user", content },
    ];
    const client = new OpenAIClient(
      endpoint,
      new AzureKeyCredential(azureApiKey)
    );
    const result = await client.getChatCompletions(deploymentId, messages);
    console.log("テキスト生成：", message);
    return result.choices;
  } catch (error) {
    console.log("テキスト生成エラー：", error);
  }
}