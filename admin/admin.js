(() => {
  const $ = (selector) => document.querySelector(selector);
  let activeConversationId = null;
  let conversations = [];
  let refreshTimer = null;

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...options.headers },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The support service could not complete that request.");
    return body;
  }

  function notify(message) {
    const toast = $("#adminToast");
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(notify.timeout);
    notify.timeout = window.setTimeout(() => toast.classList.remove("visible"), 2500);
  }

  function setAuthenticated(authenticated) {
    $("#adminLoginView").hidden = authenticated;
    $("#adminInbox").hidden = !authenticated;
    $("#adminLogout").hidden = !authenticated;
    if (authenticated) {
      refreshInbox();
      window.clearInterval(refreshTimer);
      refreshTimer = window.setInterval(refreshInbox, 5000);
    } else {
      window.clearInterval(refreshTimer);
      activeConversationId = null;
    }
  }

  function renderConversations() {
    $("#conversationCount").textContent = `${conversations.length} total`;
    const list = $("#adminConversationList");
    if (!conversations.length) {
      list.innerHTML = '<p class="admin-empty-list">No conversations yet.</p>';
      return;
    }
    list.replaceChildren(...conversations.map((conversation) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `admin-conversation${conversation.id === activeConversationId ? " selected" : ""}`;
      button.addEventListener("click", () => openConversation(conversation.id));
      const title = document.createElement("strong");
      title.textContent = conversation.name || "RentHub visitor";
      const preview = document.createElement("span");
      preview.textContent = conversation.lastMessage || "New conversation";
      const time = document.createElement("time");
      time.textContent = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(conversation.updatedAt));
      button.append(title, preview, time);
      return button;
    }));
  }

  function renderThread(messages) {
    const container = $("#adminThreadMessages");
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      const row = document.createElement("div");
      row.className = `admin-thread-message ${message.sender === "admin" ? "from-admin" : "from-visitor"}`;
      const sender = document.createElement("strong");
      sender.textContent = message.sender === "admin" ? "Support" : "Visitor";
      const text = document.createElement("p");
      text.textContent = message.text;
      const time = document.createElement("time");
      time.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(message.createdAt));
      row.append(sender, text, time);
      fragment.append(row);
    }
    container.replaceChildren(fragment);
    container.scrollTop = container.scrollHeight;
  }

  async function openConversation(id) {
    activeConversationId = id;
    const selected = conversations.find((conversation) => conversation.id === id);
    if (!selected) return;
    $("#adminThreadEmpty").hidden = true;
    $("#adminThreadView").hidden = false;
    $("#threadName").textContent = selected.name || "RentHub visitor";
    $("#threadEmail").textContent = selected.email || "No email provided";
    renderConversations();
    try {
      const result = await request(`/api/admin/conversations/${encodeURIComponent(id)}`);
      renderThread(result.messages);
    } catch (error) {
      notify(error.message);
    }
  }

  async function refreshInbox() {
    try {
      const result = await request("/api/admin/conversations");
      conversations = result.conversations;
      renderConversations();
      if (activeConversationId) {
        const selected = conversations.find((conversation) => conversation.id === activeConversationId);
        if (selected) {
          $("#threadName").textContent = selected.name || "RentHub visitor";
          $("#threadEmail").textContent = selected.email || "No email provided";
          const thread = await request(`/api/admin/conversations/${encodeURIComponent(activeConversationId)}`);
          renderThread(thread.messages);
        } else {
          activeConversationId = null;
          $("#adminThreadView").hidden = true;
          $("#adminThreadEmpty").hidden = false;
        }
      }
    } catch (error) {
      if (error.message.includes("sign in")) setAuthenticated(false);
      else notify(error.message);
    }
  }

  $("#adminLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = $("#adminLoginError");
    error.textContent = "";
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await request("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ email: $("#adminEmail").value.trim(), password: $("#adminPassword").value })
      });
      $("#adminPassword").value = "";
      setAuthenticated(true);
    } catch (loginError) {
      error.textContent = loginError.message;
    } finally {
      button.disabled = false;
    }
  });
  $("#adminLogout").addEventListener("click", async () => {
    try {
      await request("/api/admin/logout", { method: "POST", body: "{}" });
      setAuthenticated(false);
    } catch (error) {
      notify(error.message);
    }
  });
  $("#refreshInbox").addEventListener("click", refreshInbox);
  $("#adminReplyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeConversationId) return;
    const input = $("#adminReply");
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await request(`/api/admin/conversations/${encodeURIComponent(activeConversationId)}/reply`, {
        method: "POST",
        body: JSON.stringify({ text: input.value.trim() })
      });
      input.value = "";
      await refreshInbox();
    } catch (error) {
      notify(error.message);
    } finally {
      button.disabled = false;
    }
  });

  request("/api/admin/me")
    .then(() => setAuthenticated(true))
    .catch(() => setAuthenticated(false));
})();
