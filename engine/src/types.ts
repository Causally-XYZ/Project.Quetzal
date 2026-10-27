// 引擎的模型与工具协议；不依赖供应商配置或宿主。
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ImagePart { mime: string; data: string } // data：base64
export type Msg =
  | { role: "system" | "user"; content: string; images?: ImagePart[] } // images 只用于 user
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string; error?: boolean; atomic?: boolean }; // error：调用失败；atomic：宿主要求内容完整，不做头尾节选（仍可整组摘要 / 引用）
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ChatRequest {
  messages: Msg[]; tools?: ToolDef[]; maxTokens?: number; temperature?: number;
  prepareForModel?: (limits: { contextWindow: number; maxOutputTokens: number; model: string }) => Promise<ChatRequest>;
  session?: string; // 一次对话的稳定标识（同一次醒来 / 同一段交谈的多轮调用相同），供需要的供应商使用
  signal?: AbortSignal; // 外部中止（会话时间墙）
  onChunk?: () => void; // 收到任何流数据块（用于重置会话时间墙）
  onText?: (text: string) => void; // 流式文字片段
}
export interface ChatResult {
  text: string; toolCalls: ToolCall[];
  usage: {
    input: number; output: number; // 输出包含供应商报告的思考用量；不应再次加 reasoning。
    reasoning?: number; // 输出中的思考子集；未报告时省略，不推断为零。
    total?: number; // 供应商直接报告的总量，不由 input / output 猜算。
  };
  model: string; truncated?: boolean; // truncated：输出到了长度上限（max_tokens）被截断
}
