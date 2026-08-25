import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import cloud from "d3-cloud";
import { extractPaperKeywords } from "../lib/wordCloud";

const CLOUD_COLORS = ["#173f43", "#a5442e", "#2f2d3c", "#c9852f", "#397d78", "#695ca8"];

function textHash(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed || 1;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function useCompactCloud(containerRef) {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const update = (width) => setCompact(width < 600);
    update(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [containerRef]);

  return compact;
}

function CloudStage({ words, activeKeyword, hoveredKeyword, onKeywordSelect, onKeywordHover }) {
  const containerRef = useRef(null);
  const compact = useCompactCloud(containerRef);
  const layoutSize = compact ? { width: 600, height: 760 } : { width: 1200, height: 650 };
  const [layoutResult, setLayoutResult] = useState({ words: [], bounds: null });

  useEffect(() => {
    if (!words.length) {
      setLayoutResult({ words: [], bounds: null });
      return undefined;
    }

    const scores = words.map((word) => word.score);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const maxFontSize = compact ? 100 : 130;
    const minFontSize = 12;
    const layoutWords = words.map((word, index) => {
      const ratio = maxScore === minScore
        ? Math.max(0.12, 1 - index / Math.max(words.length - 1, 1))
        : (word.score - minScore) / (maxScore - minScore);
      // 빈도 차이가 작아도 상위 키워드와 보조 키워드의 위계가 보이도록 대비를 넓힌다.
      const scaledSize = minFontSize + Math.pow(ratio, 1.55) * (maxFontSize - minFontSize);
      const widthLimitedSize = (layoutSize.width * 0.7) / Math.max(word.text.length * 0.58, 1);
      const rotate = !word.phrase && word.text.length <= 12 && textHash(word.text) % 5 === 0 ? 90 : 0;
      return {
        ...word,
        keyword: word.text,
        displayText: word.text.toUpperCase(),
        rank: index,
        size: Math.max(minFontSize, Math.min(scaledSize, widthLimitedSize)),
        rotate,
        color: index === 0 ? CLOUD_COLORS[0] : CLOUD_COLORS[textHash(word.text) % CLOUD_COLORS.length],
      };
    });
    const random = seededRandom(textHash(`${compact}|${layoutWords.map((word) => word.text).join("|")}`));
    let cancelled = false;
    const layout = cloud()
      .size([layoutSize.width, layoutSize.height])
      .words(layoutWords)
      .text((word) => word.displayText)
      .padding(1)
      .rotate((word) => word.rotate)
      .font("Arial")
      .fontWeight((word) => word.rank < 10 ? 800 : 700)
      .fontSize((word) => word.size)
      .spiral("archimedean")
      .random(random)
      .timeInterval(12)
      .on("end", (placedWords, bounds) => {
        if (!cancelled) setLayoutResult({ words: placedWords, bounds });
      });
    layout.start();

    return () => {
      cancelled = true;
      layout.stop();
    };
  }, [compact, layoutSize.height, layoutSize.width, words]);

  const bounds = layoutResult.bounds;
  const boundsWidth = bounds ? Math.max(1, bounds[1].x - bounds[0].x) : layoutSize.width;
  const boundsHeight = bounds ? Math.max(1, bounds[1].y - bounds[0].y) : layoutSize.height;
  const scale = Math.min(
    (layoutSize.width * 0.98) / boundsWidth,
    (layoutSize.height * 0.97) / boundsHeight,
    1.6,
  );
  const boundsCenterX = bounds ? (bounds[0].x + bounds[1].x) / 2 - layoutSize.width / 2 : 0;
  const boundsCenterY = bounds ? (bounds[0].y + bounds[1].y) / 2 - layoutSize.height / 2 : 0;
  const renderedWords = hoveredKeyword
    ? [...layoutResult.words].sort((left, right) => {
      const leftKeyword = left.keyword ?? left.text.toLowerCase();
      const rightKeyword = right.keyword ?? right.text.toLowerCase();
      return Number(leftKeyword === hoveredKeyword) - Number(rightKeyword === hoveredKeyword);
    })
    : layoutResult.words;

  return (
    <div className={`keyword-cloud-stage ${compact ? "is-compact" : ""} ${hoveredKeyword ? "has-keyword-hover" : ""}`} ref={containerRef} aria-label="논문 키워드 워드클라우드">
      <svg viewBox={`0 0 ${layoutSize.width} ${layoutSize.height}`} role="img" aria-label="논문 제목과 초록에서 추출한 키워드 지도">
        <g transform={`translate(${layoutSize.width / 2} ${layoutSize.height / 2}) scale(${scale}) translate(${-boundsCenterX} ${-boundsCenterY})`}>
          {renderedWords.map((word) => {
            const keyword = word.keyword ?? word.text.toLowerCase();
            const active = activeKeyword === keyword;
            const hovered = hoveredKeyword === keyword;
            const selectWord = () => onKeywordSelect(active ? null : keyword);
            return (
              <g
                className={`keyword-cloud-word ${active ? "is-active" : ""} ${hovered ? "is-hovered" : ""}`}
                key={`${keyword}-${word.rank}`}
                role="button"
                tabIndex="0"
                aria-pressed={active}
                aria-label={`${keyword}, ${word.paperCount}편의 논문에서 총 ${word.occurrences ?? word.paperCount}회 등장`}
                transform={`translate(${word.x} ${word.y}) rotate(${word.rotate})`}
                onClick={selectWord}
                onMouseEnter={() => onKeywordHover(keyword)}
                onMouseLeave={() => onKeywordHover(null)}
                onFocus={() => onKeywordHover(keyword)}
                onBlur={() => onKeywordHover(null)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectWord();
                  }
                }}
              >
                <g className="keyword-cloud-word-pop">
                  <title>{keyword} · 포함 논문 {word.paperCount}편 · 총 {word.occurrences ?? word.paperCount}회 등장</title>
                  <text
                    fill={active ? "#6758c9" : word.color}
                    fontFamily="Arial"
                    fontSize={word.size}
                    fontWeight={word.rank < 10 ? 800 : 700}
                    textAnchor="middle"
                  >
                    {word.text}
                  </text>
                </g>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function KeywordRanking({ words, activeKeyword, hoveredKeyword, onKeywordSelect, onKeywordHover }) {
  return (
    <aside className="keyword-ranking" aria-label="상위 키워드 목록">
      <div className="keyword-ranking-heading">
        <strong>상위 키워드</strong>
        <span>논문 · 등장</span>
      </div>
      <ol>
        {words.slice(0, 10).map((word) => (
          <li key={word.text}>
            <button
              className={`${activeKeyword === word.text ? "is-active" : ""} ${hoveredKeyword === word.text ? "is-hovered" : ""}`}
              type="button"
              aria-pressed={activeKeyword === word.text}
              onClick={() => onKeywordSelect(activeKeyword === word.text ? null : word.text)}
              onMouseEnter={() => onKeywordHover(word.text)}
              onMouseLeave={() => onKeywordHover(null)}
              onFocus={() => onKeywordHover(word.text)}
              onBlur={() => onKeywordHover(null)}
            >
              <span>{word.text}</span>
              <strong>{word.paperCount}편 · {word.occurrences ?? word.paperCount}회</strong>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function KeywordCloudModal({
  words,
  paperCount,
  missingAbstractCount,
  title,
  scopeName,
  activeKeyword,
  onKeywordSelect,
  onClose,
}) {
  const closeButtonRef = useRef(null);
  const [hoveredKeyword, setHoveredKeyword] = useState(null);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.body.classList.add("keyword-cloud-modal-open");
    document.addEventListener("keydown", handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.body.classList.remove("keyword-cloud-modal-open");
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus?.();
    };
  }, [onClose]);

  const selectAndClose = (keyword) => {
    onKeywordSelect(keyword);
    onClose();
  };

  return createPortal(
    <div className="keyword-cloud-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="keyword-cloud-modal" role="dialog" aria-modal="true" aria-labelledby="keyword-cloud-modal-title">
        <header className="keyword-cloud-modal-header">
          <div>
            <h2 id="keyword-cloud-modal-title">{title}</h2>
            <p>{scopeName} {paperCount}편의 제목과 초록에서 추출했습니다. 논문 원문은 포함하지 않습니다.</p>
          </div>
          <div className="keyword-cloud-modal-actions">
            <span className="keyword-scope-badge">분석 범위 · 제목 + 초록</span>
            <button ref={closeButtonRef} className="keyword-cloud-close" type="button" onClick={onClose} aria-label="키워드 지도 닫기">×</button>
          </div>
        </header>
        {words.length ? (
          <div className="keyword-cloud-modal-body">
            <CloudStage
              words={words}
              activeKeyword={activeKeyword}
              hoveredKeyword={hoveredKeyword}
              onKeywordSelect={selectAndClose}
              onKeywordHover={setHoveredKeyword}
            />
            <KeywordRanking
              words={words}
              activeKeyword={activeKeyword}
              hoveredKeyword={hoveredKeyword}
              onKeywordSelect={selectAndClose}
              onKeywordHover={setHoveredKeyword}
            />
          </div>
        ) : <p className="keyword-cloud-empty">표시할 키워드가 충분하지 않습니다.</p>}
        <footer className="keyword-cloud-footer">
          <div>
            <p>글자 크기는 포함 논문 수와 총 등장 횟수, 제목 가중치를 함께 반영합니다. 오른쪽에서 논문 수와 등장 횟수를 확인할 수 있습니다.</p>
            <p>키워드를 누르면 팝업이 닫히고 논문 목록이 필터링됩니다.</p>
            {missingAbstractCount > 0 && <p>초록이 없는 {missingAbstractCount}편은 제목만 반영했습니다.</p>}
          </div>
          {activeKeyword && (
            <button type="button" onClick={() => selectAndClose(null)}>
              <strong>{activeKeyword}</strong> 필터 해제 ×
            </button>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export default function KeywordCloud({
  papers = [],
  terms,
  paperCount,
  missingAbstractCount,
  scope = "search",
  activeKeyword,
  onKeywordSelect,
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const words = useMemo(
    () => Array.isArray(terms) ? terms : extractPaperKeywords(papers, { limit: 160 }),
    [papers, terms],
  );
  const analyzedPaperCount = Number.isFinite(Number(paperCount)) ? Number(paperCount) : papers.length;
  const abstractMissingCount = Number.isFinite(Number(missingAbstractCount))
    ? Number(missingAbstractCount)
    : papers.filter((paper) => !String(paper.abstract ?? "").trim()).length;
  const scopeName = scope === "interest" ? "관심 논문" : "현재 검색 결과";
  const title = scope === "interest" ? "내 연구 키워드 지도" : "이번 검색 주요 키워드";

  if (!analyzedPaperCount) return null;

  return (
    <>
      {compact ? (
        <button className="keyword-cloud-compact" type="button" onClick={() => setOpen(true)} aria-label={`${title} 열기, ${scopeName} ${analyzedPaperCount}편의 제목과 초록 기준`}>
          <span aria-hidden="true">☁</span>
          <strong>연구 키워드</strong>
          <small>{activeKeyword || `${analyzedPaperCount}편`}</small>
        </button>
      ) : (
        <section className="keyword-cloud-launch" aria-labelledby={`${scope}-keyword-cloud-title`}>
          <div className="keyword-cloud-launch-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M7.1 18.2h10.2a4.2 4.2 0 0 0 .5-8.37A6.25 6.25 0 0 0 5.9 8.58a4.82 4.82 0 0 0 1.2 9.62Z" />
              <circle cx="9" cy="13.1" r="1.25" />
              <circle cx="12.4" cy="11.2" r="1.55" />
              <circle cx="15.8" cy="13.5" r="1.05" />
            </svg>
          </div>
          <div className="keyword-cloud-launch-copy">
            <h3 id={`${scope}-keyword-cloud-title`}>{title}</h3>
            <p>{scopeName} {analyzedPaperCount}편 · 제목+초록 기준 · 원문 제외</p>
          </div>
          <div className="keyword-cloud-preview" aria-label="상위 키워드 미리보기">
            {words.slice(0, 3).map((word) => <span key={word.text}>{word.text} <strong>{word.paperCount}</strong></span>)}
          </div>
          <button className="keyword-cloud-open" type="button" onClick={() => setOpen(true)}>
            키워드 지도 보기 <span aria-hidden="true">↗</span>
          </button>
        </section>
      )}
      {open && (
        <KeywordCloudModal
          words={words}
          paperCount={analyzedPaperCount}
          missingAbstractCount={abstractMissingCount}
          title={title}
          scopeName={scopeName}
          activeKeyword={activeKeyword}
          onKeywordSelect={onKeywordSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
