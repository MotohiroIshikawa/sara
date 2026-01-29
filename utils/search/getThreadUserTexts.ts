import { type MessageContentUnion } from "@azure/ai-agents";
import { agentsClient } from "@/utils/agents";

// thread 内の user ロール発言を、古い → 新しい順でテキスト配列として取得する
export async function getThreadUserTexts(
  threadId: string
): Promise<readonly string[]> {
  const results: string[] = [];

  // 昇順（古い→新しい）で取得
  for await (const m of agentsClient.messages.list(threadId, { order: "asc" })) {
    if (m.role !== "user") continue;

    const contents: MessageContentUnion[] = m.content as MessageContentUnion[];

    for (const block of contents) {
      // user メッセージは input_text が基本
      if (block.type === "input_text") {
        const b = block as { type: "input_text"; text?: string };
        const text: string = (b.text ?? "").trim();
        if (text.length > 0) {
          results.push(text);
        }
        continue;
      }

      // 念のため output_text も拾えるようにしておく（設計上は通常来ない）
      if (block.type === "output_text") {
        const b = block as { type: "output_text"; text?: string };
        const text: string = (b.text ?? "").trim();
        if (text.length > 0) {
          results.push(text);
        }
        continue;
      }

      // image_url など他のブロック型は検索語構築には不要なので無視
    }
  }

  return results;
}
