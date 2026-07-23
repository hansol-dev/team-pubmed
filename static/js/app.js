const state = { papers: [], yearChart: null, journalChart: null };

const byId = (id) => document.getElementById(id);

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || "요청을 처리하지 못했습니다.");
  return body;
}

function renderCharts(stats) {
  const years = Object.keys(stats.papers_by_year || {});
  const counts = Object.values(stats.papers_by_year || {});
  const journals = (stats.top_journals || []).map(([name]) => name);
  const journalCounts = (stats.top_journals || []).map(([, count]) => count);
  state.yearChart?.destroy(); state.journalChart?.destroy();
  state.yearChart = new Chart(byId("year-chart"), { type: "bar", data: { labels: years, datasets: [{ data: counts, backgroundColor: "#a99ff2", borderRadius: 9, borderSkipped: false }] }, options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: "rgba(89,75,132,.08)" } }, x: { grid: { display: false } } } } });
  state.journalChart = new Chart(byId("journal-chart"), { type: "bar", data: { labels: journals, datasets: [{ data: journalCounts, backgroundColor: "#79d7c5", borderRadius: 9, borderSkipped: false }] }, options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, grid: { color: "rgba(89,75,132,.08)" } }, y: { grid: { display: false } } } } });
}

async function loadStats() {
  const stats = await request("/api/stats");
  byId("metric-papers").textContent = stats.total_papers;
  byId("metric-journals").textContent = stats.total_journals;
  renderCharts(stats);
}

function renderPapers(papers) {
  state.papers = papers;
  byId("papers-summary").textContent = `${papers.length}건의 논문을 찾았습니다.`;
  if (!papers.length) { byId("papers-container").innerHTML = "<p class='result-summary'>조건에 맞는 논문이 없습니다.</p>"; return; }
  byId("papers-container").innerHTML = `<table class="paper-table"><thead><tr><th>논문</th><th>저널</th><th>연도</th><th>PMID</th></tr></thead><tbody>${papers.map((paper) => `<tr><td class="paper-title">${escapeHtml(paper.title || "제목 없음")}</td><td>${escapeHtml(paper.journal || "-")}</td><td>${paper.pub_year || "-"}</td><td><span class="pmid-chip">${escapeHtml(paper.pmid || "-")}</span></td></tr>`).join("")}</tbody></table>`;
}

function escapeHtml(value) { const element = document.createElement("div"); element.textContent = value; return element.innerHTML; }

byId("collect-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const status = byId("collect-status"); const button = event.currentTarget.querySelector("button");
  const form = new FormData(event.currentTarget); const payload = Object.fromEntries(form.entries());
  ["year_from", "year_to"].forEach((key) => { payload[key] = payload[key] ? Number(payload[key]) : null; }); payload.max_count = Number(payload.max_count);
  button.disabled = true; status.textContent = "PubMed에서 논문을 수집하고 있어요…";
  try { const result = await request("/api/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); byId("metric-new").textContent = result.new_count; byId("metric-skipped").textContent = result.skipped_count; status.textContent = `수집 완료 · 신규 ${result.new_count}건, 중복 ${result.skipped_count}건`; await loadStats(); }
  catch (error) { status.textContent = error.message; } finally { button.disabled = false; }
});

byId("filter-form").addEventListener("submit", async (event) => { event.preventDefault(); const params = new URLSearchParams(new FormData(event.currentTarget)); try { const result = await request(`/api/papers?${params}`); renderPapers(result.papers); } catch (error) { byId("papers-summary").textContent = error.message; } });

byId("download-csv").addEventListener("click", () => { if (!state.papers.length) return; const rows = [["PMID", "Title", "Abstract", "Journal", "Year", "Authors"], ...state.papers.map((paper) => [paper.pmid, paper.title, paper.abstract, paper.journal, paper.pub_year, paper.authors])]; const csv = "\uFEFF" + rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n"); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = "pubmed-papers.csv"; link.click(); URL.revokeObjectURL(link.href); });

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => { document.querySelectorAll(".tab,.tab-panel").forEach((element) => element.classList.remove("is-active")); tab.classList.add("is-active"); byId(tab.dataset.tab).classList.add("is-active"); if (tab.dataset.tab === "overview") loadStats().catch(() => {}); }));

loadStats().catch(() => { byId("papers-summary").textContent = "A의 데이터 모듈 통합 후 논문을 불러옵니다."; });
