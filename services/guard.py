"""Server-side policy guard for medical advice requests."""

from __future__ import annotations

import re

BLOCKED_PATTERNS = (
    r"(진단|처방|복용량|용량|약.*(먹|복용|바꿔)|치료법.*추천)",
    r"(diagnos|prescri|dosage|should i take|what medicine)",
)

BLOCKED_RESPONSE = (
    "의료적 진단·처방·복용 방법은 안내할 수 없습니다. 의료 전문가와 상담해 주세요. "
    "대신 PubMed 논문 검색과 연구 정보 요약은 도와드릴 수 있습니다."
)


def is_medical_advice_request(message: str) -> bool:
    return any(re.search(pattern, message, flags=re.IGNORECASE) for pattern in BLOCKED_PATTERNS)


def blocked_response() -> str:
    return BLOCKED_RESPONSE
