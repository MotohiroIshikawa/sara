import type { MessageContent, MessageTextContent } from "@azure/ai-agents";
import { AgentsClient, ToolUtility, isOutputOfType } from "@azure/ai-agents";
import { DefaultAzureCredential } from "@azure/identity";


export async function connectBing3(): Promise<void> {
  const projectEndpoint = process.env.AZURE_AI_ENDPOINT || "";
  const modelDeploymentName = process.env.AZURE_AI_PRJ_AGENT_NAME || "";
  const connectionId = process.env.AZURE_BING_CONNECTION_ID || "<connection-name>";

  //  const client = new AgentsClient(projectEndpoint, cred);
  let client;
  try {
    client = new AgentsClient(projectEndpoint, new DefaultAzureCredential());
    console.log("AgentsClient インスタンスを生成しました");
  } catch (err) {
    console.log("AgentsClient の生成に失敗しました:",err);
    process.exit(1);
  }

  try{
    const agents = [];
    for await (const agent of client.listAgents()) {
      agents.push(agent);
    }
    console.log("client が正常に動作しています。登録済みエージェント数:", agents.length ?? 0);
  } catch (err){
    console.error("client の疎通テストに失敗しました:", err);
    process.exit(1);
  }

  const bingTool = ToolUtility.createBingGroundingTool([{ connectionId }]);
  console.log("bingTool:");
  console.log(JSON.stringify(bingTool));
 
  const agent = await client.createAgent(modelDeploymentName, {
    name: "lineai-dev-agent",
    instructions: "You are a helpful agent",
    tools: [bingTool.definition],
  });
  console.log(`Created agent, agent ID : ${agent.id}`);

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