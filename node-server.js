const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "admin@godstimelodge.com").trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "admin123");
const IS_DEFAULT_ADMIN_PASSWORD = ADMIN_PASSWORD === "admin123";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";
const MAX_BODY_SIZE = 1024 * 1024;
const MAX_UPLOAD_BODY_SIZE = 8 * 1024 * 1024;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DB_PATH = path.join(DATA_DIR, "node-db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");
const PAYMENT_SYMBOL_MARKUP = '<text x="12" y="16" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor">₦</text>';
let notificationVersion = 0;
const notificationClients = new Set();
let dbPool = null;
let dbCache = null;
let dbReadyPromise = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureUploadsDir() {
  ensureDataDir();
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function randomId(len = 24) {
  return crypto.randomBytes(len).toString("hex");
}

function pbkdf2Hash(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256");
  return hash.toString("hex");
}

function createUser({ email, password, role, fullName, unit }) {
  const saltHex = crypto.randomBytes(16).toString("hex");
  const passwordHash = pbkdf2Hash(password, saltHex);
  return {
    id: randomId(12),
    email: String(email).trim().toLowerCase(),
    role,
    fullName: String(fullName || "").trim(),
    unit: String(unit || "").trim(),
    active: true,
    saltHex,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
}

function createTenantInvite({ fullName, unit, inviteCode, existingEmails = [] }) {
  return {
    id: randomId(12),
    email: generateTenantEmail(fullName, existingEmails),
    fullName: String(fullName || "").trim(),
    unit: String(unit || "").trim(),
    inviteCode: String(inviteCode || "").trim().toUpperCase(),
    createdAt: new Date().toISOString(),
    usedAt: "",
  };
}

function createSession(userId) {
  const now = Date.now();
  return {
    id: randomId(18),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
}

function createBill({ tenantId, title, amount, dueDate, status = "unpaid" }) {
  return {
    id: randomId(12),
    tenantId,
    title: String(title || "").trim(),
    amount: Number(amount) || 0,
    dueDate: String(dueDate || "").trim(),
    status,
    createdAt: new Date().toISOString(),
  };
}

function createPayment({ tenantId, billId, amount, note, proofLinks = [] }) {
  const createdAt = new Date().toISOString();
  return {
    id: randomId(12),
    tenantId,
    billId: String(billId || "").trim(),
    amount: Number(amount) || 0,
    note: String(note || "").trim(),
    proofLinks: normalizeSupportLinks(proofLinks, 4),
    proofFiles: [],
    discussion: note ? [createThreadEntry("tenant", `Payment note: ${note}`, createdAt, "Tenant")] : [],
    status: "pending",
    createdAt,
    reviewedAt: "",
    statusHistory: [
      {
        status: "pending",
        detail: "Payment submitted and waiting for review.",
        at: createdAt,
        actor: "tenant",
      },
    ],
  };
}

function createMaintenanceRequest({ tenantId, title, description, evidenceNote = "", evidenceLinks = [] }) {
  const createdAt = new Date().toISOString();
  const slaHours = 72;
  return {
    id: randomId(12),
    tenantId,
    title: String(title || "").trim(),
    description: String(description || "").trim(),
    evidenceNote: normalizeLine(evidenceNote || "", 160),
    evidenceLinks: normalizeSupportLinks(evidenceLinks, 4),
    evidenceFiles: [],
    discussion: [
      createThreadEntry("tenant", `Request: ${description || title || "Maintenance issue"}`, createdAt, "Tenant"),
      ...(evidenceNote ? [createThreadEntry("tenant", `Evidence note: ${evidenceNote}`, createdAt, "Tenant")] : []),
    ],
    status: "open",
    createdAt,
    slaHours,
    dueAt: new Date(Date.parse(createdAt) + slaHours * 60 * 60 * 1000).toISOString(),
    firstResponseAt: "",
    resolvedAt: "",
    updatedAt: createdAt,
    statusHistory: [
      {
        status: "open",
        detail: "Maintenance request submitted.",
        at: createdAt,
        actor: "tenant",
      },
    ],
  };
}

function createProject({ title, description, owner, budget, dueDate, status = "planned" }) {
  return {
    id: randomId(12),
    title: String(title || "").trim(),
    description: String(description || "").trim(),
    owner: String(owner || "").trim(),
    budget: Number(budget) || 0,
    dueDate: String(dueDate || "").trim(),
    status,
    createdAt: new Date().toISOString(),
  };
}

function defaultSettings() {
  return {
    lodgeName: "Godstime Lodge",
    supportEmail: ADMIN_EMAIL,
    totalUnits: 25,
    announcement: "",
    announcementUpdatedAt: "",
  };
}

function createDefaultDb() {
  const admin = createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    role: "admin",
    fullName: "Admin",
    unit: "",
  });
  return {
    users: [admin],
    tenantInvites: [],
    sessions: [],
    bills: [],
    payments: [],
    maintenanceRequests: [],
    projects: [],
    settings: defaultSettings(),
  };
}

function normalizeDb(db) {
  const settings = db && typeof db.settings === "object" && db.settings ? db.settings : {};
  return {
    users: Array.isArray(db && db.users)
      ? db.users.map((user) => ({ ...user, active: user.active !== false }))
      : [],
    tenantInvites: Array.isArray(db && db.tenantInvites)
      ? db.tenantInvites.map((invite) => ({
          ...invite,
          email: String(invite.email || "").trim().toLowerCase() || generateTenantEmail(invite.fullName),
          fullName: normalizeLine(invite.fullName || "", 80),
          unit: normalizeLine(invite.unit || "", 40),
          inviteCode: normalizeInviteCode(invite.inviteCode),
          usedAt: String(invite.usedAt || "").trim(),
        }))
      : [],
    sessions: Array.isArray(db && db.sessions) ? db.sessions : [],
    bills: Array.isArray(db && db.bills) ? db.bills : [],
    payments: Array.isArray(db && db.payments)
      ? db.payments.map((payment) => ({
          ...payment,
          note: normalizeLine(payment.note || "", 120),
          proofLinks: normalizeSupportLinks(payment.proofLinks || payment.attachments || payment.proofLinksText || payment.evidenceLinks, 4),
          proofFiles: normalizeAttachmentRecords(payment.proofFiles || payment.uploads || payment.files || []),
          discussion: normalizeThreadEntries(payment.discussion, payment.note ? [
            createThreadEntry("tenant", `Payment note: ${payment.note}`, payment.createdAt || new Date().toISOString(), "Tenant"),
          ] : []),
          status: String(payment.status || "pending").trim() || "pending",
          createdAt: String(payment.createdAt || "").trim(),
          reviewedAt: String(payment.reviewedAt || "").trim(),
          statusHistory: normalizeStatusHistory(
            payment.statusHistory,
            "pending",
            "Payment submitted and waiting for review.",
            payment.createdAt || new Date().toISOString()
          ),
        }))
      : [],
    maintenanceRequests: Array.isArray(db && db.maintenanceRequests)
      ? db.maintenanceRequests.map((request) => ({
          ...request,
          title: normalizeLine(request.title || "", 80),
          description: normalizeLine(request.description || "", 400),
          evidenceNote: normalizeLine(request.evidenceNote || "", 160),
          evidenceLinks: normalizeSupportLinks(request.evidenceLinks || request.attachments || request.evidenceLinksText, 4),
          evidenceFiles: normalizeAttachmentRecords(request.evidenceFiles || request.uploads || request.files || []),
          discussion: normalizeThreadEntries(request.discussion, [
            createThreadEntry("tenant", `Request: ${request.description || request.title || "Maintenance issue"}`, request.createdAt || new Date().toISOString(), "Tenant"),
            ...(request.evidenceNote ? [createThreadEntry("tenant", `Evidence note: ${request.evidenceNote}`, request.createdAt || new Date().toISOString(), "Tenant")] : []),
          ]),
          status: String(request.status || "open").trim() || "open",
          createdAt: String(request.createdAt || "").trim(),
          slaHours: Math.max(1, Number(request.slaHours) || 72),
          dueAt: String(request.dueAt || "").trim() || new Date(getMaintenanceDueAt({
            createdAt: String(request.createdAt || "").trim(),
            slaHours: Math.max(1, Number(request.slaHours) || 72),
          })).toISOString(),
          firstResponseAt: String(request.firstResponseAt || "").trim(),
          resolvedAt: String(request.resolvedAt || "").trim(),
          updatedAt: String(request.updatedAt || request.createdAt || "").trim(),
          statusHistory: normalizeStatusHistory(
            request.statusHistory,
            "open",
            "Maintenance request submitted.",
            request.createdAt || new Date().toISOString()
          ),
        }))
      : [],
    projects: Array.isArray(db && db.projects) ? db.projects : [],
    settings: {
      ...defaultSettings(),
      lodgeName: normalizeLine(settings.lodgeName || defaultSettings().lodgeName, 60) || defaultSettings().lodgeName,
      supportEmail: String(settings.supportEmail || defaultSettings().supportEmail).trim().toLowerCase(),
      totalUnits: Math.max(1, Number(settings.totalUnits) || defaultSettings().totalUnits),
      announcement: normalizeLine(settings.announcement || "", 160),
      announcementUpdatedAt: String(settings.announcementUpdatedAt || "").trim(),
    },
  };
}

function persistDbToFile(db) {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(normalizeDb(db), null, 2), "utf8");
}

async function ensureDatabaseReady() {
  if (!DATABASE_URL) {
    ensureDataDir();
    if (!fs.existsSync(DB_PATH)) {
      dbCache = createDefaultDb();
      persistDbToFile(dbCache);
    } else {
      dbCache = normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
      dbCache = syncBillStatuses(dbCache);
      persistDbToFile(dbCache);
    }
    return dbCache;
  }

  if (!dbPool) {
    dbPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const result = await dbPool.query("SELECT data FROM app_state WHERE state_key = $1", ["main"]);
  if (result.rowCount) {
    dbCache = normalizeDb(result.rows[0].data);
    dbCache = syncBillStatuses(dbCache);
  } else {
    dbCache = createDefaultDb();
    await dbPool.query(
      `INSERT INTO app_state (state_key, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())`,
      ["main", JSON.stringify(dbCache)]
    );
  }
  return dbCache;
}

function loadDb() {
  if (!dbCache) {
    throw new Error("Database not ready yet.");
  }
  dbCache = syncBillStatuses(dbCache);
  return dbCache;
}

async function saveDb(db) {
  const normalized = syncBillStatuses(normalizeDb(db));
  dbCache = normalized;
  if (!DATABASE_URL) {
    persistDbToFile(normalized);
    return normalized;
  }
  if (!dbPool) {
    dbPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  await dbPool.query(
    `INSERT INTO app_state (state_key, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (state_key)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    ["main", JSON.stringify(normalized)]
  );
  return normalized;
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const sid = cookies.gtl_session;
  if (!sid) return null;
  const db = loadDb();
  const now = Date.now();
  const activeSessions = db.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  if (activeSessions.length !== db.sessions.length) {
    db.sessions = activeSessions;
    void saveDb(db);
  }
  const session = activeSessions.find((item) => item.id === sid);
  if (!session) return null;
  const userId = session.userId;
  return db.users.find((u) => u.id === userId) || null;
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

function buildSessionCookie(sid, maxAge = null) {
  const parts = [`gtl_session=${encodeURIComponent(sid)}`, "HttpOnly", "Path=/", "SameSite=Lax"];
  if (COOKIE_SECURE) parts.push("Secure");
  if (maxAge !== null) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

async function persistSession(userId) {
  const db = loadDb();
  const session = createSession(userId);
  const now = Date.now();
  db.sessions = db.sessions.filter((item) => item.userId !== userId && Date.parse(item.expiresAt) > now);
  db.sessions.push(session);
  await saveDb(db);
  return session;
}

async function destroySession(sessionId) {
  if (!sessionId) return;
  const db = loadDb();
  const nextSessions = db.sessions.filter((session) => session.id !== sessionId);
  if (nextSessions.length !== db.sessions.length) {
    db.sessions = nextSessions;
    await saveDb(db);
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(payload));
}

function notifyRealtimeChange() {
  notificationVersion += 1;
  const payload = `data: ${JSON.stringify({ version: notificationVersion })}\n\n`;
  for (const client of [...notificationClients]) {
    try {
      client.res.write(payload);
    } catch (error) {
      notificationClients.delete(client);
    }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_SIZE) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("error", reject);
    req.on("end", () => resolve(data));
  });
}

function readBodyBuffer(req, maxBytes = MAX_UPLOAD_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function parseForm(body) {
  const out = {};
  body.split("&").forEach((pair) => {
    if (!pair) return;
    const [k, v = ""] = pair.split("=");
    const key = decodeURIComponent(k.replace(/\+/g, " "));
    const val = decodeURIComponent(v.replace(/\+/g, " "));
    out[key] = val;
  });
  return out;
}

function isMultipartRequest(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return contentType.includes("multipart/form-data");
}

function parseMultipartFormData(buffer, contentType) {
  const boundaryMatch = /boundary=([^;]+)/i.exec(String(contentType || ""));
  if (!boundaryMatch) {
    return { fields: {}, files: {} };
  }
  const boundary = boundaryMatch[1].replace(/^"|"$/g, "");
  const boundaryText = `--${boundary}`;
  const bodyText = buffer.toString("latin1");
  const parts = bodyText.split(boundaryText);
  const fields = {};
  const files = {};

  parts.slice(1, -1).forEach((part) => {
    let chunk = part;
    if (chunk.startsWith("\r\n")) chunk = chunk.slice(2);
    if (chunk.endsWith("\r\n")) chunk = chunk.slice(0, -2);
    if (chunk === "--") return;
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const headerText = chunk.slice(0, headerEnd);
    const valueText = chunk.slice(headerEnd + 4);
    const headers = headerText.split("\r\n");
    const disposition = headers.find((line) => /^content-disposition:/i.test(line));
    if (!disposition) return;
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    if (!nameMatch) return;
    const fieldName = nameMatch[1];
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
    if (filenameMatch && filenameMatch[1]) {
      const fileHeader = headers.find((line) => /^content-type:/i.test(line)) || "";
      const mimeType = normalizeLine(fileHeader.split(":").slice(1).join(":") || "application/octet-stream", 80) || "application/octet-stream";
      const bufferValue = Buffer.from(valueText.replace(/\r\n$/, ""), "latin1");
      if (!files[fieldName]) files[fieldName] = [];
      files[fieldName].push({
        filename: filenameMatch[1],
        mimeType,
        size: bufferValue.length,
        buffer: bufferValue,
      });
    } else {
      fields[fieldName] = Buffer.from(valueText.replace(/\r\n$/, ""), "latin1").toString("utf8");
    }
  });

  return { fields, files };
}

async function readSubmittedForm(req) {
  if (isMultipartRequest(req)) {
    const buffer = await readBodyBuffer(req);
    const contentType = String(req.headers["content-type"] || "");
    return parseMultipartFormData(buffer, contentType);
  }
  const body = await readBody(req);
  return { fields: parseForm(body), files: {} };
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDateOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-NG", {
    dateStyle: "medium",
  }).format(date);
}

function percentage(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function parseTimestamp(value) {
  const ts = Date.parse(value || "");
  return Number.isFinite(ts) ? ts : 0;
}

function compareNewestFirst(a, b) {
  return parseTimestamp(b.createdAt) - parseTimestamp(a.createdAt);
}

function compareBillTimeline(a, b) {
  return parseTimestamp(a.dueDate || a.createdAt) - parseTimestamp(b.dueDate || b.createdAt);
}

function formatShortDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(Math.abs(ms) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes <= 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function getMaintenanceDueAt(request) {
  const dueAt = request && request.dueAt ? Date.parse(request.dueAt) : Number.NaN;
  if (Number.isFinite(dueAt)) return dueAt;
  const createdAt = request && request.createdAt ? Date.parse(request.createdAt) : Number.NaN;
  const slaHours = Math.max(1, Number(request && request.slaHours) || 72);
  if (Number.isFinite(createdAt)) return createdAt + slaHours * 60 * 60 * 1000;
  return Date.now() + slaHours * 60 * 60 * 1000;
}

function getMaintenanceSlaState(request) {
  if (!request) {
    return {
      tone: "blue",
      label: "No SLA",
      detail: "No maintenance request selected.",
      dueAt: "",
    };
  }
  const dueAtMs = getMaintenanceDueAt(request);
  const dueAt = new Date(dueAtMs).toISOString();
  if (request.status === "resolved") {
    return {
      tone: "green",
      label: "Resolved",
      detail: `Resolved ${request.resolvedAt ? `on ${formatDateTime(request.resolvedAt)}` : "within the maintenance window"}.`,
      dueAt,
    };
  }
  const remaining = dueAtMs - Date.now();
  if (remaining < 0) {
    return {
      tone: "red",
      label: `Overdue by ${formatShortDuration(remaining)}`,
      detail: `Target due ${formatDateTime(dueAt)}.`,
      dueAt,
    };
  }
  if (remaining <= 6 * 60 * 60 * 1000) {
    return {
      tone: "orange",
      label: `Due in ${formatShortDuration(remaining)}`,
      detail: `Target due ${formatDateTime(dueAt)}.`,
      dueAt,
    };
  }
  return {
    tone: "blue",
    label: `Due ${formatDateTime(dueAt)}`,
    detail: `${formatShortDuration(remaining)} left before the SLA target.`,
    dueAt,
  };
}

function createStatusHistoryEntry(status, detail, at = new Date().toISOString()) {
  return {
    status: String(status || "").trim(),
    detail: normalizeLine(detail || "", 160),
    at: String(at || "").trim() || new Date().toISOString(),
    actor: "system",
  };
}

function normalizeStatusHistory(entries, fallbackStatus, fallbackDetail, fallbackAt) {
  const normalized = Array.isArray(entries)
    ? entries
        .map((entry) => ({
          status: String((entry && entry.status) || "").trim(),
          detail: normalizeLine((entry && entry.detail) || "", 160),
          at: String((entry && entry.at) || "").trim(),
          actor: String((entry && entry.actor) || "system").trim() || "system",
        }))
        .filter((entry) => entry.status && entry.at)
    : [];
  if (normalized.length) return normalized;
  return [createStatusHistoryEntry(fallbackStatus, fallbackDetail, fallbackAt)];
}

function createTrailEntry(status, detail, at = new Date().toISOString(), actor = "system") {
  return {
    status: String(status || "").trim(),
    detail: normalizeLine(detail || "", 160),
    at: String(at || "").trim() || new Date().toISOString(),
    actor: String(actor || "system").trim() || "system",
  };
}

function normalizeSupportLinks(value, maxItems = 4) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n,]+/)
        .map((item) => item);
  return raw
    .map((item) => normalizeLine(item, 180))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeAttachmentRecords(value, maxItems = 4) {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        const url = normalizeLine(item, 240);
        return url ? { name: url, url } : null;
      }
      const url = normalizeLine(item.url || item.path || item.href || "", 240);
      const storedName = normalizeLine(item.storedName || item.filename || item.fileName || "", 120);
      const name = normalizeLine(item.name || item.originalName || item.label || storedName || url, 120);
      if (!url && !storedName) return null;
      return {
        name: name || "Attachment",
        url,
        storedName,
        mimeType: normalizeLine(item.mimeType || item.type || "", 80),
        size: Math.max(0, Number(item.size) || 0),
        uploadedAt: String(item.uploadedAt || item.createdAt || "").trim(),
      };
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function attachmentFileUrl(record) {
  if (!record) return "";
  if (record.url) return record.url;
  if (record.storedName) return `/uploads/${encodeURIComponent(record.storedName)}`;
  return "";
}

function storeUploadedFile(file, prefix) {
  ensureUploadsDir();
  const originalName = normalizeLine(file && file.filename ? file.filename : "upload", 120) || "upload";
  const ext = path.extname(originalName).toLowerCase().slice(0, 12);
  const safeExt = /^[.][a-z0-9]+$/.test(ext) ? ext : "";
  const storedName = `${prefix}-${randomId(10)}${safeExt}`;
  const filePath = path.join(UPLOADS_DIR, storedName);
  fs.writeFileSync(filePath, Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || ""));
  return {
    id: randomId(8),
    name: originalName,
    storedName,
    url: `/uploads/${encodeURIComponent(storedName)}`,
    mimeType: normalizeLine(file.mimeType || "application/octet-stream", 80) || "application/octet-stream",
    size: Math.max(0, Number(file.size) || (Buffer.isBuffer(file.buffer) ? file.buffer.length : 0)),
    uploadedAt: new Date().toISOString(),
  };
}

function createThreadEntry(authorRole, body, at = new Date().toISOString(), authorName = "") {
  return {
    authorRole: String(authorRole || "system").trim() || "system",
    authorName: normalizeLine(authorName || "", 60),
    body: normalizeLine(body || "", 260),
    at: String(at || "").trim() || new Date().toISOString(),
  };
}

function normalizeThreadEntries(entries, fallbackEntries = []) {
  const normalized = Array.isArray(entries)
    ? entries
        .map((entry) => createThreadEntry(
          (entry && entry.authorRole) || (entry && entry.actor) || "system",
          (entry && entry.body) || (entry && entry.detail) || "",
          (entry && entry.at) || (entry && entry.createdAt) || new Date().toISOString(),
          (entry && entry.authorName) || ""
        ))
        .filter((entry) => entry.body && entry.at)
    : [];
  if (normalized.length) return normalized;
  return Array.isArray(fallbackEntries)
    ? fallbackEntries
        .map((entry) => createThreadEntry(
          entry.authorRole || entry.actor || "system",
          entry.body || entry.detail || "",
          entry.at || new Date().toISOString(),
          entry.authorName || ""
        ))
        .filter((entry) => entry.body && entry.at)
    : [];
}

function formatStatusLabel(status) {
  return String(status || "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isValidDateInput(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim()) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function normalizeLine(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeNameKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function generateTenantEmail(fullName, existingEmails = []) {
  const base = normalizeNameKey(fullName) || "tenant";
  const taken = new Set(existingEmails.map((email) => String(email || "").trim().toLowerCase()));
  let candidate = `${base}.tn@gtlodge.com`;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${suffix}.tn@gtlodge.com`;
    suffix += 1;
  }
  return candidate;
}

function normalizeInviteCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function generateInviteCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function getBillStatus(bill) {
  if (!bill) return "unpaid";
  if (bill.status === "paid") return "paid";
  if (isValidDateInput(bill.dueDate)) {
    const dueTs = Date.parse(`${bill.dueDate}T23:59:59Z`);
    if (dueTs < Date.now()) return "overdue";
  }
  return "unpaid";
}

function getBillStatusTone(status) {
  if (status === "paid") return "green";
  if (status === "overdue") return "red";
  return "blue";
}

function getPaymentStatusTone(status) {
  if (status === "approved") return "green";
  if (status === "rejected") return "red";
  return "orange";
}

function getMaintenanceStatusTone(status) {
  if (status === "resolved") return "green";
  if (status === "in-progress") return "orange";
  return "blue";
}

function getProjectStatusTone(status) {
  if (status === "completed") return "green";
  if (status === "active") return "orange";
  return "blue";
}

function getTenantBillOptions(db, tenantId, { includePaid = true } = {}) {
  return db.bills
    .filter((bill) => bill.tenantId === tenantId)
    .filter((bill) => includePaid || getBillStatus(bill) !== "paid")
    .sort(compareBillTimeline);
}

function getApprovedPaymentTotal(db, billId) {
  return db.payments
    .filter((payment) => payment.billId === billId && payment.status === "approved")
    .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
}

function syncBillStatuses(db) {
  db.bills.forEach((bill) => {
    const approvedTotal = getApprovedPaymentTotal(db, bill.id);
    bill.status = approvedTotal >= (Number(bill.amount) || 0) && Number(bill.amount) > 0 ? "paid" : "unpaid";
  });
  return db;
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

function checkHealth() {
  ensureDataDir();
  const db = loadDb();
  const now = Date.now();
  const activeSessions = db.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  return {
    ok: true,
    users: Array.isArray(db.users) ? db.users.length : 0,
    sessions: activeSessions.length,
  };
}

function isFormRequest(req) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return contentType.includes("application/x-www-form-urlencoded");
}

function htmlPage(title, inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/assets/sbiam-style.css" />
</head>
<body>
  ${inner}
  <script src="/assets/sbiam-script.js"></script>
</body>
</html>`;
}

function layoutPage({ title, activePath, user, roleLabel, navLinks, body, showThemeToggle = true }) {
  const shell = renderShellChrome({
    user,
    roleLabel,
    navLinks,
    activePath,
    showThemeToggle,
    showNavLinks: true,
    showMobileMenu: true,
    logoSub: roleLabel,
  });

  return htmlPage(
    title,
    `<div class="app-container">
      ${shell.mobileMenu}
      ${shell.topNav}
      ${body}
      ${shell.mobileTabBar}
      <footer class="footer"><p>&copy; 2026 Sbiam Solutions. All rights reserved.</p></footer>
    </div>`
  );
}

function renderShellChrome({
  user,
  roleLabel,
  navLinks = [],
  activePath,
  showThemeToggle = true,
  showNavLinks = true,
  showMobileMenu = true,
  logoSub,
}) {
  const avatar = escapeHtml((user.fullName || "A").slice(0, 1).toUpperCase());
  const name = escapeHtml(user.fullName || "User");
  const supplementalLinks = user.role === "admin"
    ? [
        {
          href: "/admin/bills",
          label: "Bills",
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/></svg>',
        },
        {
          href: "/admin/maintenance",
          label: "Maintenance",
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        },
        {
          href: "/admin/disputes",
          label: "Disputes",
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="M12 18h.01"/><path d="M5 5l14 14"/></svg>',
        },
      ]
    : user.role === "tenant"
    ? [
        {
          href: "/tenant/disputes",
          label: "Disputes",
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="M12 18h.01"/><path d="M5 5l14 14"/></svg>',
        },
      ]
    : [];
  const visibleNavLinks = [
    ...navLinks,
    ...supplementalLinks.filter((item) => !navLinks.some((existing) => existing.href === item.href)),
  ];
  const findNavItem = (href) => visibleNavLinks.find((item) => item.href === href) || null;
  const roleQuickLinkHrefs = user.role === "tenant"
    ? ["/tenant/dashboard", "/tenant/bills", "/tenant/payments", "/tenant/requests", "/tenant/disputes"]
    : ["/admin/dashboard", "/admin/analytics", "/admin/tenants", "/admin/payments", "/admin/bills", "/admin/maintenance", "/admin/disputes"];
  const quickLinksSource = roleQuickLinkHrefs
    .map(findNavItem)
    .filter(Boolean);
  const settingsLink = user.role === "admin"
    ? {
        href: "/admin/settings",
        label: "Settings",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06A2 2 0 1 1 4.21 16.96l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.04 4.3l.06.06A1.65 1.65 0 0 0 8.92 4a1.65 1.65 0 0 0 1-1.51V2a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06A2 2 0 1 1 19.79 7.04l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.61.79 1.02 1.43 1H21a2 2 0 1 1 0 4h-.17c-.64 0-1.23.41-1.43 1z"/></svg>',
      }
    : null;
  const isItemActive = (item) => activePath === item.href || (Array.isArray(item.children) && item.children.some((child) => activePath === child.href));
  const links = showNavLinks
    ? visibleNavLinks
        .map(
          (item) => item.children && item.children.length
            ? `<div class="nav-item nav-item-has-dropdown">
                <a href="${item.href}" class="nav-link${isItemActive(item) ? " active" : ""}">
                  ${item.icon}
                  ${escapeHtml(item.label)}
                  <svg class="dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
                </a>
                <div class="dropdown-menu">
                  ${item.children
                    .map((child) => `<a href="${child.href}" class="${activePath === child.href ? "active" : ""}">
                      ${child.icon}
                      <span>${escapeHtml(child.label)}</span>
                    </a>`)
                    .join("")}
                </div>
              </div>`
            : `<div class="nav-item">
                <a href="${item.href}" class="nav-link${isItemActive(item) ? " active" : ""}">
                  ${item.icon}
                  ${escapeHtml(item.label)}
                </a>
              </div>`
        )
        .join("")
    : "";
  const mobileLinks = showMobileMenu
    ? visibleNavLinks
        .map(
          (item) => item.children && item.children.length
            ? `<div class="mobile-menu-group">
                <div class="mobile-menu-group-label">
                  ${item.icon}
                  <span>${escapeHtml(item.label)}</span>
                </div>
                ${item.children
                  .map((child) => `<a href="${child.href}" class="${activePath === child.href ? "active" : ""}">
                    ${child.icon}
                    ${escapeHtml(child.label)}
                  </a>`)
                  .join("")}
              </div>`
            : `<a href="${item.href}" class="${activePath === item.href ? "active" : ""}">
                ${item.icon}
                ${escapeHtml(item.label)}
              </a>`
        )
        .join("")
    : "";
  const mobileQuickLinks = quickLinksSource.length
    ? `<div class="mobile-menu-quick">
        <div class="mobile-menu-quick-label">Quick Access</div>
        <div class="mobile-menu-quick-grid">
          ${quickLinksSource
            .map((item) => `<a href="${item.href}" class="mobile-quick-link${activePath === item.href ? " active" : ""}">
              ${item.icon}
              <span>${escapeHtml(item.label)}</span>
            </a>`)
            .join("")}
        </div>
      </div>`
    : "";
  const navMenu = showNavLinks ? `<div class="nav-menu">${links}</div>` : "";
  const themeToggle = showThemeToggle
    ? `<div class="theme-toggle">
        <button class="theme-btn theme-btn-snow active" onclick="setTheme('snow')" title="Snow Edition">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        </button>
        <button class="theme-btn theme-btn-carbon" onclick="setTheme('carbon')" title="Carbon Edition">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
      </div>`
    : "";
  const dashboardPath = user.role === "admin" ? "/admin/dashboard" : "/tenant/dashboard";
  const mobileMenu = showMobileMenu
    ? `<div class="mobile-menu-overlay"></div>
      <div class="mobile-menu">
        <div class="mobile-menu-header">
          <a href="${dashboardPath}" class="logo">
            <div class="logo-icon logo-mark">GT</div><div class="logo-text"><div class="logo-name">Godstime Lodge</div><div class="logo-sub">${escapeHtml(logoSub || roleLabel)}</div></div>
          </a>
          <button class="mobile-menu-close" onclick="closeMobileMenu()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <nav class="mobile-menu-nav">
          ${mobileQuickLinks}
          ${mobileLinks}
        </nav>
        <div class="mobile-menu-footer">
          ${settingsLink ? `<a href="${settingsLink.href}" class="mobile-menu-settings">
            ${settingsLink.icon}
            ${escapeHtml(settingsLink.label)}
          </a>` : ""}
          <a href="/logout" class="mobile-logout-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Logout
          </a>
          ${themeToggle}
        </div>
      </div>`
    : "";
  const topNav = `<nav class="top-nav">
        <div class="nav-container">
          <div class="nav-left">
            <a href="${dashboardPath}" class="logo logo-panel">
              <div class="logo-icon logo-mark">GT</div><div class="logo-text"><div class="logo-name">Godstime Lodge</div><div class="logo-sub">${escapeHtml(logoSub || roleLabel)}</div></div>
            </a>
            ${navMenu ? `<div class="nav-pills-wrap">${navMenu}</div>` : ""}
          </div>
          <div class="nav-right">
            ${themeToggle}
            <div class="user-menu-wrap">
              <button class="user-menu" type="button">
                <div class="user-avatar">${avatar}</div>
                <div class="user-meta">
                  <span class="user-name">${name}</span>
                  <span class="user-role">${escapeHtml(roleLabel)}</span>
                </div>
                <svg class="dropdown-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div class="dropdown-menu user-dropdown-menu">
                <div class="user-dropdown-head">
                  <div class="user-avatar user-avatar-large">${avatar}</div>
                  <div>
                    <div class="user-dropdown-name">${name}</div>
                    <div class="user-dropdown-role">${escapeHtml(roleLabel)}</div>
                  </div>
                </div>
                ${settingsLink ? `<a href="${settingsLink.href}" class="${activePath === settingsLink.href ? "active" : ""}">
                  ${settingsLink.icon}
                  <span>${escapeHtml(settingsLink.label)}</span>
                </a>` : ""}
                <a href="/logout">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                  <span>Logout</span>
                </a>
              </div>
            </div>
            ${showMobileMenu ? `<button class="mobile-menu-btn" onclick="toggleMobileMenu()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>` : ""}
          </div>
        </div>
      </nav>`;
  const mobileTabBar = user.role === "tenant" && quickLinksSource.length
    ? `<nav class="mobile-tabbar" aria-label="Tenant quick navigation">
        ${quickLinksSource
          .map((item) => `<a href="${item.href}" class="mobile-tab-link${activePath === item.href ? " active" : ""}">
            ${item.icon}
            <span>${escapeHtml(item.label)}</span>
          </a>`)
          .join("")}
      </nav>`
    : "";
  return { mobileMenu, topNav, mobileTabBar };
}

function renderActivityItem({ tone = "blue", iconSvg, title, detail, time, badge = "", badgeTone = tone }) {
  return `<div class="activity-item">
    <div class="activity-icon ${tone}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${iconSvg}</svg>
    </div>
    <div class="activity-content">
      <div class="activity-head">
        <p class="activity-text"><strong>${escapeHtml(title)}</strong></p>
        ${badge ? `<span class="badge badge-${escapeHtml(badgeTone)} activity-badge">${escapeHtml(badge)}</span>` : ""}
      </div>
      <p class="activity-text" style="color: var(--text-secondary);">${escapeHtml(detail)}</p>
      <span class="activity-time">${escapeHtml(time)}</span>
    </div>
  </div>`;
}

function renderActivityFeed(items, emptyMessage) {
  return items.length ? items.join("") : `<div style="padding:1rem; color:var(--text-secondary);">${escapeHtml(emptyMessage)}</div>`;
}

function renderStatusTrail(entries, emptyMessage) {
  const items = Array.isArray(entries) && entries.length
    ? entries
        .map((entry) => {
          const tone = ["open", "in-progress", "resolved"].includes(entry.status)
            ? getMaintenanceStatusTone(entry.status)
            : getPaymentStatusTone(entry.status);
          const actorLabel = entry.actor === "management"
            ? "Management"
            : entry.actor === "tenant"
            ? "Tenant"
            : "System";
          return `<div class="status-timeline-item">
            <div class="status-timeline-marker ${escapeHtml(tone)}"></div>
            <div class="status-timeline-content">
              <div class="status-timeline-head">
                <strong>${escapeHtml(formatStatusLabel(entry.status))}</strong>
                <span class="status-timeline-actor">${escapeHtml(actorLabel)}</span>
                <span>${escapeHtml(formatDateTime(entry.at))}</span>
              </div>
              <p>${escapeHtml(entry.detail || "")}</p>
            </div>
          </div>`;
        })
        .join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">${escapeHtml(emptyMessage)}</div>`;
  return `<div class="status-timeline">${items}</div>`;
}

function renderSupportLinks(links, emptyMessage = "No supporting documents attached.") {
  const items = Array.isArray(links) && links.length
    ? `<ul class="support-link-list">${links.map((link) => {
        const url = typeof link === "string" ? link : attachmentFileUrl(link);
        const label = typeof link === "string" ? link : (link.name || link.storedName || link.url || "Attachment");
        if (!url) return "";
        return `<li><span class="support-link-dot"></span><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a></li>`;
      }).join("")}</ul>`
    : `<div style="padding:0.85rem 0; color:var(--text-secondary);">${escapeHtml(emptyMessage)}</div>`;
  return items;
}

function renderDiscussionThread(entries, emptyMessage) {
  const items = Array.isArray(entries) && entries.length
    ? entries
        .map((entry) => {
          const actorLabel = entry.authorRole === "management"
            ? "Management"
            : entry.authorRole === "tenant"
            ? "Tenant"
            : "System";
          const nameLabel = entry.authorName ? ` • ${escapeHtml(entry.authorName)}` : "";
          return `<div class="discussion-thread-item">
            <div class="discussion-thread-head">
              <strong>${escapeHtml(actorLabel)}</strong>${nameLabel}
              <span>${escapeHtml(formatDateTime(entry.at))}</span>
            </div>
            <p>${escapeHtml(entry.body || "")}</p>
          </div>`;
        })
        .join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">${escapeHtml(emptyMessage)}</div>`;
  return `<div class="discussion-thread">${items}</div>`;
}

function renderReminderSection(title, subtitle, items, emptyMessage) {
  const body = items.length
    ? items
        .map((item) => `<article class="reminder-card ${escapeHtml(item.tone || "accent")}">
          <div class="reminder-head">
            <span class="reminder-label">${escapeHtml(item.label || "Reminder")}</span>
            ${item.meta ? `<span class="reminder-meta">${escapeHtml(item.meta)}</span>` : ""}
          </div>
          <h3 class="reminder-title">${escapeHtml(item.title)}</h3>
          <p class="reminder-copy">${escapeHtml(item.detail)}</p>
          ${item.href ? `<a href="${item.href}" class="btn ${item.tone === "success" ? "btn-secondary" : "btn-primary"}">${escapeHtml(item.actionLabel || "Open")}</a>` : ""}
        </article>`)
        .join("")
    : `<div class="reminder-empty">${escapeHtml(emptyMessage)}</div>`;
  return `<div class="card" style="margin-bottom: 1.5rem;">
    <div class="card-header">
      <div>
        <h3 class="card-title">${escapeHtml(title)}</h3>
        <p class="card-subtitle">${escapeHtml(subtitle)}</p>
      </div>
    </div>
    <div class="reminder-grid">
      ${body}
    </div>
  </div>`;
}

function buildTenantReminderItems(user, db) {
  const bills = getTenantBillOptions(db, user.id);
  const payments = db.payments
    .filter((payment) => payment.tenantId === user.id)
    .sort(compareNewestFirst);
  const requests = db.maintenanceRequests
    .filter((request) => request.tenantId === user.id)
    .sort(compareNewestFirst);
  const openBills = bills.filter((bill) => getBillStatus(bill) !== "paid");
  const pendingPayments = payments.filter((payment) => payment.status === "pending");
  const resolvedRequests = requests.filter((request) => request.status === "resolved");
  const todayTs = Date.now();
  const nextBill = openBills
    .slice()
    .sort((a, b) => {
      const aTime = isValidDateInput(a.dueDate) ? Date.parse(`${a.dueDate}T00:00:00Z`) : Number.POSITIVE_INFINITY;
      const bTime = isValidDateInput(b.dueDate) ? Date.parse(`${b.dueDate}T00:00:00Z`) : Number.POSITIVE_INFINITY;
      return aTime - bTime;
    })[0] || null;
  const overdueBills = openBills.filter((bill) => isValidDateInput(bill.dueDate) && Date.parse(`${bill.dueDate}T23:59:59Z`) < todayTs);
  const upcomingBills = openBills.filter((bill) => {
    if (!isValidDateInput(bill.dueDate)) return false;
    const dueTs = Date.parse(`${bill.dueDate}T23:59:59Z`);
    const daysAway = Math.ceil((dueTs - todayTs) / 86400000);
    return daysAway >= 0 && daysAway <= 7;
  });
  const items = [];
  if (overdueBills.length) {
    items.push({
      tone: "warning",
      label: "Due now",
      title: "You have overdue bills",
      detail: `${overdueBills.length} bill(s) are past due. Paying them first will keep your account in good standing.`,
      meta: `Outstanding ${formatCurrency(overdueBills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0))}`,
      href: "/tenant/bills",
      actionLabel: "Pay attention",
    });
  } else if (upcomingBills.length) {
    items.push({
      tone: "accent",
      label: "Upcoming",
      title: "A bill is due soon",
      detail: `${upcomingBills.length} bill(s) will be due within the next 7 days.`,
      meta: nextBill && isValidDateInput(nextBill.dueDate) ? `Next due ${formatDateOnly(`${nextBill.dueDate}T00:00:00Z`)}` : "Review schedule",
      href: "/tenant/bills",
      actionLabel: "Review bills",
    });
  }
  if (pendingPayments.length) {
    items.push({
      tone: "accent",
      label: "Pending",
      title: "A payment is waiting for approval",
      detail: `${pendingPayments.length} payment submission(s) are still being reviewed by management.`,
      meta: `Latest ${formatCurrency(pendingPayments[0].amount)}`,
      href: "/tenant/payments",
      actionLabel: "Check status",
    });
  }
  if (resolvedRequests.length) {
    items.push({
      tone: "success",
      label: "Update",
      title: "A maintenance request has been resolved",
      detail: `Management marked ${resolvedRequests[0].title} as resolved. Review it and reopen only if needed.`,
      meta: formatDateTime(resolvedRequests[0].createdAt),
      href: "/tenant/requests",
      actionLabel: "View requests",
    });
  }
  if (db.settings.announcement && db.settings.announcementUpdatedAt) {
    items.push({
      tone: "orange",
      label: "Notice",
      title: "Management posted a lodge update",
      detail: db.settings.announcement,
      meta: formatDateTime(db.settings.announcementUpdatedAt),
      href: "/tenant/dashboard",
      actionLabel: "Read update",
    });
  }
  return items;
}

function buildAdminReminderItems(db) {
  const bills = [...db.bills].sort(compareNewestFirst);
  const payments = [...db.payments].sort(compareNewestFirst);
  const maintenanceRequests = [...db.maintenanceRequests].sort(compareNewestFirst);
  const openBills = bills.filter((bill) => getBillStatus(bill) !== "paid");
  const pendingPayments = payments.filter((payment) => payment.status === "pending");
  const openMaintenance = maintenanceRequests.filter((request) => request.status !== "resolved");
  const pendingInvites = db.tenantInvites.filter((invite) => !invite.usedAt).sort(compareNewestFirst);
  const latestPendingPayment = pendingPayments[0] || null;
  const latestOpenMaintenance = openMaintenance[0] || null;
  const latestPendingInvite = pendingInvites[0] || null;
  const todayTs = Date.now();
  const overdueBills = openBills.filter((bill) => isValidDateInput(bill.dueDate) && Date.parse(`${bill.dueDate}T23:59:59Z`) < todayTs);
  const items = [];
  if (pendingPayments.length) {
    items.push({
      tone: "warning",
      label: "Approval",
      title: "Pending payments need review",
      detail: `${pendingPayments.length} payment submission(s) are still waiting for approval or rejection.`,
      meta: latestPendingPayment ? `${formatCurrency(latestPendingPayment.amount)} latest` : "Review queue",
      href: "/admin/payments",
      actionLabel: "Review now",
    });
  }
  if (overdueBills.length) {
    items.push({
      tone: "accent",
      label: "Overdue",
      title: "Some tenant bills are past due",
      detail: `${overdueBills.length} bill(s) are overdue and may need follow-up with tenants.`,
      meta: formatCurrency(overdueBills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0)),
      href: "/admin/bills",
      actionLabel: "Check bills",
    });
  }
  if (openMaintenance.length) {
    items.push({
      tone: "orange",
      label: "Open",
      title: "Maintenance requests still need attention",
      detail: `${openMaintenance.length} unresolved request(s) remain in the maintenance queue.`,
      meta: latestOpenMaintenance ? latestOpenMaintenance.title : "Open queue",
      href: "/admin/maintenance",
      actionLabel: "Open queue",
    });
  }
  if (pendingInvites.length) {
    items.push({
      tone: "warning",
      label: "Invite",
      title: "Approved tenant invites are unclaimed",
      detail: `${pendingInvites.length} invite(s) have been created but not yet used by the approved tenants.`,
      meta: latestPendingInvite ? latestPendingInvite.fullName || latestPendingInvite.email : "Pending invites",
      href: "/admin/tenants",
      actionLabel: "Manage invites",
    });
  }
  if (!db.settings.announcement) {
    items.push({
      tone: "success",
      label: "Tip",
      title: "Post a short update for tenants",
      detail: "A current announcement helps tenants notice billing or operations updates without contacting management.",
      meta: "Admin settings",
      href: "/admin/settings",
      actionLabel: "Open settings",
    });
  }
  return items;
}

function renderTenantReminderSection(user, db) {
  return `<div data-live-reminders="tenant">${renderReminderSection(
    "Notifications & Reminders",
    "Helpful prompts based on your bills, requests, and recent management updates.",
    buildTenantReminderItems(user, db),
    "You are all caught up. New reminders will appear here when something needs your attention."
  )}</div>`;
}

function renderAdminReminderSection(db) {
  return `<div data-live-reminders="admin">${renderReminderSection(
    "Notifications & Reminders",
    "Operational prompts to help management stay ahead of approvals, follow-ups, and tenant communication.",
    buildAdminReminderItems(db),
    "Operations look clear right now. New reminders will appear when follow-up is needed."
  )}</div>`;
}

function buildRealtimeNotificationPayload(user, db) {
  if (user.role === "tenant") {
    const items = buildTenantReminderItems(user, db);
    return {
      ok: true,
      role: "tenant",
      version: notificationVersion,
      count: items.length,
      items,
      html: renderTenantReminderSection(user, db),
    };
  }
  const items = buildAdminReminderItems(db);
  return {
    ok: true,
    role: "admin",
    version: notificationVersion,
    count: items.length,
    items,
    html: renderAdminReminderSection(db),
  };
}

function renderAnnouncementCard(message, title = "Announcement", updatedAt = "") {
  if (!String(message || "").trim()) return "";
  return `<div class="card" style="margin-bottom:1.5rem; border-color: rgba(56, 189, 248, 0.24); background: linear-gradient(135deg, rgba(56,189,248,0.10), rgba(34,197,94,0.06));">
    <div class="card-header">
      <div>
        <h3 class="card-title">${escapeHtml(title)}</h3>
        <p class="card-subtitle">Latest update from management${updatedAt ? ` • ${escapeHtml(formatDateTime(updatedAt))}` : ""}</p>
      </div>
      <span class="badge badge-blue">Live</span>
    </div>
    <div style="padding: 0 1.25rem 1.25rem; color: var(--text-primary);">${escapeHtml(message)}</div>
  </div>`;
}

function matchesSearch(values, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return values.some((value) => String(value || "").toLowerCase().includes(needle));
}

function sectionHeader(title, subtitle, message = "") {
  const banner = message
    ? `<div class="alert" style="margin-bottom:1rem; padding:0.9rem 1rem; border:1px solid var(--border); border-radius:16px; background:rgba(34,197,94,0.08); color:var(--text-primary);">${escapeHtml(message)}</div>`
    : "";
  return `${banner}<div class="page-header"><h1 class="greeting">${escapeHtml(title)}</h1><p class="greeting-sub">${escapeHtml(subtitle)}</p></div>`;
}

function loginView(error = "") {
  const err = error
    ? `<div class="alert alert-error" style="margin-bottom:1rem;">${escapeHtml(error)}</div>`
    : "";
  return htmlPage(
    "Login - Godstime Lodge",
    `<div class="login-page">
      <div class="login-container">
        <div class="login-card">
          <div class="login-header">
            <div class="login-logo">
              <div class="logo-icon logo-mark">GT</div>
              <div class="logo-text">
                <div class="logo-name">Godstime Lodge</div>
                <div class="logo-sub">Tenant Billing</div>
              </div>
            </div>
            <h1 class="login-title">Sign in</h1>
            <p class="login-subtitle">Tenants can only access their dashboard after login.</p>
          </div>
          ${err}
          <form class="login-form" method="post" action="/login">
            <div class="form-group">
              <label class="form-label">Email Address</label>
              <input name="email" type="email" class="form-input" placeholder="you@example.com" required />
            </div>
            <div class="form-group">
              <label class="form-label">Password</label>
              <input name="password" type="password" class="form-input" placeholder="Enter your password" required />
            </div>
            <button type="submit" class="btn btn-primary">Sign In</button>
          </form>
          <p class="login-footer" style="margin-top:1rem;">Need access? <a href="/register">Use your tenant invite</a> or contact management for approval.</p>
        </div>
      </div>
    </div>`
  );
}

function registerView(error = "") {
  const err = error
    ? `<div class="alert alert-error" style="margin-bottom:1rem;">${escapeHtml(error)}</div>`
    : "";
  return htmlPage(
    "Create Tenant Account - Godstime Lodge",
    `<div class="login-page">
      <div class="login-container">
        <div class="login-card">
          <div class="login-header">
            <div class="login-logo">
              <div class="logo-icon logo-mark">GT</div>
              <div class="logo-text">
                <div class="logo-name">Godstime Lodge</div>
                <div class="logo-sub">Tenant Billing</div>
              </div>
            </div>
            <h1 class="login-title">Create tenant account</h1>
            <p class="login-subtitle">Only tenants approved by management can register with an invite code.</p>
          </div>
          ${err}
          <form class="login-form" method="post" action="/register" data-tenant-email-form data-invite-form>
            <div class="form-group">
              <label class="form-label">Full Name</label>
              <input name="full_name" type="text" class="form-input" placeholder="e.g. Adaeze Okafor" autocomplete="name" data-invite-full-name required />
            </div>
            <div class="form-group">
              <label class="form-label">Invite Code</label>
              <input name="invite_code" type="text" class="form-input" maxlength="12" placeholder="Enter the code from management" data-invite-code required />
            </div>
            <div class="invite-status" data-tenant-email-preview aria-live="polite">Your lodge email will be generated from your name.</div>
            <div class="invite-status" data-invite-status aria-live="polite">Enter your approved full name and invite code to verify access.</div>
            <div class="form-group">
              <label class="form-label">Password</label>
              <input name="password" type="password" class="form-input" placeholder="Minimum 6 characters" required />
            </div>
            <button type="submit" class="btn btn-primary" data-invite-submit>Create Account</button>
          </form>
          <p class="login-footer" style="margin-top:1rem;">Already registered? <a href="/login">Sign in</a></p>
        </div>
      </div>
    </div>`
  );
}

function tenantDashboardView(user, db, flash = "") {
  const activeSessions = db.sessions.filter((session) => Date.parse(session.expiresAt) > Date.now());
  const currentSession = activeSessions.find((session) => session.userId === user.id) || null;
  const joinedDate = formatDateOnly(user.createdAt);
  const lastAccess = currentSession ? formatDateTime(currentSession.createdAt) : "No active session found";
  const bills = getTenantBillOptions(db, user.id);
  const payments = db.payments
    .filter((payment) => payment.tenantId === user.id)
    .sort(compareNewestFirst);
  const requests = db.maintenanceRequests
    .filter((request) => request.tenantId === user.id)
    .sort(compareNewestFirst);
  const openBills = bills.filter((bill) => getBillStatus(bill) !== "paid");
  const pendingPayments = payments.filter((payment) => payment.status === "pending");
  const openRequests = requests.filter((request) => request.status !== "resolved");
  const totalDue = openBills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);
  const totalPaid = payments.filter((payment) => payment.status === "approved").reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const nextBill = openBills
    .slice()
    .sort((a, b) => {
      const aTime = isValidDateInput(a.dueDate) ? Date.parse(`${a.dueDate}T00:00:00Z`) : Number.POSITIVE_INFINITY;
      const bTime = isValidDateInput(b.dueDate) ? Date.parse(`${b.dueDate}T00:00:00Z`) : Number.POSITIVE_INFINITY;
      return aTime - bTime;
    })[0] || null;
  const tenantPriorities = [
    {
      tone: totalDue > 0 ? "warning" : "success",
      title: totalDue > 0 ? "Outstanding balance needs attention" : "Your billing is in good shape",
      detail: totalDue > 0
        ? `${openBills.length} unpaid bill(s) totaling ${formatCurrency(totalDue)}${nextBill && isValidDateInput(nextBill.dueDate) ? `, next due ${formatDateOnly(`${nextBill.dueDate}T00:00:00Z`)}` : ""}.`
        : "You do not have any unpaid bills at the moment.",
      actionHref: "/tenant/bills",
      actionLabel: totalDue > 0 ? "Review bills" : "View billing history",
      meta: nextBill ? `Next bill: ${escapeHtml(nextBill.title)}` : "No open bills",
    },
    {
      tone: pendingPayments.length ? "accent" : "success",
      title: pendingPayments.length ? "Payments are waiting for review" : "No payments are waiting",
      detail: pendingPayments.length
        ? `${pendingPayments.length} submitted payment(s) are still pending approval from management.`
        : "Your submitted payments have all been processed.",
      actionHref: "/tenant/payments",
      actionLabel: pendingPayments.length ? "Check payments" : "Open payments",
      meta: payments[0] ? `Latest payment: ${formatCurrency(payments[0].amount)} • ${escapeHtml(payments[0].status)}` : "No payments submitted yet",
    },
    {
      tone: openRequests.length ? "orange" : "success",
      title: openRequests.length ? "Maintenance has a visible trail" : "Maintenance stays on record",
      detail: openRequests.length
        ? `${openRequests.length} maintenance request(s) still need attention, but every update is timestamped so you can track progress.`
        : "Every maintenance request keeps a timestamped trail, even after it is resolved.",
      actionHref: "/tenant/requests",
      actionLabel: openRequests.length ? "Track request trail" : "Create request",
      meta: openRequests[0]
        ? `Updated ${formatDateTime(openRequests[0].updatedAt || openRequests[0].createdAt)}`
        : "Every ticket keeps a trail",
    },
  ];
  const priorityCards = tenantPriorities
    .map((item) => `<article class="priority-card ${item.tone}">
      <div class="priority-card-head">
        <span class="priority-pill">${escapeHtml(item.tone === "success" ? "Good" : item.tone === "warning" ? "Urgent" : item.tone === "orange" ? "Open" : "Review")}</span>
        <span class="priority-meta">${escapeHtml(item.meta)}</span>
      </div>
      <h3 class="priority-title">${escapeHtml(item.title)}</h3>
      <p class="priority-copy">${escapeHtml(item.detail)}</p>
      <a href="${item.actionHref}" class="btn ${item.tone === "success" ? "btn-secondary" : "btn-primary"}">${escapeHtml(item.actionLabel)}</a>
    </article>`)
    .join("");
  const recentActivity = [];
  if (currentSession) {
    recentActivity.push(
      renderActivityItem({
        tone: "green",
        iconSvg: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        title: "Signed in",
        detail: "Your current session is active",
        time: formatDateTime(currentSession.createdAt),
        badge: "Live",
        badgeTone: "green",
      })
    );
  }
  if (bills[0]) {
    recentActivity.push(
      renderActivityItem({
        tone: "blue",
        iconSvg: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
        title: bills[0].title,
        detail: `Bill added for ${formatCurrency(bills[0].amount)}`,
        time: formatDateTime(bills[0].createdAt),
        badge: getBillStatus(bills[0]),
        badgeTone: getBillStatusTone(getBillStatus(bills[0])),
      })
    );
  }
  if (bills[1]) {
    recentActivity.push(
      renderActivityItem({
        tone: "blue",
        iconSvg: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
        title: bills[1].title,
        detail: `Bill added for ${formatCurrency(bills[1].amount)}`,
        time: formatDateTime(bills[1].createdAt),
        badge: getBillStatus(bills[1]),
        badgeTone: getBillStatusTone(getBillStatus(bills[1])),
      })
    );
  }
  if (payments[0]) {
    recentActivity.push(
      renderActivityItem({
        tone: "green",
        iconSvg: PAYMENT_SYMBOL_MARKUP,
        title: "Payment submitted",
        detail: `${formatCurrency(payments[0].amount)} is ${payments[0].status}`,
        time: formatDateTime(payments[0].createdAt),
        badge: payments[0].status,
        badgeTone: getPaymentStatusTone(payments[0].status),
      })
    );
  }
  if (payments[1]) {
    recentActivity.push(
      renderActivityItem({
        tone: "green",
        iconSvg: PAYMENT_SYMBOL_MARKUP,
        title: "Another payment",
        detail: `${formatCurrency(payments[1].amount)} is ${payments[1].status}`,
        time: formatDateTime(payments[1].createdAt),
        badge: payments[1].status,
        badgeTone: getPaymentStatusTone(payments[1].status),
      })
    );
  }
  if (requests[0]) {
    recentActivity.push(
      renderActivityItem({
        tone: "orange",
        iconSvg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        title: requests[0].title,
        detail: `Maintenance request is ${requests[0].status}`,
        time: formatDateTime(requests[0].createdAt),
        badge: requests[0].status,
        badgeTone: getMaintenanceStatusTone(requests[0].status),
      })
    );
  }
  if (requests[1]) {
    recentActivity.push(
      renderActivityItem({
        tone: "orange",
        iconSvg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        title: requests[1].title,
        detail: `Maintenance request is ${requests[1].status}`,
        time: formatDateTime(requests[1].createdAt),
        badge: requests[1].status,
        badgeTone: getMaintenanceStatusTone(requests[1].status),
      })
    );
  }
  const flashBanner = flash
    ? `<div class="alert" style="margin-bottom:1rem; padding:0.9rem 1rem; border:1px solid var(--border); border-radius:16px; background:rgba(34,197,94,0.08); color:var(--text-primary);">${escapeHtml(flash)}</div>`
    : "";
  const shell = renderShellChrome({
    user,
    roleLabel: "Tenant Billing",
    navLinks: tenantNavLinks(),
    activePath: "/tenant/dashboard",
    showThemeToggle: true,
    showNavLinks: true,
    showMobileMenu: true,
    logoSub: "Tenant Billing",
  });

  return htmlPage(
    "Tenant Dashboard - Godstime Lodge",
    `<div class="app-container">
      ${shell.mobileMenu}
      ${shell.topNav}
      <main class="main-content">
        ${flashBanner}
        ${renderAnnouncementCard(db.settings.announcement, "Lodge Update", db.settings.announcementUpdatedAt)}
        ${renderTenantReminderSection(user, db)}
        <div class="page-header">
          <h1 class="greeting">Welcome, ${escapeHtml(user.fullName)}</h1>
          <p class="greeting-sub">Your account is live for <strong>${escapeHtml(user.unit || "Unit not assigned yet")}</strong>.</p>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">My Unit</div>
            <div class="stat-value">${escapeHtml(user.unit || "Pending")}</div>
            <div class="stat-change positive">Keep this updated with management</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Joined</div>
            <div class="stat-value">${escapeHtml(joinedDate)}</div>
            <div class="stat-change positive">Your tenant account creation date</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Last Sign In</div>
            <div class="stat-value" style="font-size: 1.1rem;">${escapeHtml(lastAccess)}</div>
            <div class="stat-change positive">Current active session information</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Outstanding Bills</div>
            <div class="stat-value">${formatCurrency(totalDue)}</div>
            <div class="stat-change">${openBills.length} unpaid bills</div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-header">
            <div>
              <h3 class="card-title">What Needs Attention</h3>
              <p class="card-subtitle">The most important updates for your account right now.</p>
            </div>
          </div>
          <div class="priority-grid">
            ${priorityCards}
          </div>
        </div>

        <div class="two-col">
          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Account Snapshot</h3>
                <p class="card-subtitle">Quick details for your tenant profile</p>
              </div>
              <a href="/tenant/account" class="btn btn-secondary">Open page</a>
            </div>
            <div style="padding: 1rem 1.25rem; display:grid; gap:0.9rem; color: var(--text-primary);">
              <div><strong>Full Name:</strong> ${escapeHtml(user.fullName || "Not set")}</div>
              <div><strong>Email:</strong> ${escapeHtml(user.email)}</div>
              <div><strong>Unit:</strong> ${escapeHtml(user.unit || "Not assigned")}</div>
              <div><strong>Role:</strong> Tenant</div>
              <div><strong>Access:</strong> Protected by login</div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Lodge Status</h3>
                <p class="card-subtitle">General overview of your account standing</p>
              </div>
            </div>
            <div style="padding: 1rem 1.25rem; display: grid; gap: 1rem;">
              <div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                  <span>Outstanding bills</span>
                  <strong>${formatCurrency(totalDue)}</strong>
                </div>
                <div class="progress-bar"><div class="progress-fill warning" style="width: ${bills.length ? Math.max(15, 100 - Math.min(100, totalDue / 1000)) : 100}%;"></div></div>
              </div>
              <div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                  <span>Paid this cycle</span>
                  <strong>${formatCurrency(totalPaid)}</strong>
                </div>
                <div class="progress-bar"><div class="progress-fill success" style="width: ${Math.min(100, (totalPaid / Math.max(1, totalDue + totalPaid)) * 100)}%;"></div></div>
              </div>
              <div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                  <span>Portal setup</span>
                  <strong>${user.unit ? "Ready" : "Pending"}</strong>
                </div>
                <div class="progress-bar"><div class="progress-fill accent" style="width: ${user.unit ? 100 : 60}%;"></div></div>
              </div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top: 1.5rem;">
          <div class="card-header">
            <div>
              <h3 class="card-title">Recent Activity</h3>
              <p class="card-subtitle">Latest events on your account</p>
            </div>
          </div>
          <div class="card-scroll">
            <div class="card-scroll-inner" style="min-width: 340px;">
              <div class="activity-feed">${renderActivityFeed(recentActivity, "Your activity will appear here as you use the portal.")}</div>
            </div>
          </div>
        </div>
      </main>
      <footer class="footer"><p>&copy; 2026 Sbiam Solutions. All rights reserved.</p></footer>
    </div>`
  );
}

function tenantBillsPage(user, db, flash = "") {
  const bills = getTenantBillOptions(db, user.id);
  const rows = bills.length
    ? bills
        .map(
          (bill) => `<tr>
            <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(bill.title)}</strong></td>
            <td style="padding:0.9rem 0.75rem;">${formatCurrency(bill.amount)}</td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(isValidDateInput(bill.dueDate) ? formatDateOnly(`${bill.dueDate}T00:00:00Z`) : "Not set")}</td>
            <td style="padding:0.9rem 0.75rem;"><span class="badge badge-${getBillStatusTone(getBillStatus(bill))}">${escapeHtml(getBillStatus(bill))}</span></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" style="padding:1rem 0.75rem; color:var(--text-secondary);">No bills have been assigned yet.</td></tr>`;
  const unpaidBills = bills.filter((bill) => getBillStatus(bill) !== "paid");
  const unpaid = unpaidBills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);
  const active = unpaidBills.length;

  return layoutPage({
    title: "My Bills - Godstime Lodge",
    activePath: "/tenant/bills",
    user,
    roleLabel: "Tenant Portal",
    navLinks: tenantNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("My Bills", "A dedicated page for your lodge charges and due dates.", flash)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Outstanding</div><div class="stat-value">${formatCurrency(unpaid)}</div><div class="stat-change">${active} unpaid bills</div></div>
        <div class="stat-card"><div class="stat-label">Total Bills</div><div class="stat-value">${bills.length}</div><div class="stat-change positive">Visible charges for your account</div></div>
        <div class="stat-card"><div class="stat-label">Account</div><div class="stat-value">${escapeHtml(user.unit || "Pending")}</div><div class="stat-change positive">Unit assignment</div></div>
        <div class="stat-card"><div class="stat-label">Status</div><div class="stat-value">Live</div><div class="stat-change positive">Loaded from the backend</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <div><h3 class="card-title">Bill Records</h3><p class="card-subtitle">Your full bill history</p></div>
        </div>
        <div class="card-scroll">
          <div class="card-scroll-inner" style="min-width: 700px;">
            <table style="width:100%; border-collapse:collapse;">
              <thead>
                <tr style="text-align:left; color:var(--text-secondary); border-bottom:1px solid var(--border);">
                  <th style="padding:0.9rem 0.75rem;">Bill</th>
                  <th style="padding:0.9rem 0.75rem;">Amount</th>
                  <th style="padding:0.9rem 0.75rem;">Due Date</th>
                  <th style="padding:0.9rem 0.75rem;">Status</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </main>`,
  });
}

function tenantPaymentsPage(user, db, flash = "") {
  const bills = getTenantBillOptions(db, user.id, { includePaid: false });
  const payments = db.payments
    .filter((payment) => payment.tenantId === user.id)
    .sort(compareNewestFirst);
  const options = bills.length
    ? bills.map((bill) => {
        const status = getBillStatus(bill);
        return `<option value="${escapeHtml(bill.id)}">${escapeHtml(bill.title)} - ${formatCurrency(bill.amount)} (${escapeHtml(status)})</option>`;
      }).join("")
    : `<option value="">No unpaid bills available</option>`;
  const items = payments.length
    ? payments.map((payment) => renderActivityItem({
        tone: "green",
        iconSvg: PAYMENT_SYMBOL_MARKUP,
        title: formatCurrency(payment.amount),
        detail: payment.note || "No note added",
        time: formatDateTime(payment.createdAt),
        badge: payment.status,
        badgeTone: getPaymentStatusTone(payment.status),
      })).join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">No payments submitted yet.</div>`;
  const latestPayment = payments[0] || null;
  const latestPaymentTrail = latestPayment
    ? renderStatusTrail(latestPayment.statusHistory, "This payment does not have a review trail yet.")
    : `<div style="padding:1rem; color:var(--text-secondary);">Submit a payment to build a proof trail.</div>`;
  const latestPaymentLinks = latestPayment
    ? renderSupportLinks(latestPayment.proofLinks, "No supporting documents attached to this payment.")
    : `<div style="padding:1rem; color:var(--text-secondary);">Attach a receipt, screenshot, or reference link when you submit a payment.</div>`;
  const latestPaymentThread = latestPayment
    ? renderDiscussionThread(latestPayment.discussion, "No follow-up notes yet.")
    : `<div style="padding:1rem; color:var(--text-secondary);">Follow-up notes will appear here once you add them.</div>`;

  return layoutPage({
    title: "My Payments - Godstime Lodge",
    activePath: "/tenant/payments",
    user,
    roleLabel: "Tenant Portal",
    navLinks: tenantNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("My Payments", "Submit a new payment and track your payment history.", flash)}
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Submit Payment</h3><p class="card-subtitle">Attach a payment to one of your bills</p></div></div>
          <form method="post" action="/tenant/payments" enctype="multipart/form-data" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
            <div class="form-group"><label class="form-label">Bill</label><select name="bill_id" class="form-input" ${bills.length ? "" : "disabled"}>${options}</select></div>
            <div class="form-group"><label class="form-label">Amount</label><input name="amount" type="number" min="0" step="100" class="form-input" placeholder="e.g. 250000" required /></div>
            <div class="form-group"><label class="form-label">Proof / Reference Note</label><input name="note" type="text" maxlength="120" class="form-input" placeholder="Transfer reference, bank note, or proof detail" /></div>
            <div class="form-group"><label class="form-label">Supporting Document Links</label><input name="proof_links" type="text" maxlength="240" class="form-input" placeholder="Paste receipt links or evidence URLs separated by commas" /></div>
            <div class="form-group"><label class="form-label">Receipt Files</label><input name="proof_files" type="file" class="form-input" accept="image/*,application/pdf" multiple /></div>
            <button type="submit" class="btn btn-primary" ${bills.length ? "" : "disabled"}>Submit Payment</button>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">History</h3><p class="card-subtitle">Your submitted payments</p></div></div>
          <div class="card-scroll"><div class="card-scroll-inner" style="min-width: 340px;"><div class="activity-feed">${items}</div></div></div>
        </div>
      </div>
      <div class="card" style="margin-top:1.5rem;">
        <div class="card-header">
          <div>
            <h3 class="card-title">Payment Receipt Trail</h3>
            <p class="card-subtitle">A timestamped proof trail for your latest submission</p>
          </div>
        </div>
        <div style="padding:1rem 1.25rem;">${latestPayment ? `
          <div style="display:grid; gap:0.5rem; margin-bottom:1rem; color:var(--text-secondary);">
            <div><strong style="color:var(--text-primary);">Latest amount:</strong> ${formatCurrency(latestPayment.amount)}</div>
            <div><strong style="color:var(--text-primary);">Submitted:</strong> ${formatDateTime(latestPayment.createdAt)}</div>
            <div><strong style="color:var(--text-primary);">Proof note:</strong> ${escapeHtml(latestPayment.note || "No note added")}</div>
            <div><strong style="color:var(--text-primary);">Reviewed:</strong> ${latestPayment.reviewedAt ? formatDateTime(latestPayment.reviewedAt) : "Waiting for review"}</div>
          </div>
        ` : ""}
        ${latestPaymentTrail}
        <div style="margin-top:1rem;">
          <div style="font-weight:600; margin-bottom:0.5rem;">Attached files</div>
          ${renderSupportLinks(latestPayment ? latestPayment.proofFiles : [], "No files uploaded for this payment yet.")}
        </div>
        </div>
      </div>
      <div class="two-col" style="margin-top:1.5rem;">
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Supporting Documents</h3>
              <p class="card-subtitle">Receipts, bank references, or screenshots tied to the latest payment</p>
            </div>
          </div>
          <div style="padding:1rem 1.25rem;">${latestPaymentLinks}</div>
        </div>
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Follow-up Thread</h3>
              <p class="card-subtitle">Use this for proof or dispute notes with management</p>
            </div>
          </div>
          <div style="padding:1rem 1.25rem;">${latestPaymentThread}</div>
          ${latestPayment ? `
          <form method="post" action="/tenant/payments/comment" style="padding:0 1.25rem 1.25rem; display:grid; gap:0.85rem;">
            <input type="hidden" name="payment_id" value="${escapeHtml(latestPayment.id)}" />
            <div class="form-group"><label class="form-label">Add Note</label><input name="comment" type="text" maxlength="160" class="form-input" placeholder="Add context or a follow-up question" required /></div>
            <button type="submit" class="btn btn-secondary">Add Payment Note</button>
          </form>
          ` : ""}
        </div>
      </div>
    </main>`,
  });
}

function tenantMaintenancePage(user, db, flash = "") {
  const requests = db.maintenanceRequests
    .filter((request) => request.tenantId === user.id)
    .sort(compareNewestFirst);
  const resolvedRequests = requests.filter((request) => request.status === "resolved");
  const openRequests = requests.filter((request) => request.status !== "resolved");
  const overdueRequests = openRequests.filter((request) => getMaintenanceSlaState(request).tone === "red");
  const latestRequest = requests[0] || null;
  const latestRequestSla = getMaintenanceSlaState(latestRequest);
  const items = requests.length
    ? requests.map((request) => renderActivityItem({
        tone: "orange",
        iconSvg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        title: request.title,
        detail: request.description,
        time: formatDateTime(request.createdAt),
        badge: request.status,
        badgeTone: getMaintenanceStatusTone(request.status),
      })).join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">No maintenance requests yet.</div>`;
  const latestRequestTrail = latestRequest
    ? renderStatusTrail(latestRequest.statusHistory, "This request does not have a status trail yet.")
    : `<div style="padding:1rem; color:var(--text-secondary);">Create a request to build a status trail.</div>`;
  const latestRequestLinks = latestRequest
    ? renderSupportLinks(latestRequest.evidenceLinks, "No supporting documents attached to this request.")
    : `<div style="padding:1rem; color:var(--text-secondary);">Attach photo links or evidence URLs with the request.</div>`;
  const latestRequestThread = latestRequest
    ? renderDiscussionThread(latestRequest.discussion, "No follow-up notes yet.")
    : `<div style="padding:1rem; color:var(--text-secondary);">Follow-up notes will appear here once you add them.</div>`;

  return layoutPage({
    title: "Maintenance - Godstime Lodge",
    activePath: "/tenant/requests",
    user,
    roleLabel: "Tenant Portal",
    navLinks: tenantNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Maintenance Requests", "Send issues to management and track the status here.", flash)}
      ${renderAnnouncementCard(db.settings.announcement, "Service Notice", db.settings.announcementUpdatedAt)}
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Open Requests</div>
          <div class="stat-value">${openRequests.length}</div>
          <div class="stat-change positive">Requests still in the queue</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Overdue</div>
          <div class="stat-value">${overdueRequests.length}</div>
          <div class="stat-change ${overdueRequests.length ? "negative" : "positive"}">${overdueRequests.length ? "Outside the SLA target" : "Within the SLA target"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">First Response</div>
          <div class="stat-value">${latestRequest && latestRequest.firstResponseAt ? formatDateTime(latestRequest.firstResponseAt) : "Waiting"}</div>
          <div class="stat-change positive">When management first responded</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">SLA Target</div>
          <div class="stat-value">${latestRequest ? latestRequestSla.label : "72h"}</div>
          <div class="stat-change positive">${latestRequest ? latestRequestSla.detail : "Each ticket starts with a 72 hour target"}</div>
        </div>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">New Request</h3><p class="card-subtitle">Tell management what needs attention</p></div></div>
          <form method="post" action="/tenant/requests" enctype="multipart/form-data" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
            <div class="form-group"><label class="form-label">Title</label><input name="title" type="text" maxlength="80" class="form-input" placeholder="e.g. Water leak in bathroom" required /></div>
            <div class="form-group"><label class="form-label">Description</label><textarea name="description" class="form-input" rows="4" maxlength="400" placeholder="Describe the issue" required></textarea></div>
            <div class="form-group"><label class="form-label">Evidence / Context Note</label><input name="evidence_note" type="text" maxlength="160" class="form-input" placeholder="Add photos, location detail, or supporting context" /></div>
            <div class="form-group"><label class="form-label">Evidence Links</label><input name="evidence_links" type="text" maxlength="240" class="form-input" placeholder="Paste image or document links separated by commas" /></div>
            <div class="form-group"><label class="form-label">Evidence Files</label><input name="evidence_files" type="file" class="form-input" accept="image/*,application/pdf" multiple /></div>
            <button type="submit" class="btn btn-primary">Send Request</button>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Request History</h3><p class="card-subtitle">Your maintenance tickets</p></div></div>
          <div class="card-scroll"><div class="card-scroll-inner" style="min-width: 340px;"><div class="activity-feed">${items}</div></div></div>
        </div>
      </div>
      <div class="card" style="margin-top:1.5rem;">
        <div class="card-header"><div><h3 class="card-title">Completed Work</h3><p class="card-subtitle">This is how tenants can see what has been done</p></div></div>
        <div class="card-scroll"><div class="card-scroll-inner" style="min-width: 340px;"><div class="activity-feed">${renderActivityFeed(
          resolvedRequests.map((request) => renderActivityItem({
            tone: "green",
            iconSvg: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
            title: request.title,
            detail: "Marked resolved by management",
            time: formatDateTime(request.createdAt),
            badge: "done",
            badgeTone: "green",
          })),
          "When management resolves a request, it will show here."
        )}</div></div></div>
      </div>
      <div class="card" style="margin-top:1.5rem;">
        <div class="card-header">
          <div>
            <h3 class="card-title">Request Status Trail</h3>
            <p class="card-subtitle">See the full path from open to resolved for your latest ticket and its SLA target</p>
          </div>
        </div>
        <div style="padding:1rem 1.25rem;">
          ${latestRequest ? `
            <div style="display:grid; gap:0.5rem; margin-bottom:1rem; color:var(--text-secondary);">
              <div><strong style="color:var(--text-primary);">Latest issue:</strong> ${escapeHtml(latestRequest.title)}</div>
              <div><strong style="color:var(--text-primary);">Opened:</strong> ${formatDateTime(latestRequest.createdAt)}</div>
              <div><strong style="color:var(--text-primary);">Last updated:</strong> ${formatDateTime(latestRequest.updatedAt || latestRequest.createdAt)}</div>
              <div><strong style="color:var(--text-primary);">Context note:</strong> ${escapeHtml(latestRequest.evidenceNote || "No context note added")}</div>
              <div><strong style="color:var(--text-primary);">SLA:</strong> ${escapeHtml(latestRequestSla.label)} - ${escapeHtml(latestRequestSla.detail)}</div>
            </div>
          ` : ""}
          ${latestRequestTrail}
          <div style="margin-top:1rem;">
            <div style="font-weight:600; margin-bottom:0.5rem;">Attached files</div>
            ${renderSupportLinks(latestRequest ? latestRequest.evidenceFiles : [], "No files uploaded for this request yet.")}
          </div>
        </div>
      </div>
      <div class="two-col" style="margin-top:1.5rem;">
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Evidence Folder</h3>
              <p class="card-subtitle">Photos, links, or documents tied to the latest request</p>
            </div>
          </div>
          <div style="padding:1rem 1.25rem;">${latestRequestLinks}</div>
        </div>
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Follow-up Thread</h3>
              <p class="card-subtitle">Keep a running note with management until the issue is closed</p>
            </div>
          </div>
          <div style="padding:1rem 1.25rem;">${latestRequestThread}</div>
          ${latestRequest ? `
          <form method="post" action="/tenant/requests/comment" style="padding:0 1.25rem 1.25rem; display:grid; gap:0.85rem;">
            <input type="hidden" name="request_id" value="${escapeHtml(latestRequest.id)}" />
            <div class="form-group"><label class="form-label">Add Note</label><input name="comment" type="text" maxlength="160" class="form-input" placeholder="Add a follow-up note or question" required /></div>
            <button type="submit" class="btn btn-secondary">Add Maintenance Note</button>
          </form>
          ` : ""}
        </div>
      </div>
    </main>`,
  });
}

function tenantDisputesPage(user, db, flash = "") {
  const payments = db.payments
    .filter((payment) => payment.tenantId === user.id)
    .sort(compareNewestFirst);
  const requests = db.maintenanceRequests
    .filter((request) => request.tenantId === user.id)
    .sort(compareNewestFirst);
  const openPayments = payments.filter((payment) => payment.status === "pending");
  const openRequests = requests.filter((request) => request.status !== "resolved");
  const proofItems = payments
    .slice(0, 3)
    .map((payment) => `<article class="dispute-card">
      <div class="dispute-card-head">
        <strong>${escapeHtml(formatCurrency(payment.amount))}</strong>
        <span class="badge badge-${getPaymentStatusTone(payment.status)}">${escapeHtml(payment.status)}</span>
      </div>
      <p>${escapeHtml(payment.note || "No note added")}</p>
      <div class="dispute-meta">Submitted ${escapeHtml(formatDateTime(payment.createdAt))}</div>
    </article>`)
    .join("");
  const maintenanceItems = requests
    .slice(0, 3)
    .map((request) => `<article class="dispute-card">
      <div class="dispute-card-head">
        <strong>${escapeHtml(request.title)}</strong>
        <span class="badge badge-${getMaintenanceStatusTone(request.status)}">${escapeHtml(request.status)}</span>
      </div>
      <p>${escapeHtml(request.description)}</p>
      <div class="dispute-meta">Created ${escapeHtml(formatDateTime(request.createdAt))}</div>
    </article>`)
    .join("");

  return layoutPage({
    title: "Disputes - Godstime Lodge",
    activePath: "/tenant/disputes",
    user,
    roleLabel: "Tenant Portal",
    navLinks: tenantNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Disputes", "Your proof trail for payments and maintenance in one place.", flash)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Payment Notes</div><div class="stat-value">${payments.length}</div><div class="stat-change positive">${openPayments.length} pending review</div></div>
        <div class="stat-card"><div class="stat-label">Maintenance Tickets</div><div class="stat-value">${requests.length}</div><div class="stat-change positive">${openRequests.length} still open</div></div>
        <div class="stat-card"><div class="stat-label">Evidence Links</div><div class="stat-value">${payments.reduce((sum, payment) => sum + (Array.isArray(payment.proofLinks) ? payment.proofLinks.length : 0), 0) + requests.reduce((sum, request) => sum + (Array.isArray(request.evidenceLinks) ? request.evidenceLinks.length : 0), 0)}</div><div class="stat-change positive">Supporting documents attached</div></div>
        <div class="stat-card"><div class="stat-label">Follow-ups</div><div class="stat-value">${payments.reduce((sum, payment) => sum + (Array.isArray(payment.discussion) ? payment.discussion.length : 0), 0) + requests.reduce((sum, request) => sum + (Array.isArray(request.discussion) ? request.discussion.length : 0), 0)}</div><div class="stat-change positive">Tenant and management notes</div></div>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Payment Proof</h3><p class="card-subtitle">Receipts, notes, and review history for your last few payments</p></div></div>
          <div style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">${proofItems || `<div style="color:var(--text-secondary);">No payments yet.</div>`}</div>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Maintenance Evidence</h3><p class="card-subtitle">Requests, photos, and timeline notes for unresolved issues</p></div></div>
          <div style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">${maintenanceItems || `<div style="color:var(--text-secondary);">No maintenance requests yet.</div>`}</div>
        </div>
      </div>
    </main>`,
  });
}

function tenantNavLinks() {
  return [
    {
      href: "/tenant/dashboard",
      label: "Dashboard",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/></svg>',
    },
    {
      href: "/tenant/analytics",
      label: "Analytics",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 19 4 5 20 5"/><polyline points="7 16 11 12 14 15 20 9"/></svg>',
    },
    {
      href: "/tenant/bills",
      label: "Bills",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/></svg>',
    },
    {
      href: "/tenant/payments",
      label: "Payments",
      icon: `<svg viewBox="0 0 24 24" fill="none">${PAYMENT_SYMBOL_MARKUP}</svg>`,
    },
    {
      href: "/tenant/requests",
      label: "Maintenance",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    },
    {
      href: "/tenant/account",
      label: "Account",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4z"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    },
  ];
}

function tenantAccountPage(user, db, flash = "") {
  const bills = db.bills.filter((bill) => bill.tenantId === user.id);
  const payments = db.payments.filter((payment) => payment.tenantId === user.id);
  const requests = db.maintenanceRequests.filter((request) => request.tenantId === user.id);
  const approvedPayments = payments.filter((payment) => payment.status === "approved").reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const openBills = bills.filter((bill) => getBillStatus(bill) !== "paid");
  const content = `
    ${sectionHeader("My Account", "Review your tenant profile and account activity in one place.", flash)}
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Full Name</div>
        <div class="stat-value" style="font-size:1.1rem;">${escapeHtml(user.fullName || "Not set")}</div>
        <div class="stat-change positive">Profile name on file</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Email</div>
        <div class="stat-value" style="font-size:1rem;">${escapeHtml(user.email)}</div>
        <div class="stat-change positive">Login address</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Unit</div>
        <div class="stat-value">${escapeHtml(user.unit || "Not assigned")}</div>
        <div class="stat-change positive">Keep this updated with management</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Approved Paid</div>
        <div class="stat-value">${formatCurrency(approvedPayments)}</div>
        <div class="stat-change">${openBills.length} open bill(s)</div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Profile Details</h3>
            <p class="card-subtitle">Everything the portal has on record for you</p>
          </div>
        </div>
        <div style="padding: 1rem 1.25rem; display:grid; gap:0.9rem; color: var(--text-primary);">
          <div><strong>Full Name:</strong> ${escapeHtml(user.fullName || "Not set")}</div>
          <div><strong>Email:</strong> ${escapeHtml(user.email)}</div>
          <div><strong>Unit:</strong> ${escapeHtml(user.unit || "Not assigned")}</div>
          <div><strong>Role:</strong> Tenant</div>
          <div><strong>Joined:</strong> ${formatDateOnly(user.createdAt)}</div>
          <div><strong>Access:</strong> Protected by login</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <h3 class="card-title">Account Activity</h3>
            <p class="card-subtitle">Quick counts for your portal usage</p>
          </div>
        </div>
        <div style="padding: 1rem 1.25rem; display:grid; gap:0.9rem;">
          <div><strong>Bills:</strong> ${bills.length}</div>
          <div><strong>Payments:</strong> ${payments.length}</div>
          <div><strong>Maintenance Requests:</strong> ${requests.length}</div>
          <div><strong>Open Bills:</strong> ${openBills.length}</div>
        </div>
      </div>
    </div>`;

  return layoutPage({
    title: "Account - Godstime Lodge",
    activePath: "/tenant/account",
    user,
    roleLabel: "Tenant Portal",
    navLinks: tenantNavLinks(),
    body: `<main class="main-content">${content}</main>`,
  });
}

function tenantAnalyticsPage(user, db, flash = "") {
  const bills = [...db.bills]
    .filter((bill) => bill.tenantId === user.id)
    .sort(compareNewestFirst);
  const payments = db.payments
    .filter((payment) => payment.tenantId === user.id)
    .sort(compareNewestFirst);
  const requests = db.maintenanceRequests
    .filter((request) => request.tenantId === user.id)
    .sort(compareNewestFirst);
  const paidBills = bills.filter((bill) => getBillStatus(bill) === "paid").length;
  const unpaidBills = bills.filter((bill) => getBillStatus(bill) !== "paid");
  const totalDue = unpaidBills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);
  const approvedPayments = payments.filter((payment) => payment.status === "approved");
  const openRequests = requests.filter((request) => request.status !== "resolved");
  const recentActivity = [];
  if (bills[0]) {
    const billStatus = getBillStatus(bills[0]);
    recentActivity.push(renderActivityItem({
      tone: "blue",
      iconSvg: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
      title: bills[0].title,
      detail: `${formatCurrency(bills[0].amount)} • ${billStatus}`,
      time: formatDateTime(bills[0].createdAt),
      badge: billStatus,
      badgeTone: getBillStatusTone(billStatus),
    }));
  }
  if (payments[0]) {
    recentActivity.push(renderActivityItem({
      tone: "green",
      iconSvg: PAYMENT_SYMBOL_MARKUP,
      title: "Payment activity",
      detail: `${formatCurrency(payments[0].amount)} • ${payments[0].status}`,
      time: formatDateTime(payments[0].createdAt),
      badge: payments[0].status,
      badgeTone: getPaymentStatusTone(payments[0].status),
    }));
  }
  if (requests[0]) {
    recentActivity.push(renderActivityItem({
      tone: "orange",
      iconSvg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
      title: requests[0].title,
      detail: `Maintenance is ${requests[0].status}`,
      time: formatDateTime(requests[0].createdAt),
      badge: requests[0].status,
      badgeTone: getMaintenanceStatusTone(requests[0].status),
    }));
  }

  return layoutPage({
    title: "Analytics - Godstime Lodge",
    activePath: "/tenant/analytics",
    user,
    roleLabel: "Tenant Portal",
    navLinks: tenantNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Analytics", "Track your bills, payments, and maintenance in one place.", flash)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Bills</div><div class="stat-value">${bills.length}</div><div class="stat-change positive">${paidBills} paid, ${unpaidBills.length} unpaid</div></div>
        <div class="stat-card"><div class="stat-label">Payments</div><div class="stat-value">${payments.length}</div><div class="stat-change positive">${approvedPayments.length} approved</div></div>
        <div class="stat-card"><div class="stat-label">Open Requests</div><div class="stat-value">${openRequests.length}</div><div class="stat-change positive">${requests.length} total maintenance tickets</div></div>
        <div class="stat-card"><div class="stat-label">Outstanding</div><div class="stat-value">${formatCurrency(totalDue)}</div><div class="stat-change positive">Remaining balance</div></div>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Payment Health</h3>
              <p class="card-subtitle">How far you are in clearing bills</p>
            </div>
          </div>
          <div style="padding: 1rem 1.25rem; display:grid; gap:1rem;">
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Paid bills</span><strong>${paidBills}/${bills.length || 1}</strong></div>
              <div class="progress-bar"><div class="progress-fill success" style="width: ${percentage(paidBills, bills.length || 1)}%;"></div></div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Approved payments</span><strong>${approvedPayments.length}</strong></div>
              <div class="progress-bar"><div class="progress-fill accent" style="width: ${percentage(approvedPayments.length, payments.length || 1)}%;"></div></div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Open maintenance</span><strong>${openRequests.length}</strong></div>
              <div class="progress-bar"><div class="progress-fill warning" style="width: ${Math.min(100, openRequests.length * 25)}%;"></div></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Bill Timeline</h3>
              <p class="card-subtitle">Recent bills and their status</p>
            </div>
          </div>
          <div class="card-scroll">
            <div class="card-scroll-inner" style="min-width: 360px;">
              <div class="activity-feed">${
                bills.length
                  ? bills
                      .slice(0, 5)
                      .map((bill) => {
                        const billStatus = getBillStatus(bill);
                        return renderActivityItem({
                        tone: billStatus === "paid" ? "green" : "blue",
                        iconSvg: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
                        title: bill.title,
                        detail: `${formatCurrency(bill.amount)} • ${escapeHtml(billStatus)}`,
                        time: formatDateTime(bill.createdAt),
                        badge: billStatus,
                        badgeTone: getBillStatusTone(billStatus),
                      });
                    })
                      .join("")
                  : `<div style="padding:1rem; color:var(--text-secondary);">Bills will appear here once management creates them.</div>`
              }</div>
            </div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top: 1.5rem;">
        <div class="card-header">
          <div>
            <h3 class="card-title">Recent Activity</h3>
            <p class="card-subtitle">Latest lodge updates tied to your account</p>
          </div>
        </div>
        <div class="card-scroll">
          <div class="card-scroll-inner" style="min-width: 340px;">
            <div class="activity-feed">${renderActivityFeed(recentActivity, "Activity will show up here as you start using the portal.")}</div>
          </div>
        </div>
      </div>
    </main>`,
  });
}

function adminNavLinks() {
  return [
    {
      href: "/admin/dashboard",
      label: "Dashboard",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    },
    {
      href: "/admin/analytics",
      label: "Analytics",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 19 4 5 20 5"/><polyline points="7 16 11 12 14 15 20 9"/></svg>',
    },
    {
      href: "/admin/tenants",
      label: "Tenants",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    },
    {
      href: "/admin/payments",
      label: "Payments",
      icon: `<svg viewBox="0 0 24 24" fill="none">${PAYMENT_SYMBOL_MARKUP}</svg>`,
      children: [
        {
          href: "/admin/payments",
          label: "Payments",
          icon: `<svg viewBox="0 0 24 24" fill="none">${PAYMENT_SYMBOL_MARKUP}</svg>`,
        },
        {
          href: "/admin/bills",
          label: "Bills",
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/></svg>',
        },
      ],
    },
    {
      href: "/admin/projects",
      label: "Projects",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18"/><path d="M6 3h12l3 4v14H3V7l3-4z"/><path d="M9 12h6"/><path d="M9 16h4"/></svg>',
      children: [
        {
          href: "/admin/projects",
          label: "Projects",
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h18"/><path d="M6 3h12l3 4v14H3V7l3-4z"/><path d="M9 12h6"/><path d="M9 16h4"/></svg>',
        },
        {
          href: "/admin/maintenance",
          label: "Maintenance",
          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        },
      ],
    },
  ];
}

function adminDashboardView(user, db, flash = "") {
  const totalUnits = db.settings.totalUnits;
  const tenants = db.users
    .filter((item) => item.role === "tenant")
    .sort(compareNewestFirst);
  const activeSessions = db.sessions
    .filter((session) => Date.parse(session.expiresAt) > Date.now())
    .sort(compareNewestFirst);
  const occupiedUnits = new Set(tenants.map((tenant) => tenant.unit).filter(Boolean)).size;
  const occupancyRate = percentage(occupiedUnits, totalUnits);
  const bills = [...db.bills].sort(compareNewestFirst);
  const payments = [...db.payments].sort(compareNewestFirst);
  const maintenanceRequests = [...db.maintenanceRequests].sort(compareNewestFirst);
  const openBills = bills.filter((bill) => getBillStatus(bill) !== "paid");
  const pendingPayments = payments.filter((payment) => payment.status === "pending");
  const openMaintenance = maintenanceRequests.filter((request) => request.status !== "resolved");
  const pendingInvites = db.tenantInvites.filter((invite) => !invite.usedAt).sort(compareNewestFirst);
  const totalOutstanding = openBills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);
  const approvedPayments = payments.filter((payment) => payment.status === "approved").reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const latestPendingPayment = pendingPayments[0] || null;
  const latestOpenBill = openBills[0] || null;
  const latestOpenMaintenance = openMaintenance[0] || null;
  const latestPendingInvite = pendingInvites[0] || null;
  const adminPriorities = [
    {
      tone: pendingPayments.length ? "warning" : "success",
      label: pendingPayments.length ? "Urgent" : "Clear",
      title: pendingPayments.length ? "Payments are waiting for approval" : "Payment review queue is clear",
      detail: pendingPayments.length
        ? `${pendingPayments.length} payment submission(s) still need a decision from management.`
        : "There are no payment approvals waiting right now.",
      meta: latestPendingPayment ? `${formatCurrency(latestPendingPayment.amount)} pending` : "No pending payments",
      href: "/admin/payments",
      action: pendingPayments.length ? "Review payments" : "Open payments",
    },
    {
      tone: openBills.length ? "accent" : "success",
      label: openBills.length ? "Watch" : "Clear",
      title: openBills.length ? "Outstanding bills need follow-up" : "No unpaid bills need follow-up",
      detail: openBills.length
        ? `${openBills.length} unpaid bill(s) are still open, totaling ${formatCurrency(totalOutstanding)}.`
        : "All current bills are settled.",
      meta: latestOpenBill ? escapeHtml(latestOpenBill.title) : "No open bills",
      href: "/admin/bills",
      action: openBills.length ? "Open bills" : "View bills",
    },
    {
      tone: openMaintenance.length ? "orange" : "success",
      label: openMaintenance.length ? "Open" : "Clear",
      title: openMaintenance.length ? "Maintenance queue needs attention" : "Maintenance queue is under control",
      detail: openMaintenance.length
        ? `${openMaintenance.length} maintenance request(s) are still unresolved.`
        : "There are no unresolved maintenance issues right now.",
      meta: latestOpenMaintenance ? escapeHtml(latestOpenMaintenance.title) : "No open requests",
      href: "/admin/maintenance",
      action: openMaintenance.length ? "Track maintenance" : "View maintenance",
    },
    {
      tone: pendingInvites.length ? "warning" : "success",
      label: pendingInvites.length ? "Pending" : "Clear",
      title: pendingInvites.length ? "Tenant invites still need follow-up" : "All tenant invites are resolved",
      detail: pendingInvites.length
        ? `${pendingInvites.length} approved invite(s) have not been claimed yet.`
        : "There are no outstanding tenant invites right now.",
      meta: latestPendingInvite ? escapeHtml(latestPendingInvite.fullName || latestPendingInvite.email) : "No pending invites",
      href: "/admin/tenants",
      action: pendingInvites.length ? "Manage tenants" : "Open tenants",
    },
  ];
  const adminActionCenter = adminPriorities
    .map((item) => `<article class="priority-card ${item.tone}">
      <div class="priority-card-head">
        <span class="priority-pill">${escapeHtml(item.label)}</span>
        <span class="priority-meta">${item.meta}</span>
      </div>
      <h3 class="priority-title">${escapeHtml(item.title)}</h3>
      <p class="priority-copy">${escapeHtml(item.detail)}</p>
      <a href="${item.href}" class="btn ${item.tone === "success" ? "btn-secondary" : "btn-primary"}">${escapeHtml(item.action)}</a>
    </article>`)
    .join("");
  const recentActivity = [];
  if (tenants[0]) {
    recentActivity.push(
      renderActivityItem({
        tone: "blue",
        iconSvg: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>',
        title: `${tenants[0].fullName || tenants[0].email} registered`,
        detail: tenants[0].unit ? `Unit ${tenants[0].unit}` : "Unit not assigned yet",
        time: formatDateTime(tenants[0].createdAt),
        badge: "New",
        badgeTone: "blue",
      })
    );
  }
  if (tenants[1]) {
    recentActivity.push(
      renderActivityItem({
        tone: "blue",
        iconSvg: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>',
        title: `${tenants[1].fullName || tenants[1].email} registered`,
        detail: tenants[1].unit ? `Unit ${tenants[1].unit}` : "Unit not assigned yet",
        time: formatDateTime(tenants[1].createdAt),
        badge: "New",
        badgeTone: "blue",
      })
    );
  }
  if (bills[0]) {
    const tenant = db.users.find((item) => item.id === bills[0].tenantId);
    recentActivity.push(
      renderActivityItem({
        tone: "blue",
        iconSvg: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
        title: bills[0].title,
        detail: `${formatCurrency(bills[0].amount)} for ${tenant ? tenant.fullName || tenant.email : "Unknown tenant"}`,
        time: formatDateTime(bills[0].createdAt),
        badge: getBillStatus(bills[0]),
        badgeTone: getBillStatusTone(getBillStatus(bills[0])),
      })
    );
  }
  if (bills[1]) {
    const tenant = db.users.find((item) => item.id === bills[1].tenantId);
    recentActivity.push(
      renderActivityItem({
        tone: "blue",
        iconSvg: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
        title: bills[1].title,
        detail: `${formatCurrency(bills[1].amount)} for ${tenant ? tenant.fullName || tenant.email : "Unknown tenant"}`,
        time: formatDateTime(bills[1].createdAt),
        badge: getBillStatus(bills[1]),
        badgeTone: getBillStatusTone(getBillStatus(bills[1])),
      })
    );
  }
  if (payments[0]) {
    const tenant = db.users.find((item) => item.id === payments[0].tenantId);
    recentActivity.push(
      renderActivityItem({
        tone: "green",
        iconSvg: PAYMENT_SYMBOL_MARKUP,
        title: `${tenant ? tenant.fullName || tenant.email : "Tenant"} payment`,
        detail: `${formatCurrency(payments[0].amount)} is ${payments[0].status}`,
        time: formatDateTime(payments[0].createdAt),
        badge: payments[0].status,
        badgeTone: getPaymentStatusTone(payments[0].status),
      })
    );
  }
  if (payments[1]) {
    const tenant = db.users.find((item) => item.id === payments[1].tenantId);
    recentActivity.push(
      renderActivityItem({
        tone: "green",
        iconSvg: PAYMENT_SYMBOL_MARKUP,
        title: `${tenant ? tenant.fullName || tenant.email : "Tenant"} payment`,
        detail: `${formatCurrency(payments[1].amount)} is ${payments[1].status}`,
        time: formatDateTime(payments[1].createdAt),
        badge: payments[1].status,
        badgeTone: getPaymentStatusTone(payments[1].status),
      })
    );
  }
  if (maintenanceRequests[0]) {
    const tenant = db.users.find((item) => item.id === maintenanceRequests[0].tenantId);
    recentActivity.push(
      renderActivityItem({
        tone: "orange",
        iconSvg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        title: maintenanceRequests[0].title,
        detail: `From ${tenant ? tenant.fullName || tenant.email : "Unknown tenant"} • ${maintenanceRequests[0].status}`,
        time: formatDateTime(maintenanceRequests[0].createdAt),
        badge: maintenanceRequests[0].status,
        badgeTone: getMaintenanceStatusTone(maintenanceRequests[0].status),
      })
    );
  }
  if (maintenanceRequests[1]) {
    const tenant = db.users.find((item) => item.id === maintenanceRequests[1].tenantId);
    recentActivity.push(
      renderActivityItem({
        tone: "orange",
        iconSvg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        title: maintenanceRequests[1].title,
        detail: `From ${tenant ? tenant.fullName || tenant.email : "Unknown tenant"} • ${maintenanceRequests[1].status}`,
        time: formatDateTime(maintenanceRequests[1].createdAt),
        badge: maintenanceRequests[1].status,
        badgeTone: getMaintenanceStatusTone(maintenanceRequests[1].status),
      })
    );
  }
  if (activeSessions[0]) {
    const sessionUser = db.users.find((item) => item.id === activeSessions[0].userId);
    recentActivity.push(
      renderActivityItem({
        tone: "green",
        iconSvg: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        title: `${sessionUser ? sessionUser.fullName || sessionUser.email : "User"} signed in`,
        detail: sessionUser && sessionUser.role === "admin" ? "Administrator session" : "Tenant session",
        time: formatDateTime(activeSessions[0].createdAt),
        badge: "Live",
        badgeTone: "green",
      })
    );
  }
  if (activeSessions[1]) {
    const sessionUser = db.users.find((item) => item.id === activeSessions[1].userId);
    recentActivity.push(
      renderActivityItem({
        tone: "green",
        iconSvg: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        title: `${sessionUser ? sessionUser.fullName || sessionUser.email : "User"} signed in`,
        detail: sessionUser && sessionUser.role === "admin" ? "Administrator session" : "Tenant session",
        time: formatDateTime(activeSessions[1].createdAt),
        badge: "Live",
        badgeTone: "green",
      })
    );
  }
  const flashBanner = flash
    ? `<div class="alert" style="margin-bottom:1rem; padding:0.9rem 1rem; border:1px solid var(--border); border-radius:16px; background:rgba(34,197,94,0.08); color:var(--text-primary);">${escapeHtml(flash)}</div>`
    : "";
  const shell = renderShellChrome({
    user,
    roleLabel: "Admin Dashboard",
    navLinks: adminNavLinks(),
    activePath: "/admin/dashboard",
    showThemeToggle: true,
    showNavLinks: true,
    showMobileMenu: true,
    logoSub: "Admin Dashboard",
  });

  return htmlPage(
    "Admin Dashboard - Godstime Lodge",
    `<div class="app-container">
      ${shell.mobileMenu}
      ${shell.topNav}
      <main class="main-content">
        ${flashBanner}
        ${renderAdminReminderSection(db)}
        <div class="page-header">
          <h1 class="greeting">Welcome back, ${escapeHtml(user.fullName || "Admin")}</h1>
          <p class="greeting-sub">This dashboard now uses your live tenant and session data.</p>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">Registered Tenants</div>
            <div class="stat-value">${tenants.length}</div>
            <div class="stat-change positive">Live tenant accounts in the system</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Occupied Units</div>
            <div class="stat-value">${occupiedUnits}</div>
            <div class="stat-change positive">${occupancyRate}% of ${totalUnits} units are assigned</div>
          </div>
            <div class="stat-card">
              <div class="stat-label">Outstanding Bills</div>
              <div class="stat-value">${formatCurrency(totalOutstanding)}</div>
            <div class="stat-change positive">${openBills.length} unpaid bills</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Approved Payments</div>
            <div class="stat-value">${formatCurrency(approvedPayments)}</div>
            <div class="stat-change">${payments.length} payment records submitted</div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 1.5rem;">
          <div class="card-header">
            <div>
              <h3 class="card-title">Admin Action Center</h3>
              <p class="card-subtitle">The highest-priority operational work across billing, tenants, and maintenance.</p>
            </div>
          </div>
          <div class="priority-grid admin-priority-grid">
            ${adminActionCenter}
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Lodge Snapshot</h3>
              <p class="card-subtitle">A quick read on the property today</p>
            </div>
          </div>
          <div style="padding: 1rem 1.25rem; display: grid; gap: 1rem;">
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                <span>Tenant accounts</span>
                <strong>${tenants.length}</strong>
              </div>
              <div class="progress-bar"><div class="progress-fill accent" style="width: ${percentage(tenants.length, totalUnits)}%;"></div></div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                <span>Occupied units</span>
                <strong>${occupiedUnits}</strong>
              </div>
              <div class="progress-bar"><div class="progress-fill success" style="width: ${occupancyRate}%;"></div></div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                <span>Open items</span>
                <strong>${openBills.length + maintenanceRequests.filter((request) => request.status !== "resolved").length}</strong>
              </div>
              <div class="progress-bar"><div class="progress-fill warning" style="width: ${Math.min(100, (openBills.length + maintenanceRequests.filter((request) => request.status !== "resolved").length) * 10)}%;"></div></div>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top: 1.5rem;">
          <div class="card-header">
            <div>
              <h3 class="card-title">Recent Activity</h3>
              <p class="card-subtitle">Latest lodge updates in one place</p>
            </div>
          </div>
          <div class="card-scroll">
            <div class="card-scroll-inner" style="min-width: 340px;">
              <div class="activity-feed">${renderActivityFeed(recentActivity, "Activity will appear here as the lodge starts moving.")}</div>
            </div>
          </div>
        </div>
      </main>
      <footer class="footer"><p>&copy; 2026 Sbiam Solutions. All rights reserved.</p></footer>
    </div>`
  );
}

function adminAnalyticsPage(user, db, flash = "") {
  const totalUnits = db.settings.totalUnits;
  const tenants = db.users
    .filter((item) => item.role === "tenant")
    .sort(compareNewestFirst);
  const activeSessions = db.sessions
    .filter((session) => Date.parse(session.expiresAt) > Date.now())
    .sort(compareNewestFirst);
  const occupiedUnits = new Set(tenants.map((tenant) => tenant.unit).filter(Boolean)).size;
  const occupancyRate = percentage(occupiedUnits, totalUnits);
  const bills = [...db.bills].sort(compareNewestFirst);
  const payments = [...db.payments].sort(compareNewestFirst);
  const requests = [...db.maintenanceRequests].sort(compareNewestFirst);
  const outstandingBills = bills.filter((bill) => getBillStatus(bill) !== "paid");
  const approvedPayments = payments.filter((payment) => payment.status === "approved");
  const pendingPayments = payments.filter((payment) => payment.status === "pending");
  const openRequests = requests.filter((request) => request.status !== "resolved");
  const resolvedRequests = requests.filter((request) => request.status === "resolved");
  const recentActivity = [];
  if (tenants[0]) {
    recentActivity.push(renderActivityItem({
      tone: "blue",
      iconSvg: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>',
      title: `${tenants[0].fullName || tenants[0].email} registered`,
      detail: tenants[0].unit ? `Unit ${tenants[0].unit}` : "Unit not assigned yet",
      time: formatDateTime(tenants[0].createdAt),
      badge: "New",
      badgeTone: "blue",
    }));
  }
  if (tenants[1]) {
    recentActivity.push(renderActivityItem({
      tone: "blue",
      iconSvg: '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>',
      title: `${tenants[1].fullName || tenants[1].email} registered`,
      detail: tenants[1].unit ? `Unit ${tenants[1].unit}` : "Unit not assigned yet",
      time: formatDateTime(tenants[1].createdAt),
      badge: "New",
      badgeTone: "blue",
    }));
  }
  if (bills[0]) {
    const tenant = db.users.find((item) => item.id === bills[0].tenantId);
    recentActivity.push(renderActivityItem({
      tone: "blue",
      iconSvg: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
      title: bills[0].title,
      detail: `${formatCurrency(bills[0].amount)} for ${tenant ? tenant.fullName || tenant.email : "Unknown tenant"}`,
      time: formatDateTime(bills[0].createdAt),
      badge: getBillStatus(bills[0]),
      badgeTone: getBillStatusTone(getBillStatus(bills[0])),
    }));
  }
  if (bills[1]) {
    const tenant = db.users.find((item) => item.id === bills[1].tenantId);
    recentActivity.push(renderActivityItem({
      tone: "blue",
      iconSvg: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/>',
      title: bills[1].title,
      detail: `${formatCurrency(bills[1].amount)} for ${tenant ? tenant.fullName || tenant.email : "Unknown tenant"}`,
      time: formatDateTime(bills[1].createdAt),
      badge: getBillStatus(bills[1]),
      badgeTone: getBillStatusTone(getBillStatus(bills[1])),
    }));
  }
  if (payments[0]) {
    const tenant = db.users.find((item) => item.id === payments[0].tenantId);
    recentActivity.push(renderActivityItem({
      tone: "green",
      iconSvg: PAYMENT_SYMBOL_MARKUP,
      title: `${tenant ? tenant.fullName || tenant.email : "Tenant"} payment`,
      detail: `${formatCurrency(payments[0].amount)} • ${payments[0].status}`,
      time: formatDateTime(payments[0].createdAt),
      badge: payments[0].status,
      badgeTone: getPaymentStatusTone(payments[0].status),
    }));
  }
  if (payments[1]) {
    const tenant = db.users.find((item) => item.id === payments[1].tenantId);
    recentActivity.push(renderActivityItem({
      tone: "green",
      iconSvg: PAYMENT_SYMBOL_MARKUP,
      title: `${tenant ? tenant.fullName || tenant.email : "Tenant"} payment`,
      detail: `${formatCurrency(payments[1].amount)} • ${payments[1].status}`,
      time: formatDateTime(payments[1].createdAt),
      badge: payments[1].status,
      badgeTone: getPaymentStatusTone(payments[1].status),
    }));
  }
  if (requests[0]) {
    const tenant = db.users.find((item) => item.id === requests[0].tenantId);
    recentActivity.push(renderActivityItem({
      tone: "orange",
      iconSvg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
      title: requests[0].title,
      detail: `From ${tenant ? tenant.fullName || tenant.email : "Unknown tenant"} • ${requests[0].status}`,
      time: formatDateTime(requests[0].createdAt),
      badge: requests[0].status,
      badgeTone: getMaintenanceStatusTone(requests[0].status),
    }));
  }
  if (requests[1]) {
    const tenant = db.users.find((item) => item.id === requests[1].tenantId);
    recentActivity.push(renderActivityItem({
      tone: "orange",
      iconSvg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
      title: requests[1].title,
      detail: `From ${tenant ? tenant.fullName || tenant.email : "Unknown tenant"} • ${requests[1].status}`,
      time: formatDateTime(requests[1].createdAt),
      badge: requests[1].status,
      badgeTone: getMaintenanceStatusTone(requests[1].status),
    }));
  }
  if (activeSessions[0]) {
    const sessionUser = db.users.find((item) => item.id === activeSessions[0].userId);
    recentActivity.push(renderActivityItem({
      tone: "green",
      iconSvg: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
      title: `${sessionUser ? sessionUser.fullName || sessionUser.email : "User"} signed in`,
      detail: sessionUser && sessionUser.role === "admin" ? "Administrator session" : "Tenant session",
      time: formatDateTime(activeSessions[0].createdAt),
      badge: "Live",
      badgeTone: "green",
    }));
  }
  if (activeSessions[1]) {
    const sessionUser = db.users.find((item) => item.id === activeSessions[1].userId);
    recentActivity.push(renderActivityItem({
      tone: "green",
      iconSvg: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
      title: `${sessionUser ? sessionUser.fullName || sessionUser.email : "User"} signed in`,
      detail: sessionUser && sessionUser.role === "admin" ? "Administrator session" : "Tenant session",
      time: formatDateTime(activeSessions[1].createdAt),
      badge: "Live",
      badgeTone: "green",
    }));
  }

  return layoutPage({
    title: "Analytics - Godstime Lodge",
    activePath: "/admin/analytics",
    user,
    roleLabel: "Admin Dashboard",
    navLinks: adminNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Analytics", "A deeper look at bills, payments, occupancy, and maintenance.", flash)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Tenants</div><div class="stat-value">${tenants.length}</div><div class="stat-change positive">${occupiedUnits} occupied units</div></div>
        <div class="stat-card"><div class="stat-label">Occupancy</div><div class="stat-value">${occupancyRate}%</div><div class="stat-change positive">${occupiedUnits}/${totalUnits} units in use</div></div>
        <div class="stat-card"><div class="stat-label">Outstanding Bills</div><div class="stat-value">${outstandingBills.length}</div><div class="stat-change positive">${formatCurrency(outstandingBills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0))}</div></div>
        <div class="stat-card"><div class="stat-label">Approved Payments</div><div class="stat-value">${approvedPayments.length}</div><div class="stat-change positive">${pendingPayments.length} pending payments</div></div>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Collections</h3>
              <p class="card-subtitle">Bill and payment health</p>
            </div>
          </div>
          <div style="padding: 1rem 1.25rem; display:grid; gap:1rem;">
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Paid bills</span><strong>${bills.filter((bill) => getBillStatus(bill) === "paid").length}</strong></div>
              <div class="progress-bar"><div class="progress-fill success" style="width: ${percentage(bills.filter((bill) => getBillStatus(bill) === "paid").length, bills.length || 1)}%;"></div></div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Approved payments</span><strong>${approvedPayments.length}</strong></div>
              <div class="progress-bar"><div class="progress-fill accent" style="width: ${percentage(approvedPayments.length, payments.length || 1)}%;"></div></div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Pending payments</span><strong>${pendingPayments.length}</strong></div>
              <div class="progress-bar"><div class="progress-fill warning" style="width: ${Math.min(100, pendingPayments.length * 20)}%;"></div></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Operations</h3>
              <p class="card-subtitle">Maintenance and service workload</p>
            </div>
          </div>
          <div style="padding: 1rem 1.25rem; display:grid; gap:1rem;">
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Open requests</span><strong>${openRequests.length}</strong></div>
              <div class="progress-bar"><div class="progress-fill warning" style="width: ${Math.min(100, openRequests.length * 20)}%;"></div></div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Resolved requests</span><strong>${resolvedRequests.length}</strong></div>
              <div class="progress-bar"><div class="progress-fill success" style="width: ${percentage(resolvedRequests.length, requests.length || 1)}%;"></div></div>
            </div>
            <div>
              <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;"><span>Live sessions</span><strong>${activeSessions.length}</strong></div>
              <div class="progress-bar"><div class="progress-fill accent" style="width: ${Math.min(100, activeSessions.length * 15)}%;"></div></div>
            </div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:1.5rem;">
        <div class="card-header">
          <div>
            <h3 class="card-title">Recent Activity</h3>
            <p class="card-subtitle">Live events across the lodge</p>
          </div>
        </div>
        <div class="card-scroll">
          <div class="card-scroll-inner" style="min-width:340px;">
            <div class="activity-feed">${renderActivityFeed(recentActivity, "Activity will appear here as the lodge starts moving.")}</div>
          </div>
        </div>
      </div>
    </main>`,
  });
}

function adminTenantsPage(user, db, flash = "", filters = {}) {
  const query = normalizeLine(filters.q, 80);
  const statusFilter = normalizeLine(filters.status, 20);
  const pendingInvites = [...db.tenantInvites]
    .filter((invite) => !invite.usedAt)
    .sort(compareNewestFirst);
  const tenants = db.users
    .filter((item) => item.role === "tenant")
    .filter((tenant) => !statusFilter || (statusFilter === "active" ? tenant.active !== false : tenant.active === false))
    .filter((tenant) => matchesSearch([tenant.fullName, tenant.email, tenant.unit], query))
    .sort(compareNewestFirst);
  const activeTenants = tenants.filter((tenant) => tenant.active !== false);
  const inactiveTenants = tenants.filter((tenant) => tenant.active === false);
  const assignedUnits = new Set(activeTenants.map((tenant) => tenant.unit).filter(Boolean)).size;
  const pendingInviteRows = pendingInvites.length
    ? pendingInvites
        .map((invite) => `<tr>
          <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(invite.fullName || "Pending tenant")}</strong><br /><span style="color:var(--text-secondary);">${escapeHtml(invite.email)}</span></td>
          <td style="padding:0.9rem 0.75rem;">${escapeHtml(invite.unit || "Not assigned")}</td>
          <td style="padding:0.9rem 0.75rem;"><code>${escapeHtml(invite.inviteCode)}</code></td>
          <td style="padding:0.9rem 0.75rem;">${escapeHtml(formatDateTime(invite.createdAt))}</td>
        </tr>`)
        .join("")
    : `<tr><td colspan="4" style="padding:1rem 0.75rem; color:var(--text-secondary);">No pending tenant approvals yet.</td></tr>`;
  const rows = tenants.length
    ? tenants
        .map((tenant) => {
          const tenantBills = db.bills.filter((bill) => bill.tenantId === tenant.id);
          const tenantOutstanding = tenantBills
            .filter((bill) => getBillStatus(bill) !== "paid")
            .reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);
          return `<tr>
            <td style="padding:0.9rem 0.75rem;">
              <strong>${escapeHtml(tenant.fullName || "No name")}</strong><br />
              <span style="color:var(--text-secondary);">${escapeHtml(tenant.email)}</span>
            </td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(tenant.unit || "Not assigned")}</td>
            <td style="padding:0.9rem 0.75rem;">${formatCurrency(tenantOutstanding)}</td>
            <td style="padding:0.9rem 0.75rem;"><span class="badge badge-${tenant.active === false ? "red" : "green"}">${tenant.active === false ? "inactive" : "active"}</span></td>
            <td style="padding:0.9rem 0.75rem;">
              <form method="post" action="/admin/tenants/update" style="display:grid; gap:0.5rem;">
                <input type="hidden" name="tenant_id" value="${escapeHtml(tenant.id)}" />
                <input type="text" name="full_name" class="form-input" value="${escapeHtml(tenant.fullName || "")}" placeholder="Full name" />
                <input type="text" name="unit" class="form-input" value="${escapeHtml(tenant.unit || "")}" placeholder="Unit assignment" />
                <input type="password" name="password" class="form-input" placeholder="New password (optional)" />
                <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                  <button class="btn btn-primary" type="submit" name="status" value="active">Save Active</button>
                  <button class="btn btn-secondary" type="submit" name="status" value="inactive">Set Inactive</button>
                </div>
              </form>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" style="padding:1rem 0.75rem; color:var(--text-secondary);">No tenants found for the current filter.</td></tr>`;

  return layoutPage({
    title: "Tenants - Godstime Lodge",
    activePath: "/admin/tenants",
    user,
    roleLabel: "Admin Dashboard",
    navLinks: adminNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Tenants", "Manage tenant records, unit assignment, access, and password resets.", flash)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Visible Tenants</div><div class="stat-value">${tenants.length}</div><div class="stat-change positive">Current search result</div></div>
        <div class="stat-card"><div class="stat-label">Active</div><div class="stat-value">${activeTenants.length}</div><div class="stat-change positive">Can still sign in</div></div>
        <div class="stat-card"><div class="stat-label">Inactive</div><div class="stat-value">${inactiveTenants.length}</div><div class="stat-change positive">Access paused</div></div>
        <div class="stat-card"><div class="stat-label">Pending Invites</div><div class="stat-value">${pendingInvites.length}</div><div class="stat-change positive">${assignedUnits} active units assigned</div></div>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Approve Tenant Access</h3><p class="card-subtitle">Only approved tenants with an invite code can create accounts</p></div></div>
          <form method="post" action="/admin/tenants/invite" data-tenant-email-form style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
            <div class="form-group"><label class="form-label">Full Name</label><input name="full_name" type="text" maxlength="80" class="form-input" placeholder="e.g. Adaeze Okafor" data-tenant-email-full-name required /></div>
            <div class="invite-status" data-tenant-email-preview aria-live="polite">The tenant email will be generated from the full name.</div>
            <div class="form-group"><label class="form-label">Unit</label><input name="unit" type="text" maxlength="40" class="form-input" placeholder="e.g. Block B - 3" /></div>
            <div class="form-group"><label class="form-label">Invite Code</label><input name="invite_code" type="text" maxlength="12" class="form-input" placeholder="Leave empty to auto-generate" /></div>
            <button type="submit" class="btn btn-primary">Create Tenant Invite</button>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Find Tenants</h3><p class="card-subtitle">Search by name, email, or unit and filter by access state</p></div></div>
          <form method="get" action="/admin/tenants" class="control-grid" style="padding:1rem 1.25rem;">
            <input name="q" type="text" class="form-input" value="${escapeHtml(query)}" placeholder="Search tenants" />
            <select name="status" class="form-input">
              <option value="">All statuses</option>
              <option value="active" ${statusFilter === "active" ? "selected" : ""}>Active</option>
              <option value="inactive" ${statusFilter === "inactive" ? "selected" : ""}>Inactive</option>
            </select>
            <button type="submit" class="btn btn-primary">Filter</button>
          </form>
          <div style="padding:0 1.25rem 1.25rem; display:grid; gap:0.9rem;">
            <div><strong>Approved before signup:</strong> tenants must use the exact email and invite code you issue here.</div>
            <div><strong>Pending approvals:</strong> share the code below with the approved tenant only.</div>
            <div><strong>Existing tenants:</strong> you can still pause access or reset passwords from the board.</div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:1.5rem;">
        <div class="card-header"><div><h3 class="card-title">Pending Tenant Invites</h3><p class="card-subtitle">These people are approved to register but have not claimed access yet</p></div></div>
        <div class="card-scroll">
          <div class="card-scroll-inner" style="min-width:860px;">
            <table style="width:100%; border-collapse:collapse;">
              <thead>
                <tr style="text-align:left; color:var(--text-secondary); border-bottom:1px solid var(--border);">
                  <th style="padding:0.9rem 0.75rem;">Tenant</th>
                  <th style="padding:0.9rem 0.75rem;">Unit</th>
                  <th style="padding:0.9rem 0.75rem;">Invite Code</th>
                  <th style="padding:0.9rem 0.75rem;">Created</th>
                </tr>
              </thead>
              <tbody>${pendingInviteRows}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="card card-accent" style="margin-top:1.5rem;">
        <div class="card-header"><div><h3 class="card-title">Tenant Management Board</h3><p class="card-subtitle">Update names, assign units, pause access, or reset passwords</p></div></div>
        <div class="card-scroll">
          <div class="card-scroll-inner" style="min-width:1100px;">
            <table style="width:100%; border-collapse:collapse;">
              <thead>
                <tr style="text-align:left; color:var(--text-secondary); border-bottom:1px solid var(--border);">
                  <th style="padding:0.9rem 0.75rem;">Tenant</th>
                  <th style="padding:0.9rem 0.75rem;">Unit</th>
                  <th style="padding:0.9rem 0.75rem;">Outstanding</th>
                  <th style="padding:0.9rem 0.75rem;">Status</th>
                  <th style="padding:0.9rem 0.75rem;">Manage</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </main>`,
  });
}

function adminProjectsPage(user, db, flash = "", filters = {}) {
  const query = normalizeLine(filters.q, 80);
  const statusFilter = normalizeLine(filters.status, 20);
  const projects = [...db.projects]
    .filter((project) => !statusFilter || project.status === statusFilter)
    .filter((project) => matchesSearch([project.title, project.description, project.owner], query))
    .sort(compareNewestFirst);
  const activeProjects = projects.filter((project) => project.status === "active");
  const completedProjects = projects.filter((project) => project.status === "completed");
  const plannedProjects = projects.filter((project) => project.status === "planned");
  const rows = projects.length
    ? projects
        .map((project) => `<tr>
          <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(project.title)}</strong></td>
          <td style="padding:0.9rem 0.75rem;">${escapeHtml(project.owner || "Admin team")}</td>
          <td style="padding:0.9rem 0.75rem;">${formatCurrency(project.budget)}</td>
          <td style="padding:0.9rem 0.75rem;">${escapeHtml(isValidDateInput(project.dueDate) ? formatDateOnly(`${project.dueDate}T00:00:00Z`) : "No deadline")}</td>
          <td style="padding:0.9rem 0.75rem;"><span class="badge badge-${getProjectStatusTone(project.status)}">${escapeHtml(project.status)}</span></td>
          <td style="padding:0.9rem 0.75rem;">
            <form method="post" action="/admin/projects/status" style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <input type="hidden" name="project_id" value="${escapeHtml(project.id)}" />
              <button class="btn btn-primary" type="submit" name="status" value="active" ${project.status === "active" || project.status === "completed" ? "disabled" : ""}>Start</button>
              <button class="btn btn-secondary" type="submit" name="status" value="completed" ${project.status === "completed" ? "disabled" : ""}>Complete</button>
            </form>
          </td>
        </tr>`)
        .join("")
    : `<tr><td colspan="6" style="padding:1rem 0.75rem; color:var(--text-secondary);">No projects added yet.</td></tr>`;

  return layoutPage({
    title: "Projects - Godstime Lodge",
    activePath: "/admin/projects",
    user,
    roleLabel: "Admin Dashboard",
    navLinks: adminNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Projects", "Track lodge upgrades, major repairs, and operational initiatives.", flash)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Total Projects</div><div class="stat-value">${projects.length}</div><div class="stat-change positive">All tracked workstreams</div></div>
        <div class="stat-card"><div class="stat-label">Planned</div><div class="stat-value">${plannedProjects.length}</div><div class="stat-change positive">Waiting to begin</div></div>
        <div class="stat-card"><div class="stat-label">Active</div><div class="stat-value">${activeProjects.length}</div><div class="stat-change positive">In progress now</div></div>
        <div class="stat-card"><div class="stat-label">Completed</div><div class="stat-value">${completedProjects.length}</div><div class="stat-change positive">Finished projects</div></div>
      </div>
      <div class="card" style="margin-bottom:1.5rem;">
        <div class="card-header"><div><h3 class="card-title">Find Projects</h3><p class="card-subtitle">Search by title, owner, or description</p></div></div>
        <form method="get" action="/admin/projects" style="padding:1rem 1.25rem; display:grid; gap:0.85rem; grid-template-columns: 2fr 1fr auto;">
          <input name="q" type="text" class="form-input" value="${escapeHtml(query)}" placeholder="Search projects" />
          <select name="status" class="form-input">
            <option value="">All statuses</option>
            <option value="planned" ${statusFilter === "planned" ? "selected" : ""}>Planned</option>
            <option value="active" ${statusFilter === "active" ? "selected" : ""}>Active</option>
            <option value="completed" ${statusFilter === "completed" ? "selected" : ""}>Completed</option>
          </select>
          <button type="submit" class="btn btn-primary">Filter</button>
        </form>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Create Project</h3><p class="card-subtitle">Use this for upgrades, large repairs, and planned lodge work</p></div></div>
          <form method="post" action="/admin/projects" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
            <div class="form-group"><label class="form-label">Project Title</label><input name="title" type="text" maxlength="80" class="form-input" placeholder="e.g. Compound lighting upgrade" required /></div>
            <div class="form-group"><label class="form-label">Owner</label><input name="owner" type="text" maxlength="60" class="form-input" placeholder="e.g. Facilities Manager" /></div>
            <div class="form-group"><label class="form-label">Budget</label><input name="budget" type="number" min="0" step="1000" class="form-input" placeholder="e.g. 500000" required /></div>
            <div class="form-group"><label class="form-label">Deadline</label><input name="due_date" type="date" class="form-input" /></div>
            <div class="form-group"><label class="form-label">Description</label><textarea name="description" class="form-input" rows="4" maxlength="300" placeholder="What is this project meant to achieve?" required></textarea></div>
            <button type="submit" class="btn btn-primary">Create Project</button>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Why Projects Matter</h3><p class="card-subtitle">A separate project board helps with bigger work than day-to-day maintenance</p></div></div>
          <div style="padding:1rem 1.25rem; display:grid; gap:0.9rem;">
            <div><strong>Best for:</strong> renovations, upgrades, compliance work, and multi-step repairs.</div>
            <div><strong>Not for:</strong> quick tenant issues that belong on the maintenance page.</div>
            <div><strong>Budget tracked:</strong> ${formatCurrency(projects.reduce((sum, project) => sum + (Number(project.budget) || 0), 0))}</div>
            <div><strong>Active owners:</strong> ${activeProjects.length ? escapeHtml(activeProjects.map((project) => project.owner || "Admin team").slice(0, 3).join(", ")) : "No active projects yet"}</div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:1.5rem;">
        <div class="card-header"><div><h3 class="card-title">Project Board</h3><p class="card-subtitle">Status, budgets, deadlines, and quick actions</p></div></div>
        <div class="card-scroll">
          <div class="card-scroll-inner" style="min-width:980px;">
            <table style="width:100%; border-collapse:collapse;">
              <thead>
                <tr style="text-align:left; color:var(--text-secondary); border-bottom:1px solid var(--border);">
                  <th style="padding:0.9rem 0.75rem;">Project</th>
                  <th style="padding:0.9rem 0.75rem;">Owner</th>
                  <th style="padding:0.9rem 0.75rem;">Budget</th>
                  <th style="padding:0.9rem 0.75rem;">Deadline</th>
                  <th style="padding:0.9rem 0.75rem;">Status</th>
                  <th style="padding:0.9rem 0.75rem;">Action</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </main>`,
  });
}

function adminSettingsPage(user, db, flash = "") {
  const settings = db.settings;

  return layoutPage({
    title: "Settings - Godstime Lodge",
    activePath: "/admin/settings",
    user,
    roleLabel: "Admin Dashboard",
    navLinks: adminNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Settings", "Update the operational values that shape the portal.", flash)}
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Portal Settings</h3><p class="card-subtitle">Operational settings for the lodge portal</p></div></div>
          <form method="post" action="/admin/settings" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
            <div class="form-group"><label class="form-label">Support Email</label><input name="support_email" type="email" class="form-input" value="${escapeHtml(settings.supportEmail)}" required /></div>
            <div class="form-group"><label class="form-label">Total Units</label><input name="total_units" type="number" min="1" step="1" class="form-input" value="${escapeHtml(settings.totalUnits)}" required /></div>
            <div class="form-group"><label class="form-label">Announcement</label><textarea name="announcement" class="form-input" rows="4" maxlength="160" placeholder="Short message for operations updates">${escapeHtml(settings.announcement || "")}</textarea></div>
            <button type="submit" class="btn btn-primary">Save Settings</button>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">System Snapshot</h3><p class="card-subtitle">Current portal configuration at a glance</p></div></div>
          <div style="padding:1rem 1.25rem; display:grid; gap:0.9rem;">
            <div><strong>Support Email:</strong> ${escapeHtml(settings.supportEmail)}</div>
            <div><strong>Total Units:</strong> ${escapeHtml(settings.totalUnits)}</div>
            <div><strong>Announcement:</strong> ${escapeHtml(settings.announcement || "No announcement set")}</div>
            <div><strong>Render Health Check:</strong> <code>/healthz</code></div>
            <div><strong>Data Storage:</strong> <code>${escapeHtml(DATA_DIR)}</code></div>
          </div>
        </div>
      </div>
    </main>`,
  });
}

function adminBillsPage(user, db, flash = "", filters = {}) {
  const query = normalizeLine(filters.q, 80);
  const statusFilter = normalizeLine(filters.status, 20);
  const tenants = db.users.filter((item) => item.role === "tenant");
  const bills = [...db.bills]
    .filter((bill) => !statusFilter || getBillStatus(bill) === statusFilter)
    .filter((bill) => {
      const tenant = db.users.find((item) => item.id === bill.tenantId);
      return matchesSearch([bill.title, bill.dueDate, tenant ? tenant.fullName : "", tenant ? tenant.email : ""], query);
    })
    .sort(compareNewestFirst);
  const billTenantOptions = tenants.length
    ? tenants
        .map((tenant) => `<option value="${escapeHtml(tenant.id)}">${escapeHtml((tenant.fullName || tenant.email) + (tenant.unit ? ` - ${tenant.unit}` : ""))}</option>`)
        .join("")
    : `<option value="">No tenants available</option>`;
  const rows = bills.length
    ? bills
        .map((bill) => {
          const tenant = db.users.find((item) => item.id === bill.tenantId);
          return `<tr>
            <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(bill.title)}</strong></td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(tenant ? tenant.fullName || tenant.email : "Unknown tenant")}</td>
            <td style="padding:0.9rem 0.75rem;">${formatCurrency(bill.amount)}</td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(isValidDateInput(bill.dueDate) ? formatDateOnly(`${bill.dueDate}T00:00:00Z`) : "Not set")}</td>
            <td style="padding:0.9rem 0.75rem;"><span class="badge badge-${getBillStatusTone(getBillStatus(bill))}">${escapeHtml(getBillStatus(bill))}</span></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" style="padding:1rem 0.75rem; color:var(--text-secondary);">No bills created yet.</td></tr>`;

  return layoutPage({
    title: "Bills - Godstime Lodge",
    activePath: "/admin/bills",
    user,
    roleLabel: "Admin Dashboard",
    navLinks: adminNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Bills", "Create and review lodge charges from one page.", flash)}
      <div class="card" style="margin-bottom:1.5rem;">
        <div class="card-header"><div><h3 class="card-title">Find Bills</h3><p class="card-subtitle">Search by bill title or tenant and filter by status</p></div></div>
        <form method="get" action="/admin/bills" style="padding:1rem 1.25rem; display:grid; gap:0.85rem; grid-template-columns: 2fr 1fr auto;">
          <input name="q" type="text" class="form-input" value="${escapeHtml(query)}" placeholder="Search bills or tenants" />
          <select name="status" class="form-input">
            <option value="">All statuses</option>
            <option value="unpaid" ${statusFilter === "unpaid" ? "selected" : ""}>Unpaid</option>
            <option value="overdue" ${statusFilter === "overdue" ? "selected" : ""}>Overdue</option>
            <option value="paid" ${statusFilter === "paid" ? "selected" : ""}>Paid</option>
          </select>
          <button type="submit" class="btn btn-primary">Filter</button>
        </form>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Create Bill</h3><p class="card-subtitle">Assign a charge to a tenant</p></div></div>
          <form method="post" action="/admin/bills" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
            <div class="form-group"><label class="form-label">Tenant</label><select name="tenant_id" class="form-input">${billTenantOptions}</select></div>
            <div class="form-group"><label class="form-label">Bill Title</label><input name="title" type="text" maxlength="80" class="form-input" placeholder="e.g. April Rent" required /></div>
            <div class="form-group"><label class="form-label">Amount</label><input name="amount" type="number" min="0" step="100" class="form-input" placeholder="e.g. 250000" required /></div>
            <div class="form-group"><label class="form-label">Due Date</label><input name="due_date" type="date" class="form-input" required /></div>
            <button type="submit" class="btn btn-primary">Create Bill</button>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Bill Stats</h3><p class="card-subtitle">Quick overview</p></div></div>
          <div style="padding:1rem 1.25rem; display:grid; gap:1rem;">
            <div><strong>Total Bills:</strong> ${bills.length}</div>
            <div><strong>Unpaid Bills:</strong> ${bills.filter((bill) => getBillStatus(bill) !== "paid").length}</div>
            <div><strong>Total Value:</strong> ${formatCurrency(bills.reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0))}</div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:1.5rem;">
        <div class="card-header"><div><h3 class="card-title">Recent Bills</h3><p class="card-subtitle">Latest charges across all tenants</p></div></div>
        <div class="card-scroll">
          <div class="card-scroll-inner" style="min-width:700px;">
            <table style="width:100%; border-collapse:collapse;">
              <thead>
                <tr style="text-align:left; color:var(--text-secondary); border-bottom:1px solid var(--border);">
                  <th style="padding:0.9rem 0.75rem;">Bill</th>
                  <th style="padding:0.9rem 0.75rem;">Tenant</th>
                  <th style="padding:0.9rem 0.75rem;">Amount</th>
                  <th style="padding:0.9rem 0.75rem;">Due Date</th>
                  <th style="padding:0.9rem 0.75rem;">Status</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </main>`,
  });
}

function adminPaymentsPage(user, db, flash = "", filters = {}) {
  const query = normalizeLine(filters.q, 80);
  const statusFilter = normalizeLine(filters.status, 20);
  const payments = [...db.payments]
    .filter((payment) => !statusFilter || payment.status === statusFilter)
    .filter((payment) => {
      const tenant = db.users.find((item) => item.id === payment.tenantId);
      const bill = db.bills.find((item) => item.id === payment.billId);
      return matchesSearch([tenant ? tenant.fullName : "", tenant ? tenant.email : "", bill ? bill.title : "", payment.note], query);
    })
    .sort(compareNewestFirst);
  const rows = payments.length
    ? payments
        .map((payment) => {
          const tenant = db.users.find((item) => item.id === payment.tenantId);
          const bill = db.bills.find((item) => item.id === payment.billId);
          const isPending = payment.status === "pending";
          return `<tr>
            <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(tenant ? tenant.fullName || tenant.email : "Unknown tenant")}</strong></td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(bill ? bill.title : "No bill linked")}</td>
            <td style="padding:0.9rem 0.75rem;">${formatCurrency(payment.amount)}</td>
            <td style="padding:0.9rem 0.75rem;"><span class="badge badge-${getPaymentStatusTone(payment.status)}">${escapeHtml(payment.status)}</span></td>
            <td style="padding:0.9rem 0.75rem;">
              <form method="post" action="/admin/payments/status" style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                <input type="hidden" name="payment_id" value="${escapeHtml(payment.id)}" />
                <input type="text" name="response_note" class="form-input" placeholder="Optional review note" maxlength="160" style="min-width: 220px;" />
                <button class="btn btn-primary" type="submit" name="status" value="approved" ${isPending ? "" : "disabled"}>Approve</button>
                <button class="btn btn-secondary" type="submit" name="status" value="rejected" ${isPending ? "" : "disabled"}>Reject</button>
              </form>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" style="padding:1rem 0.75rem; color:var(--text-secondary);">No payment submissions yet.</td></tr>`;

  return layoutPage({
    title: "Payments - Godstime Lodge",
    activePath: "/admin/payments",
    user,
    roleLabel: "Admin Dashboard",
    navLinks: adminNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Payments", "Review tenant payment submissions and approve them.", flash)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Submitted</div><div class="stat-value">${payments.length}</div><div class="stat-change positive">Total payment records</div></div>
        <div class="stat-card"><div class="stat-label">Pending</div><div class="stat-value">${payments.filter((payment) => payment.status === "pending").length}</div><div class="stat-change positive">Waiting for review</div></div>
        <div class="stat-card"><div class="stat-label">Approved</div><div class="stat-value">${payments.filter((payment) => payment.status === "approved").length}</div><div class="stat-change positive">Already confirmed</div></div>
        <div class="stat-card"><div class="stat-label">Total Value</div><div class="stat-value">${formatCurrency(payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0))}</div><div class="stat-change positive">All payment submissions</div></div>
      </div>
      <div class="card" style="margin-bottom:1.5rem;">
        <div class="card-header"><div><h3 class="card-title">Find Payments</h3><p class="card-subtitle">Search by tenant, bill, or reference note</p></div></div>
        <form method="get" action="/admin/payments" style="padding:1rem 1.25rem; display:grid; gap:0.85rem; grid-template-columns: 2fr 1fr auto;">
          <input name="q" type="text" class="form-input" value="${escapeHtml(query)}" placeholder="Search payments" />
          <select name="status" class="form-input">
            <option value="">All statuses</option>
            <option value="pending" ${statusFilter === "pending" ? "selected" : ""}>Pending</option>
            <option value="approved" ${statusFilter === "approved" ? "selected" : ""}>Approved</option>
            <option value="rejected" ${statusFilter === "rejected" ? "selected" : ""}>Rejected</option>
          </select>
          <button type="submit" class="btn btn-primary">Filter</button>
        </form>
      </div>
      <div class="card">
        <div class="card-header"><div><h3 class="card-title">Payment Review Queue</h3><p class="card-subtitle">Approve or reject each submission</p></div></div>
        <div class="card-scroll">
          <div class="card-scroll-inner" style="min-width:900px;">
            <table style="width:100%; border-collapse:collapse;">
              <thead>
                <tr style="text-align:left; color:var(--text-secondary); border-bottom:1px solid var(--border);">
                  <th style="padding:0.9rem 0.75rem;">Tenant</th>
                  <th style="padding:0.9rem 0.75rem;">Bill</th>
                  <th style="padding:0.9rem 0.75rem;">Amount</th>
                  <th style="padding:0.9rem 0.75rem;">Status</th>
                  <th style="padding:0.9rem 0.75rem;">Action</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </main>`,
  });
}

function adminMaintenancePage(user, db, flash = "", filters = {}) {
  const query = normalizeLine(filters.q, 80);
  const statusFilter = normalizeLine(filters.status, 20);
  const requests = [...db.maintenanceRequests]
    .filter((request) => {
      if (!statusFilter) return true;
      if (statusFilter === "overdue") {
        return request.status !== "resolved" && getMaintenanceSlaState(request).tone === "red";
      }
      return request.status === statusFilter;
    })
    .filter((request) => {
      const tenant = db.users.find((item) => item.id === request.tenantId);
      return matchesSearch([request.title, request.description, tenant ? tenant.fullName : "", tenant ? tenant.email : ""], query);
    })
    .sort(compareNewestFirst);
  const openRequests = requests.filter((request) => request.status !== "resolved");
  const overdueRequests = openRequests.filter((request) => getMaintenanceSlaState(request).tone === "red");
  const urgentRequests = openRequests.filter((request) => getMaintenanceSlaState(request).tone === "orange");
  const latestOpenRequest = openRequests[0] || null;
  const latestOpenRequestSla = getMaintenanceSlaState(latestOpenRequest);
  const rows = requests.length
    ? requests
        .map((request) => {
          const tenant = db.users.find((item) => item.id === request.tenantId);
          const isResolved = request.status === "resolved";
          const sla = getMaintenanceSlaState(request);
          return `<tr>
            <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(tenant ? tenant.fullName || tenant.email : "Unknown tenant")}</strong></td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(request.title)}</td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(request.description)}</td>
            <td style="padding:0.9rem 0.75rem;"><span class="badge badge-${getMaintenanceStatusTone(request.status)}">${escapeHtml(request.status)}</span></td>
            <td style="padding:0.9rem 0.75rem;">
              <div class="sla-mini">
                <span class="badge badge-${escapeHtml(sla.tone)}">${escapeHtml(sla.label)}</span>
                <div class="sla-mini-detail">${escapeHtml(sla.detail)}</div>
              </div>
            </td>
            <td style="padding:0.9rem 0.75rem;">
              <form method="post" action="/admin/maintenance/status" style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                <input type="hidden" name="request_id" value="${escapeHtml(request.id)}" />
                <input type="text" name="response_note" class="form-input" placeholder="Optional response note" maxlength="160" style="min-width: 220px;" />
                <button class="btn btn-primary" type="submit" name="status" value="in-progress" ${isResolved ? "disabled" : ""}>In Progress</button>
                <button class="btn btn-secondary" type="submit" name="status" value="resolved" ${isResolved ? "disabled" : ""}>Resolve</button>
              </form>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" style="padding:1rem 0.75rem; color:var(--text-secondary);">No maintenance requests yet.</td></tr>`;

  return layoutPage({
    title: "Maintenance - Godstime Lodge",
    activePath: "/admin/maintenance",
    user,
    roleLabel: "Admin Dashboard",
    navLinks: adminNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Maintenance", "Track and update tenant requests from one page.", flash)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Requests</div><div class="stat-value">${requests.length}</div><div class="stat-change positive">All maintenance tickets</div></div>
        <div class="stat-card"><div class="stat-label">Open</div><div class="stat-value">${openRequests.length}</div><div class="stat-change positive">Waiting to be handled</div></div>
        <div class="stat-card"><div class="stat-label">Overdue</div><div class="stat-value">${overdueRequests.length}</div><div class="stat-change ${overdueRequests.length ? "negative" : "positive"}">${overdueRequests.length ? "Past the SLA target" : "Within the SLA target"}</div></div>
        <div class="stat-card"><div class="stat-label">Due Soon</div><div class="stat-value">${urgentRequests.length}</div><div class="stat-change positive">${latestOpenRequest ? latestOpenRequestSla.label : "No open request"}</div></div>
      </div>
      <div class="card" style="margin-bottom:1.5rem;">
        <div class="card-header"><div><h3 class="card-title">Find Requests</h3><p class="card-subtitle">Search by tenant, issue title, or description</p></div></div>
        <form method="get" action="/admin/maintenance" style="padding:1rem 1.25rem; display:grid; gap:0.85rem; grid-template-columns: 2fr 1fr auto;">
          <input name="q" type="text" class="form-input" value="${escapeHtml(query)}" placeholder="Search maintenance requests" />
          <select name="status" class="form-input">
            <option value="">All statuses</option>
            <option value="open" ${statusFilter === "open" ? "selected" : ""}>Open</option>
            <option value="in-progress" ${statusFilter === "in-progress" ? "selected" : ""}>In Progress</option>
            <option value="resolved" ${statusFilter === "resolved" ? "selected" : ""}>Resolved</option>
            <option value="overdue" ${statusFilter === "overdue" ? "selected" : ""}>Overdue</option>
          </select>
          <button type="submit" class="btn btn-primary">Filter</button>
        </form>
      </div>
      <div class="card">
        <div class="card-header"><div><h3 class="card-title">Maintenance Queue</h3><p class="card-subtitle">Update status for each request</p></div></div>
        <div class="card-scroll">
          <div class="card-scroll-inner" style="min-width:900px;">
            <table style="width:100%; border-collapse:collapse;">
              <thead>
                <tr style="text-align:left; color:var(--text-secondary); border-bottom:1px solid var(--border);">
                  <th style="padding:0.9rem 0.75rem;">Tenant</th>
                  <th style="padding:0.9rem 0.75rem;">Title</th>
                  <th style="padding:0.9rem 0.75rem;">Description</th>
                  <th style="padding:0.9rem 0.75rem;">Status</th>
                  <th style="padding:0.9rem 0.75rem;">SLA</th>
                  <th style="padding:0.9rem 0.75rem;">Action</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>
      </div>
    </main>`,
  });
}

function adminDisputesPage(user, db, flash = "") {
  const payments = [...db.payments].sort(compareNewestFirst);
  const requests = [...db.maintenanceRequests].sort(compareNewestFirst);
  const pendingPayments = payments.filter((payment) => payment.status === "pending");
  const openRequests = requests.filter((request) => request.status !== "resolved");
  const recentPayment = payments[0] || null;
  const recentRequest = requests[0] || null;

  return layoutPage({
    title: "Disputes - Godstime Lodge",
    activePath: "/admin/disputes",
    user,
    roleLabel: "Admin Dashboard",
    navLinks: adminNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Disputes Overview", "Watch payment proof and maintenance evidence in one place.", flash)}
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Pending Payments</div><div class="stat-value">${pendingPayments.length}</div><div class="stat-change positive">Waiting for review</div></div>
        <div class="stat-card"><div class="stat-label">Open Maintenance</div><div class="stat-value">${openRequests.length}</div><div class="stat-change positive">Still unresolved</div></div>
        <div class="stat-card"><div class="stat-label">Evidence Links</div><div class="stat-value">${payments.reduce((sum, payment) => sum + (Array.isArray(payment.proofLinks) ? payment.proofLinks.length : 0), 0) + requests.reduce((sum, request) => sum + (Array.isArray(request.evidenceLinks) ? request.evidenceLinks.length : 0), 0)}</div><div class="stat-change positive">Attached support files</div></div>
        <div class="stat-card"><div class="stat-label">Follow-ups</div><div class="stat-value">${payments.reduce((sum, payment) => sum + (Array.isArray(payment.discussion) ? payment.discussion.length : 0), 0) + requests.reduce((sum, request) => sum + (Array.isArray(request.discussion) ? request.discussion.length : 0), 0)}</div><div class="stat-change positive">Tenant and management notes</div></div>
      </div>
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Payment Trail</h3><p class="card-subtitle">Recent payment proof and response notes</p></div></div>
          <div style="padding:1rem 1.25rem;">${recentPayment ? renderDiscussionThread(recentPayment.discussion, "No payment follow-up notes yet.") : `<div style="color:var(--text-secondary);">No payments yet.</div>`}</div>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Maintenance Trail</h3><p class="card-subtitle">Recent maintenance evidence and response notes</p></div></div>
          <div style="padding:1rem 1.25rem;">${recentRequest ? renderDiscussionThread(recentRequest.discussion, "No maintenance follow-up notes yet.") : `<div style="color:var(--text-secondary);">No maintenance requests yet.</div>`}</div>
        </div>
      </div>
    </main>`,
  });
}

function requireLogin(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    redirect(res, "/login");
    return null;
  }
  return user;
}

function requireRole(req, res, role) {
  const user = requireLogin(req, res);
  if (!user) return null;
  if (user.role !== role) {
    sendText(res, 403, "Forbidden");
    return null;
  }
  return user;
}

function redirectWithMessage(res, path, message) {
  const target = new URL(path, "http://localhost");
  target.searchParams.set("message", message);
  return redirect(res, `${target.pathname}${target.search}`);
}

function serveStatic(res, pathname) {
  if (!pathname.startsWith("/assets/")) return false;
  const rel = pathname.replace("/assets/", "");
  const filePath = path.join(ASSETS_DIR, rel);
  if (!filePath.startsWith(ASSETS_DIR)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === ".css"
      ? "text/css; charset=utf-8"
      : ext === ".js"
      ? "text/javascript; charset=utf-8"
      : "application/octet-stream";

  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function serveUpload(res, pathname) {
  if (!pathname.startsWith("/uploads/")) return false;
  const rel = pathname.replace("/uploads/", "");
  const filePath = path.join(UPLOADS_DIR, rel);
  if (!filePath.startsWith(UPLOADS_DIR)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;

  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === ".png"
      ? "image/png"
      : ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".gif"
      ? "image/gif"
      : ext === ".webp"
      ? "image/webp"
      : ext === ".pdf"
      ? "application/pdf"
      : ext === ".txt"
      ? "text/plain; charset=utf-8"
      : "application/octet-stream";

  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

dbReadyPromise = ensureDatabaseReady();

const server = http.createServer(async (req, res) => {
  try {
    await dbReadyPromise;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = (req.method || "GET").toUpperCase();

    applySecurityHeaders(res);

    if (serveStatic(res, pathname)) return;
    if (serveUpload(res, pathname)) return;

    if (pathname === "/healthz") {
      try {
        const health = checkHealth();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(JSON.stringify(health));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ ok: false, error: "healthcheck_failed" }));
      }
    }

    if (pathname === "/") {
      const user = getCurrentUser(req);
      if (user) {
        return redirect(res, user.role === "tenant" ? "/tenant/dashboard" : "/admin/dashboard");
      }
      const landingFile = path.join(PUBLIC_DIR, "landing.html");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(landingFile).pipe(res);
    }

    if (pathname === "/login") {
      if (method === "GET") return send(res, 200, loginView());
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      if (!isFormRequest(req)) return send(res, 415, loginView("Unsupported form submission."));
      const body = await readBody(req);
      const form = parseForm(body);
      const email = String(form.email || "").trim().toLowerCase();
      const password = String(form.password || "");
      const db = loadDb();
      const user = db.users.find((u) => u.email === email);
      if (!user) return send(res, 401, loginView("Invalid email or password."));
      if (user.active === false) return send(res, 403, loginView("This account is currently inactive. Contact management."));
      const hash = pbkdf2Hash(password, user.saltHex);
      if (hash !== user.passwordHash) return send(res, 401, loginView("Invalid email or password."));

      const session = await persistSession(user.id);
      res.setHeader("Set-Cookie", buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)));
      return redirect(res, "/");
    }

    if (pathname === "/register") {
      if (method === "GET") return send(res, 200, registerView());
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      if (!isFormRequest(req)) return send(res, 415, registerView("Unsupported form submission."));
      const body = await readBody(req);
      const form = parseForm(body);
      const fullName = normalizeLine(form.full_name, 80);
      const inviteCode = normalizeInviteCode(form.invite_code);
      const password = String(form.password || "");
      if (!fullName || !inviteCode || !password) return send(res, 400, registerView("Please fill all required fields."));
      if (password.length < 6) return send(res, 400, registerView("Password must be at least 6 characters."));

      const db = loadDb();
      const invite = db.tenantInvites.find((item) => !item.usedAt && item.inviteCode === inviteCode && normalizeNameKey(item.fullName) === normalizeNameKey(fullName));
      if (!invite) {
        return send(res, 403, registerView("Registration is only available for approved tenants with a valid invite code."));
      }
      const email = invite.email || generateTenantEmail(fullName, db.users.map((u) => u.email));
      if (db.users.some((u) => u.email === email)) return send(res, 400, registerView("This tenant email is already registered."));
      invite.email = email;
      const tenant = createUser({ email, password, role: "tenant", fullName: invite.fullName || fullName, unit: invite.unit });
      db.users.push(tenant);
      invite.usedAt = new Date().toISOString();
      await saveDb(db);
      notifyRealtimeChange();

      const session = await persistSession(tenant.id);
      res.setHeader("Set-Cookie", buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)));
      return redirect(res, "/tenant/dashboard");
    }

    if (pathname === "/register/invite-status") {
      if (method !== "GET") return sendText(res, 405, "Method Not Allowed", { Allow: "GET" });
      const fullName = normalizeLine(url.searchParams.get("full_name"), 80);
      const inviteCode = normalizeInviteCode(url.searchParams.get("invite_code"));
      if (!fullName || !inviteCode) {
        return sendJson(res, 200, { ok: false, state: "idle", message: "Enter your approved full name and invite code to verify access." });
      }
      const db = loadDb();
      const invite = db.tenantInvites.find((item) => !item.usedAt && item.inviteCode === inviteCode && normalizeNameKey(item.fullName) === normalizeNameKey(fullName));
      if (!invite) {
        return sendJson(res, 200, { ok: false, state: "invalid", message: "Invite not found. Use the exact approved full name and code from management." });
      }
      const email = invite.email || generateTenantEmail(fullName, db.users.map((user) => user.email));
      if (db.users.some((user) => user.email === email)) {
        return sendJson(res, 200, { ok: false, state: "used", message: "That tenant email already has an account. Sign in instead.", email });
      }
      return sendJson(res, 200, {
        ok: true,
        state: "valid",
        email,
        message: `Invite confirmed for ${invite.fullName || fullName}${invite.unit ? ` • ${invite.unit}` : ""}. Your email will be ${email}.`,
      });
    }

    if (pathname === "/api/notifications") {
      if (method !== "GET") return sendText(res, 405, "Method Not Allowed", { Allow: "GET" });
      const user = requireLogin(req, res);
      if (!user) return;
      const db = loadDb();
      return sendJson(res, 200, buildRealtimeNotificationPayload(user, db));
    }

    if (pathname === "/api/notifications/stream") {
      if (method !== "GET") return sendText(res, 405, "Method Not Allowed", { Allow: "GET" });
      const user = requireLogin(req, res);
      if (!user) return;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ version: notificationVersion, role: user.role })}\n\n`);
      const client = { res, userId: user.id, role: user.role };
      notificationClients.add(client);
      const keepAlive = setInterval(() => {
        try {
          res.write(": keep-alive\n\n");
        } catch (error) {
          clearInterval(keepAlive);
          notificationClients.delete(client);
        }
      }, 25000);
      req.on("close", () => {
        clearInterval(keepAlive);
        notificationClients.delete(client);
      });
      return;
    }

    if (pathname === "/logout") {
      if (method !== "GET" && method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      const cookies = parseCookies(req);
      const sid = cookies.gtl_session;
      await destroySession(sid);
      res.setHeader("Set-Cookie", buildSessionCookie("", 0));
      return redirect(res, "/login");
    }

    if (pathname === "/tenant/dashboard") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, tenantDashboardView(user, db, String(url.searchParams.get("message") || "")));
    }

    if (pathname === "/tenant/analytics") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, tenantAnalyticsPage(user, db, String(url.searchParams.get("message") || "")));
    }

    if (pathname === "/tenant/bills") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, tenantBillsPage(user, db, String(url.searchParams.get("message") || "")));
    }

    if (pathname === "/tenant/payments") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      if (method === "GET") {
        const db = loadDb();
        return send(res, 200, tenantPaymentsPage(user, db, String(url.searchParams.get("message") || "")));
      }
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req) && !isMultipartRequest(req)) return redirectWithMessage(res, "/tenant/payments", "Unsupported payment submission.");
      const submission = await readSubmittedForm(req);
      const form = submission.fields;
      const files = submission.files || {};
      const amount = Number(form.amount || 0);
      const billId = normalizeLine(form.bill_id, 40);
      const note = normalizeLine(form.note, 120);
      const proofLinks = normalizeSupportLinks(form.proof_links, 4);
      if (amount <= 0) return redirectWithMessage(res, "/tenant/payments", "Enter a valid payment amount.");
      const db = loadDb();
      const bill = db.bills.find((item) => item.id === billId && item.tenantId === user.id);
      if (!bill) return redirectWithMessage(res, "/tenant/payments", "Choose a valid bill before submitting payment.");
      if (getBillStatus(bill) === "paid") {
        return redirectWithMessage(res, "/tenant/payments", "That bill is already marked as paid.");
      }
      const payment = createPayment({ tenantId: user.id, billId, amount, note, proofLinks });
      payment.proofFiles = Array.isArray(files.proof_files) ? files.proof_files.map((file) => storeUploadedFile(file, "payment")) : [];
      db.payments.push(payment);
      syncBillStatuses(db);
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/tenant/payments", "Payment submitted successfully.");
    }

    if (pathname === "/tenant/payments/comment") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/tenant/payments", "Unsupported payment note.");
      const body = await readBody(req);
      const form = parseForm(body);
      const comment = normalizeLine(form.comment, 160);
      const paymentId = normalizeLine(form.payment_id, 40);
      if (!comment) return redirectWithMessage(res, "/tenant/payments", "Add a note before submitting.");
      const db = loadDb();
      const payment = db.payments.find((item) => item.id === paymentId && item.tenantId === user.id);
      if (!payment) return redirectWithMessage(res, "/tenant/payments", "Payment not found.");
      payment.discussion = Array.isArray(payment.discussion) ? payment.discussion : [];
      payment.discussion.push(createThreadEntry("tenant", comment, new Date().toISOString(), user.fullName || "Tenant"));
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/tenant/payments", "Payment note added.");
    }

    if (pathname === "/tenant/requests") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      if (method === "GET") {
        const db = loadDb();
        return send(res, 200, tenantMaintenancePage(user, db, String(url.searchParams.get("message") || "")));
      }
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req) && !isMultipartRequest(req)) return redirectWithMessage(res, "/tenant/requests", "Unsupported request submission.");
      const submission = await readSubmittedForm(req);
      const form = submission.fields;
      const files = submission.files || {};
      const title = normalizeLine(form.title, 80);
      const description = normalizeLine(form.description, 400);
      const evidenceNote = normalizeLine(form.evidence_note, 160);
      const evidenceLinks = normalizeSupportLinks(form.evidence_links, 4);
      if (!title || !description) {
        return redirectWithMessage(res, "/tenant/requests", "Please add a title and description for the maintenance request.");
      }
      const db = loadDb();
      const request = createMaintenanceRequest({ tenantId: user.id, title, description, evidenceNote, evidenceLinks });
      request.evidenceFiles = Array.isArray(files.evidence_files) ? files.evidence_files.map((file) => storeUploadedFile(file, "maintenance")) : [];
      db.maintenanceRequests.push(request);
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/tenant/requests", "Maintenance request sent.");
    }

    if (pathname === "/tenant/requests/comment") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/tenant/requests", "Unsupported request note.");
      const body = await readBody(req);
      const form = parseForm(body);
      const comment = normalizeLine(form.comment, 160);
      const requestId = normalizeLine(form.request_id, 40);
      if (!comment) return redirectWithMessage(res, "/tenant/requests", "Add a note before submitting.");
      const db = loadDb();
      const request = db.maintenanceRequests.find((item) => item.id === requestId && item.tenantId === user.id);
      if (!request) return redirectWithMessage(res, "/tenant/requests", "Maintenance request not found.");
      request.discussion = Array.isArray(request.discussion) ? request.discussion : [];
      request.discussion.push(createThreadEntry("tenant", comment, new Date().toISOString(), user.fullName || "Tenant"));
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/tenant/requests", "Maintenance note added.");
    }

    if (pathname === "/tenant/disputes") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, tenantDisputesPage(user, db, String(url.searchParams.get("message") || "")));
    }

    if (pathname === "/tenant/account") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, tenantAccountPage(user, db, String(url.searchParams.get("message") || "")));
    }

    if (pathname === "/admin/dashboard") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, adminDashboardView(user, db, String(url.searchParams.get("message") || "")));
    }

    if (pathname === "/admin/analytics") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, adminAnalyticsPage(user, db, String(url.searchParams.get("message") || "")));
    }

    if (pathname === "/admin/tenants") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      if (method === "GET") {
        return send(res, 200, adminTenantsPage(user, db, String(url.searchParams.get("message") || ""), {
          q: String(url.searchParams.get("q") || ""),
          status: String(url.searchParams.get("status") || ""),
        }));
      }
      return sendText(res, 405, "Method Not Allowed", { Allow: "GET" });
    }

    if (pathname === "/admin/tenants/update") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/admin/tenants", "Unsupported tenant update.");
      const body = await readBody(req);
      const form = parseForm(body);
      const db = loadDb();
      const tenant = db.users.find((item) => item.id === normalizeLine(form.tenant_id, 40) && item.role === "tenant");
      if (!tenant) return redirectWithMessage(res, "/admin/tenants", "Tenant not found.");
      const fullName = normalizeLine(form.full_name, 80);
      const unit = normalizeLine(form.unit, 40);
      const status = normalizeLine(form.status, 20);
      const password = String(form.password || "");
      if (!fullName) return redirectWithMessage(res, "/admin/tenants", "Tenant name cannot be empty.");
      if (!["active", "inactive"].includes(status)) return redirectWithMessage(res, "/admin/tenants", "Choose a valid tenant status.");
      if (password && password.length < 6) return redirectWithMessage(res, "/admin/tenants", "New password must be at least 6 characters.");
      tenant.fullName = fullName;
      tenant.unit = unit;
      tenant.active = status === "active";
      if (password) {
        const replacement = createUser({
          email: tenant.email,
          password,
          role: tenant.role,
          fullName: tenant.fullName,
          unit: tenant.unit,
        });
        tenant.saltHex = replacement.saltHex;
        tenant.passwordHash = replacement.passwordHash;
      }
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/admin/tenants", "Tenant record updated successfully.");
    }

    if (pathname === "/admin/tenants/invite") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/admin/tenants", "Unsupported tenant invite submission.");
      const body = await readBody(req);
      const form = parseForm(body);
      const db = loadDb();
      const fullName = normalizeLine(form.full_name, 80);
      const unit = normalizeLine(form.unit, 40);
      let inviteCode = normalizeInviteCode(form.invite_code);
      if (!fullName) {
        return redirectWithMessage(res, "/admin/tenants", "Please enter a valid tenant name before approving access.");
      }
      const email = generateTenantEmail(fullName, [
        ...db.users.map((item) => item.email),
        ...db.tenantInvites.filter((item) => !item.usedAt).map((item) => item.email),
      ]);
      if (db.users.some((item) => item.email === email)) {
        return redirectWithMessage(res, "/admin/tenants", "That tenant email already belongs to a registered user.");
      }
      if (db.tenantInvites.some((item) => item.email === email && !item.usedAt)) {
        return redirectWithMessage(res, "/admin/tenants", "That tenant already has a pending invite.");
      }
      if (!inviteCode) {
        do {
          inviteCode = generateInviteCode();
        } while (db.tenantInvites.some((item) => item.inviteCode === inviteCode && !item.usedAt));
      }
      if (db.tenantInvites.some((item) => item.inviteCode === inviteCode && !item.usedAt)) {
        return redirectWithMessage(res, "/admin/tenants", "Choose a different invite code because that one is already active.");
      }
      db.tenantInvites.push(createTenantInvite({ fullName, unit, inviteCode, existingEmails: [
        ...db.users.map((item) => item.email),
        ...db.tenantInvites.map((item) => item.email),
      ] }));
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/admin/tenants", `Tenant invite created. Share code ${inviteCode} with ${fullName}. Their email is ${email}.`);
    }

    if (pathname === "/admin/projects") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      if (method === "GET") {
        return send(res, 200, adminProjectsPage(user, db, String(url.searchParams.get("message") || ""), {
          q: String(url.searchParams.get("q") || ""),
          status: String(url.searchParams.get("status") || ""),
        }));
      }
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/admin/projects", "Unsupported project submission.");
      const body = await readBody(req);
      const form = parseForm(body);
      const title = normalizeLine(form.title, 80);
      const description = normalizeLine(form.description, 300);
      const owner = normalizeLine(form.owner, 60);
      const budget = Number(form.budget || 0);
      const dueDate = normalizeLine(form.due_date, 10);
      if (!title || !description || !Number.isFinite(budget) || budget < 0) {
        return redirectWithMessage(res, "/admin/projects", "Please complete the project form correctly.");
      }
      if (dueDate && !isValidDateInput(dueDate)) {
        return redirectWithMessage(res, "/admin/projects", "Choose a valid project deadline.");
      }
      db.projects.push(createProject({ title, description, owner, budget, dueDate }));
      await saveDb(db);
      return redirectWithMessage(res, "/admin/projects", "Project created successfully.");
    }

    if (pathname === "/admin/projects/status") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/admin/projects", "Unsupported project update.");
      const body = await readBody(req);
      const form = parseForm(body);
      const db = loadDb();
      const project = db.projects.find((item) => item.id === normalizeLine(form.project_id, 40));
      if (!project) return redirectWithMessage(res, "/admin/projects", "Project not found.");
      const nextStatus = normalizeLine(form.status, 20);
      if (!["planned", "active", "completed"].includes(nextStatus)) {
        return redirectWithMessage(res, "/admin/projects", "Choose a valid project status.");
      }
      project.status = nextStatus;
      await saveDb(db);
      return redirectWithMessage(res, "/admin/projects", "Project status updated.");
    }

    if (pathname === "/admin/settings") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      if (method === "GET") {
        return send(res, 200, adminSettingsPage(user, db, String(url.searchParams.get("message") || "")));
      }
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/admin/settings", "Unsupported settings update.");
      const body = await readBody(req);
      const form = parseForm(body);
      const supportEmail = String(form.support_email || "").trim().toLowerCase();
      const totalUnits = Number(form.total_units || 0);
      const announcement = normalizeLine(form.announcement, 160);
      if (!supportEmail || !supportEmail.includes("@") || !Number.isFinite(totalUnits) || totalUnits < 1) {
        return redirectWithMessage(res, "/admin/settings", "Please enter valid settings values.");
      }
      db.settings.supportEmail = supportEmail;
      db.settings.totalUnits = totalUnits;
      if (announcement !== db.settings.announcement) {
        db.settings.announcementUpdatedAt = new Date().toISOString();
      }
      db.settings.announcement = announcement;
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/admin/settings", "Settings updated successfully.");
    }

    if (pathname === "/admin/bills") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      if (method === "GET") {
        return send(res, 200, adminBillsPage(user, db, String(url.searchParams.get("message") || ""), {
          q: String(url.searchParams.get("q") || ""),
          status: String(url.searchParams.get("status") || ""),
        }));
      }
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/admin/bills", "Unsupported bill submission.");
      const body = await readBody(req);
      const form = parseForm(body);
      const amount = Number(form.amount || 0);
      const tenantId = normalizeLine(form.tenant_id, 40);
      const title = normalizeLine(form.title, 80);
      const dueDate = normalizeLine(form.due_date, 10);
      if (!db.users.some((item) => item.id === tenantId && item.role === "tenant")) {
        return redirectWithMessage(res, "/admin/bills", "Select a valid tenant before creating a bill.");
      }
      if (!title || amount <= 0 || !isValidDateInput(dueDate)) {
        return redirectWithMessage(res, "/admin/bills", "Please fill all bill fields correctly.");
      }
      db.bills.push(createBill({ tenantId, title, amount, dueDate }));
      syncBillStatuses(db);
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/admin/bills", "Bill created successfully.");
    }

    if (pathname === "/admin/payments") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      if (method === "GET") {
        return send(res, 200, adminPaymentsPage(user, db, String(url.searchParams.get("message") || ""), {
          q: String(url.searchParams.get("q") || ""),
          status: String(url.searchParams.get("status") || ""),
        }));
      }
      return sendText(res, 405, "Method Not Allowed", { Allow: "GET" });
    }

    if (pathname === "/admin/payments/status") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/admin/payments", "Unsupported payment update.");
      const body = await readBody(req);
      const form = parseForm(body);
      const db = loadDb();
      const payment = db.payments.find((item) => item.id === normalizeLine(form.payment_id, 40));
      if (!payment) return redirectWithMessage(res, "/admin/payments", "Payment not found.");
      if (payment.status !== "pending") {
        return redirectWithMessage(res, "/admin/payments", "Only pending payments can be reviewed.");
      }
      const nextStatus = String(form.status || "").trim();
      const responseNote = normalizeLine(form.response_note, 160);
      if (!["approved", "rejected"].includes(nextStatus)) {
        return redirectWithMessage(res, "/admin/payments", "Choose a valid payment status.");
      }
      payment.status = nextStatus;
      payment.reviewedAt = new Date().toISOString();
      payment.statusHistory = Array.isArray(payment.statusHistory) ? payment.statusHistory : [];
      payment.statusHistory.push(createTrailEntry(nextStatus, responseNote ? `Payment ${nextStatus}. ${responseNote}` : `Payment ${nextStatus}.`, payment.reviewedAt, "management"));
      payment.discussion = Array.isArray(payment.discussion) ? payment.discussion : [];
      payment.discussion.push(createThreadEntry("management", responseNote ? `Management ${nextStatus}: ${responseNote}` : `Management ${nextStatus} the payment.`, payment.reviewedAt, user.fullName || "Management"));
      syncBillStatuses(db);
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/admin/payments", "Payment status updated.");
    }

    if (pathname === "/admin/maintenance") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      if (method === "GET") {
        return send(res, 200, adminMaintenancePage(user, db, String(url.searchParams.get("message") || ""), {
          q: String(url.searchParams.get("q") || ""),
          status: String(url.searchParams.get("status") || ""),
        }));
      }
      return sendText(res, 405, "Method Not Allowed", { Allow: "GET" });
    }

    if (pathname === "/admin/maintenance/status") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/admin/maintenance", "Unsupported maintenance update.");
      const body = await readBody(req);
      const form = parseForm(body);
      const db = loadDb();
      const request = db.maintenanceRequests.find((item) => item.id === normalizeLine(form.request_id, 40));
      if (!request) return redirectWithMessage(res, "/admin/maintenance", "Request not found.");
      const nextStatus = String(form.status || "").trim();
      const responseNote = normalizeLine(form.response_note, 160);
      if (!["open", "in-progress", "resolved"].includes(nextStatus)) {
        return redirectWithMessage(res, "/admin/maintenance", "Choose a valid maintenance status.");
      }
      const now = new Date().toISOString();
      request.status = nextStatus;
      request.updatedAt = now;
      if (!request.firstResponseAt && nextStatus !== "open") {
        request.firstResponseAt = now;
      }
      if (nextStatus === "resolved") {
        request.resolvedAt = now;
      }
      request.statusHistory = Array.isArray(request.statusHistory) ? request.statusHistory : [];
      request.statusHistory.push(createTrailEntry(nextStatus, responseNote ? `Maintenance request marked ${nextStatus}. ${responseNote}` : `Maintenance request marked ${nextStatus}.`, now, "management"));
      request.discussion = Array.isArray(request.discussion) ? request.discussion : [];
      request.discussion.push(createThreadEntry("management", responseNote ? `Management ${nextStatus}: ${responseNote}` : `Management marked the request ${nextStatus}.`, now, user.fullName || "Management"));
      await saveDb(db);
      notifyRealtimeChange();
      return redirectWithMessage(res, "/admin/maintenance", "Maintenance status updated.");
    }

    if (pathname === "/admin/disputes") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, adminDisputesPage(user, db, String(url.searchParams.get("message") || "")));
    }

    sendText(res, 404, "Not found");
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error && error.message === "Body too large") {
      return sendText(res, 413, "Payload Too Large", { "Cache-Control": "no-store" });
    }
    console.error("Unhandled request error", error);
    return sendText(res, 500, "Internal Server Error", { "Cache-Control": "no-store" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log("Tenant register: /register");
  console.log("Tenant dashboard: /tenant/dashboard");
  console.log("Admin dashboard: /admin/dashboard");
  console.log(`Admin login email: ${ADMIN_EMAIL}`);
  if (IS_DEFAULT_ADMIN_PASSWORD) {
    console.warn("Warning: ADMIN_PASSWORD is using the default value. Set a strong secret before production use.");
  }
});
