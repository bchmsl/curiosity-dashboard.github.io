/***********************
 * Config
 ***********************/
const ORG = "SpaceBank";
const REPOS = [
  "Android-Space-Feature-Payment",
  "Android-Space-Feature-Transfers",
  "Android-Space-Feature-Deposit",
  "Android-Space-Feature-Cards",
  "Android-Space-Feature-CardOrder",
  "Android-Space-Feature-DigitalCardOrder",
  "Android-Space-Feature-Remittance",
];

const REPO_CONCURRENCY = 3;
const PR_CONCURRENCY = 4;

const STORAGE_KEYS = {
  token: "github_token",
  username: "github_username",
  darkMode: "dark_mode",
  collapsedPrefix: "collapsed_",
};

const IGNORED_COMMENTERS = new Set(["zura-adod"]);
const NEW_WINDOW_DAYS = 2;

/***********************
 * DOM helpers
 ***********************/
const $ = (id) => document.getElementById(id);

function show(el) { el.style.display = "block"; }
function hide(el) { el.style.display = "none"; }

function setBannerError(message) {
  const banner = $("errorBanner");
  banner.textContent = message;
  show(banner);
}

function clearBannerError() {
  const banner = $("errorBanner");
  banner.textContent = "";
  hide(banner);
}

/***********************
 * Time helpers
 ***********************/
function timeAgo(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffSeconds = Math.floor((now - date) / 1000);

  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  if (diffSeconds < 604800) return `${Math.floor(diffSeconds / 86400)}d ago`;

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isNew(createdAt) {
  const createdTime = new Date(createdAt).getTime();
  const now = Date.now();
  const WINDOW_MS = NEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return now - createdTime < WINDOW_MS;
}

/***********************
 * Concurrency helper
 ***********************/
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

/***********************
 * GitHub API
 ***********************/
function buildHeaders(token) {
  return { Authorization: `token ${token}` };
}

function parseRateLimitResetSeconds(resetHeader) {
  const reset = Number(resetHeader);
  if (!Number.isFinite(reset)) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.max(0, reset - nowSec);
}

async function fetchJson(url, headers) {
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    const err = new Error(`Network error while calling GitHub: ${e?.message || e}`);
    err.kind = "network";
    throw err;
  }

  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");

  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }

    const err = new Error(body?.message || `GitHub request failed (${res.status})`);
    err.status = res.status;
    err.url = url;
    err.kind = "http";
    err.rateRemaining = remaining;
    err.rateResetSeconds = parseRateLimitResetSeconds(reset);
    throw err;
  }

  return res.json();
}

async function fetchAuthenticatedUser(headers) {
  return fetchJson("https://api.github.com/user", headers);
}

async function fetchOpenPRs(repo, headers) {
  const url = `https://api.github.com/repos/${ORG}/${repo}/pulls?state=open&per_page=100`;
  return fetchJson(url, headers);
}

async function fetchReviews(prApiUrl, headers) {
  return fetchJson(`${prApiUrl}/reviews`, headers);
}

async function fetchPrDetails(prApiUrl, headers) {
  return fetchJson(prApiUrl, headers);
}

/***********************
 * Avatar caching
 ***********************/
const userCache = new Map();

function getUser(username, headers) {
  if (!userCache.has(username)) {
    const p = fetchJson(`https://api.github.com/users/${username}`, headers).catch(() => ({
      login: username,
      avatar_url: "",
    }));
    userCache.set(username, p);
  }
  return userCache.get(username);
}

async function renderUserBlock(username, reviewer, headers) {
  const highlightClass = username === reviewer ? "highlight" : "";
  const user = await getUser(username, headers);

  return `<div class="user-block ${highlightClass}">
    <img src="${user.avatar_url}" alt="${username}" /> ${username}
  </div>`;
}

/***********************
 * Review parsing
 ***********************/
function buildLatestReviewStateMap(reviews) {
  const latest = new Map();
  for (const review of reviews) latest.set(review.user.login, review.state);
  return latest;
}

function pickUsersByState(latestReviewMap, state) {
  return [...latestReviewMap.entries()]
      .filter(([_, s]) => s === state)
      .map(([user]) => user);
}

function computeCommenters(latestReviewMap, author) {
  return [...latestReviewMap.entries()]
      .filter(([user, state]) => {
        if (state !== "COMMENTED") return false;
        if (user === author) return false;
        return !IGNORED_COMMENTERS.has(user);

      })
      .map(([user]) => user);
}

function computeAwaitingReviewers(requestedReviewers, reviews) {
  const submitted = new Set(reviews.map((r) => r.user.login));
  return requestedReviewers.filter((r) => !submitted.has(r));
}

function computeTotalReviewersCount({ requestedReviewers, approvals, changesRequested, commented }) {
  const set = new Set([...requestedReviewers, ...approvals, ...changesRequested, ...commented]);
  return set.size;
}

/***********************
 * Rendering helpers
 ***********************/
function cleanRepoName(repo) {
  return repo.replace("Android-Space-Feature-", "");
}

function collapsedKey(repo) {
  return `${STORAGE_KEYS.collapsedPrefix}${repo}`;
}

function isRepoCollapsed(repo) {
  return localStorage.getItem(collapsedKey(repo)) === "true";
}

function setRepoCollapsed(repo, collapsed) {
  localStorage.setItem(collapsedKey(repo), String(collapsed));
}

function renderStatusLabel(isDraft) {
  return `<span class="label-status ${isDraft ? "label-draft" : "label-open"}">
    ${isDraft ? "Draft" : "Open"}
  </span>`;
}

function renderSectionHeaderHtml({ repo, headerLabel, collapsed }) {
  return `
    <h2>
      <a href="https://github.com/${ORG}/${repo}/pulls" target="_blank" class="repo-link-icon" onclick="event.stopPropagation()">🔗</a>
      <span class="header-title" style="flex-grow: 1; cursor: pointer;">${headerLabel}</span>
      <span class="collapse-toggle">${collapsed ? "◁" : "▼"}</span>
    </h2>

    <div style="overflow-x:auto;">
      <table class="pr-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Author</th>
            <th>Created</th>
            <th>Stats</th>
            <th></th>
            <th></th>
            <th></th>
            <th></th>
          </tr>
        </thead>
      </table>
    </div>
  `;
}

function attachCollapseHandler(sectionEl, repo) {
  const titleEl = sectionEl.querySelector(".header-title");
  const toggleEl = sectionEl.querySelector(".collapse-toggle");

  titleEl.addEventListener("click", () => {
    const collapsed = sectionEl.classList.toggle("collapsed");
    setRepoCollapsed(repo, collapsed);
    toggleEl.textContent = collapsed ? "◁" : "▼";
  });
}

function setLoadingProgress(loaded, total) {
  $("loadingMessage").innerText = `${loaded}/${total} Repositories Loaded`;
}

function escapeHtml(str) {
  return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
}

function formatError(e) {
  if (!e) return "Unknown error";

  if (e.status === 403 && e.rateRemaining === "0") {
    const wait = e.rateResetSeconds != null ? ` Try again in ~${Math.ceil(e.rateResetSeconds / 60)} min.` : "";
    return `GitHub rate limit exceeded.${wait}`;
  }

  if (e.status === 401) return "Unauthorized (token invalid or missing scopes).";
  if (e.status === 403) return e.message || "Forbidden.";
  if (e.status === 404) return "Not found (repo/endpoint).";
  return e.message || String(e);
}

/***********************
 * Placeholder sections
 ***********************/
function createPlaceholderSection(repo) {
  const section = document.createElement("div");
  section.className = "product-section";

  const repoName = cleanRepoName(repo);
  const collapsed = isRepoCollapsed(repo);

  section.classList.toggle("collapsed", collapsed);

  const headerLabel = `📁 ${repoName} <span class="repo-pr-count" data-role="count">(Loading…)</span>`;
  section.innerHTML = renderSectionHeaderHtml({ repo, headerLabel, collapsed });

  const holder = document.createElement("div");
  holder.style.padding = "0.75rem";
  holder.style.opacity = "0.85";
  holder.innerHTML = `⏳ Loading repository…`;

  section.appendChild(holder);
  attachCollapseHandler(section, repo);

  section.dataset.repo = repo;
  section.dataset.totalCount = "0";

  return section;
}

/***********************
 * Row metadata (for filters)
 ***********************/
function setRowMeta(tr, meta) {
  tr.dataset.isNew = meta.isNew ? "true" : "false";
  tr.dataset.isDraft = meta.isDraft ? "true" : "false";

  tr.dataset.iAmRequestedReviewer = meta.iAmRequestedReviewer ? "true" : "false";
  tr.dataset.myReviewCount = String(meta.myReviewCount);
  tr.dataset.myLatestReviewState = meta.myLatestReviewState;

  tr.dataset.approvalCount = String(meta.approvalCount);
}

/***********************
 * PR row rendering
 ***********************/
async function renderPrRow({ pr, reviewer, headers }) {
  const newPR = isNew(pr.created_at);

  const author = pr.user.login;
  const authorBlock = await renderUserBlock(author, reviewer, headers);
  const statusLabel = renderStatusLabel(pr.draft);

  let commitCount = "—";
  let fileCount = -1;

  const requestedReviewers = pr.requested_reviewers.map((r) => r.login);
  const iAmRequestedReviewer = requestedReviewers.includes(reviewer);

  let myReviewCount = -1;
  let myLatestReviewState = "unknown";
  let approvalCount = -1;

  let approvals = [];
  let changesRequested = [];
  let awaitingReviewers = requestedReviewers;
  let commented = [];
  let totalReviewers = new Set(awaitingReviewers).size;

  let approvalsHtml = "None";
  let changesHtml = "None";
  let commentedHtml = "None";
  let awaitingHtml = "None";

  let statsNote = "";

  try {
    const [reviews, prDetails] = await Promise.all([
      fetchReviews(pr.url, headers),
      fetchPrDetails(pr.url, headers),
    ]);

    commitCount = prDetails.commits;
    fileCount = Number(prDetails.changed_files);

    const latest = buildLatestReviewStateMap(reviews);
    approvals = pickUsersByState(latest, "APPROVED");
    changesRequested = pickUsersByState(latest, "CHANGES_REQUESTED");
    commented = computeCommenters(latest, author);

    approvalCount = approvals.length;

    const myReviews = reviews.filter((r) => r?.user?.login === reviewer);
    myReviewCount = myReviews.length;
    if (myReviews.length > 0) myLatestReviewState = myReviews[myReviews.length - 1].state || "unknown";
    else myLatestReviewState = "none";

    awaitingReviewers = computeAwaitingReviewers(requestedReviewers, reviews);

    totalReviewers = computeTotalReviewersCount({
      requestedReviewers,
      approvals,
      changesRequested,
      commented,
    });

    const approvalBlocks = await Promise.all(approvals.map((u) => renderUserBlock(u, reviewer, headers)));
    const changeBlocks = await Promise.all(changesRequested.map((u) => renderUserBlock(u, reviewer, headers)));
    const awaitingBlocks = await Promise.all(awaitingReviewers.map((u) => renderUserBlock(u, reviewer, headers)));
    const commentedBlocks = await Promise.all(commented.map((u) => renderUserBlock(u, reviewer, headers)));

    approvalsHtml = approvalBlocks.join("") || "None";
    changesHtml = changeBlocks.join("") || "None";
    awaitingHtml = awaitingBlocks.join("") || "None";
    commentedHtml = commentedBlocks.join("") || "None";
  } catch {
    statsNote = `<div style="margin-top:0.35rem; font-size:0.75rem; opacity:0.75;">⚠️ Some PR details failed to load</div>`;
  }

  const approvalHeader = `Approvals (${approvals.length}/${totalReviewers})`;
  const changesHeader = `Changes Requested (${changesRequested.length}/${totalReviewers})`;
  const commentedHeader = `Commented (${commented.length}/${totalReviewers})`;
  const awaitingHeader = `Awaiting (${awaitingReviewers.length}/${totalReviewers})`;

  const tr = document.createElement("tr");
  tr.className = pr.draft ? "draft" : "";

  tr.innerHTML = `
    <td>
      <div style="display: flex; gap: 0.5rem; align-items: flex-start;">
        <div style="flex-shrink: 0;">${statusLabel}</div>
        <a href="${pr.html_url}" target="_blank" style="display: inline-block; white-space: normal;">
          ${pr.title}
          <span style="color: #57606a; font-weight: normal;">#${pr.number}</span>
        </a>
      </div>
    </td>

    <td data-label="Author">${authorBlock}</td>

    <td data-label="Created">
      ${timeAgo(pr.created_at)} ${newPR ? '<span class="new-tag">New</span>' : ""}
    </td>

    <td data-label="Stats">
      📝 <span class="${Number(fileCount) > 15 ? "files-warning" : ""}">
        ${fileCount < 0 ? "—" : `${fileCount} file${fileCount === 1 ? "" : "s"} changed`}
      </span><br>
      📦 ${commitCount} commit${commitCount === 1 ? "" : "s"}
      ${statsNote}
    </td>

    <td><div><strong>${approvalHeader}</strong><br>${approvalsHtml}</div></td>
    <td><div><strong>${changesHeader}</strong><br>${changesHtml}</div></td>
    <td><div><strong>${commentedHeader}</strong><br>${commentedHtml}</div></td>
    <td><div><strong>${awaitingHeader}</strong><br>${awaitingHtml}</div></td>
  `;

  setRowMeta(tr, {
    isNew: newPR,
    isDraft: !!pr.draft,
    iAmRequestedReviewer,
    myReviewCount,
    myLatestReviewState,
    approvalCount,
  });

  return tr;
}

/***********************
 * Build repo section
 ***********************/
async function buildRepoSection({ repo, reviewer, headers }) {
  const section = document.createElement("div");
  section.className = "product-section";

  let prs;
  try {
    prs = await fetchOpenPRs(repo, headers);
  } catch (e) {
    const repoName = cleanRepoName(repo);
    const collapsed = isRepoCollapsed(repo);

    section.classList.toggle("collapsed", collapsed);
    section.dataset.repo = repo;
    section.dataset.totalCount = "0";

    const headerLabel = `📁 ${repoName} <span class="repo-pr-count" data-role="count">(Error)</span>`;
    section.innerHTML = renderSectionHeaderHtml({ repo, headerLabel, collapsed });

    const msg = document.createElement("div");
    msg.style.padding = "0.75rem";
    msg.style.opacity = "0.9";
    msg.innerHTML = `⚠️ Failed to load this repository.<br><span style="font-size:0.85rem; opacity:0.85;">${escapeHtml(
        formatError(e)
    )}</span>`;

    section.appendChild(msg);
    attachCollapseHandler(section, repo);
    return section;
  }

  const tbody = document.createElement("tbody");
  const rows = await mapLimit(prs, PR_CONCURRENCY, async (pr) => renderPrRow({ pr, reviewer, headers }));

  for (const tr of rows) tbody.appendChild(tr);
  if (tbody.children.length === 0) return null;

  const total = tbody.children.length;
  const repoName = cleanRepoName(repo);
  const collapsed = isRepoCollapsed(repo);

  section.classList.toggle("collapsed", collapsed);
  section.dataset.repo = repo;
  section.dataset.totalCount = String(total);

  const headerLabel = `📁 ${repoName} <span class="repo-pr-count" data-role="count">(${total} Pull${total !== 1 ? "s" : ""})</span>`;
  section.innerHTML = renderSectionHeaderHtml({ repo, headerLabel, collapsed });

  section.querySelector("table").appendChild(tbody);
  attachCollapseHandler(section, repo);

  return section;
}

/***********************
 * Filters
 ***********************/
const FILTER_IDS = {
  awaitingMyReview: "filterAwaitingMyReview",
  reviewedNotApproved: "filterReviewedNotApproved",
  approvalMode: "approvalFilter",
  newMode: "newFilter",
  draftMode: "draftFilter",
};

function getFilterState() {
  return {
    awaitingMyReview: $(FILTER_IDS.awaitingMyReview).checked,
    reviewedNotApproved: $(FILTER_IDS.reviewedNotApproved).checked,
    approvalMode: $(FILTER_IDS.approvalMode).value,
    newMode: $(FILTER_IDS.newMode).value,
    draftMode: $(FILTER_IDS.draftMode).value,
  };
}

function matchesApprovalMode(approvalCount, mode) {
  if (mode === "any") return true;
  if (approvalCount < 0) return false;
  if (mode === "gte2") return approvalCount >= 2;
  if (mode === "lt2") return approvalCount < 2;
  if (mode === "eq0") return approvalCount === 0;
  if (mode === "gte1") return approvalCount >= 1;
  return true;
}

function matchesNewMode(isNewFlag, mode) {
  if (mode === "any") return true;
  if (mode === "onlyNew") return isNewFlag;
  if (mode === "notNew") return !isNewFlag;
  return true;
}

function matchesDraftMode(isDraftFlag, mode) {
  if (mode === "any") return true;
  if (mode === "hideDrafts") return !isDraftFlag;
  if (mode === "onlyDrafts") return isDraftFlag;
  return true;
}

function rowMatchesFilters(tr, filters) {
  const isDraft = tr.dataset.isDraft === "true";
  const isNewFlag = tr.dataset.isNew === "true";

  const iAmRequestedReviewer = tr.dataset.iAmRequestedReviewer === "true";
  const myReviewCount = Number(tr.dataset.myReviewCount ?? -1);
  const myLatest = tr.dataset.myLatestReviewState || "unknown";

  const approvalCount = Number(tr.dataset.approvalCount ?? -1);

  if (!matchesDraftMode(isDraft, filters.draftMode)) return false;
  if (!matchesNewMode(isNewFlag, filters.newMode)) return false;
  if (!matchesApprovalMode(approvalCount, filters.approvalMode)) return false;

  if (filters.awaitingMyReview) {
    if (!(iAmRequestedReviewer && myReviewCount === 0)) return false;
  }

  if (filters.reviewedNotApproved) {
    if (!(myReviewCount > 0 && myLatest !== "APPROVED")) return false;
  }

  return true;
}

function updateRepoHeaderCount(section, visibleCount, totalCount) {
  const countEl = section.querySelector('[data-role="count"]');
  if (!countEl) return;

  if (visibleCount === totalCount) {
    countEl.textContent = `(${totalCount} Pull${totalCount !== 1 ? "s" : ""})`;
  } else {
    countEl.textContent = `(${visibleCount}/${totalCount} Pull${totalCount !== 1 ? "s" : ""})`;
  }
}

function applyFilters() {
  const filters = getFilterState();

  const sections = document.querySelectorAll(".product-section");
  for (const section of sections) {
    const totalCount = Number(section.dataset.totalCount ?? 0);
    const rows = section.querySelectorAll("tbody tr");

    if (!rows || rows.length === 0) continue;

    let visible = 0;
    for (const tr of rows) {
      const ok = rowMatchesFilters(tr, filters);
      tr.style.display = ok ? "" : "none";
      if (ok) visible++;
    }

    updateRepoHeaderCount(section, visible, totalCount);
    section.style.display = visible === 0 ? "none" : "";
  }
}

function clearFilters() {
  $(FILTER_IDS.awaitingMyReview).checked = false;
  $(FILTER_IDS.reviewedNotApproved).checked = false;

  $(FILTER_IDS.approvalMode).value = "any";
  $(FILTER_IDS.newMode).value = "any";
  $(FILTER_IDS.draftMode).value = "any";

  applyFilters();
}

function setupFilters() {
  $(FILTER_IDS.awaitingMyReview).addEventListener("change", applyFilters);
  $(FILTER_IDS.reviewedNotApproved).addEventListener("change", applyFilters);

  $(FILTER_IDS.approvalMode).addEventListener("change", applyFilters);
  $(FILTER_IDS.newMode).addEventListener("change", applyFilters);
  $(FILTER_IDS.draftMode).addEventListener("change", applyFilters);

  $("clearFiltersBtn").addEventListener("click", clearFilters);
}

/***********************
 * Orchestrator (progressive)
 ***********************/
async function loadPRs() {
  clearBannerError();

  const token = $("token").value.trim();
  let reviewer = $("username").value.trim();

  if (!token) {
    alert("Please enter GitHub token");
    return;
  }

  const headers = buildHeaders(token);

  // ✅ Auto-detect username from token if empty
  if (!reviewer) {
    try {
      const me = await fetchAuthenticatedUser(headers);
      reviewer = me.login;
      $("username").value = reviewer;
    } catch (e) {
      setBannerError(`Could not determine username from token. ${formatError(e)}`);
      return;
    }
  }

  localStorage.setItem(STORAGE_KEYS.token, token);
  localStorage.setItem(STORAGE_KEYS.username, reviewer);

  userCache.clear();

  const container = $("productSections");
  const loader = $("loader");

  container.innerHTML = "";
  show(loader);

  const placeholders = new Map();
  for (const repo of REPOS) {
    const placeholder = createPlaceholderSection(repo);
    placeholders.set(repo, placeholder);
    container.appendChild(placeholder);
  }

  let loadedCount = 0;
  setLoadingProgress(loadedCount, REPOS.length);

  await mapLimit(REPOS, REPO_CONCURRENCY, async (repo) => {
    const section = await buildRepoSection({ repo, reviewer, headers });

    const placeholder = placeholders.get(repo);
    if (!placeholder) return;

    if (!section) placeholder.remove();
    else placeholder.replaceWith(section);

    loadedCount++;
    setLoadingProgress(loadedCount, REPOS.length);

    applyFilters();
  });

  hide(loader);

  const remainingSections = [...container.querySelectorAll(".product-section")];
  const errorSections = remainingSections.filter((s) =>
      s.textContent.includes("Failed to load this repository")
  ).length;

  if (remainingSections.length > 0 && errorSections === remainingSections.length) {
    setBannerError("All repositories failed to load. Check token / permissions / GitHub rate limit.");
  }
}

/***********************
 * Dark mode + init
 ***********************/
function applySavedDarkMode() {
  const enabled = localStorage.getItem(STORAGE_KEYS.darkMode) === "true";
  document.body.classList.toggle("dark-mode", enabled);
  $("darkToggle").checked = enabled;
}

function setupDarkModeToggle() {
  $("darkToggle").addEventListener("change", (e) => {
    document.body.classList.toggle("dark-mode", e.target.checked);
    localStorage.setItem(STORAGE_KEYS.darkMode, String(e.target.checked));
  });
}

function setupLoadButton() {
  $("loadBtn").addEventListener("click", loadPRs);
}

function restoreSavedCredentialsAndAutoload() {
  const savedToken = localStorage.getItem(STORAGE_KEYS.token);
  const savedUsername = localStorage.getItem(STORAGE_KEYS.username);

  if (savedToken) {
    $("token").value = savedToken;
  }
  if (savedUsername) {
    $("username").value = savedUsername;
  }

  if (savedToken) {
    loadPRs();
  }
}

function init() {
  hide($("loader"));
  hide($("errorBanner"));

  applySavedDarkMode();
  setupDarkModeToggle();
  setupLoadButton();
  setupFilters();

  applyFilters();
  restoreSavedCredentialsAndAutoload();
}

window.addEventListener("DOMContentLoaded", init);
window.loadPRs = loadPRs;
