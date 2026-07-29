import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { searchPubMed } from "../server/src/pubmed.js";

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, "../client/src/data/research-graph.json");
const yearFrom = 2022;
const yearTo = 2026;
const papersPerTopic = 25;

const topics = [
  {
    id: "oncology",
    label: "암 정밀의료",
    query: "precision oncology biomarkers",
    description: "바이오마커, 조기진단, 표적치료 연구",
    color: "#ff7f8f",
  },
  {
    id: "cardiovascular",
    label: "심혈관 건강",
    query: "cardiovascular disease prevention",
    description: "위험 예측, 예방, 생활습관 중재 연구",
    color: "#58d6c2",
  },
  {
    id: "neuroscience",
    label: "뇌·신경과학",
    query: "neurodegenerative disease biomarkers",
    description: "치매, 신경퇴행, 뇌 영상·바이오마커 연구",
    color: "#8b7cf6",
  },
  {
    id: "metabolism",
    label: "대사·당뇨",
    query: "diabetes metabolic health intervention",
    description: "당뇨, 비만, 대사 건강 중재 연구",
    color: "#ffb35c",
  },
  {
    id: "mental-health",
    label: "정신건강",
    query: "mental health digital intervention",
    description: "우울·불안, 디지털 치료, 웰빙 연구",
    color: "#5fa8ff",
  },
  {
    id: "public-health",
    label: "공중보건",
    query: "infectious disease public health surveillance",
    description: "감염병, 역학, 보건정책·감시 연구",
    color: "#d976f6",
  },
];

const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const clean = (value, max = 1200) => String(value || "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const papersByPmid = new Map();

for (const [topicIndex, topic] of topics.entries()) {
  process.stdout.write(`Fetching ${topic.label}... `);
  const papers = await searchPubMed({
    keyword: topic.query,
    yearFrom,
    yearTo,
    maxCount: papersPerTopic,
  });

  for (const paper of papers) {
    const existing = papersByPmid.get(paper.pmid);
    if (existing) {
      if (!existing.topicIds.includes(topic.id)) existing.topicIds.push(topic.id);
      continue;
    }
    papersByPmid.set(paper.pmid, {
      pmid: paper.pmid,
      title: clean(paper.title, 360),
      abstract: clean(paper.abstract, 2200),
      journal: clean(paper.journal, 180) || "Unknown journal",
      year: paper.pub_year,
      authors: (paper.authors || []).slice(0, 5),
      pmcid: paper.pmcid || null,
      doi: paper.doi || null,
      pubmedUrl: paper.pubmed_url,
      fullTextUrl: paper.full_text_url,
      accessLevel: paper.access_level,
      topicIds: [topic.id],
    });
  }
  process.stdout.write(`${papers.length} papers\n`);
  if (topicIndex < topics.length - 1) await pause(850);
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: "NCBI PubMed E-utilities",
  yearRange: [yearFrom, yearTo],
  topics: topics.map(({ query, ...topic }) => topic),
  papers: [...papersByPmid.values()].slice(0, topics.length * papersPerTopic),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Saved ${payload.papers.length} papers to ${outputPath}`);
