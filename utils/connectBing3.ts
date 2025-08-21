import { AgentsClient, ToolUtility } from "@azure/ai-agents";
import { ClientSecretCredential } from "@azure/identity";

export async function connectBing3(req: Request) {
  const endpoint = process.env.AZURE_AI_ENDPOINT || "";
  const key = process.env.AZURE_AI_APIKEY || "";
  console.log("endpoint: " + endpoint);
  console.log("key: " + key);

  const cred = new ClientSecretCredential(
    process.env.AZURE_TENANT_ID!,
    process.env.AZURE_CLIENT_ID!,
    process.env.AZURE_CLIENT_SECRET!
  );
  const client = new AgentsClient(endpoint, cred);

  try {
    const connectionId = process.env.AZURE_BING_CONNECTION_ID || "";
    console.log("connectionId: " + connectionId);
    const bing = ToolUtility.createBingGroundingTool([{connectionId}]);

    // ★ createAgent を try/catch で厳密にログ
    const agent = await client.createAgent("gpt-4o", {
      name: "nextjs-bing-agent",
      instructions: "Use Bing grounding for fresh facts.",
      tools: [bing.definition],
      toolResources: bing.resources, // ← 忘れると 400
    });
    return new Response(JSON.stringify({ agentId: agent.id }), { status: 200 });

  } catch (e: any) {
    // ここで“絶対に”中身を観察する
    console.error("createAgent error (raw):", e);
    console.error("keys:", {
      name: e?.name, code: e?.code, statusCode: e?.statusCode,
      message: e?.message, details: e?.details, inner: e?.innererror
    });
    return new Response(
      JSON.stringify({ error: e?.message ?? String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}