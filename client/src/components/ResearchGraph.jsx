import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";
import corpus from "../data/research-graph.json";

const ResearchGraph3D = lazy(() => import("./ResearchGraph3D.jsx"));

const GRAPH_WIDTH = 1400;
const GRAPH_HEIGHT = 860;
const DEFAULT_CAMERA = { x: 0, y: 0, width: GRAPH_WIDTH, height: GRAPH_HEIGHT };
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const topicTerms = {
  oncology: ["암", "종양", "항암", "바이오마커", "정밀의료", "cancer", "oncology", "tumor", "biomarker"],
  cardiovascular: ["심혈관", "심장", "혈압", "뇌졸중", "예방", "cardiovascular", "heart", "stroke", "prevention"],
  neuroscience: ["뇌", "신경", "치매", "알츠하이머", "파킨슨", "neuro", "brain", "dementia", "alzheimer"],
  metabolism: ["당뇨", "비만", "대사", "인슐린", "혈당", "diabetes", "obesity", "metabolic", "insulin"],
  "mental-health": ["정신건강", "우울", "불안", "스트레스", "디지털 치료", "mental", "depression", "anxiety", "stress"],
  "public-health": ["공중보건", "감염병", "역학", "유행", "감시", "public health", "infectious", "surveillance", "epidemiology"],
};

const stopwords = new Set([
  "about", "after", "among", "and", "are", "based", "between", "from", "into", "of", "for",
  "study", "the", "this", "through", "using", "with", "논문", "연구", "어떻게", "대한", "에서",
  "으로", "있는", "알려줘", "보여줘", "분석", "결과",
]);

const conceptCatalog = [
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

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function hashText(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function words(value) {
  return (String(value || "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{1,}/gu) || [])
    .filter((word) => !stopwords.has(word));
}

function normalizeLookup(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildGraph(data, layout) {
  const nodes = [];
  const edges = [];
  const paperIdentifiers = new Map(
    data.papers.map((paper, index) => [paper.pmid, `P${String(index + 1).padStart(3, "0")}`]),
  );
  const paperGroups = new Map(data.topics.map((topic) => [topic.id, []]));
  const centers = new Map();

  data.topics.forEach((topic, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / data.topics.length;
    const center = layout === "orbit"
      ? { x: 700 + Math.cos(angle) * 340, y: 420 + Math.sin(angle) * 265 }
      : { x: 350 + (index % 3) * 350, y: 250 + Math.floor(index / 3) * 350 };
    centers.set(topic.id, center);
    nodes.push({
      ...topic,
      id: `topic:${topic.id}`,
      type: "topic",
      x: center.x,
      y: center.y,
      count: 0,
    });
  });

  for (const paper of data.papers) {
    const topicId = paper.topicIds[0] || data.topics[0].id;
    paperGroups.get(topicId)?.push(paper);
  }

  for (const topic of data.topics) {
    const group = paperGroups.get(topic.id) || [];
    const center = centers.get(topic.id);
    const topicNode = nodes.find((node) => node.id === `topic:${topic.id}`);
    topicNode.count = group.length;
    group.forEach((paper, index) => {
      const seed = hashText(paper.pmid);
      const angle = index * GOLDEN_ANGLE + (seed % 31) / 31;
      const radius = 56 + Math.sqrt(index + 1) * (layout === "orbit" ? 25 : 29);
      const node = {
        id: `paper:${paper.pmid}`,
        identifier: paperIdentifiers.get(paper.pmid),
        type: "paper",
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius * 0.76,
        topicId: topic.id,
        color: topic.color,
        ...paper,
      };
      nodes.push(node);
      edges.push({
        id: `topic-paper:${topic.id}:${paper.pmid}`,
        source: `topic:${topic.id}`,
        target: node.id,
        type: "discusses",
      });
    });
  }

  const conceptMatches = new Map(conceptCatalog.map((concept) => [concept.id, []]));
  for (const paper of data.papers) {
    const text = `${paper.title} ${paper.abstract}`.toLowerCase();
    const matches = conceptCatalog
      .map((concept) => ({
        concept,
        score: concept.terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0),
      }))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 2);
    for (const match of matches) conceptMatches.get(match.concept.id).push({ paper, score: match.score });
  }

  const activeConcepts = conceptCatalog.filter((concept) => conceptMatches.get(concept.id).length > 0);
  activeConcepts.forEach((concept, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / activeConcepts.length;
    const radius = layout === "orbit" ? 455 : 185;
    nodes.push({
      ...concept,
      id: `concept:${concept.id}`,
      type: "concept",
      count: conceptMatches.get(concept.id).length,
      x: 700 + Math.cos(angle) * radius,
      y: 420 + Math.sin(angle) * radius * 0.72,
    });
  });

  for (const concept of activeConcepts) {
    for (const match of conceptMatches.get(concept.id)) {
      edges.push({
        id: `concept-paper:${concept.id}:${match.paper.pmid}`,
        source: `paper:${match.paper.pmid}`,
        target: `concept:${concept.id}`,
        type: "has-concept",
        weight: match.score,
      });
    }
  }

  const relatedPairs = new Set();
  for (const [, group] of paperGroups) {
    const prepared = group.map((paper) => ({
      paper,
      terms: new Set(words(`${paper.title} ${paper.abstract}`).slice(0, 120)),
    }));
    prepared.forEach((entry, index) => {
      let best = null;
      for (let offset = 1; offset < prepared.length; offset += 1) {
        const candidate = prepared[(index + offset) % prepared.length];
        let overlap = 0;
        for (const term of entry.terms) if (candidate.terms.has(term)) overlap += 1;
        const score = overlap / Math.max(1, Math.min(entry.terms.size, candidate.terms.size));
        if (!best || score > best.score) best = { paper: candidate.paper, score };
      }
      if (!best) return;
      const pair = [entry.paper.pmid, best.paper.pmid].sort().join(":");
      if (relatedPairs.has(pair)) return;
      relatedPairs.add(pair);
      edges.push({
        id: `related:${pair}`,
        source: `paper:${entry.paper.pmid}`,
        target: `paper:${best.paper.pmid}`,
        type: "related",
        weight: best.score,
      });
    });
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    node.originX = node.x;
    node.originY = node.y;
  }
  const neighbors = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    neighbors.get(edge.source)?.push(edge.target);
    neighbors.get(edge.target)?.push(edge.source);
  }
  return { nodes, edges, nodeById, neighbors };
}

function retrieve(question, graph) {
  const normalized = String(question || "").trim().toLowerCase();
  const queryWords = words(normalized);
  if (!normalized) return [];
  const matchedTopics = Object.entries(topicTerms)
    .filter(([, terms]) => terms.some((term) => normalized.includes(term)))
    .map(([topicId]) => topicId);

  return graph.nodes
    .filter((node) => node.type === "paper")
    .map((paper) => {
      const title = String(paper.title || "").toLowerCase();
      const abstract = String(paper.abstract || "").toLowerCase();
      const journal = String(paper.journal || "").toLowerCase();
      let score = matchedTopics.includes(paper.topicId) ? 8 : 0;
      for (const term of queryWords) {
        if (title.includes(term)) score += 4;
        if (abstract.includes(term)) score += 1.5;
        if (journal.includes(term)) score += 2;
      }
      if (paper.pmcid) score += 0.15;
      return { id: paper.id, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 10);
}

function nodeLabel(node) {
  if (!node) return "";
  if (node.type === "paper") return node.title;
  return node.label || node.journal || "";
}

function canvasNodeLabel(node) {
  if (node.type === "paper") return node.identifier;
  const label = nodeLabel(node);
  const limit = 24;
  return label.length > limit ? `${label.slice(0, limit)}…` : label;
}

function typeLabel(type) {
  return { paper: "논문", topic: "연구 주제", concept: "핵심 개념" }[type] || type;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function relationLabel(edge, graph) {
  const source = graph.nodeById.get(edge.source);
  const target = graph.nodeById.get(edge.target);
  if (edge.type === "related") {
    return `초록·제목 유사도 ${Math.max(1, Math.round((edge.weight || 0) * 100))}%`;
  }
  if (edge.type === "has-concept") {
    const concept = source?.type === "concept" ? source : target;
    return `${concept?.label || "핵심 개념"} · ${concept?.group || "내용 관계"}`;
  }
  const topic = source?.type === "topic" ? source : target;
  return `${topic?.label || "연구 주제"}를 다룸`;
}

function strongestRelationshipReason(node, graph, topics) {
  if (node?.type !== "paper") return "";
  const conceptNames = (graph.neighbors.get(node.id) || [])
    .map((id) => graph.nodeById.get(id))
    .filter((neighbor) => neighbor?.type === "concept")
    .slice(0, 2)
    .map((concept) => concept.label);
  if (conceptNames.length) return `핵심 개념: ${conceptNames.join(", ")}`;

  const relatedEdge = graph.edges
    .filter((edge) => edge.type === "related" && (edge.source === node.id || edge.target === node.id))
    .sort((left, right) => (right.weight || 0) - (left.weight || 0))[0];
  if (relatedEdge) return `유사 연구 연결 ${Math.max(1, Math.round((relatedEdge.weight || 0) * 100))}%`;

  return `${topics.find((topic) => topic.id === node.topicId)?.label || "의학 연구"} 분야`;
}

function shortestPath(graph, startId, endId) {
  if (!startId || !endId || startId === endId) return startId ? [startId] : [];
  const queue = [startId];
  const previous = new Map([[startId, null]]);
  while (queue.length) {
    const current = queue.shift();
    for (const neighbor of graph.neighbors.get(current) || []) {
      if (previous.has(neighbor)) continue;
      previous.set(neighbor, current);
      if (neighbor === endId) {
        const path = [endId];
        let cursor = current;
        while (cursor) {
          path.unshift(cursor);
          cursor = previous.get(cursor);
        }
        return path;
      }
      queue.push(neighbor);
    }
  }
  return [];
}

function abstractSentences(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((sentence) => sentence.replace(/^(BACKGROUND|OBJECTIVE|OBJECTIVES|AIM|AIMS|PURPOSE|METHODS?|RESULTS?|CONCLUSIONS?):\s*/i, "").trim())
    .filter((sentence) => sentence.length > 35);
}

function sentenceMatching(sentences, terms) {
  return sentences.find((sentence) => terms.some((term) => sentence.toLowerCase().includes(term))) || "";
}

function abstractSection(value, labels) {
  const boundaries = [
    "BACKGROUND", "INTRODUCTION", "OBJECTIVE", "OBJECTIVES", "AIM", "AIMS", "PURPOSE",
    "METHOD", "METHODS", "DESIGN", "RESULT", "RESULTS", "FINDINGS", "DISCUSSION",
    "CONCLUSION", "CONCLUSIONS",
  ];
  const pattern = new RegExp(
    `(?:^|\\s)(?:${labels.join("|")}):\\s*([\\s\\S]*?)(?=\\s(?:${boundaries.join("|")}):|$)`,
    "i",
  );
  const section = String(value || "").match(pattern)?.[1]?.replace(/\s+/g, " ").trim() || "";
  if (!section) return "";
  return section.length > 420 ? `${section.slice(0, 417).trim()}…` : section;
}

function paperBrief(paper, graph, topics) {
  if (!paper) return null;
  const sentences = abstractSentences(paper.abstract);
  const concepts = (graph.neighbors.get(paper.id) || [])
    .map((id) => graph.nodeById.get(id))
    .filter((node) => node?.type === "concept");
  const topic = topics.find((item) => item.id === paper.topicId);
  const conceptNames = concepts.slice(0, 2).map((concept) => concept.label);
  const focus = conceptNames.length ? conceptNames.join("과 ") : topic?.label || "의학 연구";
  if (paper.summaryKo) {
    return {
      oneLine: paper.summaryKo.oneLine,
      purpose: paper.summaryKo.purpose,
      method: paper.summaryKo.method,
      result: paper.summaryKo.result,
      concepts,
    };
  }
  const purpose = abstractSection(paper.abstract, ["OBJECTIVE", "OBJECTIVES", "AIM", "AIMS", "PURPOSE"])
    || sentenceMatching(sentences, ["aim", "objective", "purpose", "investigat", "evaluat", "explor"])
    || sentences[0]
    || "초록 발췌에서 연구 목적을 확인할 수 없습니다.";
  const method = abstractSection(paper.abstract, ["METHOD", "METHODS", "DESIGN"])
    || sentenceMatching(sentences, [
    "method", "participant", "random", "cohort", "interview", "cross-sectional",
    "retrospective", "prospective", "analysis", "model",
  ]) || "초록 발췌에서 구체적인 연구 방법을 확인할 수 없습니다.";
  const result = abstractSection(paper.abstract, ["RESULT", "RESULTS", "FINDINGS", "CONCLUSION", "CONCLUSIONS"])
    || sentenceMatching(sentences, [
    "result", "found", "showed", "demonstrat", "associated", "conclusion", "suggest",
  ]) || "현재 저장된 초록 발췌에는 주요 결과가 포함되지 않았습니다.";

  return {
    oneLine: `${topic?.label || "의학"} 분야에서 ${focus}를 다룬 연구입니다.`,
    purpose,
    method,
    result,
    concepts,
  };
}

export default function ResearchGraph({ standalone = false, displayName = "" }) {
  const [layout, setLayout] = useState("orbit");
  const [activeTopic, setActiveTopic] = useState("all");
  const [lens, setLens] = useState("all");
  const [query, setQuery] = useState("");
  const [paperLookupQuery, setPaperLookupQuery] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [hoverPoint, setHoverPoint] = useState(null);
  const [graphMode, setGraphMode] = useState("2d");
  const [cameraResetToken, setCameraResetToken] = useState(0);
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [camera, setCamera] = useState(DEFAULT_CAMERA);
  const [focusDepth, setFocusDepth] = useState(1);
  const [pathAnchorId, setPathAnchorId] = useState(null);
  const [motionPaused, setMotionPaused] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false,
  );
  const panRef = useRef(null);
  const dragRef = useRef(null);
  const draggedRef = useRef(false);
  const simulationRef = useRef(null);
  const animationFrameRef = useRef(null);
  const svgRef = useRef(null);
  const nodeElementRefs = useRef(new Map());
  const edgeElementRefs = useRef(new Map());
  const graph = useMemo(() => buildGraph(corpus, layout), [layout]);
  const paperLookupResults = useMemo(() => {
    const queryValue = normalizeLookup(paperLookupQuery);
    if (!queryValue) return [];
    const compactQuery = queryValue.replace(/\s/g, "");
    return graph.nodes
      .filter((node) => node.type === "paper")
      .map((paper) => {
        const identifier = normalizeLookup(paper.identifier);
        const pmid = normalizeLookup(paper.pmid);
        const title = normalizeLookup(paper.title);
        const authors = normalizeLookup((paper.authors || []).join(" "));
        const journal = normalizeLookup(paper.journal);
        let score = 0;
        if (identifier === compactQuery || pmid === compactQuery) score = 120;
        else if (identifier.startsWith(compactQuery) || pmid.startsWith(compactQuery)) score = 90;
        else if (title.startsWith(queryValue)) score = 75;
        else if (title.includes(queryValue)) score = 60;
        else if (authors.includes(queryValue)) score = 40;
        else if (journal.includes(queryValue)) score = 25;
        return { paper, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || (right.paper.year || 0) - (left.paper.year || 0))
      .slice(0, 8);
  }, [graph.nodes, paperLookupQuery]);

  const syncGraphDom = () => {
    for (const node of graph.nodes) {
      nodeElementRefs.current.get(node.id)?.setAttribute("transform", `translate(${node.x} ${node.y})`);
    }
    for (const edge of graph.edges) {
      const element = edgeElementRefs.current.get(edge.id);
      const source = graph.nodeById.get(edge.source);
      const target = graph.nodeById.get(edge.target);
      if (!element || !source || !target) continue;
      element.setAttribute("x1", source.x);
      element.setAttribute("y1", source.y);
      element.setAttribute("x2", target.x);
      element.setAttribute("y2", target.y);
    }
  };

  useEffect(() => {
    if (motionPaused || graphMode === "3d") {
      simulationRef.current?.stop();
      return undefined;
    }

    const linkData = graph.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
    }));
    const simulation = forceSimulation(graph.nodes)
      .alpha(0.92)
      .alphaDecay(0.018)
      .alphaTarget(0)
      .velocityDecay(0.32)
      .force("center", forceCenter(GRAPH_WIDTH / 2, GRAPH_HEIGHT / 2).strength(0.025))
      .force("charge", forceManyBody().strength((node) => (
        node.type === "topic" ? -320 : node.type === "concept" ? -105 : -34
      )).distanceMax(230))
      .force("collision", forceCollide().radius((node) => (
        node.type === "topic" ? 38 : node.type === "concept" ? 22 : 8
      )).strength(0.88).iterations(2))
      .force("link", forceLink(linkData)
        .id((node) => node.id)
        .distance((edge) => edge.type === "related" ? 54 : edge.type === "has-concept" ? 96 : 82)
        .strength((edge) => edge.type === "related" ? 0.13 : edge.type === "has-concept" ? 0.075 : 0.09))
      .force("home-x", forceX((node) => node.originX).strength((node) => node.type === "topic" ? 0.055 : 0.012))
      .force("home-y", forceY((node) => node.originY).strength((node) => node.type === "topic" ? 0.055 : 0.012));

    simulation.on("tick", () => {
      for (const node of graph.nodes) {
        if (node.fx == null) {
          node.x = clamp(node.x, 75, GRAPH_WIDTH - 75);
          node.y = clamp(node.y, 55, GRAPH_HEIGHT - 55);
        }
      }
      if (!animationFrameRef.current) {
        animationFrameRef.current = window.requestAnimationFrame(() => {
          animationFrameRef.current = null;
          syncGraphDom();
        });
      }
    });
    simulationRef.current = simulation;

    return () => {
      simulation.stop();
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (simulationRef.current === simulation) simulationRef.current = null;
    };
  }, [graph, graphMode, motionPaused]);
  const resultIds = useMemo(() => new Set(results.map((item) => item.id)), [results]);
  const paperLookupResultIds = useMemo(
    () => new Set(paperLookupResults.map((entry) => entry.paper.id)),
    [paperLookupResults],
  );
  const visualResultIds = useMemo(
    () => new Set([...resultIds, ...paperLookupResultIds]),
    [paperLookupResultIds, resultIds],
  );
  const labeledResultIds = useMemo(
    () => new Set([
      ...results.slice(0, 3).map((item) => item.id),
      ...paperLookupResults.slice(0, 3).map((entry) => entry.paper.id),
    ]),
    [paperLookupResults, results],
  );
  const evidenceIds = useMemo(() => {
    const ids = new Set(resultIds);
    for (const result of results) {
      const node = graph.nodeById.get(result.id);
      if (!node) continue;
      ids.add(`topic:${node.topicId}`);
      for (const neighborId of graph.neighbors.get(result.id) || []) {
        ids.add(neighborId);
      }
    }
    return ids;
  }, [graph, resultIds, results]);
  const selected = selectedId ? graph.nodeById.get(selectedId) : null;
  const hoveredPaper = hoveredId ? graph.nodeById.get(hoveredId) : null;
  const selectedNeighbors = selected
    ? (graph.neighbors.get(selected.id) || []).map((id) => graph.nodeById.get(id)).filter(Boolean)
    : [];
  const selectedBrief = useMemo(
    () => selected?.type === "paper" ? paperBrief(selected, graph, corpus.topics) : null,
    [graph, selected],
  );
  const relatedPaperDetails = useMemo(() => {
    if (selected?.type !== "paper") return [];
    const selectedConcepts = new Set(
      (graph.neighbors.get(selected.id) || [])
        .filter((id) => graph.nodeById.get(id)?.type === "concept"),
    );
    const candidates = new Map();

    for (const conceptId of selectedConcepts) {
      for (const neighborId of graph.neighbors.get(conceptId) || []) {
        const paper = graph.nodeById.get(neighborId);
        if (paper?.type !== "paper" || paper.id === selected.id) continue;
        const entry = candidates.get(paper.id) || { paper, concepts: [], similarity: 0 };
        entry.concepts.push(graph.nodeById.get(conceptId)?.label);
        candidates.set(paper.id, entry);
      }
    }

    for (const edge of graph.edges) {
      if (edge.type !== "related" || (edge.source !== selected.id && edge.target !== selected.id)) continue;
      const paperId = edge.source === selected.id ? edge.target : edge.source;
      const paper = graph.nodeById.get(paperId);
      if (!paper) continue;
      const entry = candidates.get(paper.id) || { paper, concepts: [], similarity: 0 };
      entry.similarity = Math.round((edge.weight || 0) * 100);
      candidates.set(paper.id, entry);
    }

    return [...candidates.values()]
      .map((entry) => ({
        ...entry,
        sameTopic: entry.paper.topicId === selected.topicId,
        score: entry.concepts.length * 3 + entry.similarity / 20 + (entry.paper.topicId === selected.topicId ? 2 : 0),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);
  }, [graph, selected]);
  const graphInsight = useMemo(() => {
    const papers = results
      .map((result) => graph.nodeById.get(result.id))
      .filter(Boolean);
    const sourcePapers = papers.length
      ? papers
      : graph.nodes.filter((node) => node.type === "paper");
    const topicCounts = new Map();
    const conceptCounts = new Map();
    for (const paper of sourcePapers) {
      topicCounts.set(paper.topicId, (topicCounts.get(paper.topicId) || 0) + 1);
      for (const neighborId of graph.neighbors.get(paper.id) || []) {
        const neighbor = graph.nodeById.get(neighborId);
        if (neighbor?.type === "concept") {
          conceptCounts.set(neighbor.id, (conceptCounts.get(neighbor.id) || 0) + 1);
        }
      }
    }
    const leadingTopic = [...topicCounts.entries()].sort((left, right) => right[1] - left[1])[0];
    const leadingConcepts = [...conceptCounts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([id, count]) => ({ node: graph.nodeById.get(id), count }));
    const fullTextCount = sourcePapers.filter((paper) => paper.pmcid).length;
    return {
      paperCount: sourcePapers.length,
      topic: corpus.topics.find((item) => item.id === leadingTopic?.[0]),
      topicCount: leadingTopic?.[1] || 0,
      concepts: leadingConcepts,
      fullTextCount,
    };
  }, [graph, results]);
  const activeFocusId = hoveredId || selectedId;
  const focusedIds = useMemo(() => {
    if (!activeFocusId) return new Set();
    const ids = new Set([activeFocusId]);
    let frontier = [activeFocusId];
    const depth = hoveredId ? 1 : focusDepth;
    for (let level = 0; level < depth; level += 1) {
      const next = [];
      for (const id of frontier) {
        for (const neighbor of graph.neighbors.get(id) || []) {
          if (!ids.has(neighbor)) next.push(neighbor);
          ids.add(neighbor);
        }
      }
      frontier = next;
    }
    return ids;
  }, [activeFocusId, focusDepth, graph, hoveredId]);
  const comparisonPath = useMemo(
    () => shortestPath(graph, pathAnchorId, selectedId),
    [graph, pathAnchorId, selectedId],
  );
  const comparisonIds = useMemo(() => new Set(comparisonPath), [comparisonPath]);
  const comparisonEdgeIds = useMemo(() => {
    const ids = new Set();
    for (let index = 0; index < comparisonPath.length - 1; index += 1) {
      const left = comparisonPath[index];
      const right = comparisonPath[index + 1];
      const edge = graph.edges.find((candidate) =>
        (candidate.source === left && candidate.target === right)
        || (candidate.source === right && candidate.target === left));
      if (edge) ids.add(edge.id);
    }
    return ids;
  }, [comparisonPath, graph.edges]);

  const visibleIds = useMemo(() => {
    const ids = new Set();
    for (const node of graph.nodes) {
      const topicMatches = activeTopic === "all"
        || node.id === `topic:${activeTopic}`
        || node.topicId === activeTopic
        || (node.type === "concept" && (graph.neighbors.get(node.id) || [])
          .some((id) => graph.nodeById.get(id)?.topicId === activeTopic));
      const lensMatches = lens === "all"
        || (lens === "papers" && node.type !== "concept")
        || (lens === "open" && (node.type !== "paper" || Boolean(node.pmcid)))
        || (lens === "evidence" && evidenceIds.has(node.id));
      if (topicMatches && lensMatches) ids.add(node.id);
    }
    return ids;
  }, [activeTopic, evidenceIds, graph, lens]);

  const visibleEdges = useMemo(
    () => graph.edges.filter((edge) =>
      visibleIds.has(edge.source)
      && visibleIds.has(edge.target)
      && (lens !== "evidence" || evidenceIds.has(edge.source) || evidenceIds.has(edge.target))),
    [evidenceIds, graph.edges, lens, visibleIds],
  );
  const focusedEdgeIds = useMemo(() => new Set(
    graph.edges
      .filter((edge) => focusedIds.has(edge.source) && focusedIds.has(edge.target))
      .map((edge) => edge.id),
  ), [focusedIds, graph.edges]);
  const positionFor = (node) => node;

  const energizeNeighborhood = (nodeId, strength = 0.018) => {
    const center = graph.nodeById.get(nodeId);
    const simulation = simulationRef.current;
    if (!center || !simulation || motionPaused) return;
    for (const neighborId of graph.neighbors.get(nodeId) || []) {
      const neighbor = graph.nodeById.get(neighborId);
      if (!neighbor || neighbor.fx != null) continue;
      neighbor.vx += (center.x - neighbor.x) * strength;
      neighbor.vy += (center.y - neighbor.y) * strength;
    }
    simulation.alpha(Math.max(simulation.alpha(), 0.16)).restart();
  };

  const focusCameraOn = (nodeId, width = 760) => {
    const node = graph.nodeById.get(nodeId);
    if (!node) return;
    const position = positionFor(node);
    const nextWidth = clamp(width, 420, GRAPH_WIDTH);
    const nextHeight = nextWidth * (GRAPH_HEIGHT / GRAPH_WIDTH);
    setCamera({
      x: position.x - nextWidth / 2,
      y: position.y - nextHeight / 2,
      width: nextWidth,
      height: nextHeight,
    });
  };

  const selectNode = (nodeId) => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    setSelectedId(nodeId);
    setFocusDepth(1);
    energizeNeighborhood(nodeId);
    focusCameraOn(nodeId);
  };

  const submitQuery = (event, nextQuery = query) => {
    event?.preventDefault();
    const value = String(nextQuery || "").trim();
    if (!value) return;
    const retrieved = retrieve(value, graph);
    setQuery(value);
    setLastQuery(value);
    setResults(retrieved);
    setLens("evidence");
    if (retrieved[0]) {
      for (const [index, item] of retrieved.entries()) {
        const node = graph.nodeById.get(item.id);
        if (!node || node.fx != null) continue;
        const angle = (Math.PI * 2 * index) / retrieved.length;
        const targetX = GRAPH_WIDTH / 2 + Math.cos(angle) * 145;
        const targetY = GRAPH_HEIGHT / 2 + Math.sin(angle) * 105;
        node.vx += (targetX - node.x) * 0.045;
        node.vy += (targetY - node.y) * 0.045;
      }
      simulationRef.current?.alpha(0.52).restart();
      setSelectedId(retrieved[0].id);
      setFocusDepth(2);
      focusCameraOn(retrieved[0].id, 880);
    }
  };

  const clearGraphSearch = () => {
    setQuery("");
    setLastQuery("");
    setResults([]);
    setLens((current) => current === "evidence" ? "all" : current);
    setSelectedId(null);
    setHoveredId(null);
    setHoverPoint(null);
    setPathAnchorId(null);
    setFocusDepth(1);
    setCamera(DEFAULT_CAMERA);
    setCameraResetToken((current) => current + 1);
  };

  const resetGraph = () => {
    setActiveTopic("all");
    setLens("all");
    setQuery("");
    setPaperLookupQuery("");
    setLastQuery("");
    setResults([]);
    setSelectedId(null);
    setPathAnchorId(null);
    setFocusDepth(1);
    for (const node of graph.nodes) {
      node.fx = null;
      node.fy = null;
      node.x = node.originX;
      node.y = node.originY;
      node.vx = 0;
      node.vy = 0;
    }
    simulationRef.current?.alpha(0.9).restart();
    setCamera(DEFAULT_CAMERA);
  };

  const zoom = (factor) => {
    setCamera((current) => {
      const width = clamp(current.width * factor, 420, GRAPH_WIDTH * 1.4);
      const height = width * (GRAPH_HEIGHT / GRAPH_WIDTH);
      return {
        x: current.x + (current.width - width) / 2,
        y: current.y + (current.height - height) / 2,
        width,
        height,
      };
    });
  };

  const handleWheel = (event) => {
    event.preventDefault();
    zoom(event.deltaY > 0 ? 1.12 : 0.88);
  };

  const startPan = (event) => {
    if (event.target.closest?.("[data-graph-node]")) return;
    panRef.current = { x: event.clientX, y: event.clientY, camera };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePan = (event) => {
    if (!panRef.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = panRef.current.camera.width / rect.width;
    const scaleY = panRef.current.camera.height / rect.height;
    setCamera({
      ...panRef.current.camera,
      x: panRef.current.camera.x - (event.clientX - panRef.current.x) * scaleX,
      y: panRef.current.camera.y - (event.clientY - panRef.current.y) * scaleY,
    });
  };

  const stopPan = () => {
    panRef.current = null;
  };

  const startNodeDrag = (event, node) => {
    event.stopPropagation();
    const position = positionFor(node);
    dragRef.current = {
      id: node.id,
      clientX: event.clientX,
      clientY: event.clientY,
      x: position.x,
      y: position.y,
    };
    node.fx = position.x;
    node.fy = position.y;
    simulationRef.current?.alphaTarget(0.14).restart();
    draggedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveNodeDrag = (event) => {
    if (!dragRef.current || !svgRef.current) return;
    event.stopPropagation();
    const rect = svgRef.current.getBoundingClientRect();
    const dx = (event.clientX - dragRef.current.clientX) * (camera.width / rect.width);
    const dy = (event.clientY - dragRef.current.clientY) * (camera.height / rect.height);
    const pointerDistance = Math.hypot(
      event.clientX - dragRef.current.clientX,
      event.clientY - dragRef.current.clientY,
    );
    if (pointerDistance > 8) draggedRef.current = true;
    const node = graph.nodeById.get(dragRef.current.id);
    if (!node) return;
    node.fx = dragRef.current.x + dx;
    node.fy = dragRef.current.y + dy;
    node.x = node.fx;
    node.y = node.fy;
    syncGraphDom();
  };

  const stopNodeDrag = (event) => {
    event.stopPropagation();
    const node = dragRef.current ? graph.nodeById.get(dragRef.current.id) : null;
    if (node) {
      node.fx = null;
      node.fy = null;
    }
    dragRef.current = null;
    const simulation = simulationRef.current;
    if (simulation && !motionPaused) {
      simulation.alphaTarget(0.04).restart();
      window.setTimeout(() => {
        if (simulationRef.current === simulation) simulation.alphaTarget(0);
      }, 650);
    }
  };

  const activateComparison = () => {
    if (!selectedId) return;
    setPathAnchorId((current) => current === selectedId ? null : selectedId);
  };

  const returnToDashboard = () => {
    window.close();
    window.setTimeout(() => {
      if (!window.closed) window.location.assign(`/${window.location.search}`);
    }, 80);
  };

  const nodeVisibleLabel = (node) =>
    labelsVisible
    && (node.type !== "paper" || node.id === selectedId || node.id === hoveredId || labeledResultIds.has(node.id));

  return (
    <section id="graph" className={`graph-page ${standalone ? "is-standalone" : ""} ${graphMode === "3d" ? "is-3d" : "is-2d"}`}>
      <header className="graph-page-header">
        <div className="graph-page-brand">
          <button type="button" onClick={returnToDashboard} aria-label="대시보드로 돌아가기">←</button>
          <span className="graph-brand-mark">✦</span>
          <div>
            <p>RESEARCH KNOWLEDGE GRAPH</p>
            <h1>Research Galaxy</h1>
          </div>
        </div>
        <div className="graph-page-meta">
          <div className="graph-corpus-summary">
            <span><strong>{corpus.papers.length}</strong> 논문</span>
            <span><strong>{graph.nodes.length}</strong> 노드</span>
            <span><strong>{graph.edges.length}</strong> 관계</span>
          </div>
          <div className="graph-view-toggle" aria-label="그래프 표시 방식">
            <button
              type="button"
              className={graphMode === "2d" ? "is-active" : ""}
              onClick={() => setGraphMode("2d")}
            >
              2D
            </button>
            <button
              type="button"
              className={graphMode === "3d" ? "is-active" : ""}
              onClick={() => {
                setGraphMode("3d");
                setHoverPoint(null);
              }}
            >
              3D
            </button>
          </div>
          {displayName && <span className="graph-user">{displayName}</span>}
        </div>
      </header>

      <div className={`knowledge-graph-shell ${selected ? "has-detail" : ""}`}>
        <aside className="graph-control-panel">
          <div className="graph-control-brand">
            <span className="graph-brand-mark">✦</span>
            <div><small>RESEARCH MAP</small><strong>Knowledge Explorer</strong></div>
          </div>

          <div className="graph-paper-lookup">
            <div className="graph-paper-lookup-heading">
              <span>논문 노드 찾기</span>
              {paperLookupQuery && (
                <button
                  type="button"
                  onClick={() => setPaperLookupQuery("")}
                  aria-label="논문 노드 검색 초기화"
                >
                  초기화
                </button>
              )}
            </div>
            <div className="graph-paper-lookup-input">
              <span aria-hidden="true">⌕</span>
              <input
                value={paperLookupQuery}
                onChange={(event) => setPaperLookupQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && paperLookupResults[0]) {
                    event.preventDefault();
                    selectNode(paperLookupResults[0].paper.id);
                  }
                  if (event.key === "Escape") setPaperLookupQuery("");
                }}
                placeholder="P099, PMID, 제목, 저자, 저널"
                aria-label="논문 노드 찾기"
              />
            </div>
            {paperLookupQuery && (
              <div className="graph-paper-lookup-results">
                {paperLookupResults.length ? paperLookupResults.map(({ paper }) => (
                  <button
                    type="button"
                    key={paper.id}
                    className={selectedId === paper.id ? "is-selected" : ""}
                    onClick={() => selectNode(paper.id)}
                  >
                    <span>{paper.identifier}</span>
                    <strong>{paper.title}</strong>
                    <small>{paper.year || "연도 미상"} · PMID {paper.pmid}</small>
                  </button>
                )) : (
                  <p>일치하는 논문 노드가 없습니다.</p>
                )}
              </div>
            )}
          </div>

          <div className="graph-explore-card">
            {results.length ? (
              <>
                <div className="graph-result-heading">
                  <span className="graph-control-label">검색 결과</span>
                  <button type="button" onClick={clearGraphSearch}>검색 초기화</button>
                </div>
                <strong>관련 논문 {results.length}편을 찾았습니다</strong>
                <p>
                  {graphInsight.topic?.label || "여러 연구 분야"}가 중심이며,
                  {graphInsight.concepts.length
                    ? ` ${graphInsight.concepts.map((item) => item.node?.label).filter(Boolean).join(", ")} 개념이 반복됩니다.`
                    : " 반복되는 핵심 개념을 탐색하고 있습니다."}
                </p>
                <div className="graph-result-list">
                  {results.map((result, index) => {
                    const paper = graph.nodeById.get(result.id);
                    return (
                      <button type="button" key={result.id} onClick={() => selectNode(result.id)}>
                        <span>{paper?.identifier || index + 1}</span>
                        <strong>{paper?.title}</strong>
                        <small>{paper?.year} · 관련도 {Math.round(result.score * 10) / 10}</small>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <span className="graph-control-label">탐색 시작</span>
                <strong>어떤 연구가 궁금한가요?</strong>
                <p>질문하거나 연구 분야를 선택하면 관련 논문과 연결 이유만 펼쳐집니다.</p>
                <div className="graph-start-topics">
                  {corpus.topics.map((topic) => (
                    <button
                      type="button"
                      key={topic.id}
                      style={{ "--topic-color": topic.color }}
                      onClick={() => {
                        setActiveTopic(topic.id);
                        setLens("papers");
                      }}
                    >
                      <i />{topic.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <details className="graph-advanced-controls">
            <summary>그래프 설정</summary>
            <div className="graph-control-section">
              <span className="graph-control-label">표시 방식</span>
              <div className="graph-lens-grid">
                {[
                  ["all", "전체"],
                  ["papers", "논문 중심"],
                  ["open", "전문 가능"],
                  ["evidence", "근거 경로"],
                ].map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    className={lens === value ? "is-active" : ""}
                    disabled={value === "evidence" && !results.length}
                    onClick={() => setLens(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="graph-control-section graph-topic-section">
              <span className="graph-control-label">연구 주제</span>
              <button
                className={`graph-topic-filter ${activeTopic === "all" ? "is-active" : ""}`}
                type="button"
                onClick={() => setActiveTopic("all")}
              >
                <span className="graph-topic-dot is-all" />
                <span>전체 분야</span>
                <strong>{corpus.papers.length}</strong>
              </button>
              {corpus.topics.map((topic) => {
                const count = corpus.papers.filter((paper) => paper.topicIds.includes(topic.id)).length;
                return (
                  <button
                    className={`graph-topic-filter ${activeTopic === topic.id ? "is-active" : ""}`}
                    type="button"
                    key={topic.id}
                    onClick={() => setActiveTopic(topic.id)}
                  >
                    <span className="graph-topic-dot" style={{ "--topic-color": topic.color }} />
                    <span>{topic.label}</span>
                    <strong>{count}</strong>
                  </button>
                );
              })}
            </div>

            <div className="graph-control-section">
              <span className="graph-control-label">노드 유형</span>
              <div className="graph-legend">
                <span><i className="is-paper" />논문 <b>{corpus.papers.length}</b></span>
                <span><i className="is-topic" />연구 주제 <b>{corpus.topics.length}</b></span>
                <span><i className="is-concept" />핵심 개념 <b>{graph.nodes.filter((node) => node.type === "concept").length}</b></span>
              </div>
            </div>

            <div className="graph-control-section">
              <span className="graph-control-label">배치</span>
              <div className="graph-layout-buttons">
                <button type="button" className={layout === "orbit" ? "is-active" : ""} onClick={() => setLayout("orbit")}>은하</button>
                <button type="button" className={layout === "clusters" ? "is-active" : ""} onClick={() => setLayout("clusters")}>클러스터</button>
              </div>
            </div>
          </details>

          <div className="graph-corpus-note">
            <span>DATASET</span>
            <p>PubMed 논문 {corpus.papers.length}편의 주제·핵심 개념·내용 유사도를 연결했습니다.</p>
            <small>{formatDate(corpus.generatedAt)} 업데이트</small>
          </div>
        </aside>

        <div className="graph-stage">
          <form className="graph-query-bar" onSubmit={submitQuery}>
            <span className="graph-query-icon">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Graph RAG에 질문해보세요 · 예: 암 바이오마커 관련 연구"
              aria-label="Graph RAG 질문"
            />
            <button type="submit">근거 경로 찾기 <span>→</span></button>
          </form>

          <div className="graph-suggestion-row">
            {["암 바이오마커 연구", "디지털 정신건강 중재", "당뇨 예방과 생활습관"].map((suggestion) => (
              <button type="button" key={suggestion} onClick={(event) => submitQuery(event, suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>

          <div className="graph-canvas-wrap">
            <svg
              ref={svgRef}
              className={`research-graph-canvas ${graphMode === "3d" ? "is-hidden" : ""}`}
              viewBox={`${camera.x} ${camera.y} ${camera.width} ${camera.height}`}
              preserveAspectRatio="xMidYMid slice"
              role="img"
              aria-label="PubMed 논문 지식 그래프"
              onWheel={handleWheel}
              onPointerDown={startPan}
              onPointerMove={movePan}
              onPointerUp={stopPan}
              onPointerCancel={stopPan}
              onClick={(event) => {
                if (!event.target.closest?.("[data-graph-node]") && !panRef.current) {
                  setSelectedId(null);
                }
              }}
            >
              <defs>
                <radialGradient id="graph-space" cx="50%" cy="45%" r="70%">
                  <stop offset="0%" stopColor="#1e1b38" />
                  <stop offset="55%" stopColor="#11101f" />
                  <stop offset="100%" stopColor="#090a11" />
                </radialGradient>
                <filter id="node-glow" x="-250%" y="-250%" width="500%" height="500%">
                  <feGaussianBlur stdDeviation="5" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <filter id="result-glow" x="-300%" y="-300%" width="600%" height="600%">
                  <feGaussianBlur stdDeviation="10" result="blur" />
                  <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="url(#graph-space)" />
              <g className="graph-stars" aria-hidden="true">
                {Array.from({ length: 80 }, (_, index) => {
                  const seed = hashText(`star-${index}`);
                  return <circle key={index} cx={seed % GRAPH_WIDTH} cy={(seed * 17) % GRAPH_HEIGHT} r={(seed % 13) / 16 + 0.35} />;
                })}
              </g>
              <g className="graph-edges">
                {visibleEdges.map((edge) => {
                  const source = graph.nodeById.get(edge.source);
                  const target = graph.nodeById.get(edge.target);
                  const sourcePosition = positionFor(source);
                  const targetPosition = positionFor(target);
                  const isEvidence = evidenceIds.has(edge.source) && evidenceIds.has(edge.target) && results.length;
                  const isFocused = focusedEdgeIds.has(edge.id);
                  const isComparison = comparisonEdgeIds.has(edge.id);
                  const isDimmed = (activeFocusId && !isFocused) || (comparisonPath.length > 1 && !isComparison);
                  return (
                    <line
                      key={edge.id}
                      ref={(element) => {
                        if (element) edgeElementRefs.current.set(edge.id, element);
                        else edgeElementRefs.current.delete(edge.id);
                      }}
                      x1={sourcePosition.x}
                      y1={sourcePosition.y}
                      x2={targetPosition.x}
                      y2={targetPosition.y}
                      className={`${edge.type} ${isEvidence ? "is-evidence" : ""} ${isFocused ? "is-focused" : ""} ${isComparison ? "is-comparison" : ""} ${isDimmed ? "is-dimmed" : ""}`}
                    >
                      <title>{relationLabel(edge, graph)}</title>
                    </line>
                  );
                })}
              </g>
              <g className="graph-nodes">
                {graph.nodes.filter((node) => visibleIds.has(node.id)).map((node) => {
                  const isSelected = node.id === selectedId;
                  const isResult = visualResultIds.has(node.id);
                  const isEvidence = evidenceIds.has(node.id) && results.length;
                  const isFocused = focusedIds.has(node.id);
                  const isComparison = comparisonIds.has(node.id);
                  const isDimmed = (activeFocusId && !isFocused) || (comparisonPath.length > 1 && !isComparison);
                  const position = positionFor(node);
                  const labelOnLeft = position.x > GRAPH_WIDTH * (selected ? 0.55 : 0.7);
                  const radius = node.type === "topic" ? 13 : node.type === "concept" ? 8 : isResult ? 6 : 3.8;
                  return (
                    <g
                      data-graph-node
                      ref={(element) => {
                        if (element) nodeElementRefs.current.set(node.id, element);
                        else nodeElementRefs.current.delete(node.id);
                      }}
                      role="button"
                      tabIndex="0"
                      aria-label={`${typeLabel(node.type)} ${nodeLabel(node)}`}
                      key={node.id}
                      className={`graph-node is-${node.type} ${isSelected ? "is-selected" : ""} ${isResult ? "is-result" : ""} ${isEvidence ? "is-evidence" : ""} ${isFocused ? "is-focused" : ""} ${isComparison ? "is-comparison" : ""} ${isDimmed ? "is-dimmed" : ""}`}
                      transform={`translate(${position.x} ${position.y})`}
                      onMouseEnter={(event) => {
                        setHoveredId(node.id);
                        if (node.type === "paper") {
                          const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
                          if (rect) {
                            setHoverPoint({
                              id: node.id,
                              x: ((event.clientX - rect.left) / rect.width) * 100,
                              y: ((event.clientY - rect.top) / rect.height) * 100,
                            });
                          }
                        }
                        energizeNeighborhood(node.id, 0.01);
                      }}
                      onMouseLeave={() => {
                        setHoveredId(null);
                        setHoverPoint(null);
                      }}
                      onPointerDown={(event) => startNodeDrag(event, node)}
                      onPointerMove={moveNodeDrag}
                      onPointerUp={stopNodeDrag}
                      onPointerCancel={stopNodeDrag}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        setSelectedId(node.id);
                        setFocusDepth((depth) => depth === 1 ? 2 : 1);
                        energizeNeighborhood(node.id, 0.035);
                        focusCameraOn(node.id, focusDepth === 1 ? 920 : 700);
                      }}
                      onClick={() => selectNode(node.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") selectNode(node.id);
                      }}
                    >
                      <circle
                        className="graph-node-hitarea"
                        r={Math.max(radius + 7, 12)}
                      />
                      {(node.type === "topic" || isResult || isSelected) && (
                        <circle className="graph-node-halo" r={radius * 2.9} fill={node.color || "#8b7cf6"} />
                      )}
                      <circle
                        className="graph-node-core"
                        r={radius}
                        fill={node.color || "#8b7cf6"}
                        filter={isResult || isSelected ? "url(#result-glow)" : node.type !== "paper" ? "url(#node-glow)" : undefined}
                      />
                      {nodeVisibleLabel(node) && (
                        <text
                          x={labelOnLeft ? -(radius + 7) : radius + 7}
                          y="4"
                          textAnchor={labelOnLeft ? "end" : "start"}
                          className={`graph-node-label is-${node.type}`}
                        >
                          {canvasNodeLabel(node)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>

            {graphMode === "3d" && (
              <Suspense fallback={<div className="graph-3d-loading">3D 그래프를 준비하고 있습니다…</div>}>
                <ResearchGraph3D
                  graph={graph}
                  visibleIds={visibleIds}
                  visibleEdges={visibleEdges}
                  resultIds={visualResultIds}
                  selectedId={selectedId}
                  resetViewToken={cameraResetToken}
                  labelsVisible={labelsVisible}
                  motionPaused={motionPaused}
                  topics={corpus.topics}
                  relationshipReason={(node) => strongestRelationshipReason(node, graph, corpus.topics)}
                  onSelect={selectNode}
                />
              </Suspense>
            )}

            {graphMode === "2d" && hoveredPaper?.type === "paper" && hoverPoint?.id === hoveredPaper.id && (
              <div
                className={`graph-node-tooltip ${hoverPoint.x > 68 ? "is-left" : ""}`}
                style={{ left: `${hoverPoint.x}%`, top: `${hoverPoint.y}%` }}
                role="tooltip"
              >
                <span>{hoveredPaper.identifier}</span>
                <strong>{hoveredPaper.title}</strong>
                <small>
                  {hoveredPaper.year || "연도 미상"} · {
                    corpus.topics.find((topic) => topic.id === hoveredPaper.topicId)?.label || "연구 분야 미상"
                  }
                </small>
                <p>{strongestRelationshipReason(hoveredPaper, graph, corpus.topics)}</p>
              </div>
            )}

            <div className="graph-floating-stats">
              <span className="is-live"><i /> LIVE GRAPH</span>
              <span>{visibleIds.size}개 노드</span>
              <span>{visibleEdges.length}개 관계</span>
            </div>

            <div className="graph-interaction-guide">
              {graphMode === "2d" ? (
                <>
                  <span>드래그</span> 노드 이동
                  <i /> <span>더블클릭</span> 2단계 관계 확장
                  <i /> <span>휠</span> 확대·축소
                </>
              ) : (
                <>
                  <span>드래그</span> 화면 회전
                  <i /> <span>클릭</span> 논문 선택
                  <i /> <span>휠</span> 확대·축소
                </>
              )}
            </div>

            <div className="graph-toolbar">
              {graphMode === "2d" && (
                <>
                  <button className="graph-zoom-button" type="button" onClick={() => zoom(0.82)} aria-label="그래프 확대">＋</button>
                  <button className="graph-zoom-button" type="button" onClick={() => zoom(1.2)} aria-label="그래프 축소">－</button>
                  <button type="button" onClick={() => setCamera(DEFAULT_CAMERA)}>화면 맞춤</button>
                </>
              )}
              <button type="button" onClick={() => setLabelsVisible((value) => !value)}>
                {labelsVisible ? "라벨 숨기기" : "라벨 보기"}
              </button>
              <button
                type="button"
                className={motionPaused ? "is-paused" : ""}
                onClick={() => setMotionPaused((value) => !value)}
              >
                {motionPaused ? "움직임 재생" : "움직임 정지"}
              </button>
              <button type="button" onClick={resetGraph}>초기화</button>
            </div>

            {results.length > 0 && (
              <div className="graph-retrieval-status">
                <span>GRAPH RETRIEVAL</span>
                <strong>“{lastQuery}”</strong>
                <p>직접 관련 논문 {results.length}편과 주제·핵심 개념·유사 연구 이웃을 확장했습니다.</p>
              </div>
            )}

            {selected && (
              <aside className="graph-detail-panel">
                <button className="graph-detail-close" type="button" onClick={() => setSelectedId(null)} aria-label="그래프 상세 닫기">×</button>
                <span className={`graph-node-type is-${selected.type}`}>{typeLabel(selected.type)}</span>
                <h3>{nodeLabel(selected)}</h3>
                {selected.type === "paper" && (
                  <>
                    <div className="graph-paper-meta">
                      <span className="is-identifier">{selected.identifier}</span>
                      <span>{selected.year || "연도 미상"}</span>
                      <span>PMID {selected.pmid}</span>
                      {selected.pmcid && <span className="is-open">PMC 전문</span>}
                    </div>
                    <p className="graph-journal-name">{selected.journal}</p>
                    <div className="graph-brief-highlight">
                      <span>한눈에 보기</span>
                      <p>{selectedBrief?.oneLine}</p>
                    </div>
                    <div className="graph-brief-sections">
                      <section>
                        <span>무엇을 알아봤나요?</span>
                        <p>{selectedBrief?.purpose}</p>
                      </section>
                      <section>
                        <span>어떻게 연구했나요?</span>
                        <p>{selectedBrief?.method}</p>
                      </section>
                      <section>
                        <span>무엇을 발견했나요?</span>
                        <p>{selectedBrief?.result}</p>
                      </section>
                    </div>
                    {selectedBrief?.concepts.length > 0 && (
                      <div className="graph-concept-chips">
                        {selectedBrief.concepts.map((concept) => (
                          <button type="button" key={concept.id} onClick={() => selectNode(concept.id)}>
                            {concept.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="graph-path-card">
                      <span>그래프에서 왜 중요한가요?</span>
                      <div>
                        <i style={{ "--path-color": selected.color }} />
                        <b>{corpus.topics.find((topic) => topic.id === selected.topicId)?.label}</b>
                        <em>→</em>
                        <b>{selectedBrief?.concepts.length || 0}개 핵심 개념</b>
                        <em>→</em>
                        <b>{relatedPaperDetails.length}개 관련 연구</b>
                      </div>
                    </div>
                    {relatedPaperDetails.length > 0 && (
                      <div className="graph-related-reasons">
                        <span>관계가 설명되는 논문</span>
                        {relatedPaperDetails.slice(0, 3).map((entry) => (
                          <button type="button" key={entry.paper.id} onClick={() => selectNode(entry.paper.id)}>
                            <strong>{entry.paper.title}</strong>
                            <small>
                              {entry.concepts.length > 0 && `${entry.concepts.join(", ")} 공유`}
                              {entry.concepts.length > 0 && (entry.similarity || entry.sameTopic) ? " · " : ""}
                              {entry.similarity > 0 && `내용 유사도 ${entry.similarity}%`}
                              {entry.similarity > 0 && entry.sameTopic ? " · " : ""}
                              {entry.sameTopic && "같은 연구 분야"}
                            </small>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      className={`graph-compare-button ${pathAnchorId === selected.id ? "is-active" : ""}`}
                      type="button"
                      onClick={activateComparison}
                    >
                      {pathAnchorId === selected.id ? "경로 시작점 해제" : "이 논문에서 연결 경로 찾기"}
                    </button>
                    {pathAnchorId && pathAnchorId !== selected.id && comparisonPath.length > 1 && (
                      <div className="graph-comparison-summary">
                        <span>SHORTEST PATH</span>
                        <strong>{comparisonPath.length - 1}단계 연결</strong>
                        <p>{comparisonPath.map((id) => nodeLabel(graph.nodeById.get(id))).join(" → ")}</p>
                      </div>
                    )}
                    <a href={selected.pubmedUrl} target="_blank" rel="noreferrer">PubMed에서 논문 보기 ↗</a>
                  </>
                )}
                {selected.type === "topic" && (
                  <>
                    <p>{selected.description}</p>
                    <div className="graph-detail-number"><strong>{selected.count}</strong><span>연결 논문</span></div>
                    <button type="button" onClick={() => setActiveTopic(selected.id.replace("topic:", ""))}>이 주제만 보기</button>
                  </>
                )}
                {selected.type === "concept" && (
                  <>
                    <p>{selected.group} 범주에 속하는 내용 기반 개념입니다. 제목과 초록에서 이 개념이 확인된 논문을 연결합니다.</p>
                    <div className="graph-detail-number"><strong>{selected.count}</strong><span>연결 논문</span></div>
                  </>
                )}
                {selected.type !== "paper" && <div className="graph-neighbor-list">
                  <span>직접 연결</span>
                  {selectedNeighbors.slice(0, 5).map((neighbor) => (
                    <button type="button" key={neighbor.id} onClick={() => selectNode(neighbor.id)}>
                      <i style={{ "--neighbor-color": neighbor.color || "#f4d88a" }} />
                      <span>{nodeLabel(neighbor)}</span>
                    </button>
                  ))}
                </div>}
              </aside>
            )}
            {!selected && (
              <aside className="graph-detail-panel graph-insight-panel">
                <span className="graph-node-type is-topic">RESEARCH INSIGHT</span>
                <h3>그래프에서 무엇을 발견할 수 있나요?</h3>
                <p className="graph-insight-lead">
                  질문을 입력하면 관련 논문만 모으고, 반복되는 주제와 핵심 개념을 근거 경로로 보여줍니다.
                </p>
                <div className="graph-insight-metrics">
                  <div><strong>{graphInsight.paperCount}</strong><span>탐색 가능한 논문</span></div>
                  <div><strong>{graphInsight.fullTextCount}</strong><span>PMC 전문 연결</span></div>
                </div>
                <div className="graph-insight-summary">
                  <span>현재 데이터의 중심</span>
                  <strong>{graphInsight.topic?.label || "6개 의학 연구 분야"}</strong>
                  <p>
                    {graphInsight.concepts.length
                      ? `${graphInsight.concepts.map((item) => item.node?.label).filter(Boolean).join(", ")} 개념이 여러 논문을 연결합니다.`
                      : "질문을 입력하면 반복되는 연구 개념을 찾아드립니다."}
                  </p>
                </div>
                <ol className="graph-use-steps">
                  <li><span>1</span><div><strong>연구 질문 입력</strong><p>궁금한 내용을 자연어로 검색하세요.</p></div></li>
                  <li><span>2</span><div><strong>관련 논문 선택</strong><p>검색 결과 목록이나 그래프 노드를 누르세요.</p></div></li>
                  <li><span>3</span><div><strong>연결 이유 확인</strong><p>공통 개념과 내용 유사성을 확인하세요.</p></div></li>
                </ol>
              </aside>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
