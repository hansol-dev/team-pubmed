const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatLog = document.getElementById("chat-log");

function addMessage(role, content = "") {
  const message = document.createElement("div");
  message.className = `chat-message ${role}`;
  message.innerHTML = role === "assistant"
    ? `<span class="avatar">✦</span><div></div>`
    : `<span class="avatar">나</span><div></div>`;
  message.querySelector("div").textContent = content;
  chatLog.appendChild(message);
  chatLog.scrollTop = chatLog.scrollHeight;
  return message.querySelector("div");
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;

  addMessage("user", message);
  chatInput.value = "";
  chatInput.disabled = true;
  const answer = addMessage("assistant");

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversation_id: "default" }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "답변을 생성하지 못했습니다.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      events.forEach((raw) => {
        const data = raw.split("\n").find((line) => line.startsWith("data: "));
        if (!data) return;
        try {
          const parsed = JSON.parse(data.slice(6));
          if (parsed.token) answer.textContent += parsed.token;
        } catch (_) {
          // Ignore incomplete SSE payloads.
        }
      });
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  } catch (error) {
    answer.textContent = error.message;
  } finally {
    chatInput.disabled = false;
    chatInput.focus();
  }
});
