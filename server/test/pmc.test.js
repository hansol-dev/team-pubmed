import test from "node:test";
import assert from "node:assert/strict";
import { chunkSections, parsePmcXml } from "../src/pmc.js";

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
