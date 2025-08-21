
import { AgentsClient, ToolUtility, isOutputOfType } from "@azure/ai-agents";
import { delay } from "@azure/core-util";
//import { AzureKeyCredential } from "@azure/core-auth";
import { DefaultAzureCredential } from "@azure/identity";

const connectBing = async (query: string) => {

  const projectEndpoint = process.env.AZURE_AI_ENDPOINT || "";
//  const projectApiKey = process.env.AZURE_AI_APIKEY || "";
  const client = new AgentsClient(projectEndpoint, new DefaultAzureCredential());

  const connectionId = process.env.AZURE_BING_CONNECTION_ID || "";
  const bingTool = ToolUtility.createBingGroundingTool([{ connectionId: connectionId }]);

  const agent = await client.createAgent("gpt-4o", {
    name: "lineai-dev-agent",
    instructions: "You are a helpful Japanese agent. Use Bing grounding for fresh facts.",
    tools: [bingTool.definition],
    toolResources: bingTool.resources,
  });
  console.log(`Created agent, agent ID : ${agent.id}`);

  // Create thread for communication
  const thread = await client.threads.create();
  console.log(`Created thread, thread ID: ${thread.id}`);

  // Create message to thread
  const message = await client.messages.create( thread.id, "user", query );
  console.log(`Created message, message ID : ${message.id}`);

  // Create and process agent run in thread with tools
  let run = await client.runs.create(thread.id, agent.id);
  while (run.status === "queued" || run.status === "in_progress") {
    await delay(1000);
    run = await client.runs.get(thread.id, run.id);
  }
  if (run.status === "failed") {
    console.log(`Run failed: ${run.lastError?.message}`);
  }
  console.log(`Run finished with status: ${run.status}`);

  // Delete the assistant when done
  await client.deleteAgent(agent.id);
  console.log(`Deleted agent, agent ID: ${agent.id}`);

  // Fetch and log all messages
  const messagesIterator = client.messages.list(thread.id);
  console.log(`Messages:`);

  // Get the first message
  const firstMessage = await messagesIterator.next();
  if (!firstMessage.done && firstMessage.value) {
    const agentMessage = firstMessage.value.content[0];
    if (isOutputOfType(agentMessage, "text")) {
      const textContent = agentMessage;
      console.log(`Text Message Content - ${textContent.text.value}`);
    }
  }
}

export default connectBing