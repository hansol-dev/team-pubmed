const STOP_WORDS = new Set(`
  a across all also among an and are as at be been being between both but by can could did do does doing done
  during each either for from further had has have having he her here hers herself him himself
  his how i if in into is it its itself may might more most much must my myself neither no nor
  not of off on once only or other our ours ourselves out over own same she should so some such
  than that the their theirs them themselves then there these they this those through to too under
  until up very via was we were what when where which while who whom why will with within without would
  you your yours yourself yourselves
  according aim aimed aims analysis analyses analyzed assessing associated association associations
  background based baseline compared comparison conclusion conclusions conducted data demonstrate
  demonstrated determine determined evaluating evaluation evidence examined findings first found
  groups however impact investigated investigation method methods objective objectives observed one participants per
  patient patients present presented previous primary reported research response result results sample
  samples showed significant significantly study studies suggest suggested support therefore three thus total two using versus xa0
`.trim().split(/\s+/));

const SHORT_SCIENCE_TERMS = new Set(["ai", "ct", "dna", "mr", "rna"]);

function canonicalize(token) {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && /(ches|shes|sses|xes|zes|oes)$/.test(token)) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

function meaningfulToken(token) {
  if (!token || /^\d+$/.test(token)) return null;
  const normalized = canonicalize(token);
  if (normalized.length < 3 && !SHORT_SCIENCE_TERMS.has(normalized)) return null;
  if (STOP_WORDS.has(token) || STOP_WORDS.has(normalized)) return null;
  return normalized;
}

function tokenSlots(text = "") {
  return (String(text)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g) ?? [])
    .map(meaningfulToken);
}

export function tokenizePaperText(text = "") {
  return tokenSlots(text).filter(Boolean);
}

function paperTermSets(paper) {
  const titleSlots = tokenSlots(paper?.title);
  const abstractSlots = tokenSlots(paper?.abstract);
  const titleTokens = titleSlots.filter(Boolean);
  const abstractTokens = abstractSlots.filter(Boolean);
  const tokens = [...titleTokens, ...abstractTokens];
  const phrases = [];

  for (const slots of [titleSlots, abstractSlots]) {
    for (let index = 0; index < slots.length - 1; index += 1) {
      const left = slots[index];
      const right = slots[index + 1];
      if (left && right && left !== right && left.length + right.length <= 26) phrases.push(`${left} ${right}`);
    }
  }

  return {
    tokens,
    phrases,
    titleTerms: new Set(titleTokens),
    terms: new Set(tokens),
    phraseTerms: new Set(phrases),
  };
}

function addDocumentTerms(target, terms, titleTerms, phrase = false) {
  for (const text of terms) {
    const current = target.get(text) ?? {
      text,
      paperCount: 0,
      titleCount: 0,
      occurrences: 0,
      phrase,
    };
    current.paperCount += 1;
    if (!phrase && titleTerms.has(text)) current.titleCount += 1;
    target.set(text, current);
  }
}

export function extractPaperKeywords(papers = [], { limit = 48 } = {}) {
  const terms = new Map();
  const phrases = new Map();
  const preparedPapers = papers.map(paperTermSets);

  for (const prepared of preparedPapers) {
    addDocumentTerms(terms, prepared.terms, prepared.titleTerms);
    addDocumentTerms(phrases, prepared.phraseTerms, new Set(), true);
    for (const token of prepared.tokens) {
      const current = terms.get(token);
      if (current) current.occurrences += 1;
    }
    for (const phrase of prepared.phrases) {
      const current = phrases.get(phrase);
      if (current) current.occurrences += 1;
    }
  }

  const phraseThreshold = Math.max(2, Math.ceil(papers.length * 0.025));
  const phraseCandidates = [...phrases.values()]
    .filter((item) => item.paperCount >= phraseThreshold)
    .sort((left, right) => right.paperCount - left.paperCount || right.occurrences - left.occurrences)
    .slice(0, 12);

  return [...terms.values(), ...phraseCandidates]
    .map((item) => ({
      ...item,
      score: item.paperCount
        + item.titleCount * 0.35
        + Math.log1p(item.occurrences) * 0.55
        + (item.phrase ? 0.45 : 0),
    }))
    .sort((left, right) => right.score - left.score || right.occurrences - left.occurrences || left.text.localeCompare(right.text, "en"))
    .slice(0, limit);
}

export function paperHasKeyword(paper, keyword) {
  if (!keyword) return true;
  const prepared = paperTermSets(paper);
  return keyword.includes(" ") ? prepared.phraseTerms.has(keyword) : prepared.terms.has(keyword);
}
