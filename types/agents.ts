// run の状態（Azure Agents 標準）
export type AgentsRunStatus =
  | "queued"
  | "in_progress"
  | "requires_action"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

// submit_tool_outputs の構造
export type AgentsSubmitToolOutputsAction = {
  type: "submit_tool_outputs";
  submitToolOutputs?: { toolCalls?: unknown };
};

// runs.get() が返す状態
export type AgentsRunState = {
  status?: AgentsRunStatus;
  requiredAction?: AgentsSubmitToolOutputsAction;
};

// submitToolOutputs の1件分
export type AgentsToolOutput = {
  toolCallId: string;
  output: string;
};

// requires_action 時に呼ばれるハンドラ
// （Meta / Instpack 用に getMeta.ts / getInstpack.ts 側で実装される）
export type AgentsRequiresActionHandler<TCaptured> = (args: {
  state: AgentsRunState;
  threadId: string;
  runId: string;
}) => Promise<{
  captured?: TCaptured;
  outputs: AgentsToolOutput[];
} | undefined>;

// runWithToolCapture の返却
export type AgentsRunResult<TCaptured> = {
  runId: string;
  captured?: TCaptured;
  finalState?: AgentsRunState;
  timedOut: boolean;
  cancelled: boolean;
};