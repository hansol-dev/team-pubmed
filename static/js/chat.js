const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatLog = document.getElementById("chat-log");
const clearChatButton = document.getElementById("clear-chat");
const conversationId = "default";
const introText = "수집한 논문을 바탕으로 무엇이 궁금한가요?";

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

function showEmptyConversation() {
  chatLog.innerHTML = "";
  addMessage("assistant", introText).parentElement.classList.add("intro-message");
}

async function loadChatHistory() {
  chatInput.disabled = true;
  clearChatButton.disabled = true;
  try {
    const response = await fetch(`/api/chat/history?conversation_id=${encodeURIComponent(conversationId)}`);
    if (response.status === 401) {
      window.location.href = "/";
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || "이전 대화를 불러오지 못했습니다.");

    chatLog.innerHTML = "";
    if (!body.messages?.length) {
      showEmptyConversation();
      return;
    }
    body.messages.forEach((message) => addMessage(message.role, message.content));
  } catch (error) {
    chatLog.innerHTML = "";
    addMessage("assistant", error.message);
  } finally {
    chatInput.disabled = false;
    clearChatButton.disabled = false;
  }
}

clearChatButton.addEventListener("click", async () => {
  if (!window.confirm("현재 대화 내역을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;

  chatInput.disabled = true;
  clearChatButton.disabled = true;
  window.setAppLoading?.(true);
  try {
    const response = await fetch(
      `/api/chat/history?conversation_id=${encodeURIComponent(conversationId)}`,
      { method: "DELETE" },
    );
    if (response.status === 401) {
      window.location.href = "/";
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || "대화 내역을 삭제하지 못했습니다.");
    showEmptyConversation();
  } catch (error) {
    window.alert(error.message);
  } finally {
    window.setAppLoading?.(false);
    chatInput.disabled = false;
    clearChatButton.disabled = false;
    chatInput.focus();
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;

  addMessage("user", message);
  chatInput.value = "";
  chatInput.disabled = true;
  clearChatButton.disabled = true;
  const answer = addMessage("assistant");
  let loadingVisible = true;

  try {
    window.setAppLoading?.(true);
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversation_id: conversationId }),
    });
    if (response.status === 401) {
      window.location.href = "/";
      return;
    }
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || "답변을 생성하지 못했습니다.");
    }
    window.setAppLoading?.(false);
    loadingVisible = false;

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
    if (loadingVisible) window.setAppLoading?.(false);
    chatInput.disabled = false;
    clearChatButton.disabled = false;
    chatInput.focus();
  }
});

loadChatHistory();
