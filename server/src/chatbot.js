import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { StateGraph, StateSchema, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { config } from "./config.js";
import {
  classifyChatInput,
  guardChatOutput,
  redactSensitiveData,
} from "./guard.js";

const NO_API_KEY_RESPONSE = "OPENAI_API_KEY가 설정되지 않았습니다.";

const ChatState = new StateSchema({
  message: z.string(),
  sanitizedMessage: z.string().default(""),
  system: z.string().default(""),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).default([]),
  context: z.array(z.unknown()).default([]),
  decision: z.enum(["allow", "blocked"]).default("allow"),
  reason: z.string().default(""),
  response: z.string().default(""),
  modelAvailable: z.boolean().default(true),
});

function messageContent(message) {
  if (typeof message?.text === "string" && message.text) return message.text;
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function historyMessages(history) {
  return history.map(({ role, content }) => (
    role === "assistant"
      ? new AIMessage(redactSensitiveData(content))
      : new HumanMessage(redactSensitiveData(content))
  ));
}

export function createGuardedChatGraph({ prepare, model }) {
  const inputGuard = (state) => {
    const result = classifyChatInput(state.message);
    return {
      decision: result.decision,
      reason: result.reason,
      response: result.response,
      sanitizedMessage: result.sanitizedMessage || "",
    };
  };

  const prepareContext = async (state) => {
    const prepared = await prepare(state.sanitizedMessage);
    return {
      system: prepared.system,
      history: prepared.history || [],
      context: prepared.context || [],
    };
  };

  const generate = async (state) => {
    const response = await model.invoke([
      new SystemMessage(state.system),
      ...historyMessages(state.history),
      new HumanMessage(state.sanitizedMessage),
    ]);
    return { response: messageContent(response) };
  };

  const outputGuard = (state) => guardChatOutput(state.response);
  const unavailable = () => ({
    decision: "blocked",
    reason: "model_unavailable",
    response: NO_API_KEY_RESPONSE,
  });

  return new StateGraph(ChatState)
    .addNode("input_guard", inputGuard)
    .addNode("prepare_context", prepareContext)
    .addNode("generate", generate)
    .addNode("output_guard", outputGuard)
    .addNode("unavailable", unavailable)
    .addEdge(START, "input_guard")
    .addConditionalEdges(
      "input_guard",
      (state) => {
        if (state.decision === "blocked") return END;
        return state.modelAvailable ? "prepare_context" : "unavailable";
      },
      ["prepare_context", "unavailable", END],
    )
    .addEdge("prepare_context", "generate")
    .addEdge("generate", "output_guard")
    .addEdge("output_guard", END)
    .addEdge("unavailable", END)
    .compile();
}

export async function runGuardedChat({
  message,
  prepare,
  model = null,
  apiKey = config.openaiApiKey,
  modelName = config.chatModel,
}) {
  const chatModel = model || (apiKey
    ? new ChatOpenAI({
        apiKey,
        model: modelName,
        maxRetries: 2,
      })
    : null);
  const graph = createGuardedChatGraph({
    prepare,
    model: chatModel || { invoke: async () => new AIMessage("") },
  });
  // AIDEV-NOTE: The complete model answer is guarded before SSE emission; token streaming cannot retract unsafe text.
  return graph.invoke({
    message,
    modelAvailable: Boolean(chatModel),
  });
}
