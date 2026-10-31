(() => {
  const $ = (selector) => document.querySelector(selector);
  const launcher = $("#supportLauncher");
  const panel = $("#supportPanel");
  const intro = $("#supportIntro");
  const conversation = $("#supportConversation");
  const messages = $("#supportMessages");
  const error = $("#supportError");
  let conversationId = null;
  let pollTimer = null;
  let lastMessageCount = 0;

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...options.headers },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Support is temporarily unavailable.");
    return body;
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function renderMessages(items) {
    if (items.length === lastMessageCount) return;
    const shouldScroll = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    const fragment = document.createDocumentFragment();
    for (const message of items) {
      const row = document.createElement("div");
      row.className = `support-message ${message.sender === "admin" ? "from-admin" : "from-visitor"}`;
      const text = document.createElement("p");
      text.textContent = message.text;
      const time = document.createElement("time");
      time.dateTime = message.createdAt;
      time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(message.createdAt));
      row.append(text, time);
      fragment.append(row);
    }
    messages.replaceChildren(fragment);
    if (shouldScroll) messages.scrollTop = messages.scrollHeight;
    if (items.length > lastMessageCount && document.hidden) $("#supportUnread").hidden = false;
    lastMessageCount = items.length;
  }

  async function refreshConversation() {
    if (!conversationId) return;
    try {
      const result = await request(`/api/support/conversation?id=${encodeURIComponent(conversationId)}`);
      renderMessages(result.messages);
    } catch (requestError) {
      showError(requestError.message);
    }
  }

  async function startConversation() {
    error.hidden = true;
    $("#supportStart").disabled = true;
    try {
      const result = await request("/api/support/start", {
        method: "POST",
        body: JSON.stringify({ name: $("#supportName").value.trim(), email: $("#supportEmail").value.trim() })
      });
      conversationId = result.id;
      intro.hidden = true;
      conversation.hidden = false;
      lastMessageCount = 0;
      await refreshConversation();
      window.clearInterval(pollTimer);
      pollTimer = window.setInterval(refreshConversation, 4000);
      $("#supportMessage").focus();
    } catch (requestError) {
      showError(requestError.message);
    } finally {
      $("#supportStart").disabled = false;
    }
  }

  launcher.addEventListener("click", async () => {
    const opening = panel.hidden;
    panel.hidden = !opening;
    launcher.setAttribute("aria-expanded", String(opening));
    if (!opening) return;
    $("#supportUnread").hidden = true;
    try {
      const result = await request("/api/support/current");
      if (result.id) {
        conversationId = result.id;
        intro.hidden = true;
        conversation.hidden = false;
        await refreshConversation();
        window.clearInterval(pollTimer);
        pollTimer = window.setInterval(refreshConversation, 4000);
      }
    } catch (requestError) {
      showError(requestError.message);
    }
  });

  $("#supportClose").addEventListener("click", () => {
    panel.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
  });
  $("#supportStart").addEventListener("click", startConversation);
  $("#supportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#supportMessage");
    const text = input.value.trim();
    if (!text || !conversationId) return;
    error.hidden = true;
    const submit = event.currentTarget.querySelector("button");
    submit.disabled = true;
    try {
      await request("/api/support/message", {
        method: "POST",
        body: JSON.stringify({ id: conversationId, text })
      });
      input.value = "";
      await refreshConversation();
    } catch (requestError) {
      showError(requestError.message);
    } finally {
      submit.disabled = false;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && conversationId) {
      $("#supportUnread").hidden = true;
      refreshConversation();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      panel.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
    }
  });
})();
