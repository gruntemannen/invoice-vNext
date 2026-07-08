/* =========================================================================
   Invoice Admin — static PWA admin console (vanilla JS, no build step)
   Views: Dashboard (GET /stats), Audit (GET /invoices), Upload (POST /upload).
   Auth: Cognito Hosted UI implicit or authorization-code + PKCE flow; id_token
         in browser storage; Bearer header on every API call; 401/403 -> re-login.
   ========================================================================= */

"use strict";

/* --------------------------- Global state ------------------------------ */
const state = {
  cfg: null,
  apiBaseUrl: "",
  maxUploadBytes: 0,
  cognito: null,
  idToken: null,
  userEmail: null,
  // audit
  invoices: [],
  nextToken: undefined,
  statusFilter: "ALL",
  searchTerm: "",
  loadingMore: false,
  // detail drawer
  currentDetail: null,
  // configuration
  netSuiteSettings: null,
  netSuiteSettingsLoaded: false,
};

const TOKEN_KEY = "invoice_admin_id_token";
const PKCE_VERIFIER_KEY = "invoice_admin_pkce_verifier";
const OAUTH_STATE_KEY = "invoice_admin_oauth_state";
const OAUTH_EXPECTED_EMAIL_KEY = "invoice_admin_oauth_expected_email";

/* ----------------------------- DOM refs -------------------------------- */
const $ = (id) => document.getElementById(id);
const bootGate = $("boot-gate");
const bootText = $("boot-text");
const appShell = $("app-shell");

/* ========================================================================
   AUTH
   ===================================================================== */

function base64UrlDecode(str) {
  // JWT uses base64url; pad and convert to standard base64.
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const decoded = atob(s);
  // Handle UTF-8 payloads.
  try {
    return decodeURIComponent(
      decoded
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
  } catch {
    return decoded;
  }
}

function base64UrlEncodeBytes(bytes) {
  const chars = Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join("");
  return btoa(chars).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
}

function isTokenValid(token) {
  const payload = decodeJwt(token);
  if (!payload || typeof payload.exp !== "number") return false;
  // exp is in seconds; allow a 30s clock-skew margin.
  return payload.exp * 1000 > Date.now() + 30_000;
}

function clearStoredAuth() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  [PKCE_VERIFIER_KEY, OAUTH_STATE_KEY, OAUTH_EXPECTED_EMAIL_KEY].forEach(removeAuthTransactionItem);
}

function setAuthTransactionItem(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* ignore */ }
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function getAuthTransactionItem(key) {
  try {
    const value = sessionStorage.getItem(key);
    if (value) return value;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeAuthTransactionItem(key) {
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function authResponseType() {
  return (state.cognito?.responseType || "token").toLowerCase() === "code" ? "code" : "token";
}

function hostedUiDomain() {
  return String(state.cognito?.domain || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

function getLoginHint() {
  const params = new URLSearchParams(window.location.search || "");
  return (params.get("login_hint") || "").trim();
}

function randomOAuthString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

async function pkceChallenge(verifier) {
  const bytes = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncodeBytes(digest);
}

/** Pull an id_token out of the URL hash (implicit flow callback). */
function readTokenFromHash() {
  if (!window.location.hash || window.location.hash.length < 2) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("id_token");
  if (token) {
    // Clean the hash so the token isn't left in the address bar / history.
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return token;
}

function readCodeFromQuery() {
  if (!window.location.search || window.location.search.length < 2) return null;
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  const errorDescription = params.get("error_description");
  const code = params.get("code");
  const oauthState = params.get("state");
  if (!error && !code) return null;

  ["code", "state", "error", "error_description", "sso", "login_hint"].forEach((name) => params.delete(name));
  const cleanQuery = params.toString();
  history.replaceState(null, "", `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}`);

  if (error) throw new Error(errorDescription || error);
  return { code, state: oauthState };
}

async function exchangeCodeForToken(code, oauthState) {
  const c = state.cognito;
  const expectedState = getAuthTransactionItem(OAUTH_STATE_KEY);
  const verifier = getAuthTransactionItem(PKCE_VERIFIER_KEY);
  const expectedEmail = getAuthTransactionItem(OAUTH_EXPECTED_EMAIL_KEY);
  removeAuthTransactionItem(OAUTH_STATE_KEY);
  removeAuthTransactionItem(PKCE_VERIFIER_KEY);
  removeAuthTransactionItem(OAUTH_EXPECTED_EMAIL_KEY);
  if (!expectedState || oauthState !== expectedState) {
    throw new Error("OAuth state mismatch");
  }
  if (!verifier) {
    throw new Error("PKCE verifier missing");
  }

  const tokenEndpoint = c.tokenEndpoint || `https://${hostedUiDomain()}/oauth2/token`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: c.clientId,
    code,
    redirect_uri: c.redirectUri,
    code_verifier: verifier,
  });

  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    throw new Error(data.error_description || data.error || `Token exchange failed (${res.status})`);
  }

  if (expectedEmail) {
    const payload = decodeJwt(data.id_token) || {};
    const actualEmail = String(payload.email || "").toLowerCase();
    if (actualEmail !== expectedEmail.toLowerCase()) {
      throw new Error(`Signed in as ${actualEmail || "another account"}, expected ${expectedEmail}. Please sign out and try again.`);
    }
  }
  return data.id_token;
}

async function buildLoginUrl() {
  const c = state.cognito;
  const responseType = authResponseType();
  const loginHint = getLoginHint();
  const qs = new URLSearchParams({
    client_id: c.clientId,
    response_type: responseType,
    scope: c.scope || "openid email profile",
    redirect_uri: c.redirectUri,
  });

  if (responseType === "code") {
    const verifier = randomOAuthString();
    const oauthState = randomOAuthString();
    setAuthTransactionItem(PKCE_VERIFIER_KEY, verifier);
    setAuthTransactionItem(OAUTH_STATE_KEY, oauthState);
    if (loginHint) setAuthTransactionItem(OAUTH_EXPECTED_EMAIL_KEY, loginHint.toLowerCase());
    else removeAuthTransactionItem(OAUTH_EXPECTED_EMAIL_KEY);
    qs.set("code_challenge", await pkceChallenge(verifier));
    qs.set("code_challenge_method", "S256");
    qs.set("state", oauthState);
  }
  if (loginHint) qs.set("login_hint", loginHint);

  return `https://${hostedUiDomain()}/login?${qs.toString()}`;
}

function buildLogoutUrl() {
  const c = state.cognito;
  const qs = new URLSearchParams({
    client_id: c.clientId,
    logout_uri: c.logoutUri || c.redirectUri,
  });
  return `https://${hostedUiDomain()}/logout?${qs.toString()}`;
}

async function redirectToLogin() {
  bootText.textContent = "Redirecting to sign in…";
  showBootGate();
  window.location.assign(await buildLoginUrl());
}

function logout() {
  clearStoredAuth();
  state.idToken = null;
  window.location.assign(buildLogoutUrl());
}

/** Resolve auth on boot. Returns true if we have a valid token. */
async function resolveAuth() {
  // 1) hash (fresh login callback)
  let token = readTokenFromHash();
  // 2) authorization code + PKCE callback
  if (!token) {
    const callback = readCodeFromQuery();
    if (callback?.code) token = await exchangeCodeForToken(callback.code, callback.state);
  }
  // 3) sessionStorage
  if (!token) {
    try {
      token = sessionStorage.getItem(TOKEN_KEY);
    } catch {
      token = null;
    }
  }

  if (token && isTokenValid(token)) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* ignore */
    }
    state.idToken = token;
    const payload = decodeJwt(token) || {};
    state.userEmail = payload.email || payload["cognito:username"] || payload.sub || "Signed in";
    return true;
  }

  // No valid token.
  clearStoredAuth();
  state.idToken = null;
  return false;
}

/* ========================================================================
   API HELPER — attaches Bearer token, handles 401/403
   ===================================================================== */

async function apiFetch(path, options = {}) {
  const url = path.startsWith("http") ? path : `${state.apiBaseUrl}${path}`;
  const headers = Object.assign({}, options.headers || {});
  if (state.idToken) headers["Authorization"] = `Bearer ${state.idToken}`;

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401 || res.status === 403) {
    // Token rejected/expired -> clear and re-login.
    clearStoredAuth();
    state.idToken = null;
    void redirectToLogin();
    // Throw so callers stop processing; redirect is already underway.
    throw new Error("Unauthorized");
  }
  return res;
}

/* ========================================================================
   FORMATTERS
   ===================================================================== */

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDay(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (isNaN(d)) return "—";
  const diff = Date.now() - d;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function fmtAmount(amount, currency) {
  if (typeof amount !== "number" || isNaN(amount)) return "—";
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
    } catch {
      /* fall through for non-ISO currency codes */
    }
  }
  return `${currency ? currency + " " : ""}${amount.toFixed(2)}`;
}

function fmtPct(value) {
  if (typeof value !== "number" || isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

function confidenceClass(c) {
  if (typeof c !== "number") return "low";
  if (c >= 0.8) return "good";
  if (c >= 0.5) return "medium";
  return "low";
}

function statusClass(status) {
  switch (status) {
    case "COMPLETED":
      return "ok";
    case "FAILED":
      return "fail";
    case "PENDING":
      return "pending";
    default:
      return "pending";
  }
}

function reviewClass(status) {
  switch (status) {
    case "READY_FOR_NETSUITE":
      return "ok";
    case "NEEDS_REVIEW":
      return "pending";
    default:
      return "pending";
  }
}

function fmtReviewStatus(status) {
  switch (status) {
    case "READY_FOR_NETSUITE":
      return "Ready";
    case "NEEDS_REVIEW":
      return "Review";
    default:
      return "—";
  }
}

function renderControlFlags(flags) {
  if (!Array.isArray(flags) || flags.length === 0) return "—";
  const visibleFlags = flags.filter((flag) => {
    const text = String(flag?.message || flag?.code || "");
    return !text.includes("sanitized_purchase_order_number");
  });
  if (visibleFlags.length === 0) return "—";
  return `<div class="flag-stack">${visibleFlags
    .slice(0, 5)
    .map((flag) => {
      const severity = ["info", "warning", "blocker"].includes(flag.severity) ? flag.severity : "info";
      return `<span class="flag ${severity}">${escapeHtml(flag.message || flag.code || "Review required")}</span>`;
    })
    .join("")}</div>`;
}

function renderVatValidation(d) {
  const validation = d.vendorVatValidation ?? d.extractedJson?.vendor?.vatValidation;
  const taxId = d.vendorTaxId ?? d.extractedJson?.vendor?.taxId;
  if (!validation && !taxId) return "—";
  if (!validation) return escapeHtml(taxId);

  const status = validation.status || (validation.valid ? "VALID" : "—");
  const cls = status === "VALID" ? "ok" : status === "INVALID" ? "fail" : "pending";
  const number = validation.normalizedVat || taxId || "";
  const provider = validation.provider === "CH_UID" ? "Swiss UID" : validation.provider === "EU_VIES" ? "VIES" : "";
  const match = validation.matches?.traderName === "INVALID" ? " name mismatch" : "";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span> ${escapeHtml(provider ? provider + " " : "")}${escapeHtml(number)}${escapeHtml(match)}`;
}

function duplicateReview(d) {
  return d.duplicateReview ?? d.extractedJson?.meta?.duplicateReview ?? null;
}

function duplicateCount(d) {
  return d.duplicateCount ?? d.extractedJson?.meta?.duplicateCount ?? 0;
}

function duplicateMatches(d) {
  const matches = d.duplicateMatches ?? d.extractedJson?.meta?.duplicateMatches ?? [];
  return Array.isArray(matches) ? matches : [];
}

function renderDuplicateDecision(d) {
  if (duplicateCount(d) <= 0) return "—";
  const review = duplicateReview(d);
  if (review?.action === "ALLOW_NETSUITE") {
    return `<span class="badge ok">Allow NetSuite</span>`;
  }
  return `<span class="badge pending">Hold for review</span>`;
}

function renderDuplicateReviewPanel(d) {
  const panel = $("duplicate-review-panel");
  if (!panel) return;

  const count = duplicateCount(d);
  if (d.status !== "COMPLETED" || count <= 0) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }

  const review = duplicateReview(d);
  const action = review?.action === "ALLOW_NETSUITE" ? "ALLOW_NETSUITE" : "HOLD_FOR_REVIEW";
  const matches = duplicateMatches(d).slice(0, 3);
  const reviewed = review?.reviewedAt
    ? `Reviewed ${escapeHtml(fmtDate(review.reviewedAt))}${
        review.reviewedBy ? ` by ${escapeHtml(review.reviewedBy)}` : ""
      }`
    : "No admin decision recorded";

  panel.innerHTML = `
    <div class="duplicate-review-head">
      <div>
        <div class="panel-title">Duplicate handling</div>
        <div class="duplicate-review-status">
          ${escapeHtml(count)} possible duplicate${count === 1 ? "" : "s"} - ${reviewed}
        </div>
      </div>
      <div class="segmented" role="group" aria-label="Duplicate invoice handling">
        <button type="button" class="${action === "HOLD_FOR_REVIEW" ? "active" : ""}"
          data-duplicate-action="HOLD_FOR_REVIEW">Hold for review</button>
        <button type="button" class="${action === "ALLOW_NETSUITE" ? "active" : ""}"
          data-duplicate-action="ALLOW_NETSUITE">Allow NetSuite</button>
      </div>
    </div>
    ${
      matches.length
        ? `<div class="duplicate-match-list">${matches
            .map(
              (m) => `
                <div class="duplicate-match">
                  <span>${escapeHtml(m.invoiceNumber || "Invoice")}</span>
                  <span>${escapeHtml(m.vendorName || "Unknown vendor")}</span>
                  <span>${escapeHtml(fmtAmount(m.totalAmount, m.currency))}</span>
                  <span>${escapeHtml(fmtDate(m.receivedAt))}</span>
                </div>`
            )
            .join("")}</div>`
        : ""
    }
    <div class="duplicate-review-message" aria-live="polite"></div>
  `;
  panel.classList.remove("hidden");

  panel.querySelectorAll("[data-duplicate-action]").forEach((button) => {
    button.addEventListener("click", () => saveDuplicateReview(button.dataset.duplicateAction));
  });
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/* ========================================================================
   TOASTS
   ===================================================================== */

function toast(message, kind = "info") {
  const host = $("toast-host");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

/* ========================================================================
   NAVIGATION
   ===================================================================== */

const VIEW_TITLES = { dashboard: "Dashboard", audit: "Audit", upload: "Upload", config: "Configuration" };

function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $(`view-${view}`).classList.remove("hidden");

  document.querySelectorAll(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  $("view-title").textContent = VIEW_TITLES[view] || "Dashboard";
  document.body.classList.remove("nav-open");

  if (view === "dashboard") loadStats();
  if (view === "audit" && state.invoices.length === 0) loadInvoices(true);
  if (view === "config" && !state.netSuiteSettingsLoaded) loadNetSuiteSettings();
}

/* ========================================================================
   DASHBOARD
   ===================================================================== */

const KPI_DEFS = [
  { key: "total", label: "Total ingested", tone: "blue" },
  { key: "successRate", label: "Success rate", tone: "green", pct: true },
  { key: "completed", label: "Completed", tone: "green" },
  { key: "failed", label: "Failed", tone: "red" },
  { key: "pending", label: "Pending", tone: "amber" },
  { key: "avgConfidence", label: "Avg confidence", tone: "violet", pct: true },
];

async function loadStats() {
  const errBox = $("dash-error");
  errBox.classList.add("hidden");
  renderKpis(null); // skeleton

  try {
    const res = await apiFetch("/stats");
    if (!res.ok) throw new Error(`Stats request failed (${res.status})`);
    const stats = await res.json();
    renderDashboard(stats);
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    errBox.textContent = "Could not load dashboard stats. Showing last known state.";
    errBox.classList.remove("hidden");
    renderKpis({}); // render zeros rather than a blank page
  }
}

function renderDashboard(stats) {
  const totals = stats.totals || {};
  renderKpis({
    total: totals.all ?? 0,
    completed: totals.completed ?? 0,
    failed: totals.failed ?? 0,
    pending: totals.pending ?? 0,
    successRate: stats.successRate ?? 0,
    avgConfidence: stats.avgConfidence ?? 0,
  });
  renderTrend(Array.isArray(stats.byDay) ? stats.byDay : []);
  renderRecentFailures(Array.isArray(stats.recentFailures) ? stats.recentFailures : []);
}

function renderKpis(data) {
  const grid = $("kpi-grid");
  grid.innerHTML = "";
  KPI_DEFS.forEach((def) => {
    const card = document.createElement("div");
    card.className = `kpi ${def.tone}`;
    let valueHtml;
    if (data == null) {
      valueHtml = `<span class="kpi-skel"></span>`;
    } else {
      const raw = data[def.key];
      const val = def.pct ? fmtPct(raw) : Number(raw ?? 0).toLocaleString();
      valueHtml = escapeHtml(val);
    }
    card.innerHTML = `
      <div class="kpi-label">${escapeHtml(def.label)}</div>
      <div class="kpi-value">${valueHtml}</div>
    `;
    grid.appendChild(card);
  });
}

/** Inline-SVG grouped bar chart: ingested / completed / failed per day. */
function renderTrend(byDay) {
  const wrap = $("trend-chart");
  const legend = $("trend-legend");
  legend.innerHTML = `
    <span class="lg"><i class="sw sw-ing"></i>Ingested</span>
    <span class="lg"><i class="sw sw-ok"></i>Completed</span>
    <span class="lg"><i class="sw sw-fail"></i>Failed</span>
  `;

  if (!byDay.length) {
    wrap.innerHTML = `<div class="empty">No data in the last 30 days.</div>`;
    return;
  }

  // Geometry
  const W = 980;
  const H = 280;
  const padL = 38;
  const padR = 12;
  const padT = 14;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxVal = Math.max(
    1,
    ...byDay.map((d) => Math.max(d.ingested || 0, d.completed || 0, d.failed || 0))
  );
  // "nice" y-axis ceiling
  const ceil = niceCeil(maxVal);

  const n = byDay.length;
  const slot = plotW / n;
  const groupPad = slot * 0.18;
  const groupW = slot - groupPad * 2;
  const barW = groupW / 3;

  const y = (v) => padT + plotH - (v / ceil) * plotH;
  const colors = { ing: "var(--c-ing)", ok: "var(--c-ok)", fail: "var(--c-fail)" };

  // Y gridlines (4 steps)
  let grid = "";
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = (ceil / steps) * i;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(
      1
    )}" class="grid-line" />`;
    grid += `<text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" class="axis-label" text-anchor="end">${Math.round(
      v
    )}</text>`;
  }

  // Bars + x labels. Label every ~Nth day to avoid clutter.
  const labelEvery = Math.ceil(n / 10);
  let bars = "";
  let xlabels = "";
  byDay.forEach((d, i) => {
    const gx = padL + i * slot + groupPad;
    const series = [
      { v: d.ingested || 0, c: colors.ing },
      { v: d.completed || 0, c: colors.ok },
      { v: d.failed || 0, c: colors.fail },
    ];
    series.forEach((s, j) => {
      const bx = gx + j * barW;
      const by = y(s.v);
      const bh = Math.max(0, padT + plotH - by);
      const title = `${d.date}\nIngested ${d.ingested || 0} · Completed ${d.completed ||
        0} · Failed ${d.failed || 0}`;
      bars += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${(barW - 1).toFixed(
        1
      )}" height="${bh.toFixed(1)}" fill="${s.c}" rx="1.5"><title>${escapeHtml(
        title
      )}</title></rect>`;
    });
    if (i % labelEvery === 0 || i === n - 1) {
      const cx = gx + groupW / 2;
      xlabels += `<text x="${cx.toFixed(1)}" y="${H - padB + 18}" class="axis-label" text-anchor="middle">${escapeHtml(
        fmtDay(d.date)
      )}</text>`;
    }
  });

  wrap.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="30-day ingestion trend">
      ${grid}
      ${bars}
      ${xlabels}
    </svg>
  `;
}

function niceCeil(v) {
  if (v <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  let step;
  if (n <= 1) step = 1;
  else if (n <= 2) step = 2;
  else if (n <= 5) step = 5;
  else step = 10;
  return step * pow;
}

function renderRecentFailures(failures) {
  const box = $("recent-failures");
  if (!failures.length) {
    box.innerHTML = `<div class="empty">No recent failures. 🎉</div>`;
    return;
  }
  box.innerHTML = "";
  failures.forEach((f) => {
    const row = document.createElement("div");
    row.className = "failure-row";
    row.innerHTML = `
      <div class="failure-main">
        <div class="failure-subject">${escapeHtml(f.subject || "(no subject)")}</div>
        <div class="failure-sub muted">${escapeHtml(f.from || "(unknown sender)")} · ${escapeHtml(
      fmtRelative(f.updatedAt)
    )}</div>
        <div class="failure-error">${escapeHtml(f.error || "Unknown error")}</div>
      </div>
      <button class="button ghost small">Open</button>
    `;
    row.querySelector("button").onclick = () => openDetail(f.messageId, f.attachmentId);
    box.appendChild(row);
  });
}

/* ========================================================================
   AUDIT
   ===================================================================== */

async function loadInvoices(reset) {
  if (state.loadingMore) return;
  const errBox = $("audit-error");

  if (reset) {
    state.invoices = [];
    state.nextToken = undefined;
  }

  state.loadingMore = true;
  const loadMoreBtn = $("audit-load-more");
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = "Loading…";

  try {
    const params = new URLSearchParams({ limit: "50" });
    if (state.nextToken) params.set("nextToken", state.nextToken);
    const res = await apiFetch(`/invoices?${params.toString()}`);
    if (!res.ok) throw new Error(`Invoices request failed (${res.status})`);
    const data = await res.json();
    state.invoices = state.invoices.concat(data.items || []);
    state.nextToken = data.nextToken;
    errBox.classList.add("hidden");
    renderAudit();
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    errBox.textContent = "Could not load invoices. Check your connection and try Refresh.";
    errBox.classList.remove("hidden");
    if (state.invoices.length === 0) renderAudit(); // show empty state, not blank
  } finally {
    state.loadingMore = false;
    loadMoreBtn.textContent = "Load more";
    loadMoreBtn.disabled = !state.nextToken;
    loadMoreBtn.classList.toggle("hidden", !state.nextToken);
  }
}

function filteredInvoices() {
  const term = state.searchTerm.trim().toLowerCase();
  return state.invoices.filter((it) => {
    if (state.statusFilter !== "ALL" && it.status !== state.statusFilter) return false;
    if (!term) return true;
    const hay = [
      it.vendorName,
      it.vendorTaxId,
      it.vendorVatStatus,
      it.buyerName,
      it.subject,
      it.from,
      it.invoiceNumber,
      it.purchaseOrderNumber,
      it.invoiceType,
      it.reviewStatus,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(term);
  });
}

function renderAudit() {
  const body = $("audit-body");
  const rows = filteredInvoices();
  $("audit-count").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  body.innerHTML = "";

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty">No invoices match your filters.</div></td></tr>`;
    return;
  }

  rows.forEach((it) => {
    const tr = document.createElement("tr");
    tr.className = "row-click";
    tr.innerHTML = `
      <td>${escapeHtml(fmtDate(it.receivedAt))}</td>
      <td class="cell-strong">${escapeHtml(it.vendorName || "—")}</td>
      <td>${escapeHtml(it.invoiceNumber || "—")}</td>
      <td class="num">${escapeHtml(fmtAmount(it.totalAmount, it.currency))}</td>
      <td><span class="badge ${statusClass(it.status)}">${escapeHtml(it.status || "—")}</span></td>
      <td><span class="badge ${reviewClass(it.reviewStatus)}">${escapeHtml(fmtReviewStatus(it.reviewStatus))}</span></td>
      <td class="num">${
        it.status === "COMPLETED"
          ? `<span class="conf ${confidenceClass(it.confidence)}">${fmtPct(it.confidence)}</span>`
          : "—"
      }</td>
    `;
    tr.onclick = () => openDetail(it.messageId, it.attachmentId);
    body.appendChild(tr);
  });
}

/* ========================================================================
   DETAIL DRAWER
   ===================================================================== */

const DETAIL_FIELDS = [
  ["Status", (d) => `<span class="badge ${statusClass(d.status)}">${escapeHtml(d.status || "—")}</span>`],
  ["Review", (d) => `<span class="badge ${reviewClass(d.reviewStatus)}">${escapeHtml(fmtReviewStatus(d.reviewStatus))}</span>`],
  ["Vendor", (d) => escapeHtml(d.vendorName || "—")],
  ["Vendor VAT", renderVatValidation],
  ["Buyer", (d) => escapeHtml(d.buyerName || d.extractedJson?.buyer?.name || "—")],
  ["Invoice #", (d) => escapeHtml(d.invoiceNumber || "—")],
  ["PO", (d) => escapeHtml(d.purchaseOrderNumber || d.extractedJson?.invoice?.purchaseOrderNumber || "—")],
  ["Type", (d) => escapeHtml(d.invoiceType || d.extractedJson?.invoice?.invoiceType || "—")],
  ["Amount", (d) => escapeHtml(fmtAmount(d.totalAmount, d.currency))],
  ["Confidence", (d) => (d.status === "COMPLETED" ? escapeHtml(fmtPct(d.confidence)) : "—")],
  ["Duplicates", (d) => escapeHtml(String(d.duplicateCount ?? d.extractedJson?.meta?.duplicateCount ?? 0))],
  ["Duplicate decision", renderDuplicateDecision],
  ["Controls", (d) => renderControlFlags(d.controlFlags ?? d.extractedJson?.meta?.controlFlags ?? [])],
  ["From", (d) => escapeHtml(d.from || "—")],
  ["Subject", (d) => escapeHtml(d.subject || "—")],
  ["Received", (d) => escapeHtml(fmtDate(d.receivedAt))],
  ["Updated", (d) => escapeHtml(fmtDate(d.updatedAt))],
];

async function openDetail(messageId, attachmentId) {
  if (!messageId || !attachmentId) return;
  state.currentDetail = { messageId, attachmentId };

  const overlay = $("drawer-overlay");
  const fields = $("drawer-fields");
  const jsonBox = $("drawer-json");

  // Open immediately with a loading state.
  fields.innerHTML = `<div class="empty">Loading…</div>`;
  jsonBox.textContent = "";
  $("drawer-meta").textContent = "";
  $("duplicate-review-panel").classList.add("hidden");
  $("duplicate-review-panel").innerHTML = "";
  overlay.classList.remove("hidden");
  document.body.classList.add("no-scroll");

  try {
    const res = await apiFetch(`/invoices/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`);
    if (!res.ok) throw new Error(`Detail request failed (${res.status})`);
    const d = await res.json();

    $("drawer-meta").textContent = `${messageId} · ${attachmentId}`;
    fields.innerHTML = DETAIL_FIELDS.map(
      ([label, fn]) => `
      <div class="meta-item">
        <span class="meta-label">${escapeHtml(label)}</span>
        <span class="meta-value">${fn(d)}</span>
      </div>`
    ).join("");
    renderDuplicateReviewPanel(d);

    let jsonPayload;
    if (d.status === "FAILED") {
      jsonPayload = {
        status: "FAILED",
        errors: d.errors || ["Unknown error"],
        messageId: d.messageId,
        attachmentId: d.attachmentId,
        receivedAt: d.receivedAt,
      };
    } else {
      jsonPayload = d.extractedJson ?? d;
    }
    jsonBox.textContent = JSON.stringify(jsonPayload, null, 2);

    // Wire download lazily (presigned URL fetched on click to keep it fresh).
    $("drawer-download").onclick = () => downloadPdf(messageId, attachmentId);
    $("drawer-netsuite").onclick = () => previewNetSuite(messageId, attachmentId);
    $("drawer-netsuite-log").onclick = () => logNetSuiteTransaction(messageId, attachmentId);
    $("drawer-delete").onclick = () => deleteInvoice(messageId, attachmentId);
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    fields.innerHTML = `<div class="banner error">Could not load this record.</div>`;
  }
}

function closeDrawer() {
  $("drawer-overlay").classList.add("hidden");
  document.body.classList.remove("no-scroll");
  state.currentDetail = null;
}

async function downloadPdf(messageId, attachmentId) {
  try {
    const res = await apiFetch(
      `/invoices/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}/download`
    );
    const j = await res.json().catch(() => ({}));
    if (res.ok && j && j.url) {
      window.open(j.url, "_blank", "noopener");
    } else {
      toast("Download URL unavailable.", "error");
    }
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    toast("Download failed.", "error");
  }
}

async function previewNetSuite(messageId, attachmentId) {
  const jsonBox = $("drawer-json");
  try {
    jsonBox.textContent = "Loading NetSuite preview...";
    const res = await apiFetch(
      `/invoices/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}/netsuite`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      jsonBox.textContent = JSON.stringify(data || { message: `Preview failed (${res.status})` }, null, 2);
      toast("NetSuite preview failed.", "error");
      return;
    }
    jsonBox.textContent = JSON.stringify(data, null, 2);
    toast("NetSuite preview loaded.", "success");
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    jsonBox.textContent = "NetSuite preview failed.";
    toast("NetSuite preview failed.", "error");
  }
}

async function logNetSuiteTransaction(messageId, attachmentId) {
  const jsonBox = $("drawer-json");
  try {
    jsonBox.textContent = "Logging NetSuite transaction...";
    const res = await apiFetch(
      `/invoices/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}/netsuite/transactions`,
      { method: "POST" }
    );
    const data = await res.json().catch(() => ({}));
    jsonBox.textContent = JSON.stringify(data, null, 2);
    if (res.ok) {
      toast(data.queued ? "NetSuite transaction queued." : "NetSuite transaction logged.", "success");
    } else {
      toast(data.message || "Transaction logging failed.", "error");
    }
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    jsonBox.textContent = "Transaction logging failed.";
    toast("Transaction logging failed.", "error");
  }
}

async function saveDuplicateReview(action) {
  if (!state.currentDetail || !["HOLD_FOR_REVIEW", "ALLOW_NETSUITE"].includes(action)) return;
  const { messageId, attachmentId } = state.currentDetail;
  const panel = $("duplicate-review-panel");
  const msg = panel?.querySelector(".duplicate-review-message");

  try {
    panel?.querySelectorAll("button").forEach((button) => {
      button.disabled = true;
    });
    if (msg) msg.textContent = "Saving...";

    const res = await apiFetch(
      `/invoices/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}/duplicate-review`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      }
    );
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (msg) msg.textContent = data.message || "Could not save duplicate decision.";
      toast(data.message || "Could not save duplicate decision.", "error");
      return;
    }

    const ready = data.reviewStatus === "READY_FOR_NETSUITE";
    toast(
      action === "ALLOW_NETSUITE"
        ? ready
          ? "Duplicate allowed for NetSuite."
          : "Duplicate allowed; remaining controls still need review."
        : "Duplicate held for review.",
      "success"
    );
    await openDetail(messageId, attachmentId);
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    if (msg) msg.textContent = "Could not save duplicate decision.";
    toast("Could not save duplicate decision.", "error");
  } finally {
    panel?.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
  }
}

/* ========================================================================
   CONFIGURATION
   ===================================================================== */

const NS_ENVS = [
  ["test", "Test"],
  ["prod", "Prod"],
];

const NS_FIELDS = [
  ["accountId", "Account ID"],
  ["restApiBaseUrl", "REST API base URL"],
  ["tokenEndpointUrl", "OAuth token endpoint"],
  ["secretArn", "Secret ARN/name"],
  ["oauthScope", "OAuth scope"],
  ["recordApiPath", "Record API path"],
  ["suiteqlPath", "SuiteQL path"],
  ["vendorBillRecordId", "Vendor bill record"],
  ["vendorPrepaymentRecordId", "Vendor prepayment record"],
  ["requestTimeoutMs", "Timeout ms", "number"],
];

function defaultNetSuiteEnv(label) {
  return {
    label,
    accountId: "",
    restApiBaseUrl: "",
    tokenEndpointUrl: "",
    secretArn: "",
    oauthScope: "rest_webservices",
    recordApiPath: "/record/v1",
    suiteqlPath: "/query/v1/suiteql",
    vendorBillRecordId: "vendorBill",
    vendorPrepaymentRecordId: "vendorPrepayment",
    requestTimeoutMs: 30000,
    suiteTaxEnabled: false,
    allowTranId: true,
  };
}

function normalizeNetSuiteSettings(raw) {
  const settings = raw || {};
  return {
    activeEnvironment: settings.activeEnvironment === "prod" ? "prod" : "test",
    environments: {
      test: Object.assign(defaultNetSuiteEnv("Test"), settings.environments?.test || {}),
      prod: Object.assign(defaultNetSuiteEnv("Prod"), settings.environments?.prod || {}),
    },
    updatedAt: settings.updatedAt,
    updatedBy: settings.updatedBy,
  };
}

async function loadNetSuiteSettings() {
  const errBox = $("config-error");
  errBox.classList.add("hidden");
  $("netsuite-config-status").textContent = "Loading...";
  try {
    const res = await apiFetch("/config/netsuite");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Configuration request failed (${res.status})`);
    state.netSuiteSettings = normalizeNetSuiteSettings(data);
    state.netSuiteSettingsLoaded = true;
    renderNetSuiteSettings();
    $("netsuite-config-status").textContent = state.netSuiteSettings.updatedAt
      ? `Last saved ${fmtDate(state.netSuiteSettings.updatedAt)}`
      : "";
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    errBox.textContent = "Could not load NetSuite configuration.";
    errBox.classList.remove("hidden");
    $("netsuite-config-status").textContent = "";
  }
}

function renderNetSuiteSettings() {
  const settings = normalizeNetSuiteSettings(state.netSuiteSettings);
  $("netsuite-active-env").value = settings.activeEnvironment;
  $("netsuite-config-envs").innerHTML = NS_ENVS.map(([env, label]) =>
    renderNetSuiteEnvironment(env, settings.environments[env] || defaultNetSuiteEnv(label), settings.activeEnvironment)
  ).join("");

  NS_ENVS.forEach(([env]) => {
    $(`ns-${env}-defaults`).onclick = () => applyNetSuiteEndpointDefaults(env);
  });
}

function renderNetSuiteEnvironment(env, values, activeEnvironment) {
  const fields = NS_FIELDS.map(([key, label, type]) => {
    const value = values[key] ?? "";
    return `
      <label class="field">
        <span>${escapeHtml(label)}</span>
        <input id="${escapeHtml(nsFieldId(env, key))}" type="${type || "text"}" value="${escapeHtml(value)}" />
      </label>
    `;
  }).join("");

  return `
    <div class="config-env">
      <div class="config-env-head">
        <div class="config-env-title">
          <h3>${escapeHtml(values.label || env)}</h3>
          ${env === activeEnvironment ? '<span class="env-badge">Push target</span>' : ""}
        </div>
        <button id="ns-${escapeHtml(env)}-defaults" class="button secondary small" type="button">Use account defaults</button>
      </div>
      <div class="form-grid">
        ${fields}
        <label class="field check-row">
          <input id="${escapeHtml(nsFieldId(env, "suiteTaxEnabled"))}" type="checkbox" ${values.suiteTaxEnabled ? "checked" : ""} />
          <span>SuiteTax enabled</span>
        </label>
        <label class="field check-row">
          <input id="${escapeHtml(nsFieldId(env, "allowTranId"))}" type="checkbox" ${values.allowTranId !== false ? "checked" : ""} />
          <span>Allow tranId</span>
        </label>
      </div>
    </div>
  `;
}

function nsFieldId(env, key) {
  return `ns-${env}-${key}`;
}

function deriveNetSuiteEndpointDefaults(accountId) {
  const clean = String(accountId || "").trim().replace(/_/g, "-").toLowerCase();
  if (!clean) return { restApiBaseUrl: "", tokenEndpointUrl: "" };
  const restApiBaseUrl = `https://${clean}.suitetalk.api.netsuite.com/services/rest`;
  return {
    restApiBaseUrl,
    tokenEndpointUrl: `${restApiBaseUrl}/auth/oauth2/v1/token`,
  };
}

function applyNetSuiteEndpointDefaults(env) {
  const accountId = $(nsFieldId(env, "accountId")).value;
  const derived = deriveNetSuiteEndpointDefaults(accountId);
  if (derived.restApiBaseUrl) $(nsFieldId(env, "restApiBaseUrl")).value = derived.restApiBaseUrl;
  if (derived.tokenEndpointUrl) $(nsFieldId(env, "tokenEndpointUrl")).value = derived.tokenEndpointUrl;
  $(nsFieldId(env, "recordApiPath")).value = $(nsFieldId(env, "recordApiPath")).value || "/record/v1";
  $(nsFieldId(env, "suiteqlPath")).value = $(nsFieldId(env, "suiteqlPath")).value || "/query/v1/suiteql";
  $(nsFieldId(env, "oauthScope")).value = $(nsFieldId(env, "oauthScope")).value || "rest_webservices";
  $(nsFieldId(env, "vendorBillRecordId")).value = $(nsFieldId(env, "vendorBillRecordId")).value || "vendorBill";
  $(nsFieldId(env, "vendorPrepaymentRecordId")).value =
    $(nsFieldId(env, "vendorPrepaymentRecordId")).value || "vendorPrepayment";
}

function collectNetSuiteSettings() {
  const environments = {};
  NS_ENVS.forEach(([env, label]) => {
    const current = { label };
    NS_FIELDS.forEach(([key, , type]) => {
      const raw = $(nsFieldId(env, key)).value.trim();
      current[key] = type === "number" ? Number(raw || 0) : raw;
    });
    current.suiteTaxEnabled = $(nsFieldId(env, "suiteTaxEnabled")).checked;
    current.allowTranId = $(nsFieldId(env, "allowTranId")).checked;
    environments[env] = current;
  });
  return {
    activeEnvironment: $("netsuite-active-env").value === "prod" ? "prod" : "test",
    environments,
  };
}

async function saveNetSuiteSettings() {
  const saveBtn = $("netsuite-save");
  const spinner = $("netsuite-config-spinner");
  const status = $("netsuite-config-status");
  const errBox = $("config-error");
  try {
    saveBtn.disabled = true;
    spinner.classList.remove("hidden");
    status.textContent = "Saving...";
    errBox.classList.add("hidden");

    const res = await apiFetch("/config/netsuite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(collectNetSuiteSettings()),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Save failed (${res.status})`);
    state.netSuiteSettings = normalizeNetSuiteSettings(data);
    state.netSuiteSettingsLoaded = true;
    renderNetSuiteSettings();
    status.textContent = `Saved ${fmtDate(state.netSuiteSettings.updatedAt)}`;
    toast("NetSuite configuration saved.", "success");
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    errBox.textContent = "Could not save NetSuite configuration.";
    errBox.classList.remove("hidden");
    status.textContent = "";
    toast("Configuration save failed.", "error");
  } finally {
    saveBtn.disabled = false;
    spinner.classList.add("hidden");
  }
}

async function deleteInvoice(messageId, attachmentId) {
  if (!window.confirm("Delete this invoice and its uploaded PDF? This cannot be undone.")) return;
  try {
    const res = await apiFetch(
      `/invoices/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.message || `Delete failed (${res.status}).`, "error");
      return;
    }
    toast("Invoice deleted.", "success");
    closeDrawer();
    // Drop it from the local list and re-render without a full reload.
    state.invoices = state.invoices.filter(
      (it) => !(it.messageId === messageId && it.attachmentId === attachmentId)
    );
    renderAudit();
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    toast("Delete failed.", "error");
  }
}

/* ========================================================================
   UPLOAD
   ===================================================================== */

async function uploadInvoice() {
  const fileInput = $("file-input");
  const uploadStatus = $("upload-status");
  const uploadBtn = $("upload-btn");
  const spinner = $("upload-spinner");

  try {
    if (!fileInput.files || fileInput.files.length === 0) {
      uploadStatus.textContent = "Select a PDF first.";
      return;
    }
    const file = fileInput.files[0];
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      uploadStatus.textContent = "PDF files only.";
      return;
    }
    if (state.maxUploadBytes > 0 && file.size > state.maxUploadBytes) {
      uploadStatus.textContent = `File too large. Max ${fmtBytes(state.maxUploadBytes)}.`;
      return;
    }

    uploadBtn.disabled = true;
    spinner.classList.remove("hidden");
    uploadStatus.textContent = "Requesting upload URL…";

    const res = await apiFetch("/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        contentType: "application/pdf",
        fileSize: file.size,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      uploadStatus.textContent = data.message || "Upload request failed.";
      return;
    }

    uploadStatus.textContent = "Uploading to S3…";
    // NOTE: presigned PUT goes straight to S3 — do NOT attach the Bearer header.
    const putRes = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: file,
    });
    if (!putRes.ok) {
      uploadStatus.textContent = `Upload failed (${putRes.status}).`;
      return;
    }

    uploadStatus.textContent = "Upload complete. Extraction running…";
    await waitForExtraction(data.messageId, data.attachmentId, uploadStatus);
  } catch (err) {
    if (err.message === "Unauthorized") return;
    console.error(err);
    uploadStatus.textContent = "Upload failed. Check the console / network tab.";
  } finally {
    uploadBtn.disabled = false;
    spinner.classList.add("hidden");
  }
}

async function waitForExtraction(messageId, attachmentId, uploadStatus) {
  const maxAttempts = 20;
  const delayMs = 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res;
    try {
      res = await apiFetch(
        `/invoices/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`
      );
    } catch (err) {
      if (err.message === "Unauthorized") return;
      throw err;
    }

    if (res.status === 404) {
      uploadStatus.textContent = `Waiting for processing to start… (${attempt}/${maxAttempts})`;
      await sleep(delayMs);
      continue;
    }

    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status && data.status !== "PENDING") {
      if (data.status === "FAILED") {
        const errMsg = (data.errors || []).join(", ") || "Unknown error";
        uploadStatus.textContent = `Processing failed: ${errMsg}`;
        toast("Extraction failed.", "error");
      } else {
        uploadStatus.textContent = "Extraction complete. Opening record…";
        toast("Extraction complete.", "success");
      }
      // Refresh audit list so the new record is present, then open it.
      await loadInvoices(true);
      openDetail(messageId, attachmentId);
      return;
    }

    uploadStatus.textContent = `Processing… (${attempt}/${maxAttempts})`;
    await sleep(delayMs);
  }
  uploadStatus.textContent = "Processing is taking longer than expected. Check the Audit view shortly.";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ========================================================================
   BOOT
   ===================================================================== */

function showBootGate() {
  bootGate.classList.remove("hidden");
  appShell.classList.add("hidden");
}

function showApp() {
  bootGate.classList.add("hidden");
  appShell.classList.remove("hidden");
}

async function loadConfig() {
  const res = await fetch("config.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`config.json failed (${res.status})`);
  const cfg = await res.json();
  state.cfg = cfg;
  state.apiBaseUrl = (cfg.apiBaseUrl || "").replace(/\/+$/, "");
  state.maxUploadBytes = Number(cfg.maxUploadBytes ?? 0);
  state.cognito = cfg.cognito || null;
  state.region = cfg.region || "";
  const regionLabel = document.getElementById("region-label");
  if (regionLabel) regionLabel.textContent = state.region ? `${state.region} • PWA` : "PWA";
}

function renderUserChip() {
  $("user-email").textContent = state.userEmail || "Signed in";
  const initial = (state.userEmail || "?").trim().charAt(0).toUpperCase() || "?";
  $("user-avatar").textContent = initial;
}

function wireEvents() {
  // Nav
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.onclick = () => switchView(btn.dataset.view);
  });
  $("nav-toggle").onclick = () => document.body.classList.toggle("nav-open");
  $("logout-btn").onclick = logout;

  // Refresh (context-aware)
  $("refresh-btn").onclick = () => {
    const active = document.querySelector(".nav-item.active");
    const view = active ? active.dataset.view : "dashboard";
    if (view === "audit") loadInvoices(true);
    else if (view === "config") loadNetSuiteSettings();
    else loadStats();
  };

  // Audit filters
  $("audit-search").addEventListener("input", (e) => {
    state.searchTerm = e.target.value;
    renderAudit();
  });
  $("audit-status").addEventListener("change", (e) => {
    state.statusFilter = e.target.value;
    renderAudit();
  });
  $("audit-load-more").onclick = () => loadInvoices(false);

  // Drawer
  $("drawer-close").onclick = closeDrawer;
  $("drawer-dismiss").onclick = closeDrawer;
  $("drawer-overlay").addEventListener("click", (e) => {
    if (e.target === $("drawer-overlay")) closeDrawer();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("drawer-overlay").classList.contains("hidden")) closeDrawer();
  });

  // Upload
  $("upload-btn").onclick = uploadInvoice;
  $("netsuite-save").onclick = saveNetSuiteSettings;
  const dz = $("dropzone");
  const fileInput = $("file-input");
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
    })
  );
  dz.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      $("upload-status").textContent = `Selected: ${e.dataTransfer.files[0].name}`;
    }
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length) {
      $("upload-status").textContent = `Selected: ${fileInput.files[0].name}`;
    }
  });
}

async function boot() {
  showBootGate();
  try {
    await loadConfig();
  } catch (err) {
    console.error(err);
    bootText.textContent = "Configuration failed to load. Please retry shortly.";
    return;
  }

  if (!state.cognito || !state.cognito.domain || !state.cognito.clientId) {
    bootText.textContent = "Authentication is not configured. Contact your administrator.";
    return;
  }

  let authenticated = false;
  try {
    authenticated = await resolveAuth();
  } catch (err) {
    console.error(err);
    clearStoredAuth();
    bootText.textContent = "Sign-in failed. Please try again.";
    return;
  }

  if (!authenticated) {
    await redirectToLogin();
    return;
  }

  renderUserChip();
  wireEvents();
  showApp();
  switchView("dashboard");
}

boot();
