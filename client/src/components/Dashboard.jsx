import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, apiUrl, stream } from "../lib/api";
import { extractPdfSections, loadPdfDocument } from "../lib/pdf";
import { supabase } from "../lib/supabase";

const INTRO = "선택한 논문을 바탕으로 무엇이 궁금한가요?";
const emptyOverview = { totalPapers: 0, totalJournals: 0, topJournals: [], papersByYear: {} };
const previewOverview = {
  totalPapers: 2410,
  totalJournals: 47,
  topJournals: [
    ["Nature Medicine", 242],
    ["JAMA Network Open", 188],
    ["The Lancet", 156],
    ["Obesity Reviews", 134],
    ["International Journal of Obesity", 119],
    ["Diabetes, Obesity and Metabolism", 104],
    ["Nutrients", 96],
    ["Frontiers in Endocrinology", 84],
    ["BMC Medicine", 72],
  ],
  papersByYear: {
    2020: 238,
    2021: 342,
    2022: 451,
    2023: 548,
    2024: 397,
    2025: 501,
  },
};

const normalizePaper = (paper) => ({
  ...paper,
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
});

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
  return {
    totalPapers: stats.totalPapers ?? stats.total_papers ?? 0,
    totalJournals: stats.totalJournals ?? stats.total_journals ?? 0,
    topJournals: stats.topJournals ?? stats.top_journals ?? [],
    papersByYear: stats.papersByYear ?? stats.papers_by_year ?? stats.latestTrend?.papers_by_year ?? {},
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
  const [collectionStats, setCollectionStats] = useState(preview ? { added: 186, skipped: 32 } : { added: 0, skipped: 0 });
  const [papers, setPapers] = useState([]);
  const [paperTotal, setPaperTotal] = useState(0);
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

  const loadConversations = useCallback(async () => {
    const body = await call("/api/chat/conversations");
    setConversations(body.conversations ?? body.items ?? body.data ?? (Array.isArray(body) ? body : []));
  }, [call]);

  useEffect(() => {
    if (preview) return undefined;
    Promise.allSettled([loadOverview(), loadPapers(), loadConversations()]);
    return undefined;
  }, [loadOverview, loadPapers, loadConversations, preview]);

  useEffect(() => {
    if (!preview) return undefined;
    document.body.classList.add("landing-preview");
    return () => document.body.classList.remove("landing-preview");
  }, [preview]);

  const selectTab = (next) => {
    setTab(next);
    setMobileSheet(false);
    if (next === "overview") loadOverview().catch(() => {});
    if (next === "papers") loadPapers().catch(() => {});
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
          saveToCollection: true,
        }),
      });
      const added = result.savedCount ?? 0;
      const skipped = Math.max(0, (result.total ?? result.papers?.length ?? 0) - added);
      setCollectionStats({ added, skipped });
      setStatus(`수집 완료 · 신규 ${added}건, 중복 ${skipped}건`);
      setMobileSheet(false);
      await Promise.all([loadOverview(), loadPapers()]);
    } catch (requestError) {
      setStatus(requestError.message);
    }
  };

  const resetCollection = async () => {
    if (preview) return;
    const confirmed = window.confirm(
      "현재 계정의 수집 논문과 모든 채팅을 초기화할까요?\n검색 이력과 개요 그래프도 함께 삭제되며, 이 작업은 되돌릴 수 없습니다.",
    );
    if (!confirmed) return;
    setStatus("수집 데이터와 채팅을 초기화하고 있어요…");
    try {
      const result = await call("/api/collection", { method: "DELETE" });
      setOverview(emptyOverview);
      setPapers([]);
      setPaperTotal(0);
      setSelected([]);
      setConversations([]);
      setConversationId(null);
      setMessages([]);
      setCollectionStats({ added: 0, skipped: 0 });
      setMobileSheet(false);
      setStatus(
        `논문 ${Number(result.removedPaperCount ?? 0).toLocaleString()}건과 채팅 `
        + `${Number(result.removedChatCount ?? 0).toLocaleString()}개를 초기화했습니다.`,
      );
    } catch (requestError) {
      setStatus(requestError.message);
    }
  };

  const search = async (event) => {
    event.preventDefault();
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(event.currentTarget)) {
      if (String(value).trim()) params.set(key, String(value).trim());
    }
    await loadPapers(params.toString()).catch(() => {});
  };

  const togglePaper = (paper) => {
    const key = String(paper.id);
    setSelected((current) => {
      if (current.some((item) => String(item.id) === key)) return current.filter((item) => String(item.id) !== key);
      if (current.length >= 5) {
        setError("챗봇에는 논문을 최대 5편까지 보낼 수 있습니다.");
        return current;
      }
      return [...current, paper];
    });
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
      <button className={`mobile-collect-trigger ${tab !== "overview" ? "is-hidden" : ""}`} type="button" onClick={() => setMobileSheet(true)}><span>＋</span> 논문 수집</button>
      <button className="mobile-sheet-backdrop" type="button" aria-label="논문 수집 창 닫기" onClick={() => setMobileSheet(false)} />
      <section className="content">
        <header className="page-header">
          <div><p className="eyebrow">RESEARCH COMPANION</p><h1><span className="desktop-title">PubMed 논문을 <em>검색하고 분석하세요.</em></span><span className="mobile-title">PubMed 논문 검색·분석</span></h1></div>
          <div className="user-menu"><span className="profile-dot">{displayName.slice(0, 1)}</span><span>{displayName}</span><button type="button" className="text-button" onClick={logout}>로그아웃</button></div>
        </header>
        <nav className="tabs" aria-label="주요 메뉴">
          {["overview", "papers", "chat"].map((name) => <button key={name} className={`tab ${tab === name ? "is-active" : ""}`} onClick={() => selectTab(name)}>{name === "overview" ? "개요" : name === "papers" ? "논문 목록" : "AI 챗봇"}</button>)}
        </nav>
        {error && <div className="app-error" role="alert"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
        <Overview active={tab === "overview"} stats={overview} collectionStats={collectionStats} />
        <Papers active={tab === "papers"} papers={papers} total={paperTotal} selected={selected} onToggle={togglePaper} onSearch={search} onChat={sendSelectedToChat} onUploadPdf={uploadPaperPdf} pdfUploadState={pdfUploadState} />
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
        <label htmlFor="collect-max">최대 수집 건수</label><input id="collect-max" name="maxResults" type="number" min="1" max="100" defaultValue="50" required />
        <button className="primary-button collect-action" type="submit"><span>＋</span> 논문 수집하기</button>
        <button className="reset-button collect-action" type="button" onClick={onReset}><span aria-hidden="true">↺</span> 수집 데이터 및 채팅 초기화</button>
        <p className="form-status" role="status">{status}</p>
      </form>
      <div className="sidebar-note"><span>✦</span> PubMed 논문 기반 탐색 도구입니다.</div>
    </aside>
  );
}

function Overview({ active, stats, collectionStats }) {
  const yearEntries = Object.entries(stats.papersByYear);
  return (
    <section id="overview" className={`tab-panel ${active ? "is-active" : ""}`}>
      <div className="metric-grid">
        <Metric tone="purple" icon="⌘" label="전체 논문" value={stats.totalPapers} note="저장된 논문 수" />
        <Metric tone="mint" icon="＋" label="이번 수집 신규" value={collectionStats.added} note="새로 추가된 논문" />
        <Metric tone="peach" icon="↷" label="중복 스킵" value={collectionStats.skipped} note="PMID 기준" />
        <Metric tone="blue" icon="▤" label="저널 수" value={stats.totalJournals} note="분석 대상 저널" />
      </div>
      <div className="chart-grid">
        <ChartCard eyebrow="PUBLICATION TREND" title="PubMed 검색 결과 수(연도별)"><Trend entries={yearEntries} /></ChartCard>
        <ChartCard eyebrow="COLLECTED DISTRIBUTION" title="수집 논문 상위 저널"><Bars entries={stats.topJournals} /></ChartCard>
      </div>
    </section>
  );
}

function Metric({ tone, icon, label, value, note }) {
  return <article className="metric-card clay-card"><span className={`metric-icon ${tone}`}>{icon}</span><p>{label}</p><strong>{value}</strong><small>{note}</small></article>;
}
function ChartCard({ eyebrow, title, children }) {
  return <article className="chart-card clay-card"><div className="card-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div></div>{children}</article>;
}
function Trend({ entries }) {
  if (!entries.length) return <div className="chart-empty"><span>✦</span><p>수집 후 연도별 검색 결과가 표시됩니다.</p></div>;
  const max = Math.max(...entries.map(([, value]) => Number(value)), 1);
  return <div className="trend-chart" style={{ "--trend-count": entries.length }}>{entries.map(([year, value]) => <div className="trend-column" key={year}><div className="trend-track" style={{ "--bar-height": `${Math.max(5, Math.round(Number(value) / max * 100))}%` }}><strong>{Number(value).toLocaleString()}</strong><span /></div><small>{year}</small></div>)}</div>;
}
function Bars({ entries }) {
  const normalized = entries.map((item) => Array.isArray(item) ? item : [item.journal ?? item.label, item.count ?? item.value]);
  if (!normalized.length) return <div className="chart-empty"><span>✦</span><p>저장된 논문이 없으면 주요 저널이 표시되지 않습니다.</p></div>;
  const max = Math.max(...normalized.map(([, value]) => Number(value)), 1);
  return <div className="bar-chart">{normalized.map(([label, value]) => <div className="bar-row" key={label}><div className="bar-label">{label}</div><div className="bar-track"><span className="bar-fill mint" style={{ width: `${Math.max(5, Number(value) / max * 100)}%` }} /></div><strong>{value}</strong></div>)}</div>;
}

function Papers({ active, papers, total, selected, onToggle, onSearch, onChat, onUploadPdf, pdfUploadState }) {
  const [sortMethod, setSortMethod] = useState("newest");
  const [evidenceFilter, setEvidenceFilter] = useState("all");
  const selectedIds = useMemo(() => new Set(selected.map((paper) => String(paper.id))), [selected]);
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
  const download = () => {
    const rows = [["PMID", "Title", "Abstract", "Journal", "Year", "Authors"], ...visiblePapers.map((p) => [p.pmid, p.title, p.abstract, p.journal, p.pubYear, p.authors])];
    const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = "publium-pubmed-metadata.csv"; link.click(); URL.revokeObjectURL(link.href);
  };
  return (
    <section id="papers" className={`tab-panel ${active ? "is-active" : ""}`}>
      <article className="clay-card table-card metadata-card">
        <div className="card-heading paper-card-heading">
          <div><p className="eyebrow">COLLECTED RECORDS</p><h2>논문 수집 목록</h2></div>
          <div className="paper-heading-actions">
            <button className="secondary-button" type="button" onClick={download}>↓ CSV 다운로드</button>
            <button className="secondary-button chat-send-button" type="button" disabled={!selected.length} onClick={onChat}>선택 {selected.length}/5편 챗봇으로 보내기 <span>→</span></button>
          </div>
        </div>
        <form className="filter-bar" onSubmit={onSearch}><input name="keyword" placeholder="제목·초록·수집 검색어 검색" /><input name="yearFrom" type="number" placeholder="시작 연도" /><input name="yearTo" type="number" placeholder="종료 연도" /><input name="journal" placeholder="저널명" /><button className="primary-button">검색</button></form>
        <div className="selection-toolbar">
          <label className="paper-sort evidence-filter" aria-label="논문 근거 범위"><select value={evidenceFilter} onChange={(event) => setEvidenceFilter(event.target.value)}><option value="all">전체 논문</option><option value="full">전문 분석 가능</option><option value="abstract">초록 기반</option></select></label>
          <label className="paper-sort" aria-label="논문 정렬 방법"><select value={sortMethod} onChange={(event) => setSortMethod(event.target.value)}><option value="newest">최신 논문순</option><option value="oldest">오래된 논문순</option><option value="collected">최근 수집순</option><option value="title">제목순</option></select></label>
          <p className="result-summary collection-count">총 <strong>{evidenceFilter === "all" ? total : visiblePapers.length}</strong>건</p>
        </div>
        {!visiblePapers.length ? <p className="result-summary">조건에 맞는 논문이 없습니다.</p> : <div className="paper-list">{visiblePapers.map((paper) => <PaperCard key={paper.id} paper={paper} checked={selectedIds.has(String(paper.id))} onToggle={() => onToggle(paper)} onUploadPdf={onUploadPdf} uploadStage={pdfUploadState[String(paper.pmid)]} />)}</div>}
      </article>
    </section>
  );
}

function PaperCard({ paper, checked, onToggle, onUploadPdf, uploadStage }) {
  const [abstractExpanded, setAbstractExpanded] = useState(false);
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
  return (
    <article className={`paper-card ${checked ? "is-selected" : ""}`}>
      <div className="paper-card-head">
        <label className="paper-select" aria-label={`${paper.title || "논문"} 선택`} title="챗봇 분석에 선택"><input type="checkbox" checked={checked} onChange={onToggle} /></label>
        <div><div className="paper-meta"><span className="meta-chip journal-chip">{paper.journal || "저널 정보 없음"}</span><span className="meta-chip">{paper.pubYear || "연도 정보 없음"}</span><span className="pmid-chip">PMID {paper.pmid || "-"}</span><span className={`analysis-chip is-${documentState.mode}`}>{documentState.label}</span></div><h3>{paper.title || "제목 없음"}</h3></div>
      </div>
      <p className="paper-author"><strong>저자</strong><span>{Array.isArray(paper.authors) ? paper.authors.join(", ") : paper.authors || "등록된 저자 정보가 없습니다."}</span></p>
      <div className="abstract-heading"><span>ABSTRACT</span><button className="abstract-toggle" type="button" onClick={() => setAbstractExpanded((value) => !value)} aria-expanded={abstractExpanded}>{abstractExpanded ? "초록 접기 ↑" : "초록 전체 보기 ↓"}</button></div>
      <p className={`abstract-preview ${abstractExpanded ? "is-expanded" : ""}`}>{paper.abstract || "초록 내용 없음"}</p>
      <div className="paper-links">
        {paper.pdfUrl && <a className="pdf-view-link" href={paper.pdfUrl} target="_blank" rel="noreferrer">PDF 보기</a>}
        <button className="pdf-upload-button" type="button" disabled={Boolean(uploadStage)} onClick={() => uploadInputRef.current?.click()}>{uploadLabel}</button>
        <input ref={uploadInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" onChange={choosePdf} />
        {pubmed && <a href={pubmed} target="_blank" rel="noreferrer">PubMed 보기 ↗</a>}
        {doi && <a href={doi} target="_blank" rel="noreferrer">출판사 원문 ↗</a>}
        {pmc && <a className="full-text-link" href={pmc} target="_blank" rel="noreferrer">PMC 무료 원문 ↗</a>}
        {!doi && !pmc && !paper.pdfUrl && <span>초록만 제공</span>}
      </div>
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
