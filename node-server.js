const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "admin@godstimelodge.com").trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "admin123");
const IS_DEFAULT_ADMIN_PASSWORD = ADMIN_PASSWORD === "admin123";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";
const MAX_BODY_SIZE = 1024 * 1024;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const DB_PATH = path.join(DATA_DIR, "node-db.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(PUBLIC_DIR, "assets");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
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
    saltHex,
    passwordHash,
    createdAt: new Date().toISOString(),
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

function createPayment({ tenantId, billId, amount, note }) {
  return {
    id: randomId(12),
    tenantId,
    billId: String(billId || "").trim(),
    amount: Number(amount) || 0,
    note: String(note || "").trim(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

function createMaintenanceRequest({ tenantId, title, description }) {
  return {
    id: randomId(12),
    tenantId,
    title: String(title || "").trim(),
    description: String(description || "").trim(),
    status: "open",
    createdAt: new Date().toISOString(),
  };
}

function normalizeDb(db) {
  return {
    users: Array.isArray(db && db.users) ? db.users : [],
    sessions: Array.isArray(db && db.sessions) ? db.sessions : [],
    bills: Array.isArray(db && db.bills) ? db.bills : [],
    payments: Array.isArray(db && db.payments) ? db.payments : [],
    maintenanceRequests: Array.isArray(db && db.maintenanceRequests) ? db.maintenanceRequests : [],
  };
}

function loadDb() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    const admin = createUser({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      role: "admin",
      fullName: "Admin",
      unit: "",
    });
    const db = { users: [admin], sessions: [], bills: [], payments: [], maintenanceRequests: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
  }
  return normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
}

function saveDb(db) {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(normalizeDb(db), null, 2), "utf8");
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
    saveDb(db);
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

function persistSession(userId) {
  const db = loadDb();
  const session = createSession(userId);
  const now = Date.now();
  db.sessions = db.sessions.filter((item) => item.userId !== userId && Date.parse(item.expiresAt) > now);
  db.sessions.push(session);
  saveDb(db);
  return session;
}

function destroySession(sessionId) {
  if (!sessionId) return;
  const db = loadDb();
  const nextSessions = db.sessions.filter((session) => session.id !== sessionId);
  if (nextSessions.length !== db.sessions.length) {
    db.sessions = nextSessions;
    saveDb(db);
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

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
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
  const avatar = escapeHtml((user.fullName || "A").slice(0, 1).toUpperCase());
  const name = escapeHtml(user.fullName || "User");
  const links = navLinks
    .map(
      (item) => `<div class="nav-item">
        <a href="${item.href}" class="nav-link${activePath === item.href ? " active" : ""}">
          ${item.icon}
          ${escapeHtml(item.label)}
        </a>
      </div>`
    )
    .join("");
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

  return htmlPage(
    title,
    `<div class="app-container">
      <nav class="top-nav">
        <div class="nav-container">
          <div class="nav-left">
            <a href="/${user.role === "admin" ? "admin" : "tenant"}/dashboard" class="logo">
              <div class="logo-icon logo-mark">GT</div><div class="logo-text"><div class="logo-name">Godstime Lodge</div><div class="logo-sub">${escapeHtml(roleLabel)}</div></div>
            </a>
            <div class="nav-menu">
              ${links}
            </div>
          </div>
          <div class="nav-right">
            ${themeToggle}
            <button class="user-menu">
              <div class="user-avatar">${avatar}</div>
              <span class="user-name">${name}</span>
            </button>
            <a href="/logout" class="btn-logout" title="Logout">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </a>
          </div>
        </div>
      </nav>
      ${body}
      <footer class="footer"><p>&copy; 2026 Sbiam Solutions. All rights reserved.</p></footer>
    </div>`
  );
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
          <p class="login-footer" style="margin-top:1rem;">No account yet? <a href="/register">Create tenant account</a></p>
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
            <p class="login-subtitle">Register to access your dashboard.</p>
          </div>
          ${err}
          <form class="login-form" method="post" action="/register">
            <div class="form-group">
              <label class="form-label">Full Name</label>
              <input name="full_name" type="text" class="form-input" placeholder="e.g. Adaeze Okafor" required />
            </div>
            <div class="form-group">
              <label class="form-label">Unit</label>
              <input name="unit" type="text" class="form-input" placeholder="e.g. Block B - 3" />
            </div>
            <div class="form-group">
              <label class="form-label">Email Address</label>
              <input name="email" type="email" class="form-input" placeholder="you@example.com" required />
            </div>
            <div class="form-group">
              <label class="form-label">Password</label>
              <input name="password" type="password" class="form-input" placeholder="Minimum 6 characters" required />
            </div>
            <button type="submit" class="btn btn-primary">Create Account</button>
          </form>
          <p class="login-footer" style="margin-top:1rem;">Already registered? <a href="/login">Sign in</a></p>
        </div>
      </div>
    </div>`
  );
}

function tenantDashboardView(user, db, flash = "") {
  const totalUnits = 25;
  const tenants = db.users.filter((item) => item.role === "tenant");
  const occupiedUnits = new Set(tenants.map((tenant) => tenant.unit).filter(Boolean)).size;
  const occupancyRate = percentage(occupiedUnits, totalUnits);
  const activeSessions = db.sessions.filter((session) => Date.parse(session.expiresAt) > Date.now());
  const currentSession = activeSessions.find((session) => session.userId === user.id) || null;
  const joinedDate = formatDateOnly(user.createdAt);
  const lastAccess = currentSession ? formatDateTime(currentSession.createdAt) : "No active session found";
  const bills = db.bills
    .filter((bill) => bill.tenantId === user.id)
    .sort((a, b) => Date.parse(a.dueDate || a.createdAt) - Date.parse(b.dueDate || b.createdAt));
  const payments = db.payments
    .filter((payment) => payment.tenantId === user.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const requests = db.maintenanceRequests
    .filter((request) => request.tenantId === user.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const totalDue = bills.filter((bill) => bill.status !== "paid").reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);
  const totalPaid = payments.filter((payment) => payment.status === "approved").reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const neighbors = tenants
    .filter((tenant) => tenant.id !== user.id && tenant.unit)
    .slice(0, 4);
  const flashBanner = flash
    ? `<div class="alert" style="margin-bottom:1rem; padding:0.9rem 1rem; border:1px solid var(--border); border-radius:16px; background:rgba(34,197,94,0.08); color:var(--text-primary);">${escapeHtml(flash)}</div>`
    : "";
  const neighborItems = neighbors.length
    ? neighbors
        .map(
          (tenant) => `<div class="activity-item">
            <div class="activity-icon blue">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>
              </svg>
            </div>
            <div class="activity-content">
              <p class="activity-text"><strong>${escapeHtml(tenant.fullName || tenant.email)}</strong></p>
              <p class="activity-text" style="color: var(--text-secondary);">Unit ${escapeHtml(tenant.unit)}</p>
              <span class="activity-time">Joined ${formatDateOnly(tenant.createdAt)}</span>
            </div>
          </div>`
        )
        .join("")
    : `<div style="padding: 1rem; color: var(--text-secondary);">As more tenants register, they will show up here.</div>`;
  const billRows = bills.length
    ? bills
        .map(
          (bill) => `<tr>
            <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(bill.title)}</strong></td>
            <td style="padding:0.9rem 0.75rem;">${formatCurrency(bill.amount)}</td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(bill.dueDate || "Not set")}</td>
            <td style="padding:0.9rem 0.75rem; text-transform:capitalize;">${escapeHtml(bill.status)}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" style="padding:1rem 0.75rem; color:var(--text-secondary);">No bills have been assigned yet.</td></tr>`;
  const paymentItems = payments.length
    ? payments
        .slice(0, 5)
        .map((payment) => {
          const bill = db.bills.find((item) => item.id === payment.billId);
          return `<div class="activity-item">
            <div class="activity-icon green">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            </div>
            <div class="activity-content">
              <p class="activity-text"><strong>${formatCurrency(payment.amount)}</strong> for ${escapeHtml(bill ? bill.title : "general payment")}</p>
              <p class="activity-text" style="color:var(--text-secondary); text-transform:capitalize;">Status: ${escapeHtml(payment.status)}</p>
              <span class="activity-time">${formatDateTime(payment.createdAt)}</span>
            </div>
          </div>`;
        })
        .join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">No payments submitted yet.</div>`;
  const requestItems = requests.length
    ? requests
        .slice(0, 5)
        .map(
          (request) => `<div class="activity-item">
            <div class="activity-icon orange">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div class="activity-content">
              <p class="activity-text"><strong>${escapeHtml(request.title)}</strong></p>
              <p class="activity-text" style="color:var(--text-secondary);">${escapeHtml(request.description)}</p>
              <span class="activity-time">${escapeHtml(request.status)} • ${formatDateTime(request.createdAt)}</span>
            </div>
          </div>`
        )
        .join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">No maintenance requests yet.</div>`;
  const billOptions = bills.length
    ? bills
        .map((bill) => `<option value="${escapeHtml(bill.id)}">${escapeHtml(bill.title)} - ${formatCurrency(bill.amount)}</option>`)
        .join("")
    : `<option value="">No bill selected</option>`;

  return htmlPage(
    "Tenant Dashboard - Godstime Lodge",
    `<div class="app-container">
      <nav class="top-nav">
        <div class="nav-container">
          <div class="nav-left">
            <a href="/tenant/dashboard" class="logo">
              <div class="logo-icon logo-mark">GT</div><div class="logo-text"><div class="logo-name">Godstime Lodge</div><div class="logo-sub">Tenant Billing</div></div>
            </a>
            <div class="nav-menu">
              <div class="nav-item">
                <a href="/tenant/dashboard" class="nav-link active">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="7" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/>
                  </svg>
                  Dashboard
                </a>
              </div>
            </div>
          </div>
          <div class="nav-right">
            <button class="user-menu">
              <div class="user-avatar">${escapeHtml(user.fullName.slice(0, 1).toUpperCase())}</div>
              <span class="user-name">${escapeHtml(user.fullName)}</span>
            </button>
            <a href="/logout" class="btn-logout" title="Logout">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </a>
          </div>
        </div>
      </nav>
      <main class="main-content">
        ${flashBanner}
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
            <div class="stat-change">${bills.filter((bill) => bill.status !== "paid").length} unpaid bills</div>
          </div>
        </div>

        <div class="card" style="margin-top: 1.5rem;">
          <div class="card-header">
            <div>
              <h3 class="card-title">Open Pages</h3>
              <p class="card-subtitle">Jump straight to the page you need</p>
            </div>
          </div>
          <div style="padding: 1rem 1.25rem; display:flex; gap:0.75rem; flex-wrap:wrap;">
            <a class="btn btn-secondary" href="/tenant/bills">Bills</a>
            <a class="btn btn-secondary" href="/tenant/payments">Payments</a>
            <a class="btn btn-secondary" href="/tenant/requests">Maintenance</a>
          </div>
        </div>

        <div class="two-col">
          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">My Account</h3>
                <p class="card-subtitle">Your current tenant profile details</p>
              </div>
              <a href="/tenant/account" class="btn btn-secondary">Open page</a>
            </div>
            <div style="padding: 1rem 1.25rem; display:grid; gap:0.9rem; color: var(--text-primary);">
              <div><strong>Full Name:</strong> ${escapeHtml(user.fullName || "Not set")}</div>
              <div><strong>Email:</strong> ${escapeHtml(user.email)}</div>
              <div><strong>Unit:</strong> ${escapeHtml(user.unit || "Not assigned")}</div>
              <div><strong>Role:</strong> Tenant</div>
              <div><strong>Access:</strong> Protected by login</div>
              <div><strong>Total Paid:</strong> ${formatCurrency(totalPaid)}</div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Make a Payment</h3>
                <p class="card-subtitle">Submit a payment record for admin approval</p>
              </div>
            </div>
            <form method="post" action="/tenant/payments" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
              <div class="form-group">
                <label class="form-label">Bill</label>
                <select name="bill_id" class="form-input">${billOptions}</select>
              </div>
              <div class="form-group">
                <label class="form-label">Amount</label>
                <input name="amount" type="number" min="0" step="100" class="form-input" placeholder="e.g. 250000" required />
              </div>
              <div class="form-group">
                <label class="form-label">Note</label>
                <input name="note" type="text" class="form-input" placeholder="Transfer reference or short note" />
              </div>
              <button type="submit" class="btn btn-primary">Submit Payment</button>
            </form>
          </div>
        </div>

        <div class="two-col" style="margin-top: 1.5rem;">
          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">My Bills</h3>
                <p class="card-subtitle">Charges assigned to your account</p>
              </div>
            </div>
            <div class="card-scroll">
              <div class="card-scroll-inner" style="min-width: 520px;">
                <table style="width:100%; border-collapse:collapse;">
                  <thead>
                    <tr style="text-align:left; color:var(--text-secondary); border-bottom:1px solid var(--border);">
                      <th style="padding:0.9rem 0.75rem;">Bill</th>
                      <th style="padding:0.9rem 0.75rem;">Amount</th>
                      <th style="padding:0.9rem 0.75rem;">Due Date</th>
                      <th style="padding:0.9rem 0.75rem;">Status</th>
                    </tr>
                  </thead>
                  <tbody>${billRows}</tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Maintenance Request</h3>
                <p class="card-subtitle">Tell management what needs attention</p>
              </div>
            </div>
            <form method="post" action="/tenant/requests" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
              <div class="form-group">
                <label class="form-label">Title</label>
                <input name="title" type="text" class="form-input" placeholder="e.g. Water leak in bathroom" required />
              </div>
              <div class="form-group">
                <label class="form-label">Description</label>
                <textarea name="description" class="form-input" rows="4" placeholder="Describe the issue in a few words" required></textarea>
              </div>
              <button type="submit" class="btn btn-primary">Send Request</button>
            </form>
          </div>
        </div>

        <div class="two-col" style="margin-top: 1.5rem;">
          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Payment History</h3>
                <p class="card-subtitle">Your recent submitted payments</p>
              </div>
            </div>
            <div class="card-scroll">
              <div class="card-scroll-inner" style="min-width:340px;">
                <div class="activity-feed">${paymentItems}</div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Maintenance Updates</h3>
                <p class="card-subtitle">Track your open and completed requests</p>
              </div>
            </div>
            <div class="card-scroll">
              <div class="card-scroll-inner" style="min-width:340px;">
                <div class="activity-feed">${requestItems}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="two-col" style="margin-top: 1.5rem;">
          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Community Snapshot</h3>
                <p class="card-subtitle">Other recently registered tenants</p>
              </div>
            </div>
            <div class="card-scroll">
              <div class="card-scroll-inner" style="min-width: 340px;">
                <div class="activity-feed">${neighborItems}</div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Lodge Overview</h3>
                <p class="card-subtitle">Shared occupancy progress</p>
              </div>
            </div>
            <div style="padding: 1rem 1.25rem; display: grid; gap: 1rem;">
              <div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                  <span>Occupancy</span>
                  <strong>${occupancyRate}%</strong>
                </div>
                <div class="progress-bar"><div class="progress-fill success" style="width: ${occupancyRate}%;"></div></div>
              </div>
              <div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                  <span>Tenant registrations</span>
                  <strong>${tenants.length}</strong>
                </div>
                <div class="progress-bar"><div class="progress-fill accent" style="width: ${percentage(tenants.length, totalUnits)}%;"></div></div>
              </div>
              <div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                  <span>My portal setup</span>
                  <strong>${user.unit ? "100%" : "80%"}</strong>
                </div>
                <div class="progress-bar"><div class="progress-fill warning" style="width: ${user.unit ? 100 : 80}%;"></div></div>
              </div>
            </div>
          </div>
        </div>
      </main>
      <footer class="footer"><p>&copy; 2026 Sbiam Solutions. All rights reserved.</p></footer>
    </div>`
  );
}

function tenantBillsPage(user, db, flash = "") {
  const bills = db.bills
    .filter((bill) => bill.tenantId === user.id)
    .sort((a, b) => Date.parse(a.dueDate || a.createdAt) - Date.parse(b.dueDate || b.createdAt));
  const rows = bills.length
    ? bills
        .map(
          (bill) => `<tr>
            <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(bill.title)}</strong></td>
            <td style="padding:0.9rem 0.75rem;">${formatCurrency(bill.amount)}</td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(bill.dueDate || "Not set")}</td>
            <td style="padding:0.9rem 0.75rem; text-transform:capitalize;">${escapeHtml(bill.status)}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" style="padding:1rem 0.75rem; color:var(--text-secondary);">No bills have been assigned yet.</td></tr>`;
  const unpaid = bills.filter((bill) => bill.status !== "paid").reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);
  const active = bills.filter((bill) => bill.status !== "paid").length;

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
  const bills = db.bills.filter((bill) => bill.tenantId === user.id);
  const payments = db.payments
    .filter((payment) => payment.tenantId === user.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const options = bills.length
    ? bills.map((bill) => `<option value="${escapeHtml(bill.id)}">${escapeHtml(bill.title)} - ${formatCurrency(bill.amount)}</option>`).join("")
    : `<option value="">No bill selected</option>`;
  const items = payments.length
    ? payments.map((payment) => `<div class="activity-item">
      <div class="activity-icon green">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      </div>
      <div class="activity-content">
        <p class="activity-text"><strong>${formatCurrency(payment.amount)}</strong></p>
        <p class="activity-text" style="color:var(--text-secondary);">${escapeHtml(payment.note || "No note added")}</p>
        <span class="activity-time">${escapeHtml(payment.status)} • ${formatDateTime(payment.createdAt)}</span>
      </div>
    </div>`).join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">No payments submitted yet.</div>`;

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
          <form method="post" action="/tenant/payments" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
            <div class="form-group"><label class="form-label">Bill</label><select name="bill_id" class="form-input">${options}</select></div>
            <div class="form-group"><label class="form-label">Amount</label><input name="amount" type="number" min="0" step="100" class="form-input" placeholder="e.g. 250000" required /></div>
            <div class="form-group"><label class="form-label">Note</label><input name="note" type="text" class="form-input" placeholder="Transfer reference or note" /></div>
            <button type="submit" class="btn btn-primary">Submit Payment</button>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">History</h3><p class="card-subtitle">Your submitted payments</p></div></div>
          <div class="card-scroll"><div class="card-scroll-inner" style="min-width: 340px;"><div class="activity-feed">${items}</div></div></div>
        </div>
      </div>
    </main>`,
  });
}

function tenantMaintenancePage(user, db, flash = "") {
  const requests = db.maintenanceRequests
    .filter((request) => request.tenantId === user.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const items = requests.length
    ? requests.map((request) => `<div class="activity-item">
      <div class="activity-icon orange">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </div>
      <div class="activity-content">
        <p class="activity-text"><strong>${escapeHtml(request.title)}</strong></p>
        <p class="activity-text" style="color:var(--text-secondary);">${escapeHtml(request.description)}</p>
        <span class="activity-time">${escapeHtml(request.status)} • ${formatDateTime(request.createdAt)}</span>
      </div>
    </div>`).join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">No maintenance requests yet.</div>`;

  return layoutPage({
    title: "Maintenance - Godstime Lodge",
    activePath: "/tenant/requests",
    user,
    roleLabel: "Tenant Portal",
    navLinks: tenantNavLinks(),
    body: `<main class="main-content">
      ${sectionHeader("Maintenance Requests", "Send issues to management and track the status here.", flash)}
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">New Request</h3><p class="card-subtitle">Tell management what needs attention</p></div></div>
          <form method="post" action="/tenant/requests" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
            <div class="form-group"><label class="form-label">Title</label><input name="title" type="text" class="form-input" placeholder="e.g. Water leak in bathroom" required /></div>
            <div class="form-group"><label class="form-label">Description</label><textarea name="description" class="form-input" rows="4" placeholder="Describe the issue" required></textarea></div>
            <button type="submit" class="btn btn-primary">Send Request</button>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Request History</h3><p class="card-subtitle">Your maintenance tickets</p></div></div>
          <div class="card-scroll"><div class="card-scroll-inner" style="min-width: 340px;"><div class="activity-feed">${items}</div></div></div>
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
      href: "/tenant/bills",
      label: "Bills",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/></svg>',
    },
    {
      href: "/tenant/payments",
      label: "Payments",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
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
  const openBills = bills.filter((bill) => bill.status !== "paid");
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

function adminNavLinks() {
  return [
    {
      href: "/admin/dashboard",
      label: "Dashboard",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    },
    {
      href: "/admin/bills",
      label: "Bills",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="13" y2="15"/></svg>',
    },
    {
      href: "/admin/payments",
      label: "Payments",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    },
    {
      href: "/admin/maintenance",
      label: "Maintenance",
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    },
  ];
}

function adminDashboardView(user, db, flash = "") {
  const totalUnits = 25;
  const tenants = db.users
    .filter((item) => item.role === "tenant")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const activeSessions = db.sessions
    .filter((session) => Date.parse(session.expiresAt) > Date.now())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const occupiedUnits = new Set(tenants.map((tenant) => tenant.unit).filter(Boolean)).size;
  const occupancyRate = percentage(occupiedUnits, totalUnits);
  const bills = db.bills.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const payments = db.payments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const maintenanceRequests = db.maintenanceRequests.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const totalOutstanding = bills.filter((bill) => bill.status !== "paid").reduce((sum, bill) => sum + (Number(bill.amount) || 0), 0);
  const approvedPayments = payments.filter((payment) => payment.status === "approved").reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const recentTenants = tenants.slice(0, 5);
  const recentActivity = [
    ...recentTenants.map((tenant) => ({
      type: "tenant",
      title: `${tenant.fullName || tenant.email} registered`,
      detail: tenant.unit ? `Unit ${tenant.unit}` : "Unit not set yet",
      at: tenant.createdAt,
    })),
    ...activeSessions.slice(0, 5).map((session) => {
      const sessionUser = db.users.find((item) => item.id === session.userId);
      return {
        type: "session",
        title: `${sessionUser ? sessionUser.fullName || sessionUser.email : "User"} signed in`,
        detail: sessionUser && sessionUser.role === "admin" ? "Administrator session" : "Tenant session",
        at: session.createdAt,
      };
    }),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 6);

  const tenantRows = tenants.length
    ? tenants
        .map((tenant) => {
          const isOnline = activeSessions.some((session) => session.userId === tenant.id);
          return `<tr>
            <td style="padding: 0.9rem 0.75rem;"><strong>${escapeHtml(tenant.fullName || "Unnamed tenant")}</strong><br /><span style="color: var(--text-secondary); font-size: 0.85rem;">${escapeHtml(tenant.email)}</span></td>
            <td style="padding: 0.9rem 0.75rem;">${escapeHtml(tenant.unit || "Not assigned")}</td>
            <td style="padding: 0.9rem 0.75rem;">${formatDateOnly(tenant.createdAt)}</td>
            <td style="padding: 0.9rem 0.75rem;"><span style="display:inline-flex; align-items:center; gap:0.45rem; color:${isOnline ? "var(--success)" : "var(--text-secondary)"};"><span style="width:0.55rem; height:0.55rem; border-radius:999px; background:${isOnline ? "var(--success)" : "var(--border)"};"></span>${isOnline ? "Online" : "Offline"}</span></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="4" style="padding: 1rem 0.75rem; color: var(--text-secondary);">No tenants have registered yet.</td></tr>`;

  const activityItems = recentActivity.length
    ? recentActivity
        .map(
          (item) => `<div class="activity-item">
            <div class="activity-icon ${item.type === "tenant" ? "blue" : "green"}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                ${
                  item.type === "tenant"
                    ? '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>'
                    : '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'
                }
              </svg>
            </div>
            <div class="activity-content">
              <p class="activity-text"><strong>${escapeHtml(item.title)}</strong></p>
              <p class="activity-text" style="color: var(--text-secondary);">${escapeHtml(item.detail)}</p>
              <span class="activity-time">${formatDateTime(item.at)}</span>
            </div>
          </div>`
        )
        .join("")
    : `<div style="padding: 1rem; color: var(--text-secondary);">Recent activity will appear here after tenants start using the portal.</div>`;
  const flashBanner = flash
    ? `<div class="alert" style="margin-bottom:1rem; padding:0.9rem 1rem; border:1px solid var(--border); border-radius:16px; background:rgba(34,197,94,0.08); color:var(--text-primary);">${escapeHtml(flash)}</div>`
    : "";
  const billTenantOptions = tenants.length
    ? tenants
        .map((tenant) => `<option value="${escapeHtml(tenant.id)}">${escapeHtml((tenant.fullName || tenant.email) + (tenant.unit ? ` - ${tenant.unit}` : ""))}</option>`)
        .join("")
    : `<option value="">No tenants available</option>`;
  const billTableRows = bills.length
    ? bills
        .slice(0, 8)
        .map((bill) => {
          const tenant = db.users.find((userItem) => userItem.id === bill.tenantId);
          return `<tr>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(bill.title)}</td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(tenant ? tenant.fullName || tenant.email : "Unknown tenant")}</td>
            <td style="padding:0.9rem 0.75rem;">${formatCurrency(bill.amount)}</td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(bill.dueDate || "Not set")}</td>
            <td style="padding:0.9rem 0.75rem; text-transform:capitalize;">${escapeHtml(bill.status)}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" style="padding:1rem 0.75rem; color:var(--text-secondary);">No bills created yet.</td></tr>`;
  const paymentItems = payments.length
    ? payments
        .slice(0, 6)
        .map((payment) => {
          const tenant = db.users.find((item) => item.id === payment.tenantId);
          return `<div class="activity-item">
            <div class="activity-icon green">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            </div>
            <div class="activity-content">
              <p class="activity-text"><strong>${escapeHtml(tenant ? tenant.fullName || tenant.email : "Unknown tenant")}</strong> submitted ${formatCurrency(payment.amount)}</p>
              <p class="activity-text" style="color:var(--text-secondary);">${escapeHtml(payment.note || "No note added")}</p>
              <span class="activity-time">${escapeHtml(payment.status)} • ${formatDateTime(payment.createdAt)}</span>
            </div>
          </div>`;
        })
        .join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">No payments recorded yet.</div>`;
  const requestItems = maintenanceRequests.length
    ? maintenanceRequests
        .slice(0, 6)
        .map((request) => {
          const tenant = db.users.find((item) => item.id === request.tenantId);
          return `<div class="activity-item">
            <div class="activity-icon orange">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </div>
            <div class="activity-content">
              <p class="activity-text"><strong>${escapeHtml(request.title)}</strong> from ${escapeHtml(tenant ? tenant.fullName || tenant.email : "Unknown tenant")}</p>
              <p class="activity-text" style="color:var(--text-secondary);">${escapeHtml(request.description)}</p>
              <span class="activity-time">${escapeHtml(request.status)} • ${formatDateTime(request.createdAt)}</span>
            </div>
          </div>`;
        })
        .join("")
    : `<div style="padding:1rem; color:var(--text-secondary);">No maintenance requests yet.</div>`;

  return htmlPage(
    "Admin Dashboard - Godstime Lodge",
    `<div class="app-container">
      <nav class="top-nav">
        <div class="nav-container">
          <div class="nav-left">
            <a href="/admin/dashboard" class="logo">
              <div class="logo-icon logo-mark">GT</div><div class="logo-text"><div class="logo-name">Godstime Lodge</div><div class="logo-sub">Admin Dashboard</div></div>
            </a>
            <div class="nav-menu">
              <div class="nav-item">
                <a href="/admin/dashboard" class="nav-link active">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                  </svg>
                  Dashboard
                </a>
              </div>
              <div class="nav-item">
                <a href="#tenants" class="nav-link">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="7" r="4"/><path d="M5.5 21a6.5 6.5 0 0 1 13 0"/>
                  </svg>
                  Tenants
                </a>
              </div>
            </div>
          </div>
          <div class="nav-right">
            <div class="theme-toggle">
              <button class="theme-btn theme-btn-snow active" onclick="setTheme('snow')" title="Snow Edition">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              </button>
              <button class="theme-btn theme-btn-carbon" onclick="setTheme('carbon')" title="Carbon Edition">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              </button>
            </div>
            <button class="user-menu">
              <div class="user-avatar">${escapeHtml((user.fullName || "A").slice(0, 1).toUpperCase())}</div>
              <span class="user-name">${escapeHtml(user.fullName || "Admin")}</span>
            </button>
            <a href="/logout" class="btn-logout" title="Logout">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </a>
          </div>
        </div>
      </nav>
      <main class="main-content">
        ${flashBanner}
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
            <div class="stat-change positive">${bills.filter((bill) => bill.status !== "paid").length} unpaid bills</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Approved Payments</div>
            <div class="stat-value">${formatCurrency(approvedPayments)}</div>
            <div class="stat-change">${payments.length} payment records submitted</div>
          </div>
        </div>

        <div class="card" style="margin-top: 1.5rem;">
          <div class="card-header">
            <div>
              <h3 class="card-title">Open Pages</h3>
              <p class="card-subtitle">Go directly to the management screen you need</p>
            </div>
          </div>
          <div style="padding: 1rem 1.25rem; display:flex; gap:0.75rem; flex-wrap:wrap;">
            <a class="btn btn-secondary" href="/admin/bills">Bills</a>
            <a class="btn btn-secondary" href="/admin/payments">Payments</a>
            <a class="btn btn-secondary" href="/admin/maintenance">Maintenance</a>
          </div>
        </div>

        <div class="two-col">
          <div class="card" id="tenants">
            <div class="card-header">
              <div>
                <h3 class="card-title">Tenant Directory</h3>
                <p class="card-subtitle">Live tenant records from the registration system</p>
              </div>
            </div>
            <div class="card-scroll">
              <div class="card-scroll-inner" style="min-width: 700px;">
                <table style="width: 100%; border-collapse: collapse;">
                  <thead>
                    <tr style="text-align: left; color: var(--text-secondary); border-bottom: 1px solid var(--border);">
                      <th style="padding: 0.9rem 0.75rem;">Tenant</th>
                      <th style="padding: 0.9rem 0.75rem;">Unit</th>
                      <th style="padding: 0.9rem 0.75rem;">Joined</th>
                      <th style="padding: 0.9rem 0.75rem;">Status</th>
                    </tr>
                  </thead>
                  <tbody>${tenantRows}</tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Create New Bill</h3>
                <p class="card-subtitle">Assign a charge to a tenant account</p>
              </div>
            </div>
            <form method="post" action="/admin/bills" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
              <div class="form-group">
                <label class="form-label">Tenant</label>
                <select name="tenant_id" class="form-input">${billTenantOptions}</select>
              </div>
              <div class="form-group">
                <label class="form-label">Bill Title</label>
                <input name="title" type="text" class="form-input" placeholder="e.g. April Rent" required />
              </div>
              <div class="form-group">
                <label class="form-label">Amount</label>
                <input name="amount" type="number" min="0" step="100" class="form-input" placeholder="e.g. 250000" required />
              </div>
              <div class="form-group">
                <label class="form-label">Due Date</label>
                <input name="due_date" type="date" class="form-input" required />
              </div>
              <button type="submit" class="btn btn-primary">Create Bill</button>
            </form>
          </div>
        </div>

        <div class="two-col" style="margin-top: 1.5rem;">
          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Recent Bills</h3>
                <p class="card-subtitle">Latest charges across all tenants</p>
              </div>
            </div>
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
                  <tbody>${billTableRows}</tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Recent Activity</h3>
                <p class="card-subtitle">Latest registrations and sign-ins</p>
              </div>
            </div>
            <div class="card-scroll">
              <div class="card-scroll-inner" style="min-width: 340px;">
                <div class="activity-feed">${activityItems}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="two-col" style="margin-top: 1.5rem;">
          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Payment Queue</h3>
                <p class="card-subtitle">Submitted tenant payments</p>
              </div>
            </div>
            <div class="card-scroll">
              <div class="card-scroll-inner" style="min-width: 340px;">
                <div class="activity-feed">${paymentItems}</div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Maintenance Queue</h3>
                <p class="card-subtitle">Incoming tenant requests</p>
              </div>
            </div>
            <div class="card-scroll">
              <div class="card-scroll-inner" style="min-width: 340px;">
                <div class="activity-feed">${requestItems}</div>
              </div>
            </div>
          </div>
        </div>
      </main>
      <footer class="footer"><p>&copy; 2026 Sbiam Solutions. All rights reserved.</p></footer>
    </div>`
  );
}

function adminBillsPage(user, db, flash = "") {
  const tenants = db.users.filter((item) => item.role === "tenant");
  const bills = db.bills.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
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
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(bill.dueDate || "Not set")}</td>
            <td style="padding:0.9rem 0.75rem; text-transform:capitalize;">${escapeHtml(bill.status)}</td>
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
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Create Bill</h3><p class="card-subtitle">Assign a charge to a tenant</p></div></div>
          <form method="post" action="/admin/bills" style="padding:1rem 1.25rem; display:grid; gap:0.85rem;">
            <div class="form-group"><label class="form-label">Tenant</label><select name="tenant_id" class="form-input">${billTenantOptions}</select></div>
            <div class="form-group"><label class="form-label">Bill Title</label><input name="title" type="text" class="form-input" placeholder="e.g. April Rent" required /></div>
            <div class="form-group"><label class="form-label">Amount</label><input name="amount" type="number" min="0" step="100" class="form-input" placeholder="e.g. 250000" required /></div>
            <div class="form-group"><label class="form-label">Due Date</label><input name="due_date" type="date" class="form-input" required /></div>
            <button type="submit" class="btn btn-primary">Create Bill</button>
          </form>
        </div>
        <div class="card">
          <div class="card-header"><div><h3 class="card-title">Bill Stats</h3><p class="card-subtitle">Quick overview</p></div></div>
          <div style="padding:1rem 1.25rem; display:grid; gap:1rem;">
            <div><strong>Total Bills:</strong> ${bills.length}</div>
            <div><strong>Unpaid Bills:</strong> ${bills.filter((bill) => bill.status !== "paid").length}</div>
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

function adminPaymentsPage(user, db, flash = "") {
  const payments = db.payments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const rows = payments.length
    ? payments
        .map((payment) => {
          const tenant = db.users.find((item) => item.id === payment.tenantId);
          const bill = db.bills.find((item) => item.id === payment.billId);
          return `<tr>
            <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(tenant ? tenant.fullName || tenant.email : "Unknown tenant")}</strong></td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(bill ? bill.title : "No bill linked")}</td>
            <td style="padding:0.9rem 0.75rem;">${formatCurrency(payment.amount)}</td>
            <td style="padding:0.9rem 0.75rem; text-transform:capitalize;">${escapeHtml(payment.status)}</td>
            <td style="padding:0.9rem 0.75rem;">
              <form method="post" action="/admin/payments/status" style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                <input type="hidden" name="payment_id" value="${escapeHtml(payment.id)}" />
                <button class="btn btn-primary" type="submit" name="status" value="approved">Approve</button>
                <button class="btn btn-secondary" type="submit" name="status" value="rejected">Reject</button>
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

function adminMaintenancePage(user, db, flash = "") {
  const requests = db.maintenanceRequests.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const rows = requests.length
    ? requests
        .map((request) => {
          const tenant = db.users.find((item) => item.id === request.tenantId);
          return `<tr>
            <td style="padding:0.9rem 0.75rem;"><strong>${escapeHtml(tenant ? tenant.fullName || tenant.email : "Unknown tenant")}</strong></td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(request.title)}</td>
            <td style="padding:0.9rem 0.75rem;">${escapeHtml(request.description)}</td>
            <td style="padding:0.9rem 0.75rem; text-transform:capitalize;">${escapeHtml(request.status)}</td>
            <td style="padding:0.9rem 0.75rem;">
              <form method="post" action="/admin/maintenance/status" style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                <input type="hidden" name="request_id" value="${escapeHtml(request.id)}" />
                <button class="btn btn-primary" type="submit" name="status" value="in-progress">In Progress</button>
                <button class="btn btn-secondary" type="submit" name="status" value="resolved">Resolve</button>
              </form>
            </td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="5" style="padding:1rem 0.75rem; color:var(--text-secondary);">No maintenance requests yet.</td></tr>`;

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
        <div class="stat-card"><div class="stat-label">Open</div><div class="stat-value">${requests.filter((request) => request.status === "open").length}</div><div class="stat-change positive">Waiting to be handled</div></div>
        <div class="stat-card"><div class="stat-label">In Progress</div><div class="stat-value">${requests.filter((request) => request.status === "in-progress").length}</div><div class="stat-change positive">Being worked on</div></div>
        <div class="stat-card"><div class="stat-label">Resolved</div><div class="stat-value">${requests.filter((request) => request.status === "resolved").length}</div><div class="stat-change positive">Closed tickets</div></div>
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = (req.method || "GET").toUpperCase();

    applySecurityHeaders(res);

    if (serveStatic(res, pathname)) return;

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
      const hash = pbkdf2Hash(password, user.saltHex);
      if (hash !== user.passwordHash) return send(res, 401, loginView("Invalid email or password."));

      const session = persistSession(user.id);
      res.setHeader("Set-Cookie", buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)));
      return redirect(res, "/");
    }

    if (pathname === "/register") {
      if (method === "GET") return send(res, 200, registerView());
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      if (!isFormRequest(req)) return send(res, 415, registerView("Unsupported form submission."));
      const body = await readBody(req);
      const form = parseForm(body);
      const fullName = String(form.full_name || "").trim();
      const unit = String(form.unit || "").trim();
      const email = String(form.email || "").trim().toLowerCase();
      const password = String(form.password || "");
      if (!fullName || !email || !password) return send(res, 400, registerView("Please fill all required fields."));
      if (password.length < 6) return send(res, 400, registerView("Password must be at least 6 characters."));

      const db = loadDb();
      if (db.users.some((u) => u.email === email)) return send(res, 400, registerView("This email is already registered."));
      const tenant = createUser({ email, password, role: "tenant", fullName, unit });
      db.users.push(tenant);
      saveDb(db);

      const session = persistSession(tenant.id);
      res.setHeader("Set-Cookie", buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)));
      return redirect(res, "/tenant/dashboard");
    }

    if (pathname === "/logout") {
      if (method !== "GET" && method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      const cookies = parseCookies(req);
      const sid = cookies.gtl_session;
      destroySession(sid);
      res.setHeader("Set-Cookie", buildSessionCookie("", 0));
      return redirect(res, "/login");
    }

    if (pathname === "/tenant/dashboard") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, tenantDashboardView(user, db, String(url.searchParams.get("message") || "")));
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
      if (!isFormRequest(req)) return redirectWithMessage(res, "/tenant/payments", "Unsupported payment submission.");
      const body = await readBody(req);
      const form = parseForm(body);
      const amount = Number(form.amount || 0);
      if (amount <= 0) return redirectWithMessage(res, "/tenant/payments", "Enter a valid payment amount.");
      const db = loadDb();
      db.payments.push(createPayment({ tenantId: user.id, billId: form.bill_id, amount, note: form.note }));
      saveDb(db);
      return redirectWithMessage(res, "/tenant/payments", "Payment submitted successfully.");
    }

    if (pathname === "/tenant/requests") {
      const user = requireRole(req, res, "tenant");
      if (!user) return;
      if (method === "GET") {
        const db = loadDb();
        return send(res, 200, tenantMaintenancePage(user, db, String(url.searchParams.get("message") || "")));
      }
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/tenant/requests", "Unsupported request submission.");
      const body = await readBody(req);
      const form = parseForm(body);
      if (!String(form.title || "").trim() || !String(form.description || "").trim()) {
        return redirectWithMessage(res, "/tenant/requests", "Please add a title and description for the maintenance request.");
      }
      const db = loadDb();
      db.maintenanceRequests.push(createMaintenanceRequest({ tenantId: user.id, title: form.title, description: form.description }));
      saveDb(db);
      return redirectWithMessage(res, "/tenant/requests", "Maintenance request sent.");
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

    if (pathname === "/admin/bills") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      if (method === "GET") {
        return send(res, 200, adminBillsPage(user, db, String(url.searchParams.get("message") || "")));
      }
      if (method !== "POST") return sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      if (!isFormRequest(req)) return redirectWithMessage(res, "/admin/bills", "Unsupported bill submission.");
      const body = await readBody(req);
      const form = parseForm(body);
      const amount = Number(form.amount || 0);
      const tenantId = String(form.tenant_id || "");
      const title = String(form.title || "").trim();
      const dueDate = String(form.due_date || "").trim();
      if (!db.users.some((item) => item.id === tenantId && item.role === "tenant")) {
        return redirectWithMessage(res, "/admin/bills", "Select a valid tenant before creating a bill.");
      }
      if (!title || amount <= 0 || !dueDate) {
        return redirectWithMessage(res, "/admin/bills", "Please fill all bill fields correctly.");
      }
      db.bills.push(createBill({ tenantId, title, amount, dueDate }));
      saveDb(db);
      return redirectWithMessage(res, "/admin/bills", "Bill created successfully.");
    }

    if (pathname === "/admin/payments") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      if (method === "GET") {
        return send(res, 200, adminPaymentsPage(user, db, String(url.searchParams.get("message") || "")));
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
      const payment = db.payments.find((item) => item.id === String(form.payment_id || ""));
      if (!payment) return redirectWithMessage(res, "/admin/payments", "Payment not found.");
      const nextStatus = String(form.status || "").trim();
      if (!["approved", "rejected"].includes(nextStatus)) {
        return redirectWithMessage(res, "/admin/payments", "Choose a valid payment status.");
      }
      payment.status = nextStatus;
      if (nextStatus === "approved") {
        const bill = db.bills.find((item) => item.id === payment.billId);
        if (bill) bill.status = "paid";
      }
      saveDb(db);
      return redirectWithMessage(res, "/admin/payments", "Payment status updated.");
    }

    if (pathname === "/admin/maintenance") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      if (method === "GET") {
        return send(res, 200, adminMaintenancePage(user, db, String(url.searchParams.get("message") || "")));
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
      const request = db.maintenanceRequests.find((item) => item.id === String(form.request_id || ""));
      if (!request) return redirectWithMessage(res, "/admin/maintenance", "Request not found.");
      const nextStatus = String(form.status || "").trim();
      if (!["open", "in-progress", "resolved"].includes(nextStatus)) {
        return redirectWithMessage(res, "/admin/maintenance", "Choose a valid maintenance status.");
      }
      request.status = nextStatus;
      saveDb(db);
      return redirectWithMessage(res, "/admin/maintenance", "Maintenance status updated.");
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
