export const RESEARCH_TOPICS = [
  {
    id: "oncology",
    label: "암 정밀의료",
    description: "바이오마커, 조기진단, 표적치료 연구",
    color: "#ff7f8f",
    terms: ["암", "종양", "항암", "바이오마커", "정밀의료", "cancer", "oncology", "tumor", "biomarker", "carcinoma"],
  },
  {
    id: "cardiovascular",
    label: "심혈관 건강",
    description: "위험 예측, 예방, 생활습관 중재 연구",
    color: "#58d6c2",
    terms: ["심혈관", "심장", "혈압", "뇌졸중", "cardiovascular", "heart", "stroke", "hypertension", "vascular"],
  },
  {
    id: "neuroscience",
    label: "뇌·신경과학",
    description: "치매, 신경퇴행, 뇌 영상·바이오마커 연구",
    color: "#8b7cf6",
    terms: ["뇌", "신경", "치매", "알츠하이머", "파킨슨", "neuro", "brain", "dementia", "alzheimer", "parkinson"],
  },
  {
    id: "metabolism",
    label: "대사·생활습관",
    description: "당뇨, 비만, 영양, 신체활동 연구",
    color: "#f5b95f",
    terms: ["당뇨", "비만", "대사", "인슐린", "혈당", "diabetes", "obesity", "metabolic", "insulin", "glycemic"],
  },
  {
    id: "mental-health",
    label: "정신건강",
    description: "우울, 불안, 스트레스, 디지털 중재 연구",
    color: "#66b9ef",
    terms: ["정신건강", "우울", "불안", "스트레스", "mental health", "depression", "anxiety", "stress", "psychological"],
  },
  {
    id: "public-health",
    label: "공중보건·감염병",
    description: "감염병, 역학, 유행, 보건 감시 연구",
    color: "#d982e8",
    terms: ["공중보건", "감염병", "역학", "유행", "감시", "public health", "infectious", "infection", "surveillance", "epidemiology"],
  },
  {
    id: "general-biomedicine",
    label: "기타 생의학",
    description: "주요 분류 외 임상·기초 의생명 연구",
    color: "#9aa2b7",
    terms: [],
  },
];

export const RESEARCH_CONCEPTS = [
  { id: "cancer-biomarker", label: "암 바이오마커", group: "질환·표지자", color: "#ff9ca8", terms: ["cancer biomarker", "tumor biomarker", "molecular biomarker", "precision oncology"] },
  { id: "immunotherapy", label: "면역치료", group: "치료·중재", color: "#ffb08c", terms: ["immunotherapy", "immune checkpoint", "car-t", "tumor immunity"] },
  { id: "genomics", label: "유전체 분석", group: "연구 방법", color: "#d89cff", terms: ["genomic", "genome", "sequencing", "transcriptomic", "gene expression"] },
  { id: "cardiovascular-prevention", label: "심혈관 예방", group: "질환·예방", color: "#6ee0d2", terms: ["cardiovascular prevention", "cardiovascular risk", "heart disease prevention"] },
  { id: "hypertension", label: "고혈압", group: "질환", color: "#7dd7c6", terms: ["hypertension", "hypertensive", "blood pressure"] },
  { id: "stroke", label: "뇌졸중", group: "질환", color: "#76c8dc", terms: ["stroke", "cerebrovascular"] },
  { id: "alzheimers", label: "알츠하이머병", group: "질환", color: "#a89cff", terms: ["alzheimer", "amyloid-beta", "amyloid β", "tau-441"] },
  { id: "neurodegeneration", label: "신경퇴행", group: "질환", color: "#998df2", terms: ["neurodegenerative", "neurodegeneration", "parkinson", "dementia"] },
  { id: "diabetes", label: "당뇨병", group: "질환", color: "#ffbd73", terms: ["diabetes", "diabetic", "glycemic", "glucose"] },
  { id: "obesity", label: "비만·대사", group: "질환", color: "#ffc66f", terms: ["obesity", "obese", "metabolic syndrome", "insulin resistance"] },
  { id: "lifestyle", label: "생활습관 중재", group: "치료·중재", color: "#e9cf73", terms: ["lifestyle intervention", "physical activity", "exercise", "dietary", "nutrition"] },
  { id: "mental-health", label: "정신건강", group: "질환", color: "#73b8ff", terms: ["mental health", "depression", "anxiety", "psychological"] },
  { id: "digital-health", label: "디지털 헬스", group: "치료·중재", color: "#65c8ff", terms: ["digital health", "mobile health", "mhealth", "digital intervention", "internet-based"] },
  { id: "infectious-disease", label: "감염병", group: "질환", color: "#dd83ef", terms: ["infectious disease", "infection", "virus", "bacterial", "pathogen"] },
  { id: "surveillance", label: "공중보건 감시", group: "공중보건", color: "#e889ec", terms: ["surveillance", "outbreak", "epidemiology", "public health"] },
  { id: "clinical-trial", label: "임상시험", group: "연구 방법", color: "#83d9b5", terms: ["clinical trial", "randomized", "randomised", "controlled trial"] },
  { id: "cohort-study", label: "코호트 연구", group: "연구 방법", color: "#8bd2c0", terms: ["cohort", "longitudinal", "prospective study", "retrospective study"] },
  { id: "systematic-review", label: "체계적 문헌고찰", group: "연구 방법", color: "#b5ca83", terms: ["systematic review", "meta-analysis", "scoping review"] },
  { id: "machine-learning", label: "머신러닝", group: "연구 방법", color: "#89baff", terms: ["machine learning", "deep learning", "artificial intelligence", "neural network"] },
  { id: "diagnostic-biomarker", label: "진단 바이오마커", group: "표지자", color: "#f090bc", terms: ["diagnostic biomarker", "early diagnosis", "early detection", "biosensor"] },
];

const STOPWORDS = new Set([
  "about", "after", "among", "and", "are", "based", "between", "from", "into", "of", "for",
  "study", "the", "this", "through", "using", "with", "논문", "연구", "어떻게", "대한", "에서",
  "으로", "있는", "알려줘", "보여줘", "분석", "결과", "관련", "무엇", "어떤",
]);

function textOf(paper) {
  return `${paper?.title || ""} ${paper?.abstract || ""}`.toLowerCase();
}

function countMatches(text, terms) {
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeAuthors(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

export function researchWords(value) {
  return (String(value || "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) || [])
    .filter((word) => !STOPWORDS.has(word));
}

export function classifyResearchTopics(paper) {
  const text = textOf(paper);
  const ranked = RESEARCH_TOPICS
    .filter((topic) => topic.id !== "general-biomedicine")
    .map((topic) => ({ id: topic.id, score: countMatches(text, topic.terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  if (!ranked.length) return ["general-biomedicine"];
  const threshold = Math.max(1, ranked[0].score - 1);
  return ranked.filter((item) => item.score >= threshold).slice(0, 2).map((item) => item.id);
}

export function matchResearchConcepts(paper, limit = 3) {
  const text = textOf(paper);
  return RESEARCH_CONCEPTS
    .map((concept) => ({ id: concept.id, score: countMatches(text, concept.terms) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((item) => item.id);
}

export function normalizeResearchPaper(paper) {
  const topicIds = unique(paper?.topicIds?.length ? paper.topicIds : classifyResearchTopics(paper));
  const conceptIds = unique(paper?.conceptIds?.length ? paper.conceptIds : matchResearchConcepts(paper));
  const pmid = String(paper?.pmid || "");
  const pmcid = paper?.pmcid || null;
  const doi = paper?.doi || null;
  return {
    pmid,
    title: String(paper?.title || "제목 없음"),
    abstract: String(paper?.abstract || ""),
    journal: String(paper?.journal || ""),
    year: Number(paper?.year ?? paper?.pubYear ?? paper?.pub_year ?? paper?.publication_year) || null,
    authors: normalizeAuthors(paper?.authors),
    pmcid,
    doi,
    pubmedUrl: paper?.pubmedUrl || paper?.pubmed_url || (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null),
    fullTextUrl: paper?.fullTextUrl || paper?.full_text_url || null,
    accessLevel: paper?.accessLevel || paper?.access_level || (pmcid ? "pmc_full_text" : doi ? "publisher_link" : "abstract_only"),
    topicIds,
    conceptIds,
    summaryKo: paper?.summaryKo || null,
  };
}

export function buildResearchCorpus(papers = [], metadata = {}) {
  const normalized = papers.map(normalizeResearchPaper).filter((paper) => paper.pmid);
  const activeTopicIds = new Set(normalized.flatMap((paper) => paper.topicIds));
  const topics = RESEARCH_TOPICS.filter((topic) => activeTopicIds.has(topic.id))
    .map(({ terms: _terms, ...topic }) => topic);
  const years = normalized.map((paper) => paper.year).filter(Number.isFinite);
  return {
    generatedAt: metadata.generatedAt || new Date().toISOString(),
    source: metadata.source || { kind: "interest", projectId: "all" },
    totalPapers: Number(metadata.totalPapers ?? normalized.length),
    truncated: Boolean(metadata.truncated),
    yearRange: years.length ? [Math.min(...years), Math.max(...years)] : [],
    topics,
    papers: normalized,
  };
}

function similarity(left, right) {
  const leftTerms = new Set(researchWords(textOf(left)).slice(0, 180));
  const rightTerms = new Set(researchWords(textOf(right)).slice(0, 180));
  if (!leftTerms.size || !rightTerms.size) return 0;
  let overlap = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) overlap += 1;
  return overlap / Math.max(1, Math.min(leftTerms.size, rightTerms.size));
}

function sharedValues(left = [], right = []) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

export function retrieveResearchSubgraph(question, papers = [], { limit = 6 } = {}) {
  const normalizedQuestion = String(question || "").trim().toLowerCase();
  if (!normalizedQuestion) return [];
  const normalizedPapers = papers.map(normalizeResearchPaper);
  const queryWords = unique(researchWords(normalizedQuestion));
  const queryTopicIds = classifyResearchTopics({ title: normalizedQuestion, abstract: "" });
  const queryConceptIds = matchResearchConcepts({ title: normalizedQuestion, abstract: "" }, RESEARCH_CONCEPTS.length);
  const hasSpecificTopic = !queryTopicIds.includes("general-biomedicine");

  const direct = normalizedPapers.map((paper) => {
    const title = paper.title.toLowerCase();
    const abstract = paper.abstract.toLowerCase();
    const journal = paper.journal.toLowerCase();
    const sharedTopics = hasSpecificTopic ? sharedValues(paper.topicIds, queryTopicIds) : [];
    const sharedConcepts = sharedValues(paper.conceptIds, queryConceptIds);
    let score = sharedTopics.length * 7 + sharedConcepts.length * 6;
    for (const word of queryWords) {
      if (title.includes(word)) score += 4;
      if (abstract.includes(word)) score += 1.25;
      if (journal.includes(word)) score += 1.5;
    }
    if (normalizedQuestion.length > 4 && title.includes(normalizedQuestion)) score += 8;
    return { paper, score, matchType: "direct", sharedTopics, sharedConcepts, similarity: 0 };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || (right.paper.year || 0) - (left.paper.year || 0))
    .slice(0, Math.min(3, limit));

  if (!direct.length) return [];
  const selected = [...direct];
  const selectedPmids = new Set(selected.map((item) => item.paper.pmid));
  const neighbors = [];
  for (const anchor of direct) {
    for (const paper of normalizedPapers) {
      if (selectedPmids.has(paper.pmid) || paper.pmid === anchor.paper.pmid) continue;
      const sharedTopics = sharedValues(anchor.paper.topicIds, paper.topicIds);
      const sharedConcepts = sharedValues(anchor.paper.conceptIds, paper.conceptIds);
      const contentSimilarity = similarity(anchor.paper, paper);
      const score = sharedConcepts.length * 4 + sharedTopics.length * 1.5 + contentSimilarity * 8;
      if (score < 1.5) continue;
      neighbors.push({
        paper,
        score,
        matchType: "neighbor",
        anchorPmid: anchor.paper.pmid,
        sharedTopics,
        sharedConcepts,
        similarity: contentSimilarity,
      });
    }
  }

  neighbors.sort((left, right) => right.score - left.score || (right.paper.year || 0) - (left.paper.year || 0));
  for (const neighbor of neighbors) {
    if (selected.length >= limit) break;
    if (selectedPmids.has(neighbor.paper.pmid)) continue;
    selected.push(neighbor);
    selectedPmids.add(neighbor.paper.pmid);
  }
  return selected;
}

export function graphConnectionReason(item) {
  if (item.matchType === "direct") {
    if (item.sharedConcepts?.length) return "질문의 핵심 개념과 직접 연결";
    if (item.sharedTopics?.length) return "질문의 연구 주제와 직접 연결";
    return "제목·초록의 질의어와 직접 연결";
  }
  const reasons = [];
  if (item.sharedConcepts?.length) reasons.push("핵심 개념 공유");
  if (item.sharedTopics?.length) reasons.push("연구 주제 공유");
  if (item.similarity > 0) reasons.push(`내용 유사도 ${Math.max(1, Math.round(item.similarity * 100))}%`);
  return reasons.join(" · ") || "직접 근거 논문의 그래프 이웃";
}
