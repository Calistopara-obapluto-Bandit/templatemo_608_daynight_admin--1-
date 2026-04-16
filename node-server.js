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
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";
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
    const db = { users: [admin] };
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function saveDb(db) {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

const sessions = new Map(); // sessionId -> userId

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
  const userId = sessions.get(sid);
  if (!userId) return null;
  const db = loadDb();
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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(body);
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
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
    "Login - God's Time Lodge",
    `<div class="login-page">
      <div class="login-container">
        <div class="login-card">
          <div class="login-header">
            <div class="login-logo">
              <div class="logo-icon logo-mark">GT</div>
              <div class="logo-text">
                <div class="logo-name">God's Time Lodge</div>
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
    "Create Tenant Account - God's Time Lodge",
    `<div class="login-page">
      <div class="login-container">
        <div class="login-card">
          <div class="login-header">
            <div class="login-logo">
              <div class="logo-icon logo-mark">GT</div>
              <div class="logo-text">
                <div class="logo-name">God's Time Lodge</div>
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
    "Tenant Dashboard - God's Time Lodge",
    `<div class="app-container">
      <nav class="top-nav">
        <div class="nav-container">
          <div class="nav-left">
            <a href="/tenant/dashboard" class="logo">
              <div class="logo-icon logo-mark">GT</div><div class="logo-text"><div class="logo-name">God's Time Lodge</div><div class="logo-sub">Tenant Billing</div></div>
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
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = (req.method || "GET").toUpperCase();

  if (serveStatic(res, pathname)) return;

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
    const body = await readBody(req);
    const form = parseForm(body);
    const email = String(form.email || "").trim().toLowerCase();
    const password = String(form.password || "");
    const db = loadDb();
    const user = db.users.find((u) => u.email === email);
    if (!user) return send(res, 401, loginView("Invalid email or password."));
    const hash = pbkdf2Hash(password, user.saltHex);
    if (hash !== user.passwordHash) return send(res, 401, loginView("Invalid email or password."));

    const sid = randomId(18);
    sessions.set(sid, user.id);
    res.setHeader("Set-Cookie", buildSessionCookie(sid));
    return redirect(res, "/");
  }

  if (pathname === "/register") {
    if (method === "GET") return send(res, 200, registerView());
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

    const sid = randomId(18);
    sessions.set(sid, tenant.id);
    res.setHeader("Set-Cookie", buildSessionCookie(sid));
    return redirect(res, "/tenant/dashboard");
  }

  if (pathname === "/logout") {
    const cookies = parseCookies(req);
    const sid = cookies.gtl_session;
    if (sid) sessions.delete(sid);
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
    const adminFile = path.join(PUBLIC_DIR, "admin-dashboard.html");
    if (fs.existsSync(adminFile)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(adminFile).pipe(res);
    }
    return sendText(res, 500, "Admin dashboard not found.");
  }

  sendText(res, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log("Tenant register: /register");
  console.log("Tenant dashboard: /tenant/dashboard");
  console.log("Admin tenants: /admin/tenants");
  console.log(`Admin login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
>>>>>>> 6a71238 (Prepare app for Render deployment)
});
