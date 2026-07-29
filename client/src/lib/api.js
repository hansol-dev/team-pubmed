const API_URL = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

export function apiUrl(path) {
  return `${API_URL}${path}`;
}

function detailMessage(detail) {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) return detail.map((item) => item?.msg).filter(Boolean).join(" · ");
  return "요청을 처리하지 못했습니다.";
}

export async function api(path, { token, headers, ...options } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(detailMessage(body.detail || body.error || body.message));
  return body;
}

export async function stream(path, { token, body, onToken, onSources, signal }) {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(detailMessage(error.detail || error.error));
  }
  if (!response.body) throw new Error("스트리밍 응답을 열지 못했습니다.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const event of events) {
      const eventName = event.split(/\r?\n/).find((item) => item.startsWith("event:"))?.slice(6).trim() || "message";
      const line = event.split(/\r?\n/).find((item) => item.startsWith("data:"));
      if (!line) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const data = JSON.parse(raw);
        if (data.error) throw new Error(data.error);
        if (eventName === "sources") onSources?.(data.sources ?? []);
        else if (eventName !== "done") onToken?.(data.token ?? data.delta ?? data.content ?? "");
      } catch (error) {
        if (error instanceof SyntaxError) onToken?.(raw);
        else throw error;
      }
    }
  }
}
