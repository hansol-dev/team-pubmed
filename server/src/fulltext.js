import { XMLParser } from "fast-xml-parser";
import { config } from "./config.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value];

function httpsUrl(value) {
  const url = String(value || "").trim();
  if (!url) return null;
  if (url.startsWith("s3://pmc-oa-opendata/")) {
    return url.replace("s3://pmc-oa-opendata/", "https://pmc-oa-opendata.s3.amazonaws.com/");
  }
  return url.replace(/^ftp:\/\/ftp\.ncbi\.nlm\.nih\.gov\//i, "https://ftp.ncbi.nlm.nih.gov/");
}

async function fetchJson(url, timeout = 20_000) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": `${config.ncbiTool}/1.0 (${config.ncbiEmail || "no-email"})` },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export async function discoverPmcResources(pmcid) {
  if (!pmcid) return null;
  const url = new URL("https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi");
  url.searchParams.set("id", pmcid);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`PMC OA request failed (${response.status})`);
  const parsed = xmlParser.parse(await response.text());
  const records = asArray(parsed?.OA?.records?.record);
  const record = records[0];
  if (!record) return null;
  const links = asArray(record.link);
  return {
    source: "pmc",
    isOpenAccess: true,
    license: record["@_license"] || null,
    pdfUrl: httpsUrl(links.find((item) => item?.["@_format"] === "pdf")?.["@_href"]),
    packageUrl: httpsUrl(links.find((item) => item?.["@_format"] === "tgz")?.["@_href"]),
    landingUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
  };
}

export async function discoverPmcAwsResources(pmcid) {
  if (!pmcid) return null;
  const listing = new URL("https://pmc-oa-opendata.s3.amazonaws.com/");
  listing.searchParams.set("list-type", "2");
  listing.searchParams.set("prefix", `${pmcid}.`);
  listing.searchParams.set("delimiter", "/");
  const response = await fetch(listing, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`PMC AWS listing failed (${response.status})`);
  const parsed = xmlParser.parse(await response.text());
  const prefixes = asArray(parsed?.ListBucketResult?.CommonPrefixes)
    .map((item) => String(item?.Prefix || ""))
    .filter((item) => new RegExp(`^${pmcid}\\.\\d+/$`, "i").test(item))
    .sort((left, right) => Number(right.match(/\.(\d+)\//)?.[1]) - Number(left.match(/\.(\d+)\//)?.[1]));
  const prefix = prefixes[0];
  if (!prefix) return null;
  const metadataUrl = `https://pmc-oa-opendata.s3.amazonaws.com/${prefix}${prefix.slice(0, -1)}.json`;
  const metadata = await fetchJson(metadataUrl);
  if (!metadata?.is_pmc_openaccess && !metadata?.is_manuscript) return null;
  return {
    source: "pmc",
    isOpenAccess: Boolean(metadata.is_pmc_openaccess),
    license: metadata.license_code || (metadata.is_manuscript ? "TDM" : null),
    pdfUrl: httpsUrl(metadata.pdf_url),
    xmlUrl: httpsUrl(metadata.xml_url),
    textUrl: httpsUrl(metadata.text_url),
    landingUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
    version: metadata.version || null,
  };
}

export async function discoverUnpaywall(doi) {
  const email = config.unpaywallEmail || config.ncbiEmail;
  if (!doi || !email) return null;
  const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`);
  url.searchParams.set("email", email);
  const data = await fetchJson(url);
  const location = data?.best_oa_location;
  if (!data?.is_oa || !location) return null;
  return {
    source: "unpaywall",
    isOpenAccess: true,
    license: location.license || null,
    pdfUrl: httpsUrl(location.url_for_pdf),
    landingUrl: httpsUrl(location.url_for_landing_page || location.url),
    version: location.version || null,
    hostType: location.host_type || null,
  };
}

export async function discoverCrossref(doi) {
  if (!doi) return null;
  const url = new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (config.ncbiEmail) url.searchParams.set("mailto", config.ncbiEmail);
  const data = await fetchJson(url);
  const work = data?.message;
  if (!work) return null;
  const links = asArray(work.link);
  const pdf = links.find((item) =>
    /application\/pdf/i.test(item?.["content-type"] || "")
    || /\.pdf(?:$|[?#])/i.test(item?.URL || ""));
  return {
    source: "crossref",
    // Crossref links are metadata leads, not proof that reuse is permitted.
    isOpenAccess: false,
    license: asArray(work.license)[0]?.URL || null,
    pdfUrl: httpsUrl(pdf?.URL),
    landingUrl: httpsUrl(work.URL || `https://doi.org/${doi}`),
  };
}

export async function discoverFullText(paper) {
  const attempts = await Promise.allSettled([
    discoverPmcAwsResources(paper.pmcid),
    discoverPmcResources(paper.pmcid),
    discoverUnpaywall(paper.doi),
    discoverCrossref(paper.doi),
  ]);
  const resources = attempts
    .filter((item) => item.status === "fulfilled" && item.value)
    .map((item) => item.value);
  const trustedPdf = resources.find((item) => item.source === "pmc" && item.pdfUrl)
    || resources.find((item) => item.source === "unpaywall" && item.pdfUrl)
    || null;
  const bestLanding = resources.find((item) => item.source === "pmc")
    || resources.find((item) => item.source === "unpaywall")
    || resources.find((item) => item.source === "crossref")
    || null;
  return {
    resources,
    pdfUrl: trustedPdf?.pdfUrl || null,
    pdfSource: trustedPdf?.source || null,
    landingUrl: bestLanding?.landingUrl || paper.full_text_url || paper.pubmed_url || null,
    source: bestLanding?.source || null,
    license: trustedPdf?.license || bestLanding?.license || null,
    isOpenAccess: Boolean(trustedPdf || bestLanding?.isOpenAccess),
  };
}

export function parseBiocSections(payload) {
  const collections = asArray(payload);
  const sections = [];
  for (const collection of collections) {
    for (const document of asArray(collection?.documents)) {
      for (const passage of asArray(document?.passages)) {
        const text = String(passage?.text || "").trim();
        if (!text) continue;
        const infons = passage?.infons || {};
        const title = String(
          infons.section
          || infons["section_type"]
          || infons.type
          || "본문",
        ).trim();
        const previous = sections.at(-1);
        if (previous?.section === title) previous.text += `\n\n${text}`;
        else sections.push({ section: title, text });
      }
    }
  }
  return sections;
}

export async function fetchBiocFullText(paper) {
  const id = paper.pmcid || paper.pmid;
  if (!id) return null;
  const url = `https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json/${encodeURIComponent(id)}/unicode`;
  const payload = await fetchJson(url, 45_000);
  const sections = parseBiocSections(payload);
  if (!sections.length) return null;
  return { sections, raw: payload, sourceUrl: url };
}
