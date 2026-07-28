const patterns = [
  /(진단|처방|복용량|약을?\s*(먹|복용)|치료법\s*추천)/i,
  /(타이레놀|아세트아미노펜|진통제|항생제|소염제).{0,24}(먹|복용|바꿔|끊어|같이)/i,
  /(diagnos|prescri|dosage|should i take|what medicine)/i,
];

export const BLOCKED_RESPONSE =
  "이 기능은 논문 분석을 위한 도구로, 개인을 위한 진단·처방·복용량 결정 등 의료 조언은 제공할 수 없습니다. 의료 관련 결정은 의료 전문가와 상담해 주세요.";

export function isMedicalAdviceRequest(message) {
  return patterns.some((pattern) => pattern.test(message));
}
