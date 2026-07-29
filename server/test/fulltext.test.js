import test from "node:test";
import assert from "node:assert/strict";
import { parseBiocSections } from "../src/fulltext.js";

test("turns BioC passages into readable sections", () => {
  const sections = parseBiocSections([{
    documents: [{
      passages: [
        { infons: { section: "Methods" }, text: "Participants were enrolled." },
        { infons: { section: "Methods" }, text: "Outcomes were measured." },
        { infons: { section: "Results" }, text: "The primary outcome improved." },
      ],
    }],
  }]);
  assert.deepEqual(sections, [
    { section: "Methods", text: "Participants were enrolled.\n\nOutcomes were measured." },
    { section: "Results", text: "The primary outcome improved." },
  ]);
});

test("ignores empty BioC passages", () => {
  assert.deepEqual(parseBiocSections([{ documents: [{ passages: [{ text: " " }] }] }]), []);
});
