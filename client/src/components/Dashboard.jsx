import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, stream } from "../lib/api";
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
  pmcid: paper.pmcid ?? paper.pmc_id,
});

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

export default function Dashboard({ session, preview = false }) {
  const token = session.access_token;
  const user = session.user;
  const [tab, setTab] = useState("overview");
  const [loading, setLoading] = useState(0);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [overview, setOverview] = useState(preview ? previewOverview : emptyOverview);
  const [collectionStats, setCollectionStats] = useState(preview ? { added: 186, skipped: 32 } : { added: "—", skipped: "—" });
  const [papers, setPapers] = useState([]);
  const [paperTotal, setPaperTotal] = useState(0);
  const [selected, setSelected] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [mobileSheet, setMobileSheet] = useState(false);

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
    <main className={`app-shell ${mobileSheet ? "collect-sheet-open" : ""}`}>
      <Sidebar onCollect={collect} status={status} onClose={() => setMobileSheet(false)} />
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
        <Papers active={tab === "papers"} papers={papers} total={paperTotal} selected={selected} onToggle={togglePaper} onSearch={search} onChat={sendSelectedToChat} />
        <Chat active={tab === "chat"} token={token} conversations={conversations} conversationId={conversationId} selectedCount={selected.length} messages={messages} setMessages={setMessages} onOpen={openConversation} onNewChat={createEmptyChat} onDeleteConversation={deleteConversation} onResetSelection={resetChatSelection} call={call} />
      </section>
      {loading > 0 && <div className="loading-indicator is-visible" role="status"><div className="loading-panel"><span className="loading-spinner" /><p>데이터를 불러오는 중입니다.</p></div></div>}
    </main>
  );
}

function Sidebar({ onCollect, status, onClose }) {
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

function Papers({ active, papers, total, selected, onToggle, onSearch, onChat }) {
  const [sortMethod, setSortMethod] = useState("newest");
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
  const download = () => {
    const rows = [["PMID", "Title", "Abstract", "Journal", "Year", "Authors"], ...sortedPapers.map((p) => [p.pmid, p.title, p.abstract, p.journal, p.pubYear, p.authors])];
    const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = "pubmed-metadata.csv"; link.click(); URL.revokeObjectURL(link.href);
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
          <label className="paper-sort" aria-label="논문 정렬 방법"><select value={sortMethod} onChange={(event) => setSortMethod(event.target.value)}><option value="newest">최신 논문순</option><option value="oldest">오래된 논문순</option><option value="collected">최근 수집순</option><option value="title">제목순</option></select></label>
          <p className="result-summary collection-count">총 <strong>{total}</strong>건</p>
        </div>
        {!sortedPapers.length ? <p className="result-summary">조건에 맞는 논문이 없습니다.</p> : <div className="paper-list">{sortedPapers.map((paper) => <PaperCard key={paper.id} paper={paper} checked={selectedIds.has(String(paper.id))} onToggle={() => onToggle(paper)} />)}</div>}
      </article>
    </section>
  );
}

function PaperCard({ paper, checked, onToggle }) {
  const [abstractExpanded, setAbstractExpanded] = useState(false);
  const pubmed = paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : null;
  const doi = paper.doi ? `https://doi.org/${paper.doi}` : null;
  const pmc = paper.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${paper.pmcid}/` : paper.fullTextUrl;
  return (
    <article className={`paper-card ${checked ? "is-selected" : ""}`}>
      <div className="paper-card-head">
        <label className="paper-select" aria-label={`${paper.title || "논문"} 선택`} title="챗봇 분석에 선택"><input type="checkbox" checked={checked} onChange={onToggle} /></label>
        <div><div className="paper-meta"><span className="meta-chip journal-chip">{paper.journal || "저널 정보 없음"}</span><span className="meta-chip">{paper.pubYear || "연도 정보 없음"}</span><span className="pmid-chip">PMID {paper.pmid || "-"}</span></div><h3>{paper.title || "제목 없음"}</h3></div>
      </div>
      <p className="paper-author"><strong>저자</strong><span>{Array.isArray(paper.authors) ? paper.authors.join(", ") : paper.authors || "등록된 저자 정보가 없습니다."}</span></p>
      <div className="abstract-heading"><span>ABSTRACT</span><button className="abstract-toggle" type="button" onClick={() => setAbstractExpanded((value) => !value)} aria-expanded={abstractExpanded}>{abstractExpanded ? "초록 접기 ↑" : "초록 전체 보기 ↓"}</button></div>
      <p className={`abstract-preview ${abstractExpanded ? "is-expanded" : ""}`}>{paper.abstract || "초록 내용 없음"}</p>
      <div className="paper-links">{pubmed && <a href={pubmed} target="_blank" rel="noreferrer">PubMed 보기 ↗</a>}{doi && <a href={doi} target="_blank" rel="noreferrer">출판사 원문 ↗</a>}{pmc && <a className="full-text-link" href={pmc} target="_blank" rel="noreferrer">PMC 무료 원문 ↗</a>}{!doi && !pmc && <span>초록만 제공</span>}</div>
    </article>
  );
}

function Chat({ active, token, conversations, conversationId, selectedCount, messages, setMessages, onOpen, onNewChat, onDeleteConversation, onResetSelection, call }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatTitle, setNewChatTitle] = useState("");
  const [creatingChat, setCreatingChat] = useState(false);
  const current = conversations.find((item) => String(item.id ?? item.conversationId) === String(conversationId));
  const currentPapers = current?.papers ?? [];
  const send = async (event) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || !conversationId || sending) return;
    const userMessage = { id: `u-${Date.now()}`, role: "user", content: message };
    const assistantId = `a-${Date.now()}`;
    setMessages((list) => [...list, userMessage, { id: assistantId, role: "assistant", content: "" }]);
    setInput(""); setSending(true);
    try {
      await stream("/api/chat/stream", {
        token, body: { conversationId, message },
        onToken: (part) => setMessages((list) => list.map((item) => item.id === assistantId ? { ...item, content: item.content + part } : item)),
      });
    } catch (error) {
      setMessages((list) => list.map((item) => item.id === assistantId ? { ...item, content: error.message } : item));
    } finally { setSending(false); }
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
      <div className="chat-layout">
        <aside className="conversation-list clay-card"><div><p className="eyebrow">CONVERSATIONS</p><h2>논문 채팅방</h2></div><button className="new-chat-button" type="button" onClick={() => setNewChatOpen(true)}><strong>＋ 새 채팅</strong><small>논문 없이 시작</small></button>{conversations.length ? conversations.map((room) => { const id = room.id ?? room.conversationId; return <button className={String(id) === String(conversationId) ? "is-active" : ""} key={id} onClick={() => onOpen(id)}><strong>{room.title || "논문 분석"}</strong><small>{room.paperCount ?? room.paper_count ?? room.papers?.length ?? 0}편의 논문</small></button>; }) : <p className="result-summary">새 채팅을 열거나 논문을 선택해 시작하세요.</p>}</aside>
        <article className="chat-card clay-card">
          <div className="card-heading chat-card-heading"><div className="chat-heading-top"><p className="eyebrow">PAPER-GROUNDED AI</p><div className="chat-heading-actions"><button className="secondary-button reset-selection-button" type="button" onClick={onResetSelection} disabled={!conversationId && !selectedCount}>선택 논문 초기화</button><button className="secondary-button history-delete-button" type="button" onClick={clear} disabled={!conversationId}>대화 내역 삭제</button><button className="secondary-button room-delete-button" type="button" onClick={removeRoom} disabled={!conversationId || sending}>채팅방 삭제</button></div></div><h2>{current?.title || "AI 논문 탐색 도우미"}</h2></div>
          {currentPapers.length > 0 && <div className="chat-paper-chips">{currentPapers.map((paper) => <span key={paper.id ?? paper.pmid}>PMID {paper.pmid}</span>)}</div>}
          <div className="chat-log">{!conversationId || !messages.length ? <div className="chat-message assistant intro-message"><span className="avatar">✦</span><div>{conversationId ? (currentPapers.length ? INTRO : "새 채팅입니다. PubMed 검색 전략이나 연구 질문을 함께 정리해보세요.") : "논문 채팅방을 선택하거나 새 채팅을 시작해주세요."}</div></div> : messages.map((message, index) => <div className={`chat-message ${message.role}`} key={message.id ?? index}><span className="avatar">{message.role === "assistant" ? "✦" : "나"}</span><div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div></div>)}</div>
          <form className="chat-form" onSubmit={send}><input value={input} onChange={(event) => setInput(event.target.value)} placeholder={conversationId ? (currentPapers.length ? "선택한 논문에 대해 질문하세요" : "연구 질문이나 PubMed 검색 전략을 물어보세요") : "먼저 채팅방을 열어주세요"} disabled={!conversationId || sending} required /><button className="primary-button" disabled={!conversationId || sending}>보내기 <span>→</span></button></form>
          <p className="chat-disclaimer">의료적 진단·처방·복용 방법은 제공하지 않습니다.</p>
        </article>
      </div>
      {newChatOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !creatingChat) setNewChatOpen(false); }}><form className="new-chat-dialog clay-card" role="dialog" aria-modal="true" aria-labelledby="new-chat-title" onSubmit={createNamedChat}><p className="eyebrow">NEW CONVERSATION</p><h2 id="new-chat-title">새 채팅방 이름</h2><p>대화 목적을 알아보기 쉬운 이름으로 입력해주세요.</p><input autoFocus maxLength={120} value={newChatTitle} onChange={(event) => setNewChatTitle(event.target.value)} placeholder="예: 당뇨병 연구 질문 정리" disabled={creatingChat} required /><div><button className="secondary-button" type="button" onClick={() => setNewChatOpen(false)} disabled={creatingChat}>취소</button><button className="primary-button" type="submit" disabled={!newChatTitle.trim() || creatingChat}>{creatingChat ? "생성 중…" : "채팅방 생성"}</button></div></form></div>}
    </section>
  );
}
