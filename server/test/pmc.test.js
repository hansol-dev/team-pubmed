import test from "node:test";
import assert from "node:assert/strict";
import { balanceRoomContext, chunkSections, parsePmcXml } from "../src/pmc.js";

test("extracts named PMC body sections without publisher crawling", () => {
  const xml = `<pmc-articleset><article><front><article-meta><permissions><license><license-p>CC BY</license-p></license></permissions></article-meta></front>
    <body><sec><title>Methods</title><p>First method.</p><p>Second method.</p></sec>
    <sec><title>Results</title><p>Main result.</p></sec></body></article></pmc-articleset>`;
  const parsed = parsePmcXml(xml);
  assert.equal(parsed.license, "CC BY");
  assert.deepEqual(parsed.sections.map((item) => item.section), ["Methods", "Results"]);
  assert.match(parsed.sections[0].text, /First method/);
});

test("chunks long sections with stable section metadata", () => {
  const chunks = chunkSections([{ section: "Results", text: "A".repeat(9000) }], 4000, 200);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.section === "Results" && chunk.content.length <= 4000));
});

test("keeps every paper overview ahead of retrieved full-text chunks", () => {
  const overviews = [
    { pmid: "1", section: "논문 개요", content: "제목: First\n초록: First abstract" },
    { pmid: "2", section: "논문 개요", content: "제목: Second\n초록: Second abstract" },
  ];
  const chunks = [
    { pmid: "1", section: "Author contributions", content: "Contributions" },
    { pmid: "2", section: "Competing interests", content: "No conflicts" },
  ];

  const context = balanceRoomContext(overviews, chunks, 4);
  assert.deepEqual(context.slice(0, 2), overviews);
  assert.equal(context[2].pmid, "1");
  assert.equal(context[3].pmid, "2");
});
