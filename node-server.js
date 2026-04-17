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

function normalizeDb(db) {
  return {
    users: Array.isArray(db && db.users) ? db.users : [],
    sessions: Array.isArray(db && db.sessions) ? db.sessions : [],
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
    const db = { users: [admin], sessions: [] };
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

function tenantDashboardView(user) {
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
        <div class="page-header">
          <h1 class="greeting">Welcome, ${escapeHtml(user.fullName)}</h1>
          <p class="greeting-sub">Unit: <strong>${escapeHtml(user.unit || "")}</strong></p>
        </div>
        <div class="card">
          <div class="card-header">
            <div>
              <h3 class="card-title">Your Dashboard</h3>
              <p class="card-subtitle">This is a backend-protected tenant page.</p>
            </div>
          </div>
          <div style="padding: 1rem; color: var(--text-secondary);">
            Next: we will connect real bills, payments, and requests to this account.
          </div>
        </div>
      </main>
      <footer class="footer"><p>&copy; 2026 Sbiam Solutions. All rights reserved.</p></footer>
    </div>`
  );
}

function adminDashboardView(user, db) {
  const totalUnits = 25;
  const tenants = db.users
    .filter((item) => item.role === "tenant")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const activeSessions = db.sessions
    .filter((session) => Date.parse(session.expiresAt) > Date.now())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const occupiedUnits = new Set(tenants.map((tenant) => tenant.unit).filter(Boolean)).size;
  const occupancyRate = percentage(occupiedUnits, totalUnits);
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
            <div class="stat-label">Active Sessions</div>
            <div class="stat-value">${activeSessions.length}</div>
            <div class="stat-change positive">Users currently signed in</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Available Units</div>
            <div class="stat-value">${Math.max(totalUnits - occupiedUnits, 0)}</div>
            <div class="stat-change">${Math.max(totalUnits - occupiedUnits, 0)} units still open</div>
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
                <h3 class="card-title">Admin Summary</h3>
                <p class="card-subtitle">A quick operational view of the lodge</p>
              </div>
            </div>
            <div style="padding: 1rem 1.25rem; display: grid; gap: 1rem;">
              <div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                  <span>Occupancy progress</span>
                  <strong>${occupancyRate}%</strong>
                </div>
                <div class="progress-bar"><div class="progress-fill success" style="width: ${occupancyRate}%;"></div></div>
              </div>
              <div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                  <span>Tenant account coverage</span>
                  <strong>${percentage(tenants.length, totalUnits)}%</strong>
                </div>
                <div class="progress-bar"><div class="progress-fill accent" style="width: ${percentage(tenants.length, totalUnits)}%;"></div></div>
              </div>
              <div>
                <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem;">
                  <span>Users currently active</span>
                  <strong>${percentage(activeSessions.length, Math.max(db.users.length, 1))}%</strong>
                </div>
                <div class="progress-bar"><div class="progress-fill warning" style="width: ${percentage(activeSessions.length, Math.max(db.users.length, 1))}%;"></div></div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-header">
              <div>
                <h3 class="card-title">Next Steps</h3>
                <p class="card-subtitle">Suggested admin actions</p>
              </div>
            </div>
            <div style="padding: 1rem 1.25rem; color: var(--text-secondary); display:grid; gap:0.85rem;">
              <div>Ask new tenants to register so they appear automatically in this dashboard.</div>
              <div>Assign unit numbers during registration to improve occupancy reporting.</div>
              <div>The next feature we can add is bill tracking, payment records, and maintenance requests for each tenant.</div>
            </div>
          </div>
        </div>
      </main>
      <footer class="footer"><p>&copy; 2026 Sbiam Solutions. All rights reserved.</p></footer>
    </div>`
  );
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
      return send(res, 200, tenantDashboardView(user));
    }

    if (pathname === "/admin/dashboard") {
      const user = requireRole(req, res, "admin");
      if (!user) return;
      const db = loadDb();
      return send(res, 200, adminDashboardView(user, db));
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
