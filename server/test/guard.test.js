import test from "node:test";
import assert from "node:assert/strict";
import { isMedicalAdviceRequest } from "../src/guard.js";

test("blocks individual diagnosis and medication requests", () => {
  assert.equal(isMedicalAdviceRequest("제 증상으로 진단해 주세요"), true);
  assert.equal(isMedicalAdviceRequest("What dosage should I take?"), true);
});

test("allows paper analysis questions", () => {
  assert.equal(isMedicalAdviceRequest("이 논문의 연구 설계와 한계를 분석해줘"), false);
});
