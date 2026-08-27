import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import KeywordCloud from "./KeywordCloud";
import { api, apiUrl, stream } from "../lib/api";
import { extractPdfSections, loadPdfDocument } from "../lib/pdf";
import { supabase } from "../lib/supabase";
import { paperHasKeyword } from "../lib/wordCloud";

const INTRO = "선택한 논문을 바탕으로 무엇이 궁금한가요?";
const emptyOverview = {
  totalPapers: 0,
  totalJournals: 0,
  projectCount: 0,
  unassignedCount: 0,
  projectDistribution: [],
  analysisStatus: { ready: 0, abstractOnly: 0, processing: 0 },
  papersByYear: {},
  latestSearch: null,
  recentPapers: [],
};
const previewOverview = {
  totalPapers: 2410,
  totalJournals: 47,
  projectCount: 4,
  unassignedCount: 184,
  projectDistribution: [
    { id: "preview-obesity", name: "비만 중재 연구", color: "#7769cf", paperCount: 760 },
    { id: "preview-diabetes", name: "당뇨 위험요인", color: "#4d9488", paperCount: 618 },
    { id: "preview-digital", name: "디지털 헬스", color: "#cb7a5e", paperCount: 502 },
    { id: "preview-review", name: "리뷰 후보", color: "#5e83b2", paperCount: 346 },
  ],
  analysisStatus: { ready: 1380, abstractOnly: 990, processing: 40 },
  papersByYear: {
    2020: 238,
    2021: 342,
    2022: 451,
    2023: 548,
    2024: 397,
    2025: 501,
  },
  latestSearch: {
    keyword: "obesity intervention",
    yearFrom: 2020,
    yearTo: 2025,
    resultCount: 100,
    totalMatches: 2477,
    searchedAt: "2026-08-27T00:00:00.000Z",
  },
  recentPapers: [
    {
      pmid: "41287614",
      title: "Digital health interventions for long-term obesity management: a systematic review",
      journal: "Journal of Medical Internet Research",
      pubYear: 2025,
      savedAt: "2026-08-26T10:30:00.000Z",
      projects: [{ id: "preview-obesity", name: "비만 중재 연구", color: "#7769cf" }],
    },
    {
      pmid: "41193026",
      title: "Lifestyle and metabolic risk factors in adults with type 2 diabetes",
      journal: "Diabetes Care",
      pubYear: 2025,
      savedAt: "2026-08-25T08:20:00.000Z",
      projects: [{ id: "preview-diabetes", name: "당뇨 위험요인", color: "#4d9488" }],
    },
    {
      pmid: "41028471",
      title: "Patient engagement with mobile health services in primary care",
      journal: "The Lancet Digital Health",
      pubYear: 2024,
      savedAt: "2026-08-24T14:10:00.000Z",
      projects: [{ id: "preview-digital", name: "디지털 헬스", color: "#cb7a5e" }],
    },
  ],
};

let chromeTranslatorPromise = null;

function normalizeDisplayText(value, fallback = "") {
  const decoded = String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("\u00a0", " ")
    .replace(/\s+/g, " ")
    .trim();
  return decoded || fallback;
}

function getChromeEnglishToKoreanTranslator(onProgress) {
  const TranslatorApi = globalThis.Translator;
  if (!TranslatorApi?.create) {
    throw new Error("CHROME_TRANSLATOR_UNAVAILABLE");
  }

  if (!chromeTranslatorPromise) {
    chromeTranslatorPromise = TranslatorApi.create({
      sourceLanguage: "en",
      targetLanguage: "ko",
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          onProgress?.(Math.round(event.loaded * 100));
        });
      },
    }).catch((error) => {
      chromeTranslatorPromise = null;
      throw error;
    });
  }

  return chromeTranslatorPromise;
}

const normalizePaper = (paper) => ({
  ...paper,
  title: normalizeDisplayText(paper.title, "제목 정보 없음"),
  journal: normalizeDisplayText(paper.journal, "저널 정보 없음"),
  id: paper.id ?? paper.paper_id ?? paper.pmid,
  pubYear: paper.pubYear ?? paper.pub_year ?? paper.year,
  fullTextUrl: paper.fullTextUrl ?? paper.full_text_url,
  pubmedUrl: paper.pubmedUrl ?? paper.pubmed_url,
  pdfUrl: paper.pdfUrl ?? paper.pdf_url,
  pdfSource: paper.pdfSource ?? paper.document_source,
  hasUploadedPdf: paper.hasUploadedPdf ?? paper.has_uploaded_pdf ?? false,
  uploadedPdfName: paper.uploadedPdfName ?? paper.uploaded_pdf_name,
  pmcid: paper.pmcid ?? paper.pmc_id,
  documentStatus: paper.documentStatus ?? paper.document_status ?? paper.rag_status,
  isSaved: paper.isSaved ?? paper.is_saved ?? false,
  projects: Array.isArray(paper.projects) ? paper.projects : [],
});

const emptyProjectSummary = { projects: [], totalCount: 0, unassignedCount: 0 };
const emptyKeywordSummary = {
  scope: "interest",
  projectId: "all",
  paperCount: 0,
  missingAbstractCount: 0,
  terms: [],
};

const hasFullTextEvidence = (paper) => paper?.documentStatus === "ready";

function paperDocumentState(paper) {
  if (paper?.documentStatus === "processing" || paper?.documentStatus === "pending") {
    return { mode: "processing", label: "PDF 처리 중" };
  }
  if (paper?.documentStatus === "failed") return { mode: "failed", label: "전문 처리 실패" };
  if (paper?.hasUploadedPdf && hasFullTextEvidence(paper)) return { mode: "uploaded", label: "업로드 PDF 분석" };
  if (hasFullTextEvidence(paper)) return { mode: "full", label: paper?.pdfSource === "user_pdf" ? "업로드 PDF 분석" : "PMC 전문 분석" };
  if (paper?.pdfUrl || paper?.hasUploadedPdf) return { mode: "available", label: "PDF 확인 가능" };
  if (paper?.pmcid) return { mode: "available", label: "PMC 전문 확인 가능" };
  if (paper?.doi || paper?.fullTextUrl) return { mode: "external", label: "외부 원문 제공" };
  return { mode: "abstract", label: "초록 기반 분석" };
}

function evidenceModeForPapers(papers = []) {
  if (!papers.length) return { mode: "none", label: "일반 연구 대화" };
  const fullTextCount = papers.filter(hasFullTextEvidence).length;
  if (fullTextCount === papers.length) return { mode: "full", label: "PMC 전문 기반" };
  if (fullTextCount > 0) return { mode: "mixed", label: "전문·초록 혼합" };
  return { mode: "abstract", label: "초록 기반" };
}

function evidenceModeForRoom(room) {
  const paperCount = Number(room.paperCount ?? room.paper_count ?? room.papers?.length ?? 0);
  const fullTextCount = Number(room.fullTextCount ?? room.full_text_count ?? 0);
  if (!paperCount) return { mode: "none", label: "일반 대화" };
  if (fullTextCount === paperCount) return { mode: "full", label: "전문 기반" };
  if (fullTextCount > 0) return { mode: "mixed", label: "혼합 근거" };
  return { mode: "abstract", label: "초록 기반" };
}

function normalizeList(body) {
  const list = body?.papers ?? body?.items ?? body?.data ?? (Array.isArray(body) ? body : []);
  return { papers: list.map(normalizePaper), total: body?.total ?? body?.count ?? list.length };
}

function normalizeOverview(body = {}) {
  const stats = body.stats ?? body;
  const analysis = stats.analysisStatus ?? stats.analysis_status ?? {};
  const latest = stats.latestSearch ?? stats.latest_search ?? null;
  const projects = stats.projectDistribution ?? stats.project_distribution ?? [];
  const recentPapers = stats.recentPapers ?? stats.recent_papers ?? [];
  return {
    totalPapers: stats.totalPapers ?? stats.total_papers ?? 0,
    totalJournals: stats.totalJournals ?? stats.total_journals ?? 0,
    projectCount: stats.projectCount ?? stats.project_count ?? 0,
    unassignedCount: stats.unassignedCount ?? stats.unassigned_count ?? 0,
    projectDistribution: projects.map((project) => ({
      id: project.id,
      name: project.name,
      color: project.color,
      paperCount: Number(project.paperCount ?? project.paper_count ?? 0),
    })),
    analysisStatus: {
      ready: Number(analysis.ready ?? 0),
      abstractOnly: Number(analysis.abstractOnly ?? analysis.abstract_only ?? 0),
      processing: Number(analysis.processing ?? 0),
    },
    papersByYear: stats.papersByYear ?? stats.papers_by_year ?? stats.latestTrend?.papers_by_year ?? {},
    latestSearch: latest ? {
      keyword: latest.keyword ?? "",
      yearFrom: Number(latest.yearFrom ?? latest.year_from ?? 0),
      yearTo: Number(latest.yearTo ?? latest.year_to ?? 0),
      resultCount: Number(latest.resultCount ?? latest.result_count ?? 0),
      totalMatches: Number(latest.totalMatches ?? latest.total_matches ?? 0),
      searchedAt: latest.searchedAt ?? latest.searched_at ?? null,
    } : null,
    recentPapers: recentPapers.map((paper) => ({
      pmid: paper.pmid,
      title: normalizeDisplayText(paper.title, "제목 정보 없음"),
      journal: normalizeDisplayText(paper.journal, "저널 정보 없음"),
      pubYear: Number(paper.pubYear ?? paper.pub_year ?? paper.publication_year ?? 0),
      savedAt: paper.savedAt ?? paper.saved_at ?? null,
      projects: Array.isArray(paper.projects) ? paper.projects : [],
    })),
  };
}

function normalizeKeywordSummary(body = {}) {
  return {
    scope: body.scope ?? "interest",
    projectId: body.projectId ?? body.project_id ?? "all",
    paperCount: Number(body.paperCount ?? body.paper_count ?? 0),
    missingAbstractCount: Number(body.missingAbstractCount ?? body.missing_abstract_count ?? 0),
    terms: Array.isArray(body.terms) ? body.terms : [],
  };
}

function messageSources(message) {
  const value = message?.citations ?? message?.sources;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function externalPaperUrl(paper) {
  if (paper?.pmcid) return `https://pmc.ncbi.nlm.nih.gov/articles/${paper.pmcid}/`;
  if (paper?.fullTextUrl) return paper.fullTextUrl;
  if (paper?.doi) return `https://doi.org/${paper.doi}`;
  if (paper?.pubmedUrl) return paper.pubmedUrl;
  return paper?.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : "";
}

function openExternalPaperWindow(paper) {
  const url = externalPaperUrl(paper);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

function bestSourceParagraph(sections, source) {
  const quote = String(source?.quote || "").trim();
  if (!quote) return null;
  for (const [sectionIndex, section] of sections.entries()) {
    for (const [paragraphIndex, paragraph] of section.paragraphs.entries()) {
      if (String(paragraph).includes(quote)) return `${sectionIndex}-${paragraphIndex}`;
    }
  }
  return null;
}

function sourceHighlightRange(paragraph, source) {
  const text = String(paragraph || "");
  const quote = String(source?.quote || "").trim();
  if (!text || !quote) return null;
  const start = text.indexOf(quote);
  return start >= 0 ? { start, end: start + quote.length } : null;
}

export default function Dashboard({ session, preview = false }) {
  const token = session.access_token;
  const user = session.user;
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [overview, setOverview] = useState(preview ? previewOverview : emptyOverview);
  const [searchResults, setSearchResults] = useState([]);
  const [searchSelected, setSearchSelected] = useState([]);
  const [searchRunId, setSearchRunId] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [interestPending, setInterestPending] = useState({});
  const [papers, setPapers] = useState([]);
  const [paperTotal, setPaperTotal] = useState(0);
  const [paperProjectFilter, setPaperProjectFilter] = useState("all");
  const [projectSummary, setProjectSummary] = useState(emptyProjectSummary);
  const [interestKeywordSummary, setInterestKeywordSummary] = useState(emptyKeywordSummary);
  const [recentlyDeletedProject, setRecentlyDeletedProject] = useState(null);
  const [selected, setSelected] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [mobileSheet, setMobileSheet] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pdfUploadState, setPdfUploadState] = useState({});

  const call = useCallback(async (path, options) => {
    setLoading((value) => value + 1);
    setError("");
    try {
      return await api(path, { ...options, token });
    } catch (requestError) {
      setError(requestError.message);
      throw requestError;
    } finally {
      setLoading((value) => Math.max(0, value - 1));
    }
  }, [token]);

  const loadOverview = useCallback(async () => {
    const body = await call("/api/overview");
    setOverview(normalizeOverview(body));
  }, [call]);

  const loadPapers = useCallback(async (params = "") => {
    const body = await call(`/api/papers${params ? `?${params}` : ""}`);
    const result = normalizeList(body);
    setPapers(result.papers);
    setPaperTotal(result.total);
  }, [call]);

  const loadProjects = useCallback(async () => {
    const body = await call("/api/projects");
    setProjectSummary({
      projects: body.projects ?? [],
      totalCount: Number(body.totalCount ?? body.total_count ?? 0),
      unassignedCount: Number(body.unassignedCount ?? body.unassigned_count ?? 0),
    });
  }, [call]);

  const loadInterestWordCloud = useCallback(async (params = "") => {
    const body = await call(`/api/wordcloud${params ? `?${params}` : ""}`);
    setInterestKeywordSummary(normalizeKeywordSummary(body));
  }, [call]);

  const loadPapersByProject = useCallback(async (projectId = paperProjectFilter, params = "") => {
    const query = new URLSearchParams(params);
    if (projectId && projectId !== "all") query.set("projectId", projectId);
    setPaperProjectFilter(projectId || "all");
    await Promise.all([loadPapers(query.toString()), loadInterestWordCloud(query.toString())]);
  }, [loadInterestWordCloud, loadPapers, paperProjectFilter]);

  const loadPaperListByProject = useCallback(async (projectId = paperProjectFilter, params = "") => {
    const query = new URLSearchParams(params);
    if (projectId && projectId !== "all") query.set("projectId", projectId);
    await loadPapers(query.toString());
  }, [loadPapers, paperProjectFilter]);

  const loadConversations = useCallback(async () => {
    const body = await call("/api/chat/conversations");
    setConversations(body.conversations ?? body.items ?? body.data ?? (Array.isArray(body) ? body : []));
  }, [call]);

  useEffect(() => {
    if (preview) return undefined;
    // The overview does not need the heavier interest-paper tools. Loading
    // those only when the tab opens keeps an optional feature failure from
    // masking the main dashboard and avoids unnecessary keyword aggregation.
    Promise.allSettled([loadOverview(), loadConversations()]);
    return undefined;
  }, [loadOverview, loadConversations, preview]);

  useEffect(() => {
    if (!preview) return undefined;
    document.body.classList.add("landing-preview");
    return () => document.body.classList.remove("landing-preview");
  }, [preview]);

  const selectTab = (next) => {
    setTab(next);
    setMobileSheet(false);
    if (next === "overview") loadOverview().catch(() => {});
    if (next === "papers") Promise.allSettled([loadPapersByProject(), loadProjects()]);
    if (next === "chat") loadConversations().catch(() => {});
  };

  const collect = async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setStatus("PubMed에서 논문과 초록을 검색하고 있어요…");
    try {
      const result = await call("/api/collection/search", {
        method: "POST",
        body: JSON.stringify({
          keyword: values.keyword.trim(),
          yearFrom: Number(values.yearFrom),
          yearTo: Number(values.yearTo),
          maxCount: Number(values.maxResults),
        }),
      });
      const found = result.total ?? result.papers?.length ?? 0;
      setSearchResults((result.papers ?? []).map(normalizePaper));
      setSearchSelected([]);
      setSearchRunId(result.searchRunId ?? result.search_run_id ?? null);
      setSearchQuery(values.keyword.trim());
      setStatus(`검색 완료 · ${found}건을 찾았습니다. 관심 논문은 직접 추가해주세요.`);
      setTab("search");
      setMobileSheet(false);
      await loadOverview();
    } catch (requestError) {
      setStatus(requestError.message);
    }
  };

  const resetCollection = async () => {
    if (preview) return;
    const confirmed = window.confirm(
      "현재 계정의 관심 논문과 모든 채팅을 초기화할까요?\n검색 이력과 개요 그래프도 함께 화면에서 제외됩니다.",
    );
    if (!confirmed) return;
    setStatus("관심 논문과 채팅을 초기화하고 있어요…");
    try {
      const result = await call("/api/collection", { method: "DELETE" });
      setOverview(emptyOverview);
      setPapers([]);
      setPaperTotal(0);
      setPaperProjectFilter("all");
      setProjectSummary(emptyProjectSummary);
      setInterestKeywordSummary(emptyKeywordSummary);
      setRecentlyDeletedProject(null);
      setSelected([]);
      setConversations([]);
      setConversationId(null);
      setMessages([]);
      setSearchResults([]);
      setSearchSelected([]);
      setSearchRunId(null);
      setSearchQuery("");
      setMobileSheet(false);
      setStatus(
        `관심 논문 ${Number(result.removedPaperCount ?? 0).toLocaleString()}건과 채팅 `
        + `${Number(result.removedChatCount ?? 0).toLocaleString()}개를 초기화했습니다.`,
      );
    } catch (requestError) {
      setStatus(requestError.message);
    }
  };

  const search = async (event, projectId = paperProjectFilter) => {
    event.preventDefault();
    setSelected([]);
    const params = new URLSearchParams();
    const formData = new FormData(event.currentTarget);
    for (const [key, value] of formData) {
      if (key !== "projectId" && String(value).trim()) params.set(key, String(value).trim());
    }
    const selectedProjectId = formData.get("projectId") || projectId;
    await loadPapersByProject(String(selectedProjectId), params.toString()).catch(() => {});
  };

  const togglePaper = (paper) => {
    const key = String(paper.id);
    setSelected((current) => {
      if (current.some((item) => String(item.id) === key)) return current.filter((item) => String(item.id) !== key);
      return [...current, paper];
    });
  };

  const selectPapers = (targetPapers, checked) => {
    const targetIds = new Set(targetPapers.map((paper) => String(paper.id)));
    setSelected((current) => {
      if (!checked) return current.filter((paper) => !targetIds.has(String(paper.id)));
      const next = new Map(current.map((paper) => [String(paper.id), paper]));
      for (const paper of targetPapers) next.set(String(paper.id), paper);
      return [...next.values()];
    });
  };

  const setInterestBusy = (pmid, busy) => {
    setInterestPending((current) => {
      const next = { ...current };
      if (busy) next[String(pmid)] = true;
      else delete next[String(pmid)];
      return next;
    });
  };

  const setInterestPapersBusy = (pmids, busy) => {
    setInterestPending((current) => {
      const next = { ...current };
      for (const pmid of pmids) {
        if (busy) next[String(pmid)] = true;
        else delete next[String(pmid)];
      }
      return next;
    });
  };

  const markSearchResultsSaved = (pmids, isSaved) => {
    const keys = new Set(pmids.map(String));
    setSearchResults((current) => current.map((paper) =>
      keys.has(String(paper.pmid)) ? { ...paper, isSaved } : paper));
    if (isSaved) {
      setSearchSelected((current) => current.filter((pmid) => !keys.has(String(pmid))));
    }
  };

  const saveInterestPapers = async (targetPapers) => {
    const unique = [...new Map(
      targetPapers
        .filter((paper) => paper?.pmid && !paper.isSaved && !interestPending[String(paper.pmid)])
        .map((paper) => [String(paper.pmid), paper]),
    ).values()];
    if (!unique.length) return false;
    const pmids = unique.map((paper) => String(paper.pmid));
    setInterestPapersBusy(pmids, true);
    try {
      await call("/api/collection", {
        method: "POST",
        body: JSON.stringify({
          pmids,
          ...(searchRunId ? { searchRunId } : {}),
        }),
      });
      markSearchResultsSaved(pmids, true);
      setStatus(unique.length === 1
        ? `관심 논문에 추가했습니다 · PMID ${pmids[0]}`
        : `선택한 논문 ${unique.length}편을 관심 논문에 추가했습니다.`);
      await Promise.all([loadOverview(), loadPapersByProject(), loadProjects()]);
      return true;
    } catch (requestError) {
      setStatus(requestError.message);
      return false;
    } finally {
      setInterestPapersBusy(pmids, false);
    }
  };

  const saveInterestPaper = (paper) => saveInterestPapers([paper]);

  const toggleSearchSelection = (paper) => {
    if (!paper?.pmid || paper.isSaved || interestPending[String(paper.pmid)]) return;
    const key = String(paper.pmid);
    setSearchSelected((current) => current.includes(key)
      ? current.filter((pmid) => pmid !== key)
      : [...current, key]);
  };

  const saveSelectedInterestPapers = () => {
    const selectedKeys = new Set(searchSelected);
    return saveInterestPapers(searchResults.filter((paper) => selectedKeys.has(String(paper.pmid))));
  };

  const removeInterestPaper = async (paper) => {
    if (!paper?.pmid || interestPending[String(paper.pmid)]) return;
    setInterestBusy(paper.pmid, true);
    try {
      await call(`/api/collection/${encodeURIComponent(paper.pmid)}`, { method: "DELETE" });
      markSearchResultsSaved([paper.pmid], false);
      setPapers((current) => current.filter((item) => String(item.pmid) !== String(paper.pmid)));
      setSelected((current) => current.filter((item) => String(item.pmid) !== String(paper.pmid)));
      setStatus(`관심 논문에서 해제했습니다 · PMID ${paper.pmid}`);
      await Promise.all([loadOverview(), loadPapersByProject(), loadProjects()]);
    } catch (requestError) {
      setStatus(requestError.message);
    } finally {
      setInterestBusy(paper.pmid, false);
    }
  };

  const toggleSearchInterest = (paper) => (
    paper.isSaved ? removeInterestPaper(paper) : saveInterestPaper(paper)
  );

  const createResearchProject = async (input) => {
    const body = await call("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setRecentlyDeletedProject(null);
    await loadProjects();
    setStatus(`프로젝트를 만들었습니다 · ${body.project.name}`);
    return body.project;
  };

  const updateResearchProject = async (projectId, input) => {
    const body = await call(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    await Promise.all([loadProjects(), loadPapersByProject()]);
    setStatus(`프로젝트를 수정했습니다 · ${body.project.name}`);
    return body.project;
  };

  const deleteResearchProject = async (project) => {
    const body = await call(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE" });
    setRecentlyDeletedProject({ ...project, ...body.project });
    setPaperProjectFilter("all");
    await Promise.all([loadProjects(), loadPapersByProject("all")]);
    setStatus(`프로젝트를 보관 처리했습니다 · ${project.name}`);
  };

  const restoreResearchProject = async () => {
    if (!recentlyDeletedProject?.id) return;
    const body = await call(`/api/projects/${encodeURIComponent(recentlyDeletedProject.id)}/restore`, {
      method: "POST",
    });
    setRecentlyDeletedProject(null);
    await Promise.all([loadProjects(), loadPapersByProject("all")]);
    setStatus(`프로젝트와 논문 분류를 복구했습니다 · ${body.project.name}`);
  };

  const replacePaperProjects = async (paper, projectIds) => {
    const body = await call(`/api/papers/${encodeURIComponent(paper.pmid)}/projects`, {
      method: "PUT",
      body: JSON.stringify({ projectIds }),
    });
    const nextProjects = body.projects ?? [];
    const staysVisible = paperProjectFilter === "all"
      || (paperProjectFilter === "unassigned" && nextProjects.length === 0)
      || nextProjects.some((project) => String(project.id) === String(paperProjectFilter));
    setPapers((current) => current
      .map((item) => String(item.pmid) === String(paper.pmid)
        ? { ...item, projects: nextProjects }
        : item)
      .filter((item) => String(item.pmid) !== String(paper.pmid) || staysVisible));
    setPaperTotal((current) => staysVisible ? current : Math.max(0, current - 1));
    setSelected((current) => current.map((item) => String(item.pmid) === String(paper.pmid)
      ? { ...item, projects: nextProjects }
      : item));
    await Promise.all([loadProjects(), loadInterestWordCloud(
      paperProjectFilter === "all" ? "" : `projectId=${encodeURIComponent(paperProjectFilter)}`,
    )]);
    setStatus(nextProjects.length
      ? `논문을 ${nextProjects.length}개 프로젝트에 분류했습니다 · PMID ${paper.pmid}`
      : `논문을 미분류로 옮겼습니다 · PMID ${paper.pmid}`);
    return nextProjects;
  };

  const assignSelectedPapersToProjects = async (targetPapers, projectIds, mode) => {
    const pmids = [...new Set(targetPapers.map((paper) => String(paper.pmid)).filter(Boolean))];
    const body = await call("/api/papers/projects", {
      method: "PUT",
      body: JSON.stringify({ pmids, projectIds, mode }),
    });
    setSelected([]);
    await Promise.all([loadPapersByProject(), loadProjects()]);
    setStatus(mode === "add"
      ? `선택한 논문 ${body.updatedCount}편에 프로젝트를 추가했습니다.`
      : projectIds.length
        ? `선택한 논문 ${body.updatedCount}편의 프로젝트 분류를 교체했습니다.`
        : `선택한 논문 ${body.updatedCount}편을 미분류로 옮겼습니다.`);
    return body.papers ?? [];
  };

  const uploadPaperPdf = async (paper, file) => {
    if (!paper?.pmid || !file || !supabase) return null;
    const pmid = String(paper.pmid);
    let storagePath = "";
    setPdfUploadState((current) => ({ ...current, [pmid]: "extracting" }));
    try {
      const { pageCount, sections } = await extractPdfSections(file);
      const uploadGrant = await call(`/api/papers/${encodeURIComponent(pmid)}/pdf/upload-url`, {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, sizeBytes: file.size }),
      });
      storagePath = uploadGrant.path;
      if (!storagePath || !uploadGrant.token) throw new Error("PDF 업로드 권한을 발급받지 못했습니다.");
      setPdfUploadState((current) => ({ ...current, [pmid]: "uploading" }));
      const { error: storageError } = await supabase.storage
        .from("paper-pdfs")
        .uploadToSignedUrl(storagePath, uploadGrant.token, file, { contentType: "application/pdf" });
      if (storageError) throw new Error(storageError.message || "PDF 저장에 실패했습니다.");

      setPdfUploadState((current) => ({ ...current, [pmid]: "processing" }));
      const result = await call(`/api/papers/${encodeURIComponent(pmid)}/pdf`, {
        method: "POST",
        body: JSON.stringify({
          storagePath,
          fileName: file.name,
          sizeBytes: file.size,
          pageCount,
          sections,
        }),
      });
      await loadPapers().catch(() => {});
      if (conversationId) {
        const detail = await call(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
        setConversations((items) => items.map((item) => {
          const itemId = item.id ?? item.conversationId ?? item.conversation_id;
          return String(itemId) === String(conversationId)
            ? { ...item, ...(detail.conversation ?? {}), papers: detail.papers ?? [] }
            : item;
        }));
      }
      return result;
    } catch (uploadError) {
      if (storagePath) {
        await supabase.storage.from("paper-pdfs").remove([storagePath]).catch(() => {});
      }
      setError(uploadError.message || "PDF 업로드를 완료하지 못했습니다.");
      throw uploadError;
    } finally {
      setPdfUploadState((current) => {
        const next = { ...current };
        delete next[pmid];
        return next;
      });
    }
  };

  const openConversation = async (id) => {
    setConversationId(id);
    setTab("chat");
    const [historyBody, detailBody] = await Promise.all([
      call(`/api/chat/${encodeURIComponent(id)}/messages`),
      call(`/api/chat/conversations/${encodeURIComponent(id)}`),
    ]);
    setMessages(historyBody.messages ?? historyBody.items ?? historyBody.data ?? (Array.isArray(historyBody) ? historyBody : []));
    const detailRoom = detailBody.conversation ?? {};
    setConversations((items) => items.map((item) => {
      const itemId = item.id ?? item.conversationId ?? item.conversation_id;
      return String(itemId) === String(id) ? { ...item, ...detailRoom, papers: detailBody.papers ?? [] } : item;
    }));
  };

  const createEmptyChat = async (title) => {
    const result = await call("/api/chat/conversations/from-papers", {
      method: "POST",
      body: JSON.stringify({ pmids: [], title }),
    });
    const room = result.conversation ?? result;
    const id = room.id ?? room.conversationId ?? room.conversation_id;
    await loadConversations();
    if (id) await openConversation(id);
  };

  const deleteConversation = async (id) => {
    if (!id) return;
    await call(`/api/chat/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
    setConversations((items) => items.filter((item) => String(item.id ?? item.conversationId ?? item.conversation_id) !== String(id)));
    if (String(conversationId) === String(id)) {
      setConversationId(null);
      setMessages([]);
    }
  };

  const sendSelectedToChat = async () => {
    if (!selected.length) return;
    if (selected.length > 5) {
      setError("챗봇에는 선택한 논문 중 최대 5편까지만 보낼 수 있습니다.");
      return;
    }
    const result = await call("/api/chat/conversations/from-papers", {
      method: "POST",
      body: JSON.stringify({ pmids: selected.map((paper) => paper.pmid) }),
    });
    const room = result.conversation ?? result;
    const id = room.id ?? room.conversationId ?? room.conversation_id;
    setSelected([]);
    await loadConversations();
    if (id) await openConversation(id);
  };

  const resetChatSelection = () => {
    setSelected([]);
    setConversationId(null);
    setMessages([]);
  };

  const logout = () => supabase?.auth.signOut();
  const displayName = user.user_metadata?.full_name || user.user_metadata?.name || user.email || "사용자";
  const openResearchGraph = () => {
    const graphUrl = new URL("/research-graph", window.location.origin);
    if (new URLSearchParams(window.location.search).get("dev") === "1") {
      graphUrl.searchParams.set("dev", "1");
    }
    if (preview) graphUrl.searchParams.set("preview", "1");
    window.open(graphUrl.toString(), "_blank", "noopener,noreferrer");
  };
  const openOverviewProject = (projectId = "all") => {
    setTab("papers");
    setMobileSheet(false);
    setSelected([]);
    if (!preview) Promise.allSettled([loadPapersByProject(projectId), loadProjects()]);
  };

  return (
    <main className={`app-shell ${mobileSheet ? "collect-sheet-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <Sidebar onCollect={collect} onReset={resetCollection} status={status} onClose={() => setMobileSheet(false)} />
      {!preview && (
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={sidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
          aria-expanded={!sidebarCollapsed}
          onClick={() => setSidebarCollapsed((value) => !value)}
        >
          {sidebarCollapsed ? "›" : "‹"}
        </button>
      )}
      <button className={`mobile-collect-trigger ${tab !== "overview" ? "is-hidden" : ""}`} type="button" onClick={() => setMobileSheet(true)}><span>⌕</span> 논문 검색</button>
      <button className="mobile-sheet-backdrop" type="button" aria-label="논문 검색 창 닫기" onClick={() => setMobileSheet(false)} />
      <section className="content">
        <header className="page-header">
          <div><h1><span className="desktop-title">PubMed 논문을 <em>검색하고 분석하세요.</em></span><span className="mobile-title">PubMed 논문 검색·분석</span></h1></div>
          <div className="user-menu"><span className="profile-dot">{displayName.slice(0, 1)}</span><span>{displayName}</span><button type="button" className="text-button" onClick={logout}>로그아웃</button></div>
        </header>
        <nav className="tabs" aria-label="주요 메뉴">
          {[
            ["overview", "개요"],
            ["search", "검색 결과"],
            ["papers", "관심 논문"],
            ["chat", "AI 챗봇"],
          ].map(([name, label]) => (
            <button key={name} className={`tab ${tab === name ? "is-active" : ""}`} onClick={() => selectTab(name)}>
              {label}
            </button>
          ))}
          <button className="tab graph-launch-tab" type="button" onClick={openResearchGraph}>
            지식 그래프 <span aria-hidden="true">↗</span>
          </button>
        </nav>
        {error && <div className="app-error" role="alert"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        <Overview
          active={tab === "overview"}
          stats={overview}
          onProjectOpen={openOverviewProject}
        />
        <SearchResults
          active={tab === "search"}
          papers={searchResults}
          query={searchQuery}
          selectedPmids={searchSelected}
          onToggleSelection={toggleSearchSelection}
          onSelectAll={setSearchSelected}
          onSaveSelected={saveSelectedInterestPapers}
          onInterestToggle={toggleSearchInterest}
          interestPending={interestPending}
        />
        <Papers
          active={tab === "papers"}
          papers={papers}
          total={paperTotal}
          selected={selected}
          projects={projectSummary.projects}
          projectTotal={projectSummary.totalCount}
          unassignedCount={projectSummary.unassignedCount}
          keywordSummary={interestKeywordSummary}
          activeProjectId={paperProjectFilter}
          recentlyDeletedProject={recentlyDeletedProject}
          onToggle={togglePaper}
          onSearch={search}
          onProjectFilter={(projectId, params = "") => {
            setSelected([]);
            return loadPapersByProject(projectId, params);
          }}
          onKeywordFilter={(projectId, params = "") => {
            setSelected([]);
            return loadPaperListByProject(projectId, params);
          }}
          onCreateProject={createResearchProject}
          onUpdateProject={updateResearchProject}
          onDeleteProject={deleteResearchProject}
          onRestoreProject={restoreResearchProject}
          onAssignProjects={replacePaperProjects}
          onBulkAssignProjects={assignSelectedPapersToProjects}
          onSelectPapers={selectPapers}
          onChat={sendSelectedToChat}
          onUploadPdf={uploadPaperPdf}
          onRemoveInterest={removeInterestPaper}
          interestPending={interestPending}
          pdfUploadState={pdfUploadState}
        />
        <Chat active={tab === "chat"} token={token} conversations={conversations} conversationId={conversationId} selectedCount={selected.length} messages={messages} setMessages={setMessages} onOpen={openConversation} onNewChat={createEmptyChat} onDeleteConversation={deleteConversation} onResetSelection={resetChatSelection} onUploadPdf={uploadPaperPdf} pdfUploadState={pdfUploadState} call={call} />
      </section>
      {loading > 0 && <div className="loading-indicator is-visible" role="status"><div className="loading-panel"><span className="loading-spinner" /><p>데이터를 불러오는 중입니다.</p></div></div>}
    </main>
  );
}

function Sidebar({ onCollect, onReset, status, onClose }) {
  return (
    <aside className="sidebar clay-card">
      <a className="brand" href="/" aria-label="Publium 홈"><span>✦</span> Publium</a>
      <p className="brand-copy">논문을 모으고, 흐름을 읽고,<br />근거를 바탕으로 질문하세요.</p>
      <button className="sheet-close" type="button" onClick={onClose}>×</button>
      <form className="collect-form" onSubmit={onCollect}>
        <label htmlFor="collect-keyword">검색 키워드</label><input id="collect-keyword" name="keyword" placeholder="예: diabetes" required />
        <div className="field-row">
          <div><label htmlFor="collect-from">시작 연도</label><input id="collect-from" name="yearFrom" type="number" min="1900" max="2100" defaultValue="2020" required /></div>
          <div><label htmlFor="collect-to">종료 연도</label><input id="collect-to" name="yearTo" type="number" min="1900" max="2100" defaultValue={new Date().getFullYear()} required /></div>
        </div>
        <label htmlFor="collect-max">최대 검색 건수</label><input id="collect-max" name="maxResults" type="number" min="1" max="100" defaultValue="50" required />
        <button className="primary-button collect-action" type="submit"><span>⌕</span> PubMed 검색하기</button>
        <button className="reset-button collect-action" type="button" onClick={onReset}><span aria-hidden="true">↺</span> 관심 논문 및 채팅 초기화</button>
        <p className="form-status" role="status">{status}</p>
      </form>
      <div className="sidebar-note"><span>✦</span> 검색 결과는 자동으로 관심 논문에 저장되지 않습니다.</div>
    </aside>
  );
}

function Overview({ active, stats, onProjectOpen }) {
  return (
    <section id="overview" className={`tab-panel ${active ? "is-active" : ""}`}>
      <div className="metric-grid">
        <Metric tone="purple" icon="⌘" label="관심 논문" value={stats.totalPapers} note="직접 등록한 논문" />
        <Metric tone="mint" icon="▦" label="연구 프로젝트" value={stats.projectCount} note="진행 중인 연구 묶음" onClick={() => onProjectOpen("all")} />
        <Metric tone="peach" icon="!" label="미분류 논문" value={stats.unassignedCount} note="프로젝트 지정 필요" onClick={() => onProjectOpen("unassigned")} />
        <Metric tone="blue" icon="✓" label="원문 분석 완료" value={stats.analysisStatus.ready} note={`관심 논문 ${stats.totalPapers}편 중`} />
      </div>
      <div className="overview-insight-grid">
        <OverviewCard className="project-insight-card" eyebrow="RESEARCH WORKSPACES" title="프로젝트별 관심 논문">
          <button className="overview-card-action" type="button" onClick={() => onProjectOpen("all")}>전체 보기 <span aria-hidden="true">→</span></button>
          <ProjectDistribution projects={stats.projectDistribution} unassignedCount={stats.unassignedCount} onProjectOpen={onProjectOpen} />
        </OverviewCard>
        <OverviewCard className="analysis-insight-card" eyebrow="EVIDENCE READINESS" title="분석 준비 상태">
          <AnalysisReadiness status={stats.analysisStatus} total={stats.totalPapers} />
        </OverviewCard>
        <OverviewCard className="search-insight-card" eyebrow="RECENT SEARCH" title={stats.latestSearch ? `“${stats.latestSearch.keyword}” 검색 추이` : "최근 검색 추이"}>
          <SearchTrend entries={stats.papersByYear} search={stats.latestSearch} />
        </OverviewCard>
      </div>
      <div className="overview-continuation-grid">
        <OverviewCard className="recent-papers-card" eyebrow="RECENTLY SAVED" title="최근 관심 논문">
          <button className="overview-card-action" type="button" onClick={() => onProjectOpen("all")}>관심 논문 보기 <span aria-hidden="true">→</span></button>
          <RecentPapers papers={stats.recentPapers} onProjectOpen={onProjectOpen} />
        </OverviewCard>
        <OverviewCard className="next-actions-card" eyebrow="NEXT ACTIONS" title="지금 이어서 할 일">
          <NextActions stats={stats} onProjectOpen={onProjectOpen} />
        </OverviewCard>
      </div>
    </section>
  );
}

function OverviewCard({ className = "", eyebrow, title, children }) {
  return <article className={`overview-card clay-card ${className}`}><div className="overview-card-heading"><div><p className="eyebrow">{eyebrow}</p><h2 title={title}>{title}</h2></div></div>{children}</article>;
}

function Metric({ tone, icon, label, value, note, onClick }) {
  const content = <><span className={`metric-icon ${tone}`}>{icon}</span><div className="metric-copy"><p>{label}</p><div className="metric-value-row"><strong>{Number(value ?? 0).toLocaleString()}</strong><small>{note}</small></div></div>{onClick && <span className="metric-card-arrow" aria-hidden="true">→</span>}</>;
  if (onClick) return <button className="metric-card clay-card is-actionable" type="button" onClick={onClick}>{content}</button>;
  return <article className="metric-card clay-card">{content}</article>;
}

function formatOverviewDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(date);
}

function RecentPapers({ papers = [], onProjectOpen }) {
  if (!papers.length) return <div className="overview-empty recent-empty"><span aria-hidden="true">★</span><strong>최근 저장한 논문이 없습니다.</strong><p>검색 결과에서 관심 논문을 추가하면 여기에 바로 표시됩니다.</p></div>;
  return <ul className="recent-paper-list">{papers.map((paper, index) => {
    const project = paper.projects?.[0];
    const extraProjectCount = Math.max(0, (paper.projects?.length ?? 0) - 1);
    return <li key={paper.pmid} className="recent-paper-item">
      <span className="recent-paper-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
      <div className="recent-paper-copy">
        <h3 title={paper.title}>{paper.title}</h3>
        <p><span title={paper.journal}>{paper.journal}</span>{paper.pubYear > 0 && <><i>·</i>{paper.pubYear}</>}{paper.savedAt && <><i>·</i>{formatOverviewDate(paper.savedAt)} 저장</>}</p>
      </div>
      <button
        className={`recent-paper-project ${project ? "" : "is-unassigned"}`}
        type="button"
        style={project ? { "--project-color": project.color } : undefined}
        onClick={() => onProjectOpen(project?.id ?? "unassigned")}
        aria-label={`${project?.name ?? "미분류"} 관심 논문 보기`}
      >
        <i />
        <span>{project?.name ?? "미분류"}{extraProjectCount > 0 ? ` +${extraProjectCount}` : ""}</span>
      </button>
    </li>;
  })}</ul>;
}

function NextActions({ stats, onProjectOpen }) {
  const actions = [
    stats.unassignedCount > 0
      ? { icon: "!", title: "미분류 논문 정리", meta: `${Number(stats.unassignedCount).toLocaleString()}편`, projectId: "unassigned", tone: "peach" }
      : { icon: "✓", title: "논문 분류 상태 확인", meta: "분류 완료", projectId: "all", tone: "mint" },
    stats.projectCount > 0
      ? { icon: "▦", title: "프로젝트별 논문 확인", meta: `${Number(stats.projectCount).toLocaleString()}개`, projectId: "all", tone: "purple" }
      : { icon: "+", title: "첫 연구 프로젝트 만들기", meta: "관심 논문에서 시작", projectId: "all", tone: "purple" },
    stats.totalPapers > 0
      ? { icon: "↗", title: "AI 채팅용 논문 선택", meta: `${Number(stats.totalPapers).toLocaleString()}편 중 선택`, projectId: "all", tone: "blue" }
      : { icon: "⌕", title: "관심 논문 추가하기", meta: "검색부터 시작", projectId: "all", tone: "blue" },
  ];
  return <div className="next-action-list">{actions.map((action) => (
    <button key={action.title} type="button" onClick={() => onProjectOpen(action.projectId)}>
      <span className={`next-action-icon ${action.tone}`} aria-hidden="true">{action.icon}</span>
      <span><strong>{action.title}</strong><small>{action.meta}</small></span>
      <i aria-hidden="true">→</i>
    </button>
  ))}</div>;
}

function ProjectDistribution({ projects, unassignedCount, onProjectOpen }) {
  if (!projects.length && unassignedCount > 0) return <div className="project-start-state"><span><strong>{Number(unassignedCount).toLocaleString()}</strong>편</span><div><strong>모든 관심 논문이 아직 미분류입니다.</strong><p>프로젝트를 하나 만들고 관련 논문부터 묶어보세요.</p></div><button type="button" onClick={() => onProjectOpen("unassigned")}>프로젝트 만들고 분류하기 <span aria-hidden="true">→</span></button></div>;
  const entries = [
    ...(unassignedCount > 0 ? [{ id: "unassigned", name: "미분류", color: "#c7785c", paperCount: unassignedCount }] : []),
    ...projects,
  ];
  if (!entries.length) return <div className="overview-empty"><span aria-hidden="true">▦</span><strong>아직 프로젝트가 없습니다.</strong><p>관심 논문에서 프로젝트를 만들고 연구 주제별로 묶어보세요.</p><button type="button" onClick={() => onProjectOpen("all")}>관심 논문으로 이동</button></div>;
  const max = Math.max(...entries.map((entry) => Number(entry.paperCount)), 1);
  return <div className="project-insight-list">{entries.map((entry) => (
    <button key={entry.id} type="button" className="project-insight-row" onClick={() => onProjectOpen(entry.id)}>
      <span className="project-insight-label"><i style={{ "--project-color": entry.color }} /><span title={entry.name}>{entry.name}</span></span>
      <span className="project-insight-track"><i style={{ width: `${Math.max(3, Number(entry.paperCount) / max * 100)}%`, "--project-color": entry.color }} /></span>
      <strong>{Number(entry.paperCount).toLocaleString()}편</strong>
    </button>
  ))}</div>;
}

function AnalysisReadiness({ status, total }) {
  const entries = [
    { key: "ready", label: "원문 분석 완료", value: status.ready, color: "#4d9488" },
    { key: "abstract", label: "초록 기반", value: status.abstractOnly, color: "#7189b6" },
    { key: "processing", label: "처리 중", value: status.processing, color: "#c98263" },
  ];
  const denominator = Math.max(Number(total), 1);
  const readyRatio = total ? Math.round(Number(status.ready) / denominator * 100) : 0;
  if (!total) return <div className="overview-empty compact"><span aria-hidden="true">✓</span><strong>분석할 관심 논문이 없습니다.</strong><p>논문을 저장하면 근거 준비 상태를 확인할 수 있습니다.</p></div>;
  return <div className="analysis-readiness">
    <div className="analysis-score"><strong>{readyRatio}%</strong><span>원문 근거 준비</span></div>
    <div className="analysis-stack" aria-label={`원문 분석 완료 ${status.ready}편, 초록 기반 ${status.abstractOnly}편, 처리 중 ${status.processing}편`}>
      {entries.filter((entry) => entry.value > 0).map((entry) => <i key={entry.key} style={{ width: `${Number(entry.value) / denominator * 100}%`, "--status-color": entry.color }} />)}
    </div>
    <ul>{entries.map((entry) => <li key={entry.key}><span><i style={{ "--status-color": entry.color }} />{entry.label}</span><strong>{Number(entry.value).toLocaleString()}편</strong></li>)}</ul>
    <p className="analysis-note">원문이 없어도 제목과 초록으로 대화할 수 있습니다.</p>
  </div>;
}

function compactCount(value) {
  const number = Number(value ?? 0);
  if (number >= 100_000) return `${(number / 10_000).toFixed(1).replace(/\.0$/, "")}만`;
  if (number >= 10_000) return `${(number / 10_000).toFixed(1).replace(/\.0$/, "")}만`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/, "")}천`;
  return number.toLocaleString();
}

function SearchTrend({ entries, search }) {
  const normalized = Object.entries(entries ?? {}).map(([year, value]) => [Number(year), Number(value)]).filter(([year, value]) => Number.isFinite(year) && Number.isFinite(value)).sort(([left], [right]) => left - right);
  if (!search || !normalized.length) return <div className="overview-empty compact"><span aria-hidden="true">⌕</span><strong>아직 검색 기록이 없습니다.</strong><p>PubMed 검색 후 키워드별 연도 추이를 확인할 수 있습니다.</p></div>;
  const periodLabel = search.yearFrom === search.yearTo ? `${search.yearFrom}년` : `${search.yearFrom}–${search.yearTo}`;
  if (normalized.length === 1) return <div className="search-trend-summary">
    <div className="search-trend-meta"><span>{periodLabel} · PubMed 전체 결과</span><strong>총 {compactCount(search.totalMatches)}건</strong></div>
    <div className="single-year-trend"><span>{normalized[0][0]}</span><strong>{compactCount(normalized[0][1])}<small>건</small></strong><i style={{ "--single-bar": "100%" }} /></div>
    <p>한 해만 검색했습니다. 기간을 넓히면 연도별 증가·감소를 비교할 수 있습니다.</p>
  </div>;
  const width = 320;
  const height = 92;
  const paddingX = 9;
  const paddingY = 10;
  const max = Math.max(...normalized.map(([, value]) => value), 1);
  const point = ([, value], index) => ({
    x: normalized.length === 1 ? width / 2 : paddingX + index / (normalized.length - 1) * (width - paddingX * 2),
    y: height - paddingY - value / max * (height - paddingY * 2),
  });
  const points = normalized.map(point);
  const line = points.map(({ x, y }) => `${x},${y}`).join(" ");
  const area = `M ${points[0].x} ${height - paddingY} L ${points.map(({ x, y }) => `${x} ${y}`).join(" L ")} L ${points.at(-1).x} ${height - paddingY} Z`;
  const peakIndex = normalized.findIndex(([, value]) => value === max);
  return <div className="search-trend-summary">
    <div className="search-trend-meta"><span>{periodLabel} · PubMed 전체 결과</span><strong>총 {compactCount(search.totalMatches)}건</strong></div>
    <svg className="search-sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${search.keyword} 검색 결과의 연도별 변화`}>
      <path className="search-sparkline-area" d={area} />
      <polyline className="search-sparkline-line" points={line} />
      {points.map(({ x, y }, index) => <circle key={normalized[index][0]} cx={x} cy={y} r={index === peakIndex ? 4 : 2.5}><title>{normalized[index][0]}년 ${normalized[index][1].toLocaleString()}건</title></circle>)}
    </svg>
    <div className="search-trend-axis"><span>{normalized[0][0]}</span><strong>최고 {normalized[peakIndex][0]}년 · {compactCount(max)}건</strong><span>{normalized.at(-1)[0]}</span></div>
    <p>검색된 최대 100편이 아니라 PubMed의 전체 검색 건수입니다.</p>
  </div>;
}

function SearchResults({ active, papers, query, selectedPmids, onToggleSelection, onSelectAll, onSaveSelected, onInterestToggle, interestPending }) {
  const [activeKeyword, setActiveKeyword] = useState(null);
  const selectedSet = useMemo(() => new Set(selectedPmids.map(String)), [selectedPmids]);
  const visiblePapers = useMemo(() => papers.filter((paper) => paperHasKeyword(paper, activeKeyword)), [papers, activeKeyword]);
  const selectablePmids = useMemo(() => visiblePapers
    .filter((paper) => !paper.isSaved && !interestPending[String(paper.pmid)])
    .map((paper) => String(paper.pmid)), [visiblePapers, interestPending]);
  const selectedCount = selectablePmids.filter((pmid) => selectedSet.has(pmid)).length;
  const totalSelectedCount = papers.filter((paper) => !paper.isSaved && selectedSet.has(String(paper.pmid))).length;
  const allSelected = selectablePmids.length > 0 && selectedCount === selectablePmids.length;

  useEffect(() => setActiveKeyword(null), [query]);

  return (
    <section id="search" className={`tab-panel ${active ? "is-active" : ""}`}>
      <article className="clay-card table-card metadata-card">
        <div className="card-heading paper-card-heading">
          <div className="search-heading-copy">
            <p className="eyebrow">SEARCH RESULTS</p>
            <div className="search-title-row">
              <h2>{query ? `“${query}” 검색 결과` : "검색 결과"}</h2>
              <p className="search-result-notice">
                <span aria-hidden="true">i</span>
                검색 결과는 관심 논문에 자동 저장되지 않습니다. 보관할 논문만 직접 추가해주세요.
              </p>
            </div>
          </div>
          <div className="search-heading-actions">
            <p className="result-summary collection-count">{activeKeyword ? <><strong>{visiblePapers.length}</strong>/{papers.length}건 표시</> : <>총 <strong>{papers.length}</strong>건</>}</p>
            <button
              className="bulk-interest-button"
              type="button"
              disabled={!totalSelectedCount}
              onClick={onSaveSelected}
            >
              <span aria-hidden="true">★</span> 선택 {totalSelectedCount}편 관심 논문 추가
            </button>
          </div>
        </div>
        <KeywordCloud papers={papers} scope="search" activeKeyword={activeKeyword} onKeywordSelect={setActiveKeyword} />
        {papers.length > 0 && (
          <div className="search-selection-toolbar">
            <label>
              <input
                type="checkbox"
                checked={allSelected}
                disabled={!selectablePmids.length}
                onChange={() => onSelectAll(allSelected ? [] : selectablePmids)}
              />
              {activeKeyword ? "필터 결과의 미등록 논문 전체 선택" : "미등록 논문 전체 선택"}
            </label>
            <strong>{totalSelectedCount}편 선택</strong>
          </div>
        )}
        {!papers.length
          ? <p className="result-summary">왼쪽 검색창에서 키워드와 연도를 입력해 논문을 검색하세요.</p>
          : <div className="paper-list">{visiblePapers.map((paper) => (
            <PaperCard
              key={paper.id}
              paper={paper}
              checked={selectedSet.has(String(paper.pmid))}
              onToggle={() => onToggleSelection(paper)}
              selectionDisabled={paper.isSaved || Boolean(interestPending[String(paper.pmid)])}
              selectionTitle={paper.isSaved ? "이미 관심 논문에 등록됨" : "관심 논문으로 추가할 논문 선택"}
              interestSaved={paper.isSaved}
              onInterestToggle={() => onInterestToggle(paper)}
              interestBusy={Boolean(interestPending[String(paper.pmid)])}
            />
          ))}</div>}
      </article>
    </section>
  );
}

function ProjectFolderIcon() {
  return (
    <svg className="project-folder-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M2.75 5.5c0-.97.78-1.75 1.75-1.75h2.7l1.55 1.6h6.75c.97 0 1.75.78 1.75 1.75v7.4c0 .97-.78 1.75-1.75 1.75h-11A1.75 1.75 0 0 1 2.75 14.5v-9Z" />
      <path d="M3.15 8h13.7" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="control-chevron" viewBox="0 0 12 8" aria-hidden="true" focusable="false">
      <path d="m1.5 1.5 4.5 4 4.5-4" />
    </svg>
  );
}

function Papers({
  active,
  papers,
  total,
  selected,
  projects,
  projectTotal,
  unassignedCount,
  keywordSummary = emptyKeywordSummary,
  activeProjectId,
  recentlyDeletedProject,
  onToggle,
  onSearch,
  onProjectFilter,
  onKeywordFilter,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onRestoreProject,
  onAssignProjects,
  onBulkAssignProjects,
  onSelectPapers,
  onChat,
  onUploadPdf,
  onRemoveInterest,
  interestPending,
  pdfUploadState,
}) {
  const [sortMethod, setSortMethod] = useState("newest");
  const [evidenceFilter, setEvidenceFilter] = useState("all");
  const [activeKeyword, setActiveKeyword] = useState(null);
  const [projectEditor, setProjectEditor] = useState(null);
  const [assignmentPaper, setAssignmentPaper] = useState(null);
  const [bulkAssignmentOpen, setBulkAssignmentOpen] = useState(false);
  const [searchFiltersOpen, setSearchFiltersOpen] = useState(false);
  const filterFormRef = useRef(null);
  const selectedIds = useMemo(() => new Set(selected.map((paper) => String(paper.id))), [selected]);
  const activeProject = projects.find((project) => String(project.id) === String(activeProjectId));
  const sortedPapers = useMemo(() => [...papers].sort((left, right) => {
    if (sortMethod === "oldest") {
      return (Number(left.pubYear) || 9999) - (Number(right.pubYear) || 9999) ||
        String(left.pmid || "").localeCompare(String(right.pmid || ""), "en", { numeric: true });
    }
    if (sortMethod === "collected") {
      return new Date(right.collected_at || right.collectedAt || 0) - new Date(left.collected_at || left.collectedAt || 0);
    }
    if (sortMethod === "title") {
      return String(left.title || "").localeCompare(String(right.title || ""), "ko");
    }
    return (Number(right.pubYear) || 0) - (Number(left.pubYear) || 0) ||
      String(right.pmid || "").localeCompare(String(left.pmid || ""), "en", { numeric: true });
  }), [papers, sortMethod]);
  const visiblePapers = useMemo(() => sortedPapers.filter((paper) => {
    if (evidenceFilter === "full") return hasFullTextEvidence(paper);
    if (evidenceFilter === "abstract") return !hasFullTextEvidence(paper);
    return true;
  }), [sortedPapers, evidenceFilter]);
  const keywordFilteredPapers = useMemo(
    () => visiblePapers.filter((paper) => paperHasKeyword(paper, activeKeyword)),
    [visiblePapers, activeKeyword],
  );
  const allVisibleSelected = keywordFilteredPapers.length > 0
    && keywordFilteredPapers.every((paper) => selectedIds.has(String(paper.id)));

  const download = () => {
    const rows = [["PMID", "Title", "Abstract", "Journal", "Year", "Authors"], ...keywordFilteredPapers.map((p) => [p.pmid, p.title, p.abstract, p.journal, p.pubYear, p.authors])];
    const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = "publium-pubmed-metadata.csv"; link.click(); URL.revokeObjectURL(link.href);
  };
  const currentFilterParams = () => {
    const params = new URLSearchParams();
    if (filterFormRef.current) {
      for (const [key, value] of new FormData(filterFormRef.current)) {
        if (String(value).trim()) params.set(key, String(value).trim());
      }
    }
    return params;
  };
  const changeProjectFilter = (projectId) => {
    setActiveKeyword(null);
    const params = currentFilterParams();
    onProjectFilter(projectId, params.toString()).catch(() => {});
  };
  const changeKeywordFilter = (keyword) => {
    setActiveKeyword(keyword);
    const params = currentFilterParams();
    if (keyword) params.set("keyword", keyword);
    onKeywordFilter(activeProjectId, params.toString()).catch(() => {});
  };
  const removeProject = async () => {
    if (!activeProject) return;
    const confirmed = window.confirm(
      `“${activeProject.name}” 프로젝트를 보관 처리할까요?\n관심 논문 자체는 삭제되지 않으며, 바로 복구할 수 있습니다.`,
    );
    if (!confirmed) return;
    await onDeleteProject(activeProject).catch(() => {});
  };
  return (
    <section id="papers" className={`tab-panel ${active ? "is-active" : ""}`}>
      <article className="clay-card table-card metadata-card">
        <div className="card-heading paper-card-heading">
          <div><p className="eyebrow">INTEREST PAPERS</p><h2>관심 논문 목록</h2></div>
          <div className="paper-heading-actions">
            <button className="secondary-button" type="button" onClick={download}>↓ CSV 다운로드</button>
            <button className="secondary-button chat-send-button" type="button" disabled={!selected.length || selected.length > 5} onClick={onChat} title={selected.length > 5 ? "챗봇에는 최대 5편까지 보낼 수 있습니다." : "선택 논문을 챗봇으로 보내기"}>{selected.length > 5 ? `챗봇은 최대 5편 · 현재 ${selected.length}편` : `선택 ${selected.length}/5편 챗봇으로 보내기`} <span>→</span></button>
          </div>
        </div>
        <div className="selection-toolbar">
          <div className="interest-toolbar-row is-research-tools">
            <span className="toolbar-section-label">연구</span>
            <div className="interest-toolbar-main">
              <label className="paper-sort project-paper-filter" aria-label="프로젝트별 필터">
                <span>프로젝트</span>
                <select value={activeProjectId} onChange={(event) => changeProjectFilter(event.target.value)}>
                  <option value="all">전체 · {projectTotal}편</option>
                  {projects.map((project) => <option value={project.id} key={project.id}>{project.name} · {project.paper_count ?? 0}편</option>)}
                  <option value="unassigned">미분류 · {unassignedCount}편</option>
                </select>
              </label>
              {activeProject && <button type="button" className="project-action" onClick={() => setProjectEditor(activeProject)}>수정</button>}
              {activeProject && <button type="button" className="project-action is-danger" onClick={removeProject}>삭제</button>}
              <button type="button" className="project-create-button" onClick={() => setProjectEditor({})}><span aria-hidden="true">＋</span> 프로젝트</button>
              <KeywordCloud
                compact
                papers={papers}
                terms={keywordSummary.terms}
                paperCount={keywordSummary.paperCount}
                missingAbstractCount={keywordSummary.missingAbstractCount}
                scope="interest"
                activeKeyword={activeKeyword}
                onKeywordSelect={changeKeywordFilter}
              />
              <button className={`paper-search-toggle is-compact ${searchFiltersOpen ? "is-active" : ""}`} type="button" aria-expanded={searchFiltersOpen} aria-controls="interest-paper-search-form" onClick={() => setSearchFiltersOpen((value) => !value)}>
                <span aria-hidden="true">⌕</span><strong>논문 검색</strong><ChevronIcon />
              </button>
            </div>
          </div>
          <div className="interest-toolbar-row is-list-tools">
            <span className="toolbar-section-label">목록</span>
            <div className="paper-bulk-selection">
              <label className="paper-select-all">
                <input type="checkbox" checked={allVisibleSelected} disabled={!keywordFilteredPapers.length} onChange={() => onSelectPapers(keywordFilteredPapers, !allVisibleSelected)} />
                현재 목록 전체 선택
              </label>
              <button className="bulk-project-button" type="button" disabled={!selected.length} onClick={() => setBulkAssignmentOpen(true)}><ProjectFolderIcon /> 선택 {selected.length}편 프로젝트 분류</button>
              {selected.length > 0 && <button className="paper-selection-clear" type="button" onClick={() => onSelectPapers(selected, false)}>선택 해제</button>}
            </div>
            <div className="paper-list-controls">
              <label className="paper-sort evidence-filter" aria-label="논문 근거 범위"><select value={evidenceFilter} onChange={(event) => setEvidenceFilter(event.target.value)}><option value="all">전체 논문</option><option value="full">전문 분석 가능</option><option value="abstract">초록 기반</option></select></label>
              <label className="paper-sort" aria-label="논문 정렬 방법"><select value={sortMethod} onChange={(event) => setSortMethod(event.target.value)}><option value="newest">최신 논문순</option><option value="oldest">오래된 논문순</option><option value="collected">최근 관심 등록순</option><option value="title">제목순</option></select></label>
              <p className="result-summary collection-count">{activeKeyword ? <><strong>{keywordFilteredPapers.length}</strong>/{evidenceFilter === "all" ? total : visiblePapers.length}건 표시</> : <>총 <strong>{evidenceFilter === "all" ? total : visiblePapers.length}</strong>건</>}</p>
            </div>
          </div>
        </div>
        <form id="interest-paper-search-form" ref={filterFormRef} className={`filter-bar paper-search-form ${searchFiltersOpen ? "is-open" : ""}`} onSubmit={(event) => {
          setActiveKeyword(null);
          onSearch(event, activeProjectId);
        }}>
          <input name="keyword" placeholder="관심 논문의 제목·초록 검색" />
          <input name="yearFrom" type="number" placeholder="시작 연도" />
          <input name="yearTo" type="number" placeholder="종료 연도" />
          <input name="journal" placeholder="저널명" />
          <button className="primary-button">검색</button>
        </form>
        {recentlyDeletedProject && (
          <div className="project-undo" role="status">
            <span>“{recentlyDeletedProject.name}” 프로젝트를 보관 처리했습니다. 논문은 그대로 유지됩니다.</span>
            <button type="button" onClick={() => onRestoreProject().catch(() => {})}>되돌리기</button>
          </div>
        )}
        {!keywordFilteredPapers.length ? <p className="result-summary">조건에 맞는 관심 논문이 없습니다.</p> : <div className="paper-list">{keywordFilteredPapers.map((paper) => <PaperCard key={paper.id} paper={paper} checked={selectedIds.has(String(paper.id))} onToggle={() => onToggle(paper)} onUploadPdf={onUploadPdf} uploadStage={pdfUploadState[String(paper.pmid)]} interestSaved onInterestToggle={() => onRemoveInterest(paper)} interestBusy={Boolean(interestPending[String(paper.pmid)])} onManageProjects={() => setAssignmentPaper(paper)} />)}</div>}
      </article>
      {projectEditor && (
        <ProjectEditorDialog
          project={projectEditor.id ? projectEditor : null}
          onClose={() => setProjectEditor(null)}
          onSubmit={(input) => projectEditor.id
            ? onUpdateProject(projectEditor.id, input)
            : onCreateProject(input)}
        />
      )}
      {assignmentPaper && (
        <PaperProjectDialog
          paper={assignmentPaper}
          projects={projects}
          onClose={() => setAssignmentPaper(null)}
          onSave={(projectIds) => onAssignProjects(assignmentPaper, projectIds)}
        />
      )}
      {bulkAssignmentOpen && (
        <BulkPaperProjectDialog
          papers={selected}
          projects={projects}
          onClose={() => setBulkAssignmentOpen(false)}
          onSave={(projectIds, mode) => onBulkAssignProjects(selected, projectIds, mode)}
        />
      )}
    </section>
  );
}

function ProjectEditorDialog({ project, onClose, onSubmit }) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [color, setColor] = useState(project?.color ?? "#7c6ee6");
  const [busy, setBusy] = useState(false);
  const colors = ["#7c6ee6", "#5c87d9", "#3f9f8d", "#dc8d5d", "#c26982", "#727b96"];
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSubmit({ name: name.trim(), description: description.trim(), color });
      onClose();
    } catch {
      // The shared app error banner reports request failures.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onSubmit={submit}>
        <header>
          <div><p className="eyebrow">RESEARCH PROJECT</p><h2 id="project-dialog-title">{project ? "프로젝트 수정" : "새 프로젝트 만들기"}</h2></div>
          <button type="button" className="project-dialog-close" onClick={onClose} aria-label="닫기">×</button>
        </header>
        <label>프로젝트 이름<input autoFocus value={name} maxLength={80} required placeholder="예: 당뇨병 예측 모델" onChange={(event) => setName(event.target.value)} /></label>
        <label>설명 <span>선택</span><textarea value={description} maxLength={500} rows={3} placeholder="연구 목적이나 분류 기준을 짧게 적어두세요." onChange={(event) => setDescription(event.target.value)} /></label>
        <fieldset className="project-color-picker">
          <legend>구분 색상</legend>
          <div>{colors.map((value) => <button className={color === value ? "is-selected" : ""} style={{ "--swatch": value }} type="button" key={value} aria-label={`${value} 색상`} aria-pressed={color === value} onClick={() => setColor(value)} />)}</div>
        </fieldset>
        <footer><button type="button" className="secondary-button" onClick={onClose}>취소</button><button type="submit" className="primary-button" disabled={busy || !name.trim()}>{busy ? "저장 중…" : project ? "변경 저장" : "프로젝트 만들기"}</button></footer>
      </form>
    </div>
  );
}

function PaperProjectDialog({ paper, projects, onClose, onSave }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set((paper.projects ?? []).map((project) => String(project.id))));
  const [busy, setBusy] = useState(false);
  const toggle = (projectId) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(String(projectId))) next.delete(String(projectId));
    else next.add(String(projectId));
    return next;
  });
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSave([...selectedIds]);
      onClose();
    } catch {
      // The shared app error banner reports request failures.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="project-dialog paper-project-dialog" role="dialog" aria-modal="true" aria-labelledby="paper-project-dialog-title" onSubmit={submit}>
        <header>
          <div><p className="eyebrow">ORGANIZE PAPER</p><h2 id="paper-project-dialog-title">논문 프로젝트 분류</h2></div>
          <button type="button" className="project-dialog-close" onClick={onClose} aria-label="닫기">×</button>
        </header>
        <div className="paper-project-dialog-title"><span>PMID {paper.pmid}</span><strong>{paper.title}</strong></div>
        {!projects.length ? <div className="project-empty"><ProjectFolderIcon /><strong>아직 만든 프로젝트가 없습니다.</strong><p>창을 닫고 ‘새 프로젝트’를 먼저 만들어주세요.</p></div> : (
          <div className="project-check-list">{projects.map((project) => (
            <label key={project.id}>
              <input type="checkbox" checked={selectedIds.has(String(project.id))} onChange={() => toggle(project.id)} />
              <i style={{ "--project-color": project.color }} aria-hidden="true" />
              <span><strong>{project.name}</strong>{project.description && <small>{project.description}</small>}</span>
              <em>{project.paper_count ?? 0}편</em>
            </label>
          ))}</div>
        )}
        <p className="project-dialog-help">여러 프로젝트를 동시에 선택할 수 있습니다. 아무것도 선택하지 않으면 미분류로 이동합니다.</p>
        <footer><button type="button" className="secondary-button" onClick={onClose}>취소</button><button type="submit" className="primary-button" disabled={busy}>{busy ? "저장 중…" : "분류 저장"}</button></footer>
      </form>
    </div>
  );
}

function BulkPaperProjectDialog({ papers, projects, onClose, onSave }) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [mode, setMode] = useState("add");
  const [busy, setBusy] = useState(false);
  const toggle = (projectId) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(String(projectId))) next.delete(String(projectId));
    else next.add(String(projectId));
    return next;
  });
  const submit = async (event) => {
    event.preventDefault();
    if (mode === "add" && !selectedIds.size) return;
    setBusy(true);
    try {
      await onSave([...selectedIds], mode);
      onClose();
    } catch {
      // The shared app error banner reports request failures.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="project-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="project-dialog paper-project-dialog bulk-project-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-project-dialog-title" onSubmit={submit}>
        <header>
          <div><p className="eyebrow">BULK ORGANIZE</p><h2 id="bulk-project-dialog-title">선택 논문 일괄 분류</h2></div>
          <button type="button" className="project-dialog-close" onClick={onClose} aria-label="닫기">×</button>
        </header>
        <p className="bulk-project-count"><strong>{papers.length}편</strong>의 관심 논문에 같은 분류를 적용합니다.</p>
        <fieldset className="bulk-project-mode">
          <legend>적용 방식</legend>
          <label className={mode === "add" ? "is-selected" : ""}>
            <input type="radio" name="mode" value="add" checked={mode === "add"} onChange={() => setMode("add")} />
            <span><strong>프로젝트 추가</strong><small>각 논문의 기존 분류는 그대로 유지합니다.</small></span>
          </label>
          <label className={mode === "replace" ? "is-selected" : ""}>
            <input type="radio" name="mode" value="replace" checked={mode === "replace"} onChange={() => setMode("replace")} />
            <span><strong>프로젝트 교체</strong><small>선택한 프로젝트만 남기고 기존 분류를 해제합니다.</small></span>
          </label>
        </fieldset>
        {!projects.length ? <div className="project-empty"><ProjectFolderIcon /><strong>아직 만든 프로젝트가 없습니다.</strong><p>프로젝트를 만든 뒤 다시 시도해주세요.</p></div> : (
          <div className="project-check-list">{projects.map((project) => (
            <label key={project.id}>
              <input type="checkbox" checked={selectedIds.has(String(project.id))} onChange={() => toggle(project.id)} />
              <i style={{ "--project-color": project.color }} aria-hidden="true" />
              <span><strong>{project.name}</strong>{project.description && <small>{project.description}</small>}</span>
              <em>{project.paper_count ?? 0}편</em>
            </label>
          ))}</div>
        )}
        {mode === "replace" && !selectedIds.size
          ? <p className="project-dialog-help is-warning">프로젝트를 선택하지 않고 저장하면 {papers.length}편 모두 미분류로 이동합니다.</p>
          : <p className="project-dialog-help">여러 프로젝트를 동시에 선택할 수 있습니다.</p>}
        <footer><button type="button" className="secondary-button" onClick={onClose}>취소</button><button type="submit" className="primary-button" disabled={busy || !papers.length || (mode === "add" && !selectedIds.size)}>{busy ? "적용 중…" : `${papers.length}편에 적용`}</button></footer>
      </form>
    </div>
  );
}

function PaperCard({ paper, checked = false, onToggle, selectionDisabled = false, selectionTitle = "논문 선택", onUploadPdf, uploadStage, interestSaved, onInterestToggle, interestBusy = false, onManageProjects }) {
  const [abstractExpanded, setAbstractExpanded] = useState(false);
  const [translation, setTranslation] = useState({ status: "idle", title: "", abstract: "", error: "" });
  const [showTranslation, setShowTranslation] = useState(false);
  const uploadInputRef = useRef(null);
  const pubmed = paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : null;
  const doi = paper.doi ? `https://doi.org/${paper.doi}` : (!paper.pmcid ? paper.fullTextUrl : null);
  const pmc = paper.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${paper.pmcid}/` : null;
  const documentState = paperDocumentState(paper);
  const uploadLabel = {
    extracting: "PDF 읽는 중…",
    uploading: "PDF 업로드 중…",
    processing: "전문 처리 중…",
  }[uploadStage] || (paper.hasUploadedPdf ? "PDF 다시 업로드" : "PDF 업로드");
  const choosePdf = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await onUploadPdf(paper, file);
    } catch {
      // The shared app error banner reports upload failures.
    } finally {
      event.target.value = "";
    }
  };
  const translateWithChrome = async () => {
    if (translation.status === "done") {
      setShowTranslation((value) => !value);
      return;
    }

    setTranslation({ status: "preparing", title: "", abstract: "", error: "" });
    try {
      const translatorPromise = getChromeEnglishToKoreanTranslator((progress) => {
        setTranslation((current) => ({ ...current, status: "downloading", progress }));
      });
      const translator = await translatorPromise;
      setTranslation((current) => ({ ...current, status: "translating" }));

      const title = paper.title ? await translator.translate(paper.title) : "";
      const abstract = paper.abstract ? await translator.translate(paper.abstract) : "";
      setTranslation({ status: "done", title, abstract, error: "" });
      setShowTranslation(true);
    } catch {
      chromeTranslatorPromise = null;
      setTranslation({
        status: "error",
        title: "",
        abstract: "",
        error: "Chrome 내장 번역을 사용할 수 없습니다. 데스크톱 Chrome 138 이상에서 다시 시도해 주세요.",
      });
    }
  };
  const translationBusy = ["preparing", "downloading", "translating"].includes(translation.status);
  const translationLabel = translation.status === "downloading"
    ? `Chrome 번역 준비 ${translation.progress ?? 0}%`
    : translationBusy
      ? "Chrome 번역 중…"
      : translation.status === "done"
        ? showTranslation ? "영문 원문 보기" : "한국어 번역 보기"
        : translation.status === "error" ? "번역 다시 시도" : "한국어 번역";
  const displayedTitle = showTranslation && translation.title ? translation.title : paper.title;
  const displayedAbstract = showTranslation && translation.abstract ? translation.abstract : paper.abstract;
  return (
    <article className={`paper-card ${checked ? "is-selected" : ""} ${onToggle ? "" : "is-search-result"}`}>
      <div className={`paper-card-head ${onToggle ? "" : "no-selection"}`}>
        {onToggle && <label className={`paper-select ${selectionDisabled ? "is-disabled" : ""}`} aria-label={`${paper.title || "논문"} 선택`} title={selectionTitle}><input type="checkbox" checked={checked} disabled={selectionDisabled} onChange={onToggle} /></label>}
        <div><div className="paper-meta">{interestSaved && (
          <div className="paper-project-tags" aria-label="지정된 프로젝트">
            {(paper.projects ?? []).length
              ? paper.projects.map((project) => <span key={project.id} style={{ "--project-color": project.color }}><i aria-hidden="true" />{project.name}</span>)
              : <span className="is-unassigned"><i aria-hidden="true" />미분류</span>}
          </div>
        )}<span className="meta-chip journal-chip" title={paper.journal || "저널 정보 없음"}><span>{paper.journal || "저널 정보 없음"}</span></span><span className="meta-chip">{paper.pubYear || "연도 정보 없음"}</span><span className="pmid-chip">PMID {paper.pmid || "-"}</span><span className={`analysis-chip is-${documentState.mode}`}>{documentState.label}</span>{showTranslation && <span className="analysis-chip is-full">Chrome 한국어 번역</span>}</div><h3>{displayedTitle || "제목 없음"}</h3></div>
      </div>
      <p className="paper-author"><strong>저자</strong><span>{Array.isArray(paper.authors) ? paper.authors.join(", ") : paper.authors || "등록된 저자 정보가 없습니다."}</span></p>
      <div className="abstract-heading"><span>{showTranslation ? "ABSTRACT · 한국어 번역" : "ABSTRACT"}</span><button className="abstract-toggle" type="button" onClick={() => setAbstractExpanded((value) => !value)} aria-expanded={abstractExpanded}>{abstractExpanded ? "초록 접기 ↑" : "초록 전체 보기 ↓"}</button></div>
      <p className={`abstract-preview ${abstractExpanded ? "is-expanded" : ""}`}>{displayedAbstract || "초록 내용 없음"}</p>
      <div className="paper-links">
        {onInterestToggle && (
          <button
            className={`interest-button ${interestSaved ? "is-saved" : ""}`}
            type="button"
            disabled={interestBusy}
            aria-pressed={Boolean(interestSaved)}
            onClick={onInterestToggle}
          >
            {interestBusy ? "처리 중…" : interestSaved ? "★ 관심 논문 해제" : "＋ 관심 논문 추가"}
          </button>
        )}
        {onManageProjects && <button className="paper-project-button" type="button" onClick={onManageProjects}><ProjectFolderIcon /> 프로젝트 분류</button>}
        <button
          className={`chrome-translate-button ${showTranslation ? "is-active" : ""} ${translationBusy ? "is-loading" : ""}`}
          type="button"
          disabled={translationBusy || (!paper.title && !paper.abstract)}
          aria-pressed={showTranslation}
          title="Chrome 내장 번역을 사용하며 서버 API를 호출하지 않습니다."
          onClick={translateWithChrome}
        >
          {translationLabel}
        </button>
        {paper.pdfUrl && <a className="pdf-view-link" href={paper.pdfUrl} target="_blank" rel="noreferrer">PDF 보기</a>}
        {onUploadPdf && <button className="pdf-upload-button" type="button" disabled={Boolean(uploadStage)} onClick={() => uploadInputRef.current?.click()}>{uploadLabel}</button>}
        {onUploadPdf && <input ref={uploadInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={choosePdf} />}
        {pubmed && <a href={pubmed} target="_blank" rel="noreferrer">PubMed 보기 ↗</a>}
        {doi && <a href={doi} target="_blank" rel="noreferrer">출판사 원문 ↗</a>}
        {pmc && <a className="full-text-link" href={pmc} target="_blank" rel="noreferrer">PMC 무료 원문 ↗</a>}
        {!doi && !pmc && !paper.pdfUrl && <span>초록만 제공</span>}
      </div>
      {translation.error && <p className="translation-error" role="status">{translation.error}</p>}
    </article>
  );
}

function PaperReader({ reader, loading, error, source, onClose, onUploadPdf, uploadStage, onReload, token }) {
  const highlightRef = useRef(null);
  const uploadInputRef = useRef(null);
  const sections = reader?.document?.sections ?? [];
  const pdfUrl = reader?.paper?.pdfUrl ?? reader?.paper?.pdf_url;
  const [viewMode, setViewMode] = useState("text");
  const highlightKey = useMemo(
    () => bestSourceParagraph(sections, source),
    [sections, source],
  );

  useEffect(() => {
    setViewMode(sections.length || !pdfUrl ? "text" : "pdf");
  }, [reader?.paper?.pmid, sections.length, pdfUrl]);

  useEffect(() => {
    if (!highlightKey) return;
    const timer = window.setTimeout(() => {
      highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [highlightKey]);

  const choosePdf = async (event) => {
    const file = event.target.files?.[0];
    if (!file || !reader?.paper) return;
    try {
      await onUploadPdf(reader.paper, file);
      await onReload(reader.paper);
      setViewMode("pdf");
    } catch {
      // The shared app error banner reports upload failures.
    } finally {
      event.target.value = "";
    }
  };

  return (
    <aside className="paper-reader clay-card" aria-label="논문 원문 뷰어">
      <header className="paper-reader-header">
        <div>
          <p className="eyebrow">PAPER READER</p>
          <h2>{reader?.paper?.title || "논문 원문"}</h2>
        </div>
        <button className="reader-close" type="button" onClick={onClose} aria-label="원문 닫기">×</button>
      </header>
      {reader?.paper && (
        <div className="reader-meta-row">
          <div className="reader-meta">
            <span>{reader.paper.journal || "저널 정보 없음"}</span>
            <span>{reader.paper.publicationYear || "연도 정보 없음"}</span>
            <strong>{reader.document?.status === "full_text" ? (reader.paper.pdfSource === "user_pdf" ? "업로드 PDF 전문" : "PMC 공개 원문") : "초록 제공"}</strong>
          </div>
          <div className="reader-document-actions">
            {(reader.paper.externalPdfUrl || pdfUrl) && <a href={reader.paper.externalPdfUrl || pdfUrl} target="_blank" rel="noreferrer">PDF 새 창 ↗</a>}
            <button type="button" onClick={() => openExternalPaperWindow(reader.paper)}>외부 원문 ↗</button>
            <button type="button" disabled={Boolean(uploadStage)} onClick={() => uploadInputRef.current?.click()}>{uploadStage ? "PDF 처리 중…" : reader.paper.hasUploadedPdf ? "PDF 교체" : "PDF 업로드"}</button>
            <input ref={uploadInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={choosePdf} />
          </div>
        </div>
      )}
      {(sections.length > 0 || pdfUrl) && (
        <div className="reader-view-tabs" role="tablist" aria-label="논문 보기 방식">
          <button className={viewMode === "text" ? "is-active" : ""} type="button" role="tab" aria-selected={viewMode === "text"} onClick={() => setViewMode("text")}>본문</button>
          <button className={viewMode === "pdf" ? "is-active" : ""} type="button" role="tab" aria-selected={viewMode === "pdf"} disabled={!pdfUrl} onClick={() => setViewMode("pdf")}>PDF</button>
        </div>
      )}
      {highlightKey && viewMode === "text" && (
        <p className="reader-source-notice">
          <span>✦</span> 답변에 참고한 문단을 강조했습니다.
        </p>
      )}
      {!loading && !error && viewMode === "text" && reader?.document?.status === "abstract_only" && (
        <p className="reader-availability-note">
          이 논문은 PMC 공개 전문이 없어 저장된 초록만 표시됩니다. 전체 내용은 외부 원문에서 확인할 수 있습니다.
        </p>
      )}
      {viewMode === "pdf" && pdfUrl ? (
        <PdfViewer url={pdfUrl} title={reader?.paper?.title || "논문"} token={token} />
      ) : <div className="paper-reader-body">
        {loading && <p className="reader-state">원문을 불러오는 중입니다…</p>}
        {!loading && error && <p className="reader-state is-error">{error}</p>}
        {!loading && !error && !sections.length && (
          <p className="reader-state">표시할 수 있는 공개 원문이나 초록이 없습니다.</p>
        )}
        {!loading && !error && sections.map((section, sectionIndex) => (
          <section className="reader-section" key={section.id ?? sectionIndex}>
            <h3>{section.title || "본문"}</h3>
            {section.paragraphs.map((paragraph, paragraphIndex) => {
              const key = `${sectionIndex}-${paragraphIndex}`;
              const highlighted = key === highlightKey;
              const range = highlighted ? sourceHighlightRange(paragraph, source) : null;
              return (
                <p
                  className={range ? "has-source-highlight" : ""}
                  key={key}
                  ref={range ? highlightRef : undefined}
                >
                  {range
                    ? <>
                      {paragraph.slice(0, range.start)}
                      <mark className="source-highlight">{paragraph.slice(range.start, range.end)}</mark>
                      {paragraph.slice(range.end)}
                    </>
                    : paragraph}
                </p>
              );
            })}
          </section>
        ))}
      </div>}
    </aside>
  );
}

function PdfViewer({ url, title, token }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const documentRef = useRef(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [state, setState] = useState("loading");

  useEffect(() => {
    let active = true;
    setState("loading");
    setPageNumber(1);
    const source = url.startsWith("/api/")
      ? { url: apiUrl(url), httpHeaders: { Authorization: `Bearer ${token}` } }
      : url;
    loadPdfDocument(source).then((document) => {
      if (!active) return document.destroy();
      documentRef.current = document;
      setPageCount(document.numPages);
      setState("ready");
      return undefined;
    }).catch(() => {
      if (active) setState("error");
    });
    return () => {
      active = false;
      documentRef.current?.destroy();
      documentRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    if (state !== "ready" || !documentRef.current || !canvasRef.current) return undefined;
    let cancelled = false;
    let renderTask;
    documentRef.current.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const availableWidth = Math.max(280, (containerRef.current?.clientWidth || 640) - 24);
      const viewport = page.getViewport({ scale: Math.min(2, availableWidth / base.width) });
      const canvas = canvasRef.current;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext("2d");
      renderTask = page.render({
        canvasContext: context,
        viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
      });
      return renderTask.promise;
    }).catch((renderError) => {
      if (!cancelled && renderError?.name !== "RenderingCancelledException") setState("error");
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pageNumber, state, url]);

  return (
    <div className="reader-pdf-frame" ref={containerRef}>
      <div className="reader-pdf-toolbar">
        <button type="button" disabled={pageNumber <= 1} onClick={() => setPageNumber((value) => value - 1)}>← 이전</button>
        <span>{pageCount ? `${pageNumber} / ${pageCount}` : "PDF 불러오는 중"}</span>
        <button type="button" disabled={!pageCount || pageNumber >= pageCount} onClick={() => setPageNumber((value) => value + 1)}>다음 →</button>
      </div>
      {state === "loading" && <p className="reader-state">PDF를 불러오는 중입니다…</p>}
      {state === "error" && <p className="reader-state is-error">PDF를 화면에 표시하지 못했습니다. PDF 새 창 버튼을 이용해주세요.</p>}
      <div className="reader-pdf-page" hidden={state !== "ready"}>
        <canvas ref={canvasRef} aria-label={`${title} PDF ${pageNumber}페이지`} />
      </div>
    </div>
  );
}

function Chat({ active, token, conversations, conversationId, selectedCount, messages, setMessages, onOpen, onNewChat, onDeleteConversation, onResetSelection, onUploadPdf, pdfUploadState, call }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatTitle, setNewChatTitle] = useState("");
  const [creatingChat, setCreatingChat] = useState(false);
  const [reader, setReader] = useState(null);
  const [readerSource, setReaderSource] = useState(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState("");
  const current = conversations.find((item) => String(item.id ?? item.conversationId) === String(conversationId));
  const currentPapers = (current?.papers ?? []).map(normalizePaper);
  const currentEvidenceMode = evidenceModeForPapers(currentPapers);

  useEffect(() => {
    setReader(null);
    setReaderSource(null);
    setReaderError("");
  }, [conversationId]);

  const openPaper = async (paper, source = null) => {
    if (!conversationId || !paper?.pmid) return;
    setReader({
      paper: {
        pmid: paper.pmid,
        title: paper.title,
        journal: paper.journal,
        publicationYear: paper.pubYear,
        pdfUrl: paper.pdfUrl,
        pdfSource: paper.pdfSource,
        hasUploadedPdf: paper.hasUploadedPdf,
        uploadedPdfName: paper.uploadedPdfName,
        pmcid: paper.pmcid,
        doi: paper.doi,
        pubmedUrl: paper.pubmedUrl,
        fullTextUrl: paper.fullTextUrl,
      },
      document: { sections: [] },
    });
    setReaderSource(source);
    setReaderError("");
    setReaderLoading(true);
    try {
      const sourceDocumentId = source?.documentId ?? source?.document_id;
      const documentQuery = sourceDocumentId
        ? `?documentId=${encodeURIComponent(sourceDocumentId)}`
        : "";
      const body = await call(`/api/chat/conversations/${encodeURIComponent(conversationId)}/papers/${encodeURIComponent(paper.pmid)}/document${documentQuery}`);
      setReader({ ...body, paper: normalizePaper(body.paper ?? {}) });
    } catch (requestError) {
      setReaderError(requestError.message);
    } finally {
      setReaderLoading(false);
    }
  };

  const send = async (event) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || !conversationId || sending) return;
    const userMessage = { id: `u-${Date.now()}`, role: "user", content: message };
    const assistantId = `a-${Date.now()}`;
    setMessages((list) => [...list, userMessage, {
      id: assistantId,
      role: "assistant",
      content: "",
      citations: [],
    }]);
    setInput("");
    setSending(true);
    try {
      await stream("/api/chat/stream", {
        token,
        body: { conversationId, message },
        onToken: (part) => setMessages((list) => list.map((item) =>
          item.id === assistantId ? { ...item, content: item.content + part } : item)),
        onSources: (sources) => setMessages((list) => list.map((item) =>
          item.id === assistantId ? { ...item, citations: sources } : item)),
      });
    } catch (error) {
      setMessages((list) => list.map((item) =>
        item.id === assistantId ? { ...item, content: error.message, citations: [] } : item));
    } finally {
      setSending(false);
    }
  };

  const clear = async () => {
    if (!conversationId || !window.confirm("현재 대화 내역을 모두 삭제할까요?")) return;
    await call(`/api/chat/${encodeURIComponent(conversationId)}/messages`, { method: "DELETE" });
    setMessages([]);
  };

  const removeRoom = async () => {
    if (!conversationId || !window.confirm("현재 논문 채팅방을 삭제할까요? 대화 내역도 함께 삭제됩니다.")) return;
    await onDeleteConversation(conversationId);
  };

  const createNamedChat = async (event) => {
    event.preventDefault();
    const title = newChatTitle.trim();
    if (!title || creatingChat) return;
    setCreatingChat(true);
    try {
      await onNewChat(title);
      setNewChatTitle("");
      setNewChatOpen(false);
    } finally {
      setCreatingChat(false);
    }
  };

  return (
    <section id="chat" className={`tab-panel ${active ? "is-active" : ""}`}>
      <div className="chat-panel-actions" aria-label="채팅 관리">
        <button className="secondary-button reset-selection-button" type="button" onClick={onResetSelection} disabled={!conversationId && !selectedCount}>선택 논문 초기화</button>
        <button className="secondary-button history-delete-button" type="button" onClick={clear} disabled={!conversationId}>대화 내역 삭제</button>
        <button className="secondary-button room-delete-button" type="button" onClick={removeRoom} disabled={!conversationId || sending}>채팅방 삭제</button>
      </div>
      <div className={`chat-layout ${reader ? "has-reader" : ""}`}>
        {!reader && <aside className="conversation-list clay-card">
          <div><p className="eyebrow">CONVERSATIONS</p><h2>논문 채팅방</h2></div>
          <button className="new-chat-button" type="button" onClick={() => setNewChatOpen(true)}>
            <strong>＋ 새 채팅</strong><small>논문 없이 시작</small>
          </button>
          {conversations.length ? conversations.map((room) => {
            const id = room.id ?? room.conversationId;
            const roomEvidenceMode = evidenceModeForRoom(room);
            return (
              <button
                className={String(id) === String(conversationId) ? "is-active" : ""}
                key={id}
                onClick={() => onOpen(id)}
              >
                <strong>{room.title || "논문 분석"}</strong>
                <small>{room.paperCount ?? room.paper_count ?? room.papers?.length ?? 0}편의 논문 · <span className={`room-evidence ${roomEvidenceMode.mode}`}>{roomEvidenceMode.label}</span></small>
              </button>
            );
          }) : <p className="result-summary">새 채팅을 열거나 논문을 선택해 시작하세요.</p>}
        </aside>}
        <div className={`chat-workspace ${reader ? "has-reader" : ""}`}>
          {reader && (
            <PaperReader
              reader={reader}
              loading={readerLoading}
              error={readerError}
              source={readerSource}
              onUploadPdf={onUploadPdf}
              uploadStage={pdfUploadState[String(reader?.paper?.pmid)]}
              onReload={(paper) => openPaper(normalizePaper(paper))}
              token={token}
              onClose={() => {
                setReader(null);
                setReaderSource(null);
              }}
            />
          )}
          <article className="chat-card clay-card">
            <div className="card-heading chat-card-heading">
              <div className="chat-heading-top">
                <p className="eyebrow">PAPER-GROUNDED AI</p>
                <span className={`chat-evidence-badge ${currentEvidenceMode.mode}`}>{currentEvidenceMode.label}</span>
              </div>
              <h2>{current?.title || "AI 논문 탐색 도우미"}</h2>
            </div>
            {currentPapers.length > 0 && (
              <div className="chat-paper-chips">
                {currentPapers.map((paper, index) => (
                  <div className="paper-view-buttons" key={paper.id ?? paper.pmid}>
                    <span>논문 {index + 1}</span>
                    <em className={`is-${paperDocumentState(paper).mode}`}>{paperDocumentState(paper).label}</em>
                    <button
                      className={String(reader?.paper?.pmid) === String(paper.pmid) ? "is-active" : ""}
                      type="button"
                      title={paper.title || "논문 원문 보기"}
                      onClick={() => openPaper(paper)}
                    >
                      원문 보기
                    </button>
                    <button
                      type="button"
                      title={`${paper.title || "논문"} 외부 페이지 열기`}
                      onClick={() => openExternalPaperWindow(paper)}
                    >
                      외부 원문 ↗
                    </button>
                  </div>
                ))}
              </div>
            )}
            {currentEvidenceMode.mode === "abstract" && (
              <p className="chat-evidence-note">이 채팅방은 저장된 제목과 초록만 근거로 답변하며, 본문 세부사항은 추측하지 않습니다.</p>
            )}
            {currentEvidenceMode.mode === "mixed" && (
              <p className="chat-evidence-note">PMC 전문과 초록만 제공된 논문이 함께 선택되어 있습니다. 논문별 근거 범위가 다릅니다.</p>
            )}
            <div className="chat-log">
              {!conversationId || !messages.length ? (
                <div className="chat-message assistant intro-message">
                  <span className="avatar">✦</span>
                  <div>{conversationId ? (currentPapers.length ? INTRO : "새 채팅입니다. 궁금한 연구 주제나 논문 분석 방향에 대해 질문해보세요.") : "논문 채팅방을 선택하거나 새 채팅을 시작해주세요."}</div>
                </div>
              ) : messages.map((message, index) => {
                const sources = messageSources(message);
                return (
                  <div className={`chat-message ${message.role}`} key={message.id ?? index}>
                    <span className="avatar">{message.role === "assistant" ? "✦" : "나"}</span>
                    <div>
                      <div className="message-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                      {message.role === "assistant" && sources.length > 0 && (
                        <div className="message-sources">
                          <span>답변 근거</span>
                          <div>
                            {sources.map((source, sourceIndex) => {
                              const paperIndex = currentPapers.findIndex((paper) =>
                                String(paper.pmid) === String(source.pmid));
                              const paper = currentPapers[paperIndex];
                              return (
                                <button
                                  type="button"
                                  key={source.id ?? `${source.pmid}-${sourceIndex}`}
                                  disabled={!paper}
                                  onClick={() => openPaper(paper, source)}
                                >
                                  논문 {paperIndex >= 0 ? paperIndex + 1 : "–"} · {source.section || "본문"}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <form className="chat-form" onSubmit={send}>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={conversationId ? (currentPapers.length ? "선택한 논문에 대해 질문하세요" : "연구 주제나 논문 분석 방향에 대해 질문하세요") : "먼저 채팅방을 열어주세요"}
                disabled={!conversationId || sending}
                required
              />
              <button className="primary-button" disabled={!conversationId || sending}>보내기 <span>→</span></button>
            </form>
            <p className="chat-disclaimer">의료적 진단·처방·복용 방법은 제공하지 않습니다.</p>
          </article>
        </div>
      </div>
      {newChatOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !creatingChat) setNewChatOpen(false);
        }}>
          <form className="new-chat-dialog clay-card" role="dialog" aria-modal="true" aria-labelledby="new-chat-title" onSubmit={createNamedChat}>
            <p className="eyebrow">NEW CONVERSATION</p>
            <h2 id="new-chat-title">새 채팅방 이름</h2>
            <p>대화 목적을 알아보기 쉬운 이름으로 입력해주세요.</p>
            <input autoFocus maxLength={120} value={newChatTitle} onChange={(event) => setNewChatTitle(event.target.value)} placeholder="예: 당뇨병 연구 질문 정리" disabled={creatingChat} required />
            <div>
              <button className="secondary-button" type="button" onClick={() => setNewChatOpen(false)} disabled={creatingChat}>취소</button>
              <button className="primary-button" type="submit" disabled={!newChatTitle.trim() || creatingChat}>{creatingChat ? "생성 중…" : "채팅방 생성"}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
