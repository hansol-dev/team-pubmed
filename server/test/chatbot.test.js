import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import { runGuardedChat } from "../src/chatbot.js";

test("LangGraph blocks unsafe input before retrieval and model execution", async () => {
  let prepared = false;
  let invoked = false;
  const result = await runGuardedChat({
    message: "What dosage should I take?",
    prepare: async () => {
      prepared = true;
      return { system: "", history: [], context: [] };
    },
    model: {
      invoke: async () => {
        invoked = true;
        return new AIMessage("unsafe");
      },
    },
  });

  assert.equal(result.decision, "blocked");
  assert.equal(result.reason, "medical_advice");
  assert.equal(prepared, false);
  assert.equal(invoked, false);
});

test("LangGraph prepares context and returns a guarded LangChain response", async () => {
  const calls = [];
  const context = [{ pmid: "123", content: "Evidence" }];
  const result = await runGuardedChat({
    message: "researcher@example.com의 논문을 분석해줘",
    prepare: async (sanitizedMessage) => {
      calls.push({ type: "prepare", sanitizedMessage });
      return {
        system: "논문 근거만 사용하세요.",
        history: [{ role: "assistant", content: "이전 답변" }],
        context,
      };
    },
    model: {
      invoke: async (messages) => {
        calls.push({ type: "model", messages });
        return new AIMessage("근거에 따르면 연구 결과가 개선되었습니다.");
      },
    },
  });

  assert.equal(result.decision, "allow");
  assert.equal(result.response, "근거에 따르면 연구 결과가 개선되었습니다.");
  assert.deepEqual(result.context, context);
  assert.equal(calls[0].sanitizedMessage, "[EMAIL_REDACTED]의 논문을 분석해줘");
  assert.equal(calls[1].messages.at(-1).content, "[EMAIL_REDACTED]의 논문을 분석해줘");
});

test("LangGraph replaces unsafe model output before it reaches SSE", async () => {
  const result = await runGuardedChat({
    message: "이 논문의 결과를 설명해줘",
    prepare: async () => ({ system: "안전하게 답하세요.", history: [], context: [] }),
    model: {
      invoke: async () => new AIMessage("이 약은 10 mg씩 복용하세요."),
    },
  });

  assert.equal(result.decision, "blocked");
  assert.equal(result.reason, "unsafe_medical_output");
  assert.doesNotMatch(result.response, /10 mg/);
});
