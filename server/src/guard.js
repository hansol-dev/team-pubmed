const medicalAdvicePatterns = [
  /(제|내|제가|나는|우리\s*아이|제\s*아이|환자).{0,30}(진단|처방|복용량|어떤\s*약|무슨\s*약|치료법)/i,
  /(진단|처방|치료법).{0,18}(해\s*줘|해주세요|추천해|결정해)/i,
  /(어떤|무슨).{0,10}(약|치료).{0,18}(먹|받|해야|좋을)/i,
  /(열이|기침|두통|복통|통증|어지러|혈압|혈당|증상).{0,35}(어떻게|뭘|무엇을|먹|복용|치료|병원|해야)/i,
  /(타이레놀|아세트아미노펜|진통제|항생제|소염제).{0,24}(먹|복용|바꿔|끊어|같이)/i,
  /(diagnose me|diagnose my|my symptoms|what dosage should i|should i take|what medicine should i)/i,
  /(i have|i am experiencing|i'm experiencing).{0,40}(pain|fever|cough|dizziness|symptoms?).{0,40}(what should|should i|medicine|treatment)/i,
];

const promptInjectionPatterns = [
  /(이전|기존|위의).{0,30}(지시|명령|규칙).{0,20}(무시|잊어|폐기)/i,
  /(시스템|개발자|숨겨진).{0,20}(프롬프트|지침|메시지).{0,20}(보여|공개|출력|복사)/i,
  /(ignore|disregard|forget).{0,40}(previous|system|developer|instruction)/i,
  /(reveal|show|print|repeat).{0,30}(system prompt|hidden prompt|developer message|api key)/i,
  /(OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL)/i,
];

const unsafeOutputPatterns = [
  /\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml)\b.{0,30}(복용|투여).{0,18}(하세요|하십시오|권장합니다)/i,
  /(복용|투여).{0,18}(하세요|하십시오|해도 됩니다|권장합니다)/i,
  /(약|항생제|진통제|소염제).{0,20}(드세요|복용하세요|끊으세요|바꾸세요)/i,
  /(당신|귀하)의?\s*(증상|상태).{0,30}(질환|병|진단|가능성이 높)/i,
  /(you should|i recommend).{0,35}(take|stop taking|increase|decrease|change).{0,30}(medicine|medication|dose|dosage|mg)/i,
  /(your symptoms|you likely|you have).{0,35}(indicate|diagnos|disease|condition)/i,
];

const sensitiveDataPatterns = [
  { pattern: /\bsk-[a-zA-Z0-9_-]{16,}\b/g, replacement: "[API_KEY_REDACTED]" },
  { pattern: /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\b/g, replacement: "[TOKEN_REDACTED]" },
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: "[EMAIL_REDACTED]" },
  { pattern: /(?<!\d)(?:01[016789][-\s]?\d{3,4}[-\s]?\d{4})(?!\d)/g, replacement: "[PHONE_REDACTED]" },
];

export const BLOCKED_RESPONSE =
  "이 기능은 논문 분석을 위한 도구로, 개인을 위한 진단·처방·복용량 결정 등 의료 조언은 제공할 수 없습니다. 의료 관련 결정은 의료 전문가와 상담해 주세요.";

export const PROMPT_INJECTION_RESPONSE =
  "시스템 지침, 내부 프롬프트, 비밀값을 공개하거나 기존 안전 규칙을 우회하는 요청은 처리할 수 없습니다. 논문 검색이나 연구 근거 분석에 관한 질문으로 바꿔 주세요.";

export const UNSAFE_OUTPUT_RESPONSE =
  "안전 기준에 맞는 연구 근거 중심 답변을 생성하지 못했습니다. 개인 의료 조언이 아닌 논문의 연구 결과·방법·한계에 관한 질문으로 다시 요청해 주세요.";

export const EMPTY_OUTPUT_RESPONSE =
  "답변을 생성하지 못했습니다. 질문을 조금 더 구체적으로 작성해 주세요.";

export function isMedicalAdviceRequest(message) {
  return medicalAdvicePatterns.some((pattern) => pattern.test(message));
}

export function isPromptInjectionRequest(message) {
  return promptInjectionPatterns.some((pattern) => pattern.test(message));
}

export function redactSensitiveData(value) {
  return sensitiveDataPatterns.reduce(
    (text, { pattern, replacement }) => text.replace(pattern, replacement),
    String(value || ""),
  );
}

export function classifyChatInput(message) {
  if (isMedicalAdviceRequest(message)) {
    return { decision: "blocked", reason: "medical_advice", response: BLOCKED_RESPONSE };
  }
  if (isPromptInjectionRequest(message)) {
    return { decision: "blocked", reason: "prompt_injection", response: PROMPT_INJECTION_RESPONSE };
  }
  return {
    decision: "allow",
    reason: "allowed",
    response: "",
    sanitizedMessage: redactSensitiveData(message),
  };
}

export function guardChatOutput(response) {
  const sanitizedResponse = redactSensitiveData(response).trim();
  if (!sanitizedResponse) {
    return { decision: "blocked", reason: "empty_output", response: EMPTY_OUTPUT_RESPONSE };
  }
  if (unsafeOutputPatterns.some((pattern) => pattern.test(sanitizedResponse))) {
    return { decision: "blocked", reason: "unsafe_medical_output", response: UNSAFE_OUTPUT_RESPONSE };
  }
  return { decision: "allow", reason: "allowed", response: sanitizedResponse };
}
