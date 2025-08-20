
const connectBing2 = async (query: string) => {

  try {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT || "";
    const apiKey = process.env.AZURE_OPENAI_API_KEY || "";
    const connectionId = process.env.AZURE_BING_CONNECTION_ID || "";

    // Prompt に Bing Search を使うことを指示
    const body = {
      messages: [
        { role: "system", content: "You have access to Bing Search for answering questions." },
        { role: "user", content: query }
      ],
      options: {
        grounding: {
          connectionId
        }
      }
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Azure AI Agent error: ${text}`);
    }

    const data = await response.json();
console.log(data);
//    res.status(200).json(data);

  } catch (error) {
    console.error(error);
//    res.status(500).json({ error: error.message });
  }
}

export default connectBing2