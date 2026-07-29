import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import OpenAI from "openai";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");
const dataPath = path.join(rootDirectory, "client", "src", "data", "research-graph.json");

dotenv.config({ path: path.join(rootDirectory, ".env"), quiet: true });
dotenv.config({ path: path.join(rootDirectory, "server", ".env"), override: false, quiet: true });

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY가 필요합니다.");
}

const model = process.env.GRAPH_SUMMARY_MODEL || "gpt-4.1-mini";
const batchSize = Math.max(1, Number.parseInt(process.env.GRAPH_SUMMARY_BATCH_SIZE || "8", 10));
const shouldForce = process.argv.includes("--force");
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const corpus = JSON.parse(await fs.readFile(dataPath, "utf8"));
const pendingPapers = corpus.papers.filter((paper) => {
  if (shouldForce) return true;
  const summary = paper.summaryKo;
  return !summary?.oneLine || !summary?.purpose || !summary?.method || !summary?.result;
});

const responseFormat = {
  type: "json_schema",
  json_schema: {
    name: "paper_korean_summaries",
    strict: true,
    schema: {
      type: "object",
      properties: {
        summaries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pmid: { type: "string" },
              oneLine: { type: "string" },
              purpose: { type: "string" },
              method: { type: "string" },
              result: { type: "string" },
            },
            required: ["pmid", "oneLine", "purpose", "method", "result"],
            additionalProperties: false,
          },
        },
      },
      required: ["summaries"],
      additionalProperties: false,
    },
  },
};

function promptFor(papers) {
  return JSON.stringify(papers.map((paper) => ({
    pmid: paper.pmid,
    title: paper.title,
    abstract: paper.abstract,
  })));
}

async function summarizeBatch(papers) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: [
              "당신은 의학 논문 초록을 일반 사용자가 이해하기 쉽게 정리하는 한국어 편집자입니다.",
              "반드시 제공된 제목과 초록에 명시된 사실만 사용하세요.",
              "논문 제목은 번역하거나 요약 결과에 다시 적지 마세요.",
              "oneLine은 연구의 핵심을 한국어 한 문장으로, purpose·method·result는 각각 한국어 1~2문장으로 작성하세요.",
              "해당 내용이 초록에서 확인되지 않으면 '초록에서 확인되지 않음'이라고 쓰세요.",
              "과장, 추론, 의료 조언을 추가하지 마세요.",
            ].join(" "),
          },
          {
            role: "user",
            content: `다음 논문들을 PMID별로 정리하세요.\n${promptFor(papers)}`,
          },
        ],
        response_format: responseFormat,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("모델이 빈 응답을 반환했습니다.");
      return JSON.parse(content).summaries;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
    }
  }
  throw new Error(`요약 생성 실패: ${lastError?.message || "알 수 없는 오류"}`);
}

console.log(`모델 ${model}로 ${pendingPapers.length}편의 한국어 요약을 생성합니다.`);

for (let offset = 0; offset < pendingPapers.length; offset += batchSize) {
  const batch = pendingPapers.slice(offset, offset + batchSize);
  const summaries = await summarizeBatch(batch);
  const summaryByPmid = new Map(summaries.map((summary) => [summary.pmid, summary]));

  for (const paper of batch) {
    const summary = summaryByPmid.get(paper.pmid);
    if (!summary) throw new Error(`PMID ${paper.pmid} 요약이 응답에서 누락되었습니다.`);
    paper.summaryKo = {
      oneLine: summary.oneLine.trim(),
      purpose: summary.purpose.trim(),
      method: summary.method.trim(),
      result: summary.result.trim(),
    };
  }

  await fs.writeFile(dataPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");
  console.log(`${Math.min(offset + batch.length, pendingPapers.length)}/${pendingPapers.length} 완료`);
}

console.log("한국어 논문 요약 저장을 완료했습니다.");
