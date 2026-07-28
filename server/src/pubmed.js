import { XMLParser } from "fast-xml-parser";
import { config } from "./config.js";

const ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });

const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];

export function plainText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (value["#text"] != null) return plainText(value["#text"]);
    return Object.entries(value)
      .filter(([key]) => !key.startsWith("@_"))
      .map(([, item]) => plainText(item)).filter(Boolean).join(" ");
  }
  return "";
}

function identityParams() {
  return {
    tool: config.ncbiTool,
    ...(config.ncbiEmail ? { email: config.ncbiEmail } : {}),
    ...(config.ncbiApiKey ? { api_key: config.ncbiApiKey } : {}),
  };
}

async function ncbiFetch(url, params) {
  const response = await fetch(`${url}?${new URLSearchParams({ ...params, ...identityParams() })}`, {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: params.retmode === "json" ? "application/json" : "application/xml" },
  });
  if (!response.ok) throw new Error(`NCBI request failed (${response.status})`);
  return response;
}

export async function searchPubMed({ keyword, yearFrom, yearTo, maxCount = 50 }) {
  const term = `${keyword.trim()} AND ${yearFrom}:${yearTo}[pdat]`;
  const search = await ncbiFetch(ESEARCH, {
    db: "pubmed", term, retmax: String(maxCount), retmode: "json", sort: "pub date",
  });
  const ids = (await search.json()).esearchresult?.idlist || [];
  if (!ids.length) return [];
  const fetchResponse = await ncbiFetch(EFETCH, {
    db: "pubmed", id: ids.join(","), retmode: "xml",
  });
  return parsePubMedXml(await fetchResponse.text());
}

export async function countPubMedByYear({ keyword, yearFrom, yearTo }) {
  const result = {};
  for (let year = yearFrom; year <= yearTo; year += 1) {
    const response = await ncbiFetch(ESEARCH, {
      db: "pubmed", term: `${keyword.trim()} AND ${year}:${year}[pdat]`, retmax: "0", retmode: "json",
    });
    result[year] = Number((await response.json()).esearchresult?.count || 0);
    if (!config.ncbiApiKey && year < yearTo) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return result;
}

export function parsePubMedXml(xml) {
  const data = parser.parse(xml);
  const records = array(data?.PubmedArticleSet?.PubmedArticle);
  return records.map((record) => {
    const citation = record.MedlineCitation || {};
    const article = citation.Article || {};
    const ids = array(record.PubmedData?.ArticleIdList?.ArticleId);
    const id = (type) => plainText(ids.find((item) => item?.["@_IdType"] === type));
    const abstracts = array(article.Abstract?.AbstractText).map((item) => {
      const text = plainText(item);
      const label = typeof item === "object" ? item["@_Label"] : "";
      return label && text ? `${label}: ${text}` : text;
    }).filter(Boolean);
    const authors = array(article.AuthorList?.Author).map((author) =>
      plainText(author.CollectiveName) ||
      [plainText(author.ForeName), plainText(author.LastName)].filter(Boolean).join(" ")
    ).filter(Boolean);
    const date = article.ArticleDate || article.Journal?.JournalIssue?.PubDate || {};
    const yearText = plainText(date.Year) || plainText(date.MedlineDate).match(/\b(?:18|19|20)\d{2}\b/)?.[0];
    const pmid = plainText(citation.PMID);
    const pmcid = id("pmc");
    const doi = id("doi");
    return {
      pmid,
      title: plainText(article.ArticleTitle),
      abstract: abstracts.join("\n"),
      journal: plainText(article.Journal?.Title),
      pub_year: yearText ? Number(yearText) : null,
      authors,
      doi,
      pmcid,
      pubmed_url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      full_text_url: pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/` : (doi ? `https://doi.org/${doi}` : null),
      full_text_source: pmcid ? "pmc" : (doi ? "publisher" : null),
      access_level: pmcid ? "pmc_full_text" : (doi ? "publisher_link" : "abstract_only"),
    };
  }).filter((paper) => paper.pmid);
}
