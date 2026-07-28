import test from "node:test";
import assert from "node:assert/strict";
import { parsePubMedXml } from "../src/pubmed.js";

test("parses abstract, DOI, PMCID, authors and URLs", () => {
  const xml = `<?xml version="1.0"?>
  <PubmedArticleSet><PubmedArticle>
    <MedlineCitation><PMID>12345</PMID><Article>
      <ArticleTitle>Useful study</ArticleTitle>
      <Abstract><AbstractText Label="BACKGROUND">Background text.</AbstractText><AbstractText>Conclusion.</AbstractText></Abstract>
      <Journal><Title>Medical Journal</Title><JournalIssue><PubDate><Year>2025</Year></PubDate></JournalIssue></Journal>
      <AuthorList><Author><ForeName>Jane</ForeName><LastName>Doe</LastName></Author></AuthorList>
    </Article></MedlineCitation>
    <PubmedData><ArticleIdList>
      <ArticleId IdType="pubmed">12345</ArticleId>
      <ArticleId IdType="doi">10.1000/test</ArticleId>
      <ArticleId IdType="pmc">PMC9876</ArticleId>
    </ArticleIdList></PubmedData>
  </PubmedArticle></PubmedArticleSet>`;
  const [paper] = parsePubMedXml(xml);
  assert.equal(paper.pmid, "12345");
  assert.equal(paper.abstract, "BACKGROUND: Background text.\nConclusion.");
  assert.deepEqual(paper.authors, ["Jane Doe"]);
  assert.equal(paper.doi, "10.1000/test");
  assert.equal(paper.pmcid, "PMC9876");
  assert.equal(paper.full_text_source, "pmc");
  assert.equal(paper.full_text_url, "https://pmc.ncbi.nlm.nih.gov/articles/PMC9876/");
});
