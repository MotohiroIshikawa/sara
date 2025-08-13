import { AzureOpenAI } from "openai";

const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
const apiKey = process.env.AZURE_OPENAI_API_KEY || "";
const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "";
const deployment = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "";
const modelName = process.env.AZURE_OPENAI_MODEL_NAME || "";
const client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment });

const connectGPT = async (message: string) => {

  const prompt = `
    #以下のキーワードを含む情報を返信してください。
    キーワード:
    ${message}
    #返信する内容は、300文字以内としてください。
    `;

  const messages = [
    { role: "system", content: "あなたは丁寧な日本語が得意です。" },
    { role: "user", content: prompt },
  ];
  try{
    const result = await client.chat.completions.create({
      messages: messages,
      max_tokens: 4096,
      temperature: 1,
      top_p: 0.95,
      model: modelName,
    });
    console.log("1.GPT text generated: ", message);
    return result.choices[0].message.content || "";
  } catch (error) {
    console.log("ERROR 1.GPT text generating: ", error);
  }
}

export default connectGPT