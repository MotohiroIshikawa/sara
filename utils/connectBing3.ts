import type { MessageContent, MessageTextContent } from "@azure/ai-agents";
import {
  AgentsClient,
  ToolUtility,
  isOutputOfType,
  type Agent,
  type Message,
  type Run
} from "@azure/ai-agents";
//import { AgentsClient, ToolUtility, isOutputOfType } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";

export async function connectBing3(): Promise<void> {
  const projectEndpoint = process.env.AZURE_AI_ENDPOINT || "";
  const modelDeploymentName = process.env.AZURE_AI_PRJ_AGENT_NAME || "";
  const connectionId = process.env.AZURE_BING_CONNECTION_ID || "<connection-name>";

  // 認証
  const cred = new DefaultAzureCredential();
  // 認証に成功しているかどうか確認
  try {
    const token = await cred.getToken("https://cognitiveservices.azure.com/.default");
    if (!token) {
      console.error("❌ 認証失敗(getToken): token is null");
      return;
    }
    console.log("✅ 認証成功: token acquired, expiresOnTimestamp =", token?.expiresOnTimestamp);
  } catch (e) {
    console.error("❌ 認証失敗(getToken):", e);
    return;
  }

  // client作成
  const client = new AgentsClient(projectEndpoint, cred);
  // clientが作成できているかどうか確認
  try {
    const thread = await client.threads.create();
    console.log("✅ 疎通成功: createThread OK, id =", thread.id);
    // 後片付け（任意）
    try {
      await client.threads.delete(thread.id);
      console.log("🧹 deleted thread:", thread.id);
    } catch(delErr) {
      console.warn("⚠️ threads.delete でエラー（続行）:", delErr);
    }
  } catch (e) {
    // ここで落ちるならエンドポイント/権限/プロジェクトの問題を疑う
    console.error("❌ 疎通失敗(create/delete Thread):", e);
  }


  // Grounding with Bing Tool作成
  const bingTool = ToolUtility.createBingGroundingTool([{ connectionId }]);
  console.log("bingTool:" + JSON.stringify(bingTool));

  let agent;
  try {
    agent = await client.createAgent(modelDeploymentName, {
      name: `lineai-dev-agent-${Date.now()}`,
      instructions: "You are a helpful agent",
      tools: [bingTool.definition],
    });
    console.log("Created agent:", agent.id, agent.name);
  } catch (err: unknown) {
    console.error("createAgent failed. raw:", err);
    if (err instanceof Error) {
      console.error("name:", err.name);
      console.error("message:", err.message);
    }
    if (typeof (err as any)?.response?.bodyAsText === "string") {
      console.error("body:", (err as any).response.bodyAsText);
    }
    process.exit(1);
  }

  const thread = await client.threads.create();
  console.log(`Created thread, thread ID: ${thread.id}`);

  const message = await client.messages.create(
    thread.id,
    "user",
    "How does wikipedia explain Euler's Identity?",
  );
  console.log(`Created message, message ID : ${message.id}`);

  console.log("Creating run...");
  const run = await client.runs.createAndPoll(thread.id, agent.id, {
    pollingOptions: {
      intervalInMs: 2000,
    },
    onResponse: (response): void => {
      console.log(`Received response with status: ${response.parsedBody.status}`);
    },
  });
  console.log(`Run finished with status: ${run.status}`);

  await client.deleteAgent(agent.id);
  console.log(`Deleted agent, agent ID: ${agent.id}`);

  const messagesIterator = client.messages.list(thread.id);

  const firstMessage = await messagesIterator.next();
  if (!firstMessage.done && firstMessage.value) {
    const agentMessage: MessageContent = firstMessage.value.content[0];
    if (isOutputOfType<MessageTextContent>(agentMessage, "text")) {
      console.log(`Text Message Content - ${agentMessage.text.value}`);
    }
  }
}

connectBing3().catch((err) => {
  console.error("The sample encountered an error:", err);
});