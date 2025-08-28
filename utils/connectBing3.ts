import {
  AgentsClient,
  ToolUtility,
  connectionToolType,
  isOutputOfType,
  type MessageTextContent,
  type ThreadMessage,
} from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";

// エラー出力用
function logHttpError(e: unknown, label: string) {
  console.error(`❌ ${label}`);
  if (e instanceof Error) {
    console.error("  name:", e.name);
    console.error("  message:", e.message);
  } else {
    console.error("  raw:", String(e));
  }
  const resp = (e as { response?: Record<string, unknown> }).response;
  if (resp) {
    const body = typeof resp.bodyAsText === "string" ? resp.bodyAsText : undefined;
    if (body) console.error("  bodyAsText:", body);
    const status = 
      typeof (resp as { status?: number }).status === "number"
      ? (resp as { status: number }).status
      : undefined;
    if (status) console.error("  status:", status);
  }
}

export async function connectBing3(question: string): Promise<string> {
  const projectEndpoint = process.env.AZURE_AI_PRJ_ENDPOINT || "";
  const modelDeploymentName = process.env.AZURE_OPENAI_DEPLOYMENT_NAME || "";
  const bingConnectionId = process.env.AZURE_BING_CONNECTION_ID || "";

  // 認証
  const cred = new DefaultAzureCredential();
  try {
    const token = await cred.getToken("https://cognitiveservices.azure.com/.default");
    if (!token) {
      console.error("❌ getToken failed: token is null");
      return("エラーが発生しました(CRED:token is null)");
    }
    console.log("✅ token acquired, expiresOnTimestamp =", token?.expiresOnTimestamp);
  } catch (e) {
    logHttpError(e, "getToken failed");
    return("エラーが発生しました(CRED)");
  }

  // client作成
  const client = new AgentsClient(projectEndpoint, cred);

  // Grounding with Bing Tool作成
  const bingTool = ToolUtility.createConnectionTool(
    connectionToolType.BingGrounding, 
    [bingConnectionId],
  );
  console.log("🔧 bingTool.definition =", JSON.stringify(bingTool.definition));

  // Agent作成
  console.log("📌 modelDeploymentName =", modelDeploymentName);
  console.log("bingTool.definition =", JSON.stringify(bingTool.definition, null, 2));
  let agent: { id: string };
  try {
    agent = await client.createAgent(modelDeploymentName, {
      name: `bing-agent-${Date.now()}`,
      instructions: "You are a helpful agent that can answer with help from Bing search.",
      tools: [bingTool.definition],
    });
    console.log("✅ Agent created:", agent.id);
  } catch (e) {
    logHttpError(e, "createAgent failed");
    return "エージェント作成に失敗しました。";
  }

  try {
    // Thread作成
    const thread = await client.threads.create();
    console.log("✅ Thread created:", thread.id);

    // ユーザの質問を送信
    await client.messages.create(thread.id, "user", question);

    // 実行
    await client.runs.createAndPoll(thread.id, agent.id);

    // すべてのメッセージを取得する
    const all: ThreadMessage[] = [];
    for await (const m of client.messages.list(thread.id)) {
      all.push(m);
    }
    // createdAt がある前提で昇順ソート（古い→新しい）
    all.sort((a, b) => (new Date(a.createdAt!).getTime() - new Date(b.createdAt!).getTime()));

    const assistantTexts: string[] = [];
    for (const m of all) {
      if (m.role !== "assistant") continue;
      for (const c of m.content) {
        if (isOutputOfType<MessageTextContent>(c, "text")) {
          assistantTexts.push(c.text.value);
        }
      }
    }

    return assistantTexts.length
    ? assistantTexts.join("\n---\n")
    : "⚠️ 応答の text コンテンツが見つかりませんでした。";

  } finally {
    // 後片付け
    try {
      await client.deleteAgent(agent.id);
      console.log(`🧹Deleted agent, agent ID: ${agent.id}`);
    } catch(e) {
      logHttpError(e, "deleteAgent failed (続行)");
    }
  }
}