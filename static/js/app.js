const state = { papers: [] };
let pendingRequests = 0;

const byId = (id) => document.getElementById(id);

function setMobileCollectSheet(open) {
  document.body.classList.toggle("collect-sheet-open", open);
  byId("mobile-collect-trigger").setAttribute("aria-expanded", String(open));
}

function setAppLoading(isLoading) {
  pendingRequests = Math.max(0, pendingRequests + (isLoading ? 1 : -1));
  byId("loading-indicator").classList.toggle("is-visible", pendingRequests > 0);
}

window.setAppLoading = setAppLoading;

async function request(url, options = {}) {
  setAppLoading(true);
  try {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(formatError(body.detail));
    return body;
  } finally {
    setAppLoading(false);
  }
}

function formatError(detail) {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => item?.msg).filter(Boolean);
    if (messages.length) return messages.join(" · ");
  }
  return "요청을 처리하지 못했습니다.";
}

function nonEmptyFormParams(form) {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(form).entries()) {
    const normalized = String(value).trim();
    if (normalized) params.append(key, normalized);
  }
  return params;
}

function renderCharts(stats, trend = null) {
  const storedTrend = trend || stats.latest_trend;
  renderVerticalTrend(byId("year-chart"), Object.entries(storedTrend?.papers_by_year || {}));
  renderBarChart(byId("journal-chart"), stats.top_journals || [], "mint", "저장된 논문이 없으면 주요 저널이 표시되지 않습니다.");
}

function renderVerticalTrend(container, entries) {
  container.className = "trend-chart";
  container.style.setProperty("--trend-count", Math.max(entries.length, 1));
  if (!entries.length) {
    container.innerHTML = '<div class="chart-empty"><span>✦</span><p>수집 후 연도별 검색 결과가 표시됩니다.</p></div>';
    return;
  }
  const maxValue = Math.max(...entries.map(([, value]) => Number(value)));
  container.innerHTML = entries.map(([year, value]) => {
    const height = Math.max(5, Math.round((Number(value) / maxValue) * 100));
    return `<div class="trend-column"><div class="trend-track" style="--bar-height:${height}%"><strong>${Number(value).toLocaleString()}</strong><span></span></div><small>${escapeHtml(year)}</small></div>`;
  }).join("");
}

function renderBarChart(container, entries, tone, emptyMessage) {
  container.className = "bar-chart";
  if (!entries.length) {
    container.innerHTML = `<div class="chart-empty"><span>✦</span><p>${emptyMessage}</p></div>`;
    return;
  }
  const maxValue = Math.max(...entries.map(([, value]) => Number(value)));
  container.innerHTML = entries.map(([label, value]) => {
    const width = Math.max(5, Math.round((Number(value) / maxValue) * 100));
    return `<div class="bar-row"><div class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div><div class="bar-track"><span class="bar-fill ${tone}" style="width:${width}%"></span></div><strong>${Number(value).toLocaleString()}</strong></div>`;
  }).join("");
}

async function loadStats() {
  const stats = await request("/api/stats");
  byId("metric-papers").textContent = stats.total_papers;
  byId("metric-journals").textContent = stats.total_journals;
  renderCharts(stats);
}

async function loadTrend(filters) {
  const params = new URLSearchParams(filters);
  const note = byId("trend-note");
  note.textContent = "PubMed 전체 검색 건수를 집계하고 있어요…";
  try {
    params.set("persist", "true");
    const trend = await request(`/api/trend?${params}`);
    const stats = await request("/api/stats");
    renderCharts(stats, trend);
    note.textContent = `‘${trend.keyword}’의 연도별 전체 검색 결과입니다.`;
  } catch (error) {
    note.textContent = error.message;
  }
}

function renderPapers(papers, totalCount = papers.length) {
  state.papers = papers;
  byId("papers-summary").textContent = totalCount === papers.length ? `${papers.length}건의 수집 논문입니다.` : `${totalCount}건 중 ${papers.length}건이 검색되었습니다.`;
  if (!papers.length) { byId("papers-container").innerHTML = "<p class='result-summary'>조건에 맞는 논문이 없습니다.</p>"; return; }
  byId("papers-container").innerHTML = `<div class="paper-list">${papers.map((paper) => `<article class="paper-card"><div class="paper-card-head"><div><h3>${escapeHtml(paper.title || "제목 없음")}</h3><div class="paper-meta"><span class="meta-chip journal-chip">${escapeHtml(paper.journal || "저널 정보 없음")}</span><span class="meta-chip">${paper.pub_year || "연도 정보 없음"}</span><span class="pmid-chip">PMID ${escapeHtml(paper.pmid || "-")}</span></div></div></div><p class="paper-author"><strong>저자</strong> ${escapeHtml(paper.authors || "등록된 저자 정보가 없습니다.")}</p><p class="abstract-preview">${escapeHtml(paper.abstract || "초록 내용 없음")}</p><details class="abstract-details"><summary>초록 전체 보기</summary><p>${escapeHtml(paper.abstract || "초록 내용 없음")}</p></details></article>`).join("")}</div>`;
}

async function loadPapers() {
  try {
    const result = await request("/api/metadata");
    renderPapers(result.papers, result.total);
  } catch (error) {
    byId("papers-summary").textContent = error.message;
  }
}

async function searchMetadata(params) {
  if (!params.toString()) {
    await loadPapers();
    return;
  }
  try {
    const result = await request(`/api/papers?${params}`);
    renderPapers(result.papers, result.total);
  } catch (error) {
    byId("papers-summary").textContent = error.message;
  }
}

function escapeHtml(value) { const element = document.createElement("div"); element.textContent = value; return element.innerHTML; }

byId("collect-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const status = byId("collect-status"); const button = event.currentTarget.querySelector("button");
  const form = new FormData(event.currentTarget); const payload = Object.fromEntries(form.entries());
  ["year_from", "year_to"].forEach((key) => { payload[key] = payload[key] ? Number(payload[key]) : null; }); payload.max_count = Number(payload.max_count);
  button.disabled = true; status.textContent = "PubMed에서 논문을 수집하고 있어요…";
  try { const result = await request("/api/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); byId("metric-new").textContent = result.new_count; byId("metric-skipped").textContent = result.skipped_count; status.textContent = `수집 완료 · 신규 ${result.new_count}건, 중복 ${result.skipped_count}건`; await loadStats(); await loadTrend(payload); }
  catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
});

byId("reset-data").addEventListener("click", async () => {
  const confirmed = window.confirm("수집된 논문 데이터를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.");
  if (!confirmed) return;
  const button = byId("reset-data");
  const status = byId("collect-status");
  button.disabled = true;
  try {
    const result = await request("/api/papers/reset", { method: "POST" });
    state.papers = [];
    byId("metadata-filter-form").reset();
    renderPapers([], 0);
    renderCharts({ top_journals: [] });
    byId("metric-papers").textContent = "0";
    byId("metric-journals").textContent = "0";
    byId("metric-new").textContent = "—";
    byId("metric-skipped").textContent = "—";
    byId("trend-note").textContent = "키워드를 수집하면 PubMed 전체 검색 건수로 추세를 표시합니다.";
    status.textContent = `${result.removed_count}건의 수집 데이터를 초기화했습니다.`;
    await loadStats();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

byId("metadata-filter-form").addEventListener("submit", async (event) => { event.preventDefault(); searchMetadata(nonEmptyFormParams(event.currentTarget)); });
byId("mobile-collect-trigger").addEventListener("click", () => setMobileCollectSheet(true));
byId("mobile-sheet-backdrop").addEventListener("click", () => setMobileCollectSheet(false));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") setMobileCollectSheet(false); });

byId("download-csv").addEventListener("click", () => { if (!state.papers.length) return; const rows = [["PMID", "Title", "Abstract", "Journal", "Year", "Authors"], ...state.papers.map((paper) => [paper.pmid, paper.title, paper.abstract, paper.journal, paper.pub_year, paper.authors])]; const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n"); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = "pubmed-metadata.csv"; link.click(); URL.revokeObjectURL(link.href); });

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => { document.querySelectorAll(".tab,.tab-panel").forEach((element) => element.classList.remove("is-active")); tab.classList.add("is-active"); byId(tab.dataset.tab).classList.add("is-active"); if (tab.dataset.tab === "overview") loadStats().catch(() => {}); if (tab.dataset.tab === "papers") loadPapers(); }));

loadStats().catch(() => { byId("papers-summary").textContent = "A의 데이터 모듈 통합 후 논문을 불러옵니다."; });
