require("dotenv").config({ path: require("node:path").resolve(__dirname, "..", ".env") });

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");
const { MongoClient, ObjectId } = require("mongodb");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || "house-renter";
const ADMIN_EMAIL = (process.env.RENTHUB_ADMIN_EMAIL || "").trim().toLowerCase();
const ADMIN_PASSWORD = process.env.RENTHUB_ADMIN_PASSWORD || "";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const SESSION_MS = 12 * 60 * 60 * 1000;
const VISITOR_COOKIE_SECONDS = 60 * 60 * 24 * 180;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_MESSAGES_PER_CONVERSATION = 1000;
const scrypt = promisify(crypto.scrypt);
const adminPasswordSalt = ADMIN_PASSWORD ? crypto.randomBytes(16) : null;
const adminPasswordHash = ADMIN_PASSWORD
  ? crypto.scryptSync(ADMIN_PASSWORD, adminPasswordSalt, 64)
  : null;
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};
const PUBLIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
  ["/houses.json", "houses.json"],
  ["/favicon.svg", "favicon.svg"],
  ["/support.js", "support.js"],
  ["/admin", "admin/index.html"],
  ["/admin/", "admin/index.html"],
  ["/admin.html", "admin/index.html"],
  ["/admin/admin.css", "admin/admin.css"],
  ["/admin/admin.js", "admin/admin.js"]
]);

if (!MONGO_URI) throw new Error("Set MONGO_URI in the environment or local .env file.");
if (ADMIN_EMAIL && ADMIN_PASSWORD.length < 12) {
  throw new Error("RENTHUB_ADMIN_PASSWORD must contain at least 12 characters.");
}

const mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
let db;
let users;
let sessions;
let conversations;
const rateLimits = new Map();

function jsonResponse(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function parseCookies(request) {
  const cookies = {};
  for (const part of (request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function cookie(name, value, options = {}) {
  const attributes = [`${name}=${value}`, "Path=/", "SameSite=Strict", "HttpOnly"];
  if (options.maxAge !== undefined) attributes.push(`Max-Age=${options.maxAge}`);
  if (options.clear) attributes.push("Max-Age=0");
  if (IS_PRODUCTION) attributes.push("Secure");
  return attributes.join("; ");
}

function ensureSameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    if (new URL(origin).host === request.headers.host) return true;
  } catch {
    jsonResponse(response, 403, { error: "This request origin is not allowed." });
    return false;
  }
  jsonResponse(response, 403, { error: "This request origin is not allowed." });
  return false;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      if (!body) return resolve({});
      try {
        const value = JSON.parse(body);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          reject(Object.assign(new Error("Request body must be a JSON object."), { status: 400 }));
          return;
        }
        resolve(value);
      } catch {
        reject(Object.assign(new Error("Request body contains invalid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function allowRequest(key, limit, intervalMs) {
  const now = Date.now();
  const timestamps = (rateLimits.get(key) || []).filter((time) => now - time < intervalMs);
  if (timestamps.length >= limit) {
    rateLimits.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  rateLimits.set(key, timestamps);
  return true;
}

async function createSession(response, kind, fields = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  await sessions.insertOne({
    tokenHash: hashToken(token),
    kind,
    ...fields,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + SESSION_MS)
  });
  response.setHeader("Set-Cookie", cookie("renthubSession", token, { maxAge: SESSION_MS / 1000 }));
}

async function currentSession(request) {
  const token = parseCookies(request).renthubSession;
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  return sessions.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
}

async function requireUser(request, response) {
  const session = await currentSession(request);
  if (!session || session.kind !== "user" || !ObjectId.isValid(session.userId)) {
    jsonResponse(response, 401, { error: "Please sign in to continue." });
    return null;
  }
  const user = await users.findOne({ _id: new ObjectId(session.userId) }, { projection: { name: 1, email: 1, favorites: 1 } });
  if (!user) {
    jsonResponse(response, 401, { error: "Your account could not be found. Please sign in again." });
    return null;
  }
  return user;
}

async function requireAdmin(request, response) {
  const session = await currentSession(request);
  if (!session || session.kind !== "admin") {
    jsonResponse(response, 401, { error: "Please sign in as an admin." });
    return null;
  }
  return session;
}

async function hashPassword(password, salt) {
  return scrypt(password, salt, 64);
}

function publicUser(user) {
  return { id: user._id.toString(), name: user.name, email: user.email, favorites: user.favorites || [] };
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validateMessage(value) {
  const text = normalizeText(value, MAX_MESSAGE_LENGTH);
  if (!text || typeof value !== "string" || value.trim().length > MAX_MESSAGE_LENGTH) {
    const error = new Error(`Messages must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
    error.status = 400;
    throw error;
  }
  return text;
}

function publicConversation(conversation) {
  const lastMessage = conversation.messages.at(-1);
  return {
    id: conversation._id.toString(),
    name: conversation.name,
    email: conversation.email,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessage: lastMessage?.text || ""
  };
}

async function handleApi(request, response, url) {
  const { pathname, searchParams } = url;
  const method = request.method;

  if (method === "OPTIONS") {
    if (!ensureSameOrigin(request, response)) return;
    response.writeHead(204, { Allow: "GET, POST, PUT, DELETE, OPTIONS", "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (pathname === "/api/auth/signup" && method === "POST") {
    if (!ensureSameOrigin(request, response)) return;
    const ip = request.socket.remoteAddress || "unknown";
    if (!allowRequest(`signup:${ip}`, 8, 60 * 60_000)) {
      jsonResponse(response, 429, { error: "Too many sign-up attempts. Try again later." });
      return;
    }
    const body = await readBody(request);
    const name = normalizeText(body.name, 80);
    const email = normalizeText(body.email, 254).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!name || !validateEmail(email) || password.length < 8 || password.length > 128) {
      jsonResponse(response, 400, { error: "Enter your name, a valid email address, and a password between 8 and 128 characters." });
      return;
    }
    const salt = crypto.randomBytes(16);
    const passwordHash = await hashPassword(password, salt);
    try {
      const result = await users.insertOne({
        name, email, passwordSalt: salt.toString("hex"), passwordHash: passwordHash.toString("hex"),
        favorites: [], createdAt: new Date()
      });
      const user = { _id: result.insertedId, name, email };
      await createSession(response, "user", { userId: result.insertedId.toString() });
      jsonResponse(response, 201, { user: publicUser(user) });
    } catch (error) {
      if (error.code === 11000) {
        jsonResponse(response, 409, { error: "An account with this email already exists." });
        return;
      }
      throw error;
    }
    return;
  }

  if (pathname === "/api/auth/signin" && method === "POST") {
    if (!ensureSameOrigin(request, response)) return;
    const ip = request.socket.remoteAddress || "unknown";
    if (!allowRequest(`signin:${ip}`, 12, 15 * 60_000)) {
      jsonResponse(response, 429, { error: "Too many sign-in attempts. Try again later." });
      return;
    }
    const body = await readBody(request);
    const email = normalizeText(body.email, 254).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const user = await users.findOne({ email });
    const salt = user?.passwordSalt ? Buffer.from(user.passwordSalt, "hex") : Buffer.alloc(16);
    const expectedHash = user?.passwordHash ? Buffer.from(user.passwordHash, "hex") : Buffer.alloc(64);
    const actualHash = await hashPassword(password.slice(0, 128), salt);
    if (password.length > 128 || !user || actualHash.length !== expectedHash.length || !crypto.timingSafeEqual(actualHash, expectedHash)) {
      jsonResponse(response, 401, { error: "Email or password is incorrect." });
      return;
    }
    await createSession(response, "user", { userId: user._id.toString() });
    jsonResponse(response, 200, { user: publicUser(user) });
    return;
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    const user = await requireUser(request, response);
    if (user) jsonResponse(response, 200, { user: publicUser(user) });
    return;
  }

  if (pathname === "/api/auth/signout" && method === "POST") {
    if (!ensureSameOrigin(request, response)) return;
    const token = parseCookies(request).renthubSession;
    if (token) await sessions.deleteOne({ tokenHash: hashToken(token) });
    jsonResponse(response, 200, { ok: true }, { "Set-Cookie": cookie("renthubSession", "", { clear: true }) });
    return;
  }

  if (pathname === "/api/auth/favorites" && method === "GET") {
    const user = await requireUser(request, response);
    if (user) jsonResponse(response, 200, { favorites: user.favorites || [] });
    return;
  }

  const favoriteMatch = pathname.match(/^\/api\/auth\/favorites\/([a-z0-9-]{1,100})$/i);
  if (favoriteMatch && ["PUT", "DELETE"].includes(method)) {
    if (!ensureSameOrigin(request, response)) return;
    const user = await requireUser(request, response);
    if (!user) return;
    const houseId = favoriteMatch[1];
    const update = method === "PUT" ? { $addToSet: { favorites: houseId } } : { $pull: { favorites: houseId } };
    const updatedUser = await users.findOneAndUpdate(
      { _id: user._id },
      update,
      { returnDocument: "after", projection: { favorites: 1 } }
    );
    jsonResponse(response, 200, { favorites: updatedUser.favorites || [] });
    return;
  }

  if (pathname === "/api/support/current" && method === "GET") {
    const visitorToken = parseCookies(request).renthubVisitor;
    const visitorTokenHash = visitorToken ? hashToken(visitorToken) : null;
    const conversation = visitorTokenHash
      ? await conversations.findOne({ visitorTokenHash }, { projection: { _id: 1 } })
      : null;
    jsonResponse(response, 200, conversation ? { id: conversation._id.toString() } : { id: null });
    return;
  }

  if (pathname === "/api/support/start" && method === "POST") {
    if (!ensureSameOrigin(request, response)) return;
    const ip = request.socket.remoteAddress || "unknown";
    if (!allowRequest(`support-start:${ip}`, 20, 60 * 60_000)) {
      jsonResponse(response, 429, { error: "Too many new conversations from this network. Try again later." });
      return;
    }
    const body = await readBody(request);
    let visitorToken = parseCookies(request).renthubVisitor;
    const headers = {};
    if (!visitorToken || !/^[A-Za-z0-9_-]{40,60}$/.test(visitorToken)) {
      visitorToken = crypto.randomBytes(32).toString("base64url");
      headers["Set-Cookie"] = cookie("renthubVisitor", visitorToken, { maxAge: VISITOR_COOKIE_SECONDS });
    }
    const visitorTokenHash = hashToken(visitorToken);
    const existing = await conversations.findOne({ visitorTokenHash }, { projection: { _id: 1 } });
    if (existing) {
      jsonResponse(response, 200, { id: existing._id.toString() }, headers);
      return;
    }
    const name = normalizeText(body.name, 80);
    const email = normalizeText(body.email, 254).toLowerCase();
    if (email && !validateEmail(email)) {
      jsonResponse(response, 400, { error: "Enter a valid email address or leave it blank." });
      return;
    }
    const now = new Date();
    const conversation = {
      visitorTokenHash, name, email, createdAt: now, updatedAt: now, messages: []
    };
    try {
      const result = await conversations.insertOne(conversation);
      jsonResponse(response, 201, { id: result.insertedId.toString() }, headers);
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existingConversation = await conversations.findOne({ visitorTokenHash }, { projection: { _id: 1 } });
      if (!existingConversation) throw error;
      jsonResponse(response, 200, { id: existingConversation._id.toString() }, headers);
    }
    return;
  }

  if (pathname === "/api/support/conversation" && method === "GET") {
    const visitorToken = parseCookies(request).renthubVisitor;
    const conversation = visitorToken
      ? await conversations.findOne({
        _id: ObjectId.isValid(searchParams.get("id")) ? new ObjectId(searchParams.get("id")) : null,
        visitorTokenHash: hashToken(visitorToken)
      }, { projection: { messages: 1 } })
      : null;
    if (!conversation) {
      jsonResponse(response, 404, { error: "Conversation not found." });
      return;
    }
    jsonResponse(response, 200, { messages: conversation.messages || [] });
    return;
  }

  if (pathname === "/api/support/message" && method === "POST") {
    if (!ensureSameOrigin(request, response)) return;
    const visitorToken = parseCookies(request).renthubVisitor;
    if (!visitorToken || !allowRequest(`visitor:${hashToken(visitorToken)}`, 12, 60_000)) {
      jsonResponse(response, 429, { error: "Please wait a moment before sending another message." });
      return;
    }
    const body = await readBody(request);
    const id = ObjectId.isValid(body.id) ? new ObjectId(body.id) : null;
    const text = validateMessage(body.text);
    const message = { id: crypto.randomUUID(), sender: "visitor", text, createdAt: new Date() };
    const updated = await conversations.updateOne(
      { _id: id, visitorTokenHash: hashToken(visitorToken), "messages.999": { $exists: false } },
      { $push: { messages: message }, $set: { updatedAt: message.createdAt } }
    );
    if (!updated.matchedCount) {
      jsonResponse(response, 404, { error: "Conversation not found or message limit reached." });
      return;
    }
    jsonResponse(response, 201, { ok: true });
    return;
  }

  if (pathname === "/api/admin/login" && method === "POST") {
    if (!ensureSameOrigin(request, response)) return;
    const ip = request.socket.remoteAddress || "unknown";
    if (!allowRequest(`admin-login:${ip}`, 8, 15 * 60_000)) {
      jsonResponse(response, 429, { error: "Too many sign-in attempts. Try again later." });
      return;
    }
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      jsonResponse(response, 503, { error: "Admin login is not configured. Set RENTHUB_ADMIN_EMAIL and RENTHUB_ADMIN_PASSWORD in the host environment." });
      return;
    }
    const body = await readBody(request);
    const email = normalizeText(body.email, 254).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const validPassword = password.length <= 128 &&
      crypto.timingSafeEqual(
        await hashPassword(password, adminPasswordSalt),
        adminPasswordHash
      );
    if (email !== ADMIN_EMAIL || !validPassword) {
      jsonResponse(response, 401, { error: "Email or password is incorrect." });
      return;
    }
    await createSession(response, "admin", { email: ADMIN_EMAIL });
    jsonResponse(response, 200, { ok: true });
    return;
  }

  if (pathname === "/api/admin/me" && method === "GET") {
    const admin = await requireAdmin(request, response);
    if (admin) jsonResponse(response, 200, { email: admin.email });
    return;
  }

  if (pathname === "/api/admin/logout" && method === "POST") {
    if (!ensureSameOrigin(request, response)) return;
    const token = parseCookies(request).renthubSession;
    if (token) await sessions.deleteOne({ tokenHash: hashToken(token), kind: "admin" });
    jsonResponse(response, 200, { ok: true }, { "Set-Cookie": cookie("renthubSession", "", { clear: true }) });
    return;
  }

  if (pathname === "/api/admin/conversations" && method === "GET") {
    if (!await requireAdmin(request, response)) return;
    const items = await conversations.find({}, {
      projection: { name: 1, email: 1, createdAt: 1, updatedAt: 1, messages: { $slice: -1 } }
    }).sort({ updatedAt: -1 }).limit(200).toArray();
    jsonResponse(response, 200, { conversations: items.map(publicConversation) });
    return;
  }

  const adminConversationMatch = pathname.match(/^\/api\/admin\/conversations\/([0-9a-f]{24})(?:\/(reply))?$/i);
  if (adminConversationMatch && method === "GET" && !adminConversationMatch[2]) {
    if (!await requireAdmin(request, response)) return;
    const conversation = await conversations.findOne(
      { _id: new ObjectId(adminConversationMatch[1]) },
      { projection: { messages: 1 } }
    );
    if (!conversation) {
      jsonResponse(response, 404, { error: "Conversation not found." });
      return;
    }
    jsonResponse(response, 200, { messages: conversation.messages || [] });
    return;
  }

  if (adminConversationMatch && method === "POST" && adminConversationMatch[2] === "reply") {
    if (!ensureSameOrigin(request, response) || !await requireAdmin(request, response)) return;
    const body = await readBody(request);
    const text = validateMessage(body.text);
    const now = new Date();
    const result = await conversations.updateOne(
      { _id: new ObjectId(adminConversationMatch[1]), "messages.999": { $exists: false } },
      { $push: { messages: { id: crypto.randomUUID(), sender: "admin", text, createdAt: now } }, $set: { updatedAt: now } }
    );
    if (!result.matchedCount) {
      jsonResponse(response, 404, { error: "Conversation not found or message limit reached." });
      return;
    }
    jsonResponse(response, 201, { ok: true });
    return;
  }

  jsonResponse(response, 404, { error: "API endpoint not found." });
}

function serveStatic(response, pathname) {
  const filename = PUBLIC_FILES.get(pathname);
  if (!filename) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
    response.end("Not found");
    return;
  }
  fs.readFile(path.join(ROOT, filename), (error, contents) => {
    if (error) {
      console.error(`Could not read public file ${filename}:`, error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Could not load this page.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(filename)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cache-Control": "no-cache"
    });
    response.end(contents);
  });
}

async function start() {
  await mongoClient.connect();
  db = mongoClient.db(DB_NAME);
  users = db.collection("users");
  sessions = db.collection("sessions");
  conversations = db.collection("support_conversations");
  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    conversations.createIndex({ visitorTokenHash: 1 }, { unique: true }),
    conversations.createIndex({ updatedAt: -1 })
  ]);
  const server = http.createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || `localhost:${PORT}`}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end("Method not allowed");
        return;
      }
      serveStatic(response, url.pathname);
    } catch (error) {
      if (error.status) {
        jsonResponse(response, error.status, { error: error.message });
        return;
      }
      console.error("Request failed:", error);
      if (!response.headersSent) jsonResponse(response, 500, { error: "The server encountered an error. Please try again." });
      else response.destroy();
    }
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`RentHub is available on port ${PORT}`);
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) console.warn("Admin login is disabled until admin environment variables are configured.");
    else console.log("The support admin inbox is available at /admin");
  });
  const shutdown = () => server.close(async () => {
    await mongoClient.close();
    process.exit(0);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch(async (error) => {
  console.error("Could not connect to MongoDB. Check MONGO_URI and network access settings.");
  console.error(`MongoDB connection error: ${error.name}${error.code ? ` (${error.code})` : ""}`);
  await mongoClient.close();
  process.exitCode = 1;
});
