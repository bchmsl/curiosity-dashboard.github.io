/***********************
 * App metadata
 ***********************/
const APP_VERSION = "v3.0.0";

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
  "Android-Space-Feature-CreditCard",
];

const REPO_CONCURRENCY = 3;
const PR_CONCURRENCY = 4;

const SESSION_KEYS = {
    token: "github_token",
};
const LOCAL_KEYS = {
    username: "github_username",
    darkMode: "dark_mode",
    collapsedPrefix: "collapsed_",
    filters: "filters_state_v2",
    presets: "filters_presets_v1",
};

const IGNORED_COMMENTERS = new Set(["zura-adod"]);
const NEW_WINDOW_DAYS = 2;

/***********************
 * DOM helpers
 ***********************/
const $ = (id) => document.getElementById(id);

function show(el) {
    el.style.display = "block";
}

function hide(el) {
    el.style.display = "none";
}

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

    return date.toLocaleDateString(undefined, {month: "short", day: "numeric"});
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

    const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
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
    return {Authorization: `token ${token}`};
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
        res = await fetch(url, {headers});
    } catch (e) {
        const err = new Error(`Network error while calling GitHub: ${e?.message || e}`);
        err.kind = "network";
        throw err;
    }

    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");

    if (!res.ok) {
        let body = null;
        try {
            body = await res.json();
        } catch { /* ignore */
        }

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

function escapeHtml(str) {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

async function renderUserBlock(username, reviewer, headers) {
    const highlightClass = username === reviewer ? "highlight" : "";
    const user = await getUser(username, headers);

    const safeUsername = escapeHtml(username);

    // ✅ Native tooltip: full username on hover
    return `<div class="user-block ${highlightClass}" title="${safeUsername}">
    <img src="${user.avatar_url}" alt="${safeUsername}" />
    <span class="user-name" title="${safeUsername}">${safeUsername}</span>
  </div>`;
}

/***********************
 * Review parsing
 ***********************/
function buildLatestReviewStateMap(reviews) {
    const latest = new Map(); // user -> {state, time}

    for (const r of reviews || []) {
        const user = r?.user?.login;
        if (!user) continue;

        const t = new Date(r.submitted_at || 0).getTime();
        const prev = latest.get(user);

        if (!prev || t > prev.time) {
            latest.set(user, {state: r.state, time: t});
        }
    }

    return new Map([...latest.entries()].map(([u, v]) => [u, v.state]));
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
    const submitted = new Set((reviews || []).map((r) => r.user.login));
    return requestedReviewers.filter((r) => !submitted.has(r));
}

function computeTotalReviewersCount({requestedReviewers, approvals, changesRequested, commented}) {
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
    return `${LOCAL_KEYS.collapsedPrefix}${repo}`;
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

/**
 * ✅ Column width ratios (total 100%)
 * Title gets the most.
 */
const COLUMN_WIDTHS = {
    title: "30%",
    author: "10%",
    created: "5%",
    stats: "15%",
    approvals: "10%",
    changes: "10%",
    commented: "10%",
    awaiting: "10%",
};

function renderSectionHeaderHtml({repo, headerLabel, collapsed}) {
    return `
    <h2>
      <a href="https://github.com/${ORG}/${repo}/pulls" target="_blank" class="repo-link-icon" onclick="event.stopPropagation()">🔗</a>
      <span class="header-title" style="flex-grow: 1; cursor: pointer;">${headerLabel}</span>
      <span class="collapse-toggle">${collapsed ? "◁" : "▼"}</span>
    </h2>

    <div class="pr-table-wrap">
      <table class="pr-table">
        <colgroup>
          <col class="col-title" style="width:${COLUMN_WIDTHS.title}">
          <col class="col-author" style="width:${COLUMN_WIDTHS.author}">
          <col class="col-created" style="width:${COLUMN_WIDTHS.created}">
          <col class="col-stats" style="width:${COLUMN_WIDTHS.stats}">
          <col class="col-approvals" style="width:${COLUMN_WIDTHS.approvals}">
          <col class="col-changes" style="width:${COLUMN_WIDTHS.changes}">
          <col class="col-commented" style="width:${COLUMN_WIDTHS.commented}">
          <col class="col-awaiting" style="width:${COLUMN_WIDTHS.awaiting}">
        </colgroup>

        <thead>
          <tr>
            <th>Title</th>
            <th>Author</th>
            <th>Created</th>
            <th>Stats</th>
            <th>Approvals</th>
            <th>Changes Requested</th>
            <th>Commented</th>
            <th>Awaiting</th>
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
    section.innerHTML = renderSectionHeaderHtml({repo, headerLabel, collapsed});

    const holder = document.createElement("div");
    holder.className = "repo-loading";
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
async function renderPrRow({pr, reviewer, headers}) {
    const newPR = isNew(pr.created_at);

    const author = pr.user.login;
    const authorBlock = await renderUserBlock(author, reviewer, headers);
    const statusLabel = renderStatusLabel(pr.draft);

    let commitCount = "—";
    let fileCount = -1;

    const requestedReviewers = (pr.requested_reviewers || []).map((r) => r.login);
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

        const myReviews = (reviews || [])
            .filter((r) => r?.user?.login === reviewer)
            .slice()
            .sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime());

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

    // ✅ Faded columns when empty
    const approvalsEmptyClass = approvals.length === 0 ? "empty-column" : "";
    const changesEmptyClass = changesRequested.length === 0 ? "empty-column" : "";
    const commentedEmptyClass = commented.length === 0 ? "empty-column" : "";
    const awaitingEmptyClass = awaitingReviewers.length === 0 ? "empty-column" : "";

    const tr = document.createElement("tr");
    tr.className = pr.draft ? "draft" : "";

    tr.innerHTML = `
    <td data-label="Title">
      <div style="display: flex; gap: 0.5rem; align-items: flex-start;">
        <div style="flex-shrink: 0;">${statusLabel}</div>
        <a href="${pr.html_url}" target="_blank" style="display: inline-block; white-space: normal;">
          ${escapeHtml(pr.title)}
          <span style="color: #57606a; font-weight: normal;">#${pr.number}</span>
        </a>
      </div>
    </td>

    <td data-label="Author">${authorBlock}</td>

    <td data-label="Created">
      <div class="created-cell">
        <span class="created-time">${timeAgo(pr.created_at)}</span>
        ${newPR ? '<span class="new-tag">New</span>' : ""}
      </div>
    </td>

    <td data-label="Stats">
      📝 <span class="${Number(fileCount) > 15 ? "files-warning" : ""}">
        ${fileCount < 0 ? "—" : `${fileCount} file${fileCount === 1 ? "" : "s"} changed`}
      </span><br>
      📦 ${commitCount} commit${commitCount === 1 ? "" : "s"}
      ${statsNote}
    </td>

    <td data-label="Approvals" class="${approvalsEmptyClass}">
      <div><strong>${approvalHeader}</strong><br>${approvalsHtml}</div>
    </td>

    <td data-label="Changes" class="${changesEmptyClass}">
      <div><strong>${changesHeader}</strong><br>${changesHtml}</div>
    </td>

    <td data-label="Commented" class="${commentedEmptyClass}">
      <div><strong>${commentedHeader}</strong><br>${commentedHtml}</div>
    </td>

    <td data-label="Awaiting" class="${awaitingEmptyClass}">
      <div><strong>${awaitingHeader}</strong><br>${awaitingHtml}</div>
    </td>
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
async function buildRepoSection({repo, reviewer, headers}) {
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
        section.innerHTML = renderSectionHeaderHtml({repo, headerLabel, collapsed});

        const msg = document.createElement("div");
        msg.className = "repo-error";
        msg.innerHTML = `⚠️ Failed to load this repository.<br><span style="font-size:0.85rem; opacity:0.85;">${escapeHtml(
            formatError(e)
        )}</span>`;

        section.appendChild(msg);
        attachCollapseHandler(section, repo);
        return section;
    }

    const tbody = document.createElement("tbody");
    const rows = await mapLimit(prs, PR_CONCURRENCY, async (pr) => renderPrRow({pr, reviewer, headers}));

    for (const tr of rows) tbody.appendChild(tr);
    if (tbody.children.length === 0) return null;

    const total = tbody.children.length;
    const repoName = cleanRepoName(repo);
    const collapsed = isRepoCollapsed(repo);

    section.classList.toggle("collapsed", collapsed);
    section.dataset.repo = repo;
    section.dataset.totalCount = String(total);

    const headerLabel = `📁 ${repoName} <span class="repo-pr-count" data-role="count">(${total} Pull${total !== 1 ? "s" : ""})</span>`;
    section.innerHTML = renderSectionHeaderHtml({repo, headerLabel, collapsed});

    section.querySelector("table").appendChild(tbody);
    attachCollapseHandler(section, repo);

    return section;
}

/***********************
 * Filters (with persistence + presets)
 ***********************/
const FILTER_IDS = {
    awaitingMyReview: "filterAwaitingMyReview",
    reviewedNotApproved: "filterReviewedNotApproved",
    approvalMode: "approvalFilter",
    newMode: "newFilter",
    draftMode: "draftFilter",
};

const DEFAULT_FILTERS = {
    awaitingMyReview: false,
    reviewedNotApproved: false,
    approvalMode: "any",
    newMode: "any",
    draftMode: "hideDrafts",
};

let activePresetId = null;

function normalizeFilters(filters) {
    return {
        awaitingMyReview: !!filters.awaitingMyReview,
        reviewedNotApproved: !!filters.reviewedNotApproved,
        approvalMode: String(filters.approvalMode ?? DEFAULT_FILTERS.approvalMode),
        newMode: String(filters.newMode ?? DEFAULT_FILTERS.newMode),
        draftMode: String(filters.draftMode ?? DEFAULT_FILTERS.draftMode),
    };
}

function filtersEqual(a, b) {
    const A = normalizeFilters(a);
    const B = normalizeFilters(b);
    return (
        A.awaitingMyReview === B.awaitingMyReview &&
        A.reviewedNotApproved === B.reviewedNotApproved &&
        A.approvalMode === B.approvalMode &&
        A.newMode === B.newMode &&
        A.draftMode === B.draftMode
    );
}

function getFilterState() {
    return normalizeFilters({
        awaitingMyReview: $(FILTER_IDS.awaitingMyReview).checked,
        reviewedNotApproved: $(FILTER_IDS.reviewedNotApproved).checked,
        approvalMode: $(FILTER_IDS.approvalMode).value,
        newMode: $(FILTER_IDS.newMode).value,
        draftMode: $(FILTER_IDS.draftMode).value,
    });
}

function saveFiltersToStorage(filters) {
    try {
        localStorage.setItem(LOCAL_KEYS.filters, JSON.stringify(normalizeFilters(filters)));
    } catch { /* ignore */
    }
}

function loadFiltersFromStorage() {
    try {
        const raw = localStorage.getItem(LOCAL_KEYS.filters);
        if (!raw) return null;
        return normalizeFilters(JSON.parse(raw));
    } catch {
        return null;
    }
}

function setFiltersUI(filters) {
    const f = normalizeFilters(filters);
    $(FILTER_IDS.awaitingMyReview).checked = f.awaitingMyReview;
    $(FILTER_IDS.reviewedNotApproved).checked = f.reviewedNotApproved;
    $(FILTER_IDS.approvalMode).value = f.approvalMode;
    $(FILTER_IDS.newMode).value = f.newMode;
    $(FILTER_IDS.draftMode).value = f.draftMode;
}

function restoreSavedFilters() {
    const saved = loadFiltersFromStorage();
    if (saved) setFiltersUI(saved);
    else setFiltersUI(DEFAULT_FILTERS);
}

function loadPresets() {
    try {
        const raw = localStorage.getItem(LOCAL_KEYS.presets);
        const arr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(arr)) return [];
        return arr
            .filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && p.filters)
            .map((p) => ({...p, filters: normalizeFilters(p.filters)}));
    } catch {
        return [];
    }
}

function savePresets(presets) {
    try {
        localStorage.setItem(LOCAL_KEYS.presets, JSON.stringify(presets));
    } catch { /* ignore */
    }
}

function findPresetById(presets, id) {
    return presets.find((p) => p.id === id) || null;
}

function findPresetByName(presets, name) {
    const n = String(name || "").trim().toLowerCase();
    return presets.find((p) => p.name.trim().toLowerCase() === n) || null;
}

function renderPresetsBar() {
    const bar = $("presetsBar");
    const presets = loadPresets();

    if (presets.length === 0) {
        bar.innerHTML = "";
        hide(bar);
        return;
    }

    show(bar);
    bar.innerHTML = presets.map((p) => {
        const active = p.id === activePresetId;
        return `
      <button class="preset-chip ${active ? "active" : ""}" data-preset-id="${p.id}" type="button">
        ${escapeHtml(p.name)}
      </button>
    `;
    }).join("");

    bar.querySelectorAll(".preset-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-preset-id");
            applyPresetById(id);
        });
    });
}

function applyPresetById(presetId) {
    const presets = loadPresets();
    const preset = findPresetById(presets, presetId);
    if (!preset) return;

    activePresetId = preset.id;
    setFiltersUI(preset.filters);
    saveFiltersToStorage(preset.filters);
    applyFilters({persist: false});

    renderPresetsBar();
    updateSaveDeleteButton();
}

function resolveActivePresetFromCurrentFilters() {
    const presets = loadPresets();
    const current = getFilterState();
    const match = presets.find((p) => filtersEqual(p.filters, current)) || null;
    activePresetId = match ? match.id : null;
}

function updateSaveDeleteButton() {
    const btn = $("savePresetBtn");
    const presets = loadPresets();
    const current = getFilterState();

    const active = activePresetId ? findPresetById(presets, activePresetId) : null;
    const isExactActive = active ? filtersEqual(active.filters, current) : false;

    if (active && isExactActive) {
        btn.textContent = "Delete";
        btn.classList.add("delete-mode");
    } else {
        btn.textContent = "Save";
        btn.classList.remove("delete-mode");
    }
}

function onSaveOrDeletePresetClick() {
    const presets = loadPresets();
    const current = getFilterState();

    const active = activePresetId ? findPresetById(presets, activePresetId) : null;
    const isExactActive = active ? filtersEqual(active.filters, current) : false;

    if (active && isExactActive) {
        const ok = confirm(`Delete preset "${active.name}"?`);
        if (!ok) return;

        const next = presets.filter((p) => p.id !== active.id);
        savePresets(next);

        activePresetId = null;
        renderPresetsBar();
        updateSaveDeleteButton();
        return;
    }

    const suggested = active ? active.name : "";
    const name = prompt("Name this filter preset:", suggested);
    if (!name) return;

    const trimmed = name.trim();
    if (!trimmed) return;

    const existingByName = findPresetByName(presets, trimmed);

    let next = presets.slice();
    let savedId;

    if (existingByName) {
        const overwrite = confirm(`Preset "${existingByName.name}" already exists. Overwrite it?`);
        if (!overwrite) return;

        const updated = {...existingByName, name: trimmed, filters: current, updatedAt: Date.now()};
        next = next.map((p) => (p.id === existingByName.id ? updated : p));
        savedId = existingByName.id;
    } else {
        const id = String(Date.now());
        next.unshift({
            id,
            name: trimmed,
            filters: current,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        savedId = id;
    }

    savePresets(next);
    activePresetId = savedId;

    renderPresetsBar();
    updateSaveDeleteButton();
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

function applyFilters({persist = true} = {}) {
    const filters = getFilterState();

    if (persist) saveFiltersToStorage(filters);

    resolveActivePresetFromCurrentFilters();

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

    renderPresetsBar();
    updateSaveDeleteButton();
}

function clearFilters() {
    setFiltersUI(DEFAULT_FILTERS);
    saveFiltersToStorage(DEFAULT_FILTERS);

    activePresetId = null;
    applyFilters({persist: false});
}

function setupFilters() {
    const onChange = () => applyFilters({persist: true});

    $(FILTER_IDS.awaitingMyReview).addEventListener("change", onChange);
    $(FILTER_IDS.reviewedNotApproved).addEventListener("change", onChange);

    $(FILTER_IDS.approvalMode).addEventListener("change", onChange);
    $(FILTER_IDS.newMode).addEventListener("change", onChange);
    $(FILTER_IDS.draftMode).addEventListener("change", onChange);

    $("clearFiltersBtn").addEventListener("click", clearFilters);
    $("savePresetBtn").addEventListener("click", onSaveOrDeletePresetClick);
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

    sessionStorage.setItem(SESSION_KEYS.token, token);
    localStorage.setItem(LOCAL_KEYS.username, reviewer);

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
        const section = await buildRepoSection({repo, reviewer, headers});

        const placeholder = placeholders.get(repo);
        if (!placeholder) return;

        if (!section) placeholder.remove();
        else placeholder.replaceWith(section);

        loadedCount++;
        setLoadingProgress(loadedCount, REPOS.length);

        applyFilters({persist: false});
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
 * Footer init
 ***********************/
function setupFooterMeta() {
    const ver = $("appVersion");
    if (ver) ver.textContent = APP_VERSION;

    const year = $("appYear");
    if (year) year.textContent = `© ${new Date().getFullYear()}`;
}

/***********************
 * Dark mode + init
 ***********************/
function applySavedDarkMode() {
    const enabled = localStorage.getItem(LOCAL_KEYS.darkMode) === "true";
    document.body.classList.toggle("dark-mode", enabled);
    $("darkToggle").checked = enabled;
}

function setupDarkModeToggle() {
    $("darkToggle").addEventListener("change", (e) => {
        document.body.classList.toggle("dark-mode", e.target.checked);
        localStorage.setItem(LOCAL_KEYS.darkMode, String(e.target.checked));
    });
}

function setupLoadButton() {
    $("loadBtn").addEventListener("click", loadPRs);
}

function restoreSavedCredentialsAndAutoload() {
    const savedToken = sessionStorage.getItem(SESSION_KEYS.token);
    const savedUsername = localStorage.getItem(LOCAL_KEYS.username);

    if (savedToken) $("token").value = savedToken;
    if (savedUsername) $("username").value = savedUsername;

    if (savedToken) loadPRs();
}

function init() {
    hide($("loader"));
    hide($("errorBanner"));

    setupFooterMeta();

    applySavedDarkMode();
    setupDarkModeToggle();

    restoreSavedFilters();
    resolveActivePresetFromCurrentFilters();
    renderPresetsBar();
    updateSaveDeleteButton();

    setupFilters();
    setupLoadButton();

    applyFilters({persist: false});
    restoreSavedCredentialsAndAutoload();
}

window.addEventListener("DOMContentLoaded", init);
window.loadPRs = loadPRs;
