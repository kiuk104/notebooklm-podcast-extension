const fields = {
  token: document.getElementById("token"),
  repo: document.getElementById("repo"),
  rssMode: document.getElementById("rss-mode"),
  committerName: document.getElementById("committer-name"),
  committerEmail: document.getElementById("committer-email"),
  autoDownloadNew: document.getElementById("auto-download-new"),
  bulkSkipOlderDays: document.getElementById("bulk-skip-older-days"),
  deleteLocalOnPushSuccess: document.getElementById("delete-local-on-push"),
};
const statusEl = document.getElementById("status");
const feedUrlEl = document.getElementById("feed-url");
const openFeedEl = document.getElementById("open-feed");
const copyFeedBtn = document.getElementById("copy-feed");
const langSelectEl = document.getElementById("lang-select");

const KEYS = ["token", "repo", "rssMode", "committerName", "committerEmail", "autoDownloadNew", "bulkSkipOlderDays", "deleteLocalOnPushSuccess"];
const RSS_MODE_DEFAULT = "actions";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

// 다기기간 동기화: GitHub 설정 + uiLang 은 chrome.storage.sync 보관, 다른 기기와
// 자동 공유. background.js 의 동일 헬퍼와 짝 — 옛 데이터는 SW startup migration
// 으로 옮겨지지만 옵션 페이지가 먼저 떠도 안전하게 sync→local fallback. 자세한
// 정당화는 background.js 의 CFG_KEYS 주석 참고.
const CFG_KEYS = [
  "token", "repo", "rssMode", "autoDownloadNew",
  "committerName", "committerEmail", "uiLang",
];

async function cfgGet(keys) {
  const want = keys ?? CFG_KEYS;
  const [s, l] = await Promise.all([
    chrome.storage.sync.get(want).catch(() => ({})),
    chrome.storage.local.get(want).catch(() => ({})),
  ]);
  const out = {};
  for (const k of want) out[k] = s[k] !== undefined ? s[k] : l[k];
  return out;
}

async function cfgSet(obj) {
  await chrome.storage.sync.set(obj);
  try { await chrome.storage.local.remove(Object.keys(obj)); } catch {}
}

(async () => {
  // ui lang 먼저 — applyTranslations() 후에야 나머지 dynamic render 가 올바른 언어로.
  // 우선순위: 사용자가 셀렉터로 명시 선택한 값 > Chrome 브라우저 UI 언어 > navigator.language > ko.
  // chrome.i18n.getUILanguage() 가 "ko-KR"/"en-US"/"de-DE" 형태로 줌 — 앞 2자만 사용.
  const langStored = await cfgGet(["uiLang"]);
  let lang = langStored.uiLang;
  if (!lang) {
    const chromeLang = (chrome.i18n?.getUILanguage?.() || navigator.language || "ko").toLowerCase().slice(0, 2);
    lang = chromeLang;
  }
  i18nSetLang(["ko", "en", "de"].includes(lang) ? lang : "ko");
  if (langSelectEl) langSelectEl.value = i18nGetLang();
  refreshHelpLink();

  const stored = await cfgGet(KEYS);
  for (const k of KEYS) {
    if (k === "autoDownloadNew") {
      fields.autoDownloadNew.checked = !!stored.autoDownloadNew;
    } else if (k === "deleteLocalOnPushSuccess") {
      // default ON — 옵션이 한 번도 저장 안 됐으면 (undefined) 자동 활성. 사용자가
      // 명시적으로 false 저장한 경우만 비활성.
      fields.deleteLocalOnPushSuccess.checked = stored.deleteLocalOnPushSuccess !== false;
    } else if (k === "bulkSkipOlderDays") {
      // 빈값 / undefined 면 placeholder 의 default 가 보이도록 비워둠.
      if (stored[k] !== undefined && stored[k] !== null && stored[k] !== "") {
        fields.bulkSkipOlderDays.value = stored[k];
      }
    } else if (stored[k]) {
      fields[k].value = stored[k];
    }
  }
  if (!stored.rssMode) fields.rssMode.value = RSS_MODE_DEFAULT;
  refreshFeedUrl();
  loadStorageUsage();
})();

// 사이드바 도움말 링크가 현재 언어 매칭 help 파일로 라우팅되도록.
// help.html (ko, default) / help-en.html / help-de.html — 사용자가 언어를 바꾸면
// 바로 갱신되어, 다음 [도움말] 클릭이 그 언어 페이지로 새 탭 열림.
function refreshHelpLink() {
  const a = document.getElementById("help-link");
  if (a) {
    const lang = i18nGetLang();
    const file = lang === "en" ? "help-en.html" : lang === "de" ? "help-de.html" : "help.html";
    a.href = `../help/${file}`;
  }
  // 오류 제보 이메일 링크 — 제목에 버전 + 현재 언어 라벨을 넣어 mailto 구성. GitHub
  // 이슈 링크는 정적이라 HTML href 그대로, 이메일만 동적으로 채운다.
  const em = document.getElementById("feedback-email-link");
  if (em) {
    const ver = chrome.runtime.getManifest().version;
    const subject = encodeURIComponent(`[NotebookLM Podcast Sync v${ver}] ${t("sidebar.feedback")}`);
    em.href = `mailto:kiuk104@gmail.com?subject=${subject}`;
  }
}

if (langSelectEl) {
  langSelectEl.addEventListener("change", async () => {
    const v = langSelectEl.value;
    await cfgSet({ uiLang: v });
    i18nSetLang(v);
    // dynamic render 를 다시 — 진행 모니터 / 직전 스캔 / 에피소드 목록 의 동적 텍스트.
    if (lastRenderedState) renderTaskState(lastRenderedState);
    renderLastScanPanel();
    if (epItems.length > 0) renderEpisodeTable();
    // 선택해서 받기 트리가 열려있으면 태그 텍스트 재렌더.
    if (pickEl && pickEl.style.display === "block" && pickState) {
      renderPickTree();
      lastScanPickToggleBtn.textContent = t("monitor.lastScan.pickClose");
    }
    refreshHelpLink();
    // sidebar version label.
    try {
      const v2 = chrome.runtime.getManifest().version;
      const el = document.getElementById("sidebar-version");
      if (el) el.textContent = `v${v2} · ${t("sidebar.subtitle")}`;
    } catch {}
  });
}

function refreshFeedUrl() {
  const repo = fields.repo.value.trim();
  if (!REPO_RE.test(repo)) {
    feedUrlEl.value = "";
    openFeedEl.href = "#";
    openFeedEl.style.pointerEvents = "none";
    openFeedEl.style.opacity = "0.4";
    copyFeedBtn.disabled = true;
    copyFeedBtn.style.opacity = "0.4";
    copyFeedBtn.style.cursor = "not-allowed";
    return;
  }
  const [owner, name] = repo.split("/");
  const url = `https://${owner}.github.io/${name}/feed.xml`;
  feedUrlEl.value = url;
  openFeedEl.href = url;
  openFeedEl.style.pointerEvents = "";
  openFeedEl.style.opacity = "1";
  copyFeedBtn.disabled = false;
  copyFeedBtn.style.opacity = "";
  copyFeedBtn.style.cursor = "pointer";
}

fields.repo.addEventListener("input", refreshFeedUrl);

copyFeedBtn.addEventListener("click", async () => {
  if (!feedUrlEl.value) return;
  try {
    await navigator.clipboard.writeText(feedUrlEl.value);
  } catch {
    feedUrlEl.focus();
    feedUrlEl.select();
    document.execCommand("copy");
  }
  const original = copyFeedBtn.textContent;
  copyFeedBtn.textContent = t("github.feedUrl.copied");
  setTimeout(() => { copyFeedBtn.textContent = original; }, 1400);
});

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const repo = fields.repo.value.trim();
  if (!REPO_RE.test(repo)) {
    show(t("github.status.repoFormat"), "error");
    return;
  }
  await cfgSet({
    token: fields.token.value.trim(),
    repo,
    rssMode: fields.rssMode.value || RSS_MODE_DEFAULT,
    committerName: fields.committerName.value.trim(),
    committerEmail: fields.committerEmail.value.trim(),
    autoDownloadNew: fields.autoDownloadNew.checked,
    bulkSkipOlderDays: fields.bulkSkipOlderDays.value.trim(),
    deleteLocalOnPushSuccess: fields.deleteLocalOnPushSuccess.checked,
  });
  show(t("github.status.saved"), "success");
  loadStorageUsage();
});

function show(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status " + kind;
  statusEl.style.display = "block";
}

// 진행 모니터 + 에피소드 목록 양쪽의 저장소 사용량 박스를 동시에 갱신.
// retention 한도 도달 시 옛 episode 자동 삭제 + 2년 이전 노트북 카드는 일괄
// 다운로드에서 스킵 — 사용자가 사고 흐름을 미리 인지하도록 두 화면에 표시.
async function loadStorageUsage() {
  const ids = ["", "-ep"];
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: "storage:usage" });
  } catch { r = null; }
  for (const suffix of ids) {
    const panel = document.getElementById(`storage-usage-panel${suffix}`);
    const summary = document.getElementById(`storage-usage-summary${suffix}`);
    const meta = document.getElementById(`storage-usage-meta${suffix}`);
    const fill = document.getElementById(`storage-usage-fill${suffix}`);
    if (!panel) continue;
    if (!r?.ok) { panel.style.display = "none"; continue; }
    panel.style.display = "block";
    const usedMB = r.totalBytes / 1024 / 1024;
    const maxMB = r.maxTotalMB;
    const pct = maxMB ? Math.min(100, (usedMB / maxMB) * 100) : 0;
    summary.textContent = maxMB
      ? t("monitor.storage.summary", { used: usedMB.toFixed(1), max: maxMB.toFixed(0), count: r.fileCount, pct: pct.toFixed(0) })
      : t("monitor.storage.summaryNoLimit", { used: usedMB.toFixed(1), count: r.fileCount });
    meta.textContent = t("monitor.storage.skipDays", { n: r.skipOlderDays });
    fill.style.width = pct.toFixed(0) + "%";
    fill.style.background = pct > 90 ? "#dc2626" : pct > 75 ? "#f59e0b" : "#10b981";
  }
}

// 에피소드 페이지의 스킵 목록 토글 패널. shortId 외 메타 (filename, title, date,
// notebookTitle, skippedAt) 도 표시 — 사용자가 어떤 파일을 스킵 등록했는지 사후 확인.
async function renderSkipPanel() {
  const panel = document.getElementById("ep-skip-panel");
  const listEl = document.getElementById("ep-skip-list");
  const countEl = document.getElementById("ep-skip-count");
  if (!panel) return;
  const r = await chrome.runtime.sendMessage({ type: "skip:list" }).catch(() => null);
  const entries = r?.entries || [];
  countEl.textContent = t("episodes.skip.count", { n: entries.length });
  listEl.innerHTML = "";
  if (entries.length === 0) {
    listEl.innerHTML = `<div class="hint" style="margin:0;">${escapeHtml(t("episodes.skip.empty"))}</div>`;
    return;
  }
  // 등록 시각 역순 (최근 등록한 게 위). skippedAt 0 (옛 마이그레이션) 은 맨 아래.
  const sorted = entries.slice().sort((a, b) => (b.skippedAt || 0) - (a.skippedAt || 0));
  for (const e2 of sorted) {
    const row = document.createElement("div");
    row.style.cssText = "padding:6px 0; border-bottom:1px solid #eee;";
    const dateStr = e2.skippedAt ? new Date(e2.skippedAt).toLocaleDateString() : "—";
    const epDate = e2.date
      ? `${e2.date.slice(0, 4)}-${e2.date.slice(4, 6)}-${e2.date.slice(6, 8)}`
      : "";
    const titleLine = e2.title
      ? `<div style="font-size:13px;">${escapeHtml(e2.title)}</div>`
      : e2.filename
        ? `<div style="font-size:13px; color:#666;">${escapeHtml(e2.filename)}</div>`
        : `<div style="font-size:13px; color:#999; font-style:italic;">${escapeHtml(t("episodes.skip.noMeta"))}</div>`;
    const metaLine = (epDate || e2.notebookTitle)
      ? `<div style="font-size:12px; color:#888; margin-top:2px;">${escapeHtml([epDate, e2.notebookTitle].filter(Boolean).join(" · "))}</div>`
      : "";
    row.innerHTML = `
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
        <div style="flex:1; min-width:0;">
          ${titleLine}
          ${metaLine}
          <div style="font-size:11px; color:#aaa; margin-top:2px;">
            <code>${escapeHtml(e2.shortId)}</code>
            <span style="margin-left:8px;">${escapeHtml(t("episodes.skip.skippedAt", { date: dateStr }))}</span>
          </div>
        </div>
        <button type="button" class="ep-skip-unset" data-sid="${escapeHtml(e2.shortId)}" style="font-size:12px; padding:2px 8px; flex-shrink:0;">${escapeHtml(t("episodes.skip.unset"))}</button>
      </div>`;
    listEl.appendChild(row);
  }
}

document.addEventListener("click", async (e) => {
  const t2 = e.target;
  // [한도 초과분 정리] — retention.maxTotalMB 한도 넘는 옛 파일 ghDelete + 영구 스킵
  // 등록. workflow 의 retention 컷과 같은 알고리즘이지만 익스텐션 스킵 목록에도
  // 등록돼 다음 스캔에 같은 카드가 신규로 다시 안 잡힘. 명시 클릭만 동작.
  if (t2.classList?.contains("storage-cleanup-btn")) {
    if (!confirm(t("monitor.storage.cleanup.confirm"))) return;
    t2.disabled = true;
    const origText = t2.textContent;
    t2.textContent = t("monitor.storage.cleanup.running");
    try {
      const r = await chrome.runtime.sendMessage({ type: "storage:cleanup" });
      if (!r?.ok) throw new Error(r?.error || "cleanup failed");
      const droppedMB = (r.droppedBytes / 1024 / 1024).toFixed(1);
      if (r.droppedCount === 0) {
        alert(t("monitor.storage.cleanup.noOp"));
      } else {
        alert(t("monitor.storage.cleanup.done", { count: r.droppedCount, mb: droppedMB }));
      }
      await loadStorageUsage();
      // 에피소드 페이지면 목록도 갱신.
      if (document.getElementById("page-episodes")?.classList.contains("active")) {
        await loadEpisodeList();
      }
      if (document.getElementById("ep-skip-panel")?.style.display === "block") {
        await renderSkipPanel();
      }
    } catch (err) {
      alert(t("monitor.storage.cleanup.fail", { msg: err.message }));
    } finally {
      t2.disabled = false;
      t2.textContent = origText;
    }
    return;
  }
  if (t2.id === "ep-skip-toggle") {
    const panel = document.getElementById("ep-skip-panel");
    if (panel.style.display === "none") {
      panel.style.display = "block";
      await renderSkipPanel();
    } else {
      panel.style.display = "none";
    }
    return;
  }
  if (t2.id === "ep-skip-clear") {
    if (!confirm(t("episodes.skip.confirmClear"))) return;
    await chrome.runtime.sendMessage({ type: "skip:clear" });
    await renderSkipPanel();
    return;
  }
  if (t2.classList?.contains("ep-skip-unset")) {
    const sid = t2.dataset.sid;
    await chrome.runtime.sendMessage({ type: "skip:remove", shortId: sid });
    await renderSkipPanel();
    return;
  }
});

document.getElementById("toggle-token").addEventListener("click", () => {
  const t = fields.token;
  const btn = document.getElementById("toggle-token");
  if (t.type === "password") {
    t.type = "text";
    btn.textContent = "🙈";
  } else {
    t.type = "password";
    btn.textContent = "👁";
  }
});

document.getElementById("verify").addEventListener("click", async () => {
  const token = fields.token.value.trim();
  const repo = fields.repo.value.trim();
  if (!token) return show(t("github.status.tokenEmpty"), "error");
  if (!REPO_RE.test(repo)) return show(t("github.status.repoFormat"), "error");
  show(t("github.status.verifying"), "");
  try {
    const userR = await fetch("https://api.github.com/user", { headers: ghHeaders(token) });
    if (userR.status === 401) return show(t("github.status.tokenInvalid"), "error");
    if (!userR.ok) return show(`✗ /user ${userR.status}: ${(await userR.text()).slice(0, 120)}`, "error");
    const user = await userR.json();

    const repoR = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token) });
    if (repoR.status === 404) return show(t("github.status.repoNotFound", { user: user.login, repo }), "error");
    if (!repoR.ok) return show(`✗ /repos/${repo} ${repoR.status}: ${(await repoR.text()).slice(0, 120)}`, "error");
    const repoData = await repoR.json();
    const canPush = repoData.permissions?.push;
    if (canPush === false) return show(t("github.status.noPush", { user: user.login }), "error");
    show(t("github.status.ok", { user: user.login, repo }), "success");
  } catch (e) {
    show(t("github.status.network", { msg: e.message }), "error");
  }
});

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ---------- 진행 모니터 (모든 노트북 스캔 / 일괄 다운로드) ----------

const taskPanel = document.getElementById("task-panel");
const taskTitleEl = document.getElementById("task-title");
const taskStatusEl = document.getElementById("task-status");
const taskElapsedEl = document.getElementById("task-elapsed");
const taskMessageEl = document.getElementById("task-message");
const progressFillEl = document.getElementById("progress-fill");
const taskStatsEl = document.getElementById("task-stats");
const taskErrorsEl = document.getElementById("task-errors");
const taskRecentHeadEl = document.getElementById("task-recent-head");
const taskRecentSummaryEl = document.getElementById("task-recent-summary");
const taskRecentEl = document.getElementById("task-recent");
const taskActionsEl = document.getElementById("task-actions");
const taskClearBtn = document.getElementById("task-clear");
const taskCancelBtn = document.getElementById("task-cancel");
const cardProgressEl = document.getElementById("card-progress");
const cardProgressTitleEl = document.getElementById("card-progress-title");
const cardProgressStageEl = document.getElementById("cp-stage-label");
const cardProgressBytesEl = document.getElementById("cp-bytes");
const cardProgressFillEl = document.getElementById("card-progress-fill");

function taskLabel(task) {
  if (task === "scan:all") return t("task.label.scan");
  if (task === "bulk:remote") return t("task.label.bulk");
  return task;
}
function statusLabel(status) {
  const map = { idle: "task.status.idle", running: "task.status.running", completed: "task.status.completed", failed: "task.status.failed" };
  return map[status] ? t(map[status]) : status;
}

let lastRenderedState = null;
let elapsedTimer = null;

function formatElapsed(ms) {
  if (!ms || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return t("time.sec", { n: sec });
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return t("time.min", { m: min, s: remSec });
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return t("time.hour", { h: hr, m: remMin });
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

function formatTimeAgo(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return t("time.ago.sec", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("time.ago.min", { n: min });
  const hr = Math.floor(min / 60);
  return t("time.ago.hour", { n: hr });
}

// 현재 카드의 byte-stage 진행률. background 가 setTaskState({currentCardProgress})
// 로 갱신하면 broadcast 되어 여기서 라이브 표시. 카드 push 끝나면 null 로 리셋되면서
// 패널이 자동 hidden. running 상태가 아니면 표시 안 함 (예: 완료 후 stale 값).
function renderCardProgress(progress, status) {
  if (!progress || !progress.episodeTitle || status !== "running") {
    cardProgressEl.style.display = "none";
    return;
  }
  cardProgressEl.style.display = "block";
  cardProgressTitleEl.textContent = progress.episodeTitle;
  cardProgressTitleEl.title = progress.episodeTitle;
  cardProgressStageEl.textContent = stageLabel(progress.stage);
  if (progress.bytes && progress.totalBytes) {
    const pct = Math.min(100, (progress.bytes / progress.totalBytes) * 100);
    cardProgressFillEl.style.width = pct.toFixed(1) + "%";
    cardProgressBytesEl.textContent = `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`;
  } else if (progress.bytes) {
    // totalBytes 모름 (Content-Length 없는 응답) — fill 은 30% 임시.
    cardProgressFillEl.style.width = "30%";
    cardProgressBytesEl.textContent = formatBytes(progress.bytes);
  } else {
    cardProgressFillEl.style.width = "0%";
    cardProgressBytesEl.textContent = "";
  }
}

// 진행 stage → 표시 텍스트. i18n key 있으면 그쪽, 없으면 stage 그대로 노출.
function stageLabel(stage) {
  const key = `monitor.cardProgress.stage.${stage}`;
  const translated = t(key);
  // i18n 미정의면 t() 가 key 자체를 반환 — 그 경우 fallback 으로 stage raw.
  return translated === key ? stage : translated;
}

function renderRecentPushes(recent) {
  if (!recent || recent.length === 0) {
    taskRecentHeadEl.style.display = "none";
    taskRecentEl.style.display = "none";
    return;
  }
  taskRecentHeadEl.style.display = "flex";
  taskRecentEl.style.display = "block";

  // 새 항목이 위로 오게 역순 표시.
  const reversed = recent.slice().reverse();

  // 누적 바이트 (성공 push 만)
  let totalBytes = 0;
  let okN = 0, skipN = 0, warnN = 0, errN = 0;
  for (const p of recent) {
    if (p.ok && typeof p.size === "number") totalBytes += p.size;
    if (p.ok) okN++;
    else if (p.skipped && p.skipKind === "no-config") warnN++;
    else if (p.skipped) skipN++;
    else errN++;
  }
  const summaryParts = [];
  if (okN > 0) summaryParts.push(`✓ ${okN}`);
  if (skipN > 0) summaryParts.push(`↻ ${skipN}`);
  if (warnN > 0) summaryParts.push(`⚠ ${warnN}`);
  if (errN > 0) summaryParts.push(`✗ ${errN}`);
  if (totalBytes > 0) summaryParts.push(formatBytes(totalBytes));
  taskRecentSummaryEl.textContent = summaryParts.join(" · ");

  taskRecentEl.innerHTML = reversed.map((p) => {
    const isWarn = p.skipped && p.skipKind === "no-config";
    const cls = p.ok ? "ok" : isWarn ? "warn" : p.skipped ? "skip" : "err";
    const icon = p.ok ? "✓" : isWarn ? "⚠" : p.skipped ? "↻" : "✗";
    const title = escapeHtml(p.episodeTitle || p.filename || "—");
    let detail = "";
    if (p.skipped) {
      detail = `<span class="size">${escapeHtml(p.reason || "")}</span>`;
    } else if (!p.ok) {
      detail = `<span class="size">${escapeHtml((p.error || "").slice(0, 80))}</span>`;
    } else if (p.size != null) {
      detail = `<span class="size">${formatBytes(p.size)}</span>`;
    }
    let feedTag = "";
    if (p.feedOk) feedTag = '<span class="feed-tag">+ feed</span>';
    else if (p.feedError) feedTag = `<span class="feed-tag feed-err" title="${escapeHtml(p.feedError)}">⚠ feed</span>`;
    const ago = p.timestamp ? `<span class="ts">${formatTimeAgo(Date.now() - p.timestamp)}</span>` : "";
    return `<div class="recent-item ${cls}"><span class="icon">${icon}</span> ${title}${detail}${feedTag}${ago}</div>`;
  }).join("");
}

function renderTaskState(state) {
  lastRenderedState = state;
  if (!state || state.task === null || state.status === "idle") {
    taskPanel.style.display = "none";
    stopElapsedTimer();
    return;
  }
  taskPanel.style.display = "block";
  taskPanel.className = "task-panel " + state.status;

  taskTitleEl.textContent = taskLabel(state.task);
  taskStatusEl.textContent = statusLabel(state.status);

  if (state.startedAt) {
    const ms = (state.endedAt || Date.now()) - state.startedAt;
    taskElapsedEl.textContent = formatElapsed(ms);
  } else {
    taskElapsedEl.textContent = "";
  }

  taskMessageEl.textContent = state.message || "";

  const pct = state.total > 0 ? Math.min(100, (state.done / state.total) * 100) : (state.status === "completed" ? 100 : 0);
  progressFillEl.style.width = pct.toFixed(1) + "%";

  const stats = [];
  if (state.total > 0) stats.push(`${state.done}/${state.total}`);
  if (state.notebookCount > 0) stats.push(t("monitor.summary.notebooks", { n: state.notebookCount }));
  if (state.cardCount > 0) stats.push(t("monitor.summary.cards", { n: state.cardCount }));
  if (state.successCount > 0) stats.push(`✓ ${state.successCount}`);
  if (state.errorCount > 0) stats.push(`✗ ${state.errorCount}`);
  taskStatsEl.textContent = stats.join(" · ");

  if (state.errors && state.errors.length > 0) {
    taskErrorsEl.style.display = "block";
    taskErrorsEl.innerHTML = state.errors.map((err) => {
      const label = err.episodeTitle || err.url || "(unknown)";
      return `<div>· ${escapeHtml(label)}: ${escapeHtml(err.message || "")}</div>`;
    }).join("");
  } else {
    taskErrorsEl.style.display = "none";
  }

  renderRecentPushes(state.recentPushes);
  renderCardProgress(state.currentCardProgress, state.status);

  // 진행 중에는 [강제 중단] 만, 종료 후에는 [초기화] 만 노출.
  if (state.status === "running") {
    taskActionsEl.style.display = "flex";
    taskCancelBtn.style.display = "inline-block";
    taskClearBtn.style.display = "none";
    startElapsedTimer();
  } else if (state.status === "completed" || state.status === "failed") {
    taskActionsEl.style.display = "flex";
    taskCancelBtn.style.display = "none";
    taskClearBtn.style.display = "inline-block";
    stopElapsedTimer();
  } else {
    taskActionsEl.style.display = "none";
    stopElapsedTimer();
  }
  refreshMonitorChrome();
}

function startElapsedTimer() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    if (!lastRenderedState) return;
    if (lastRenderedState.status === "running" && lastRenderedState.startedAt) {
      const ms = Date.now() - lastRenderedState.startedAt;
      taskElapsedEl.textContent = formatElapsed(ms);
    }
    // recent push 의 "X초전" 라벨도 갱신 — 진행 중에는 사용자가 시계처럼 활용.
    if (lastRenderedState.recentPushes && lastRenderedState.recentPushes.length > 0) {
      renderRecentPushes(lastRenderedState.recentPushes);
    }
  }, 1000);
}

function stopElapsedTimer() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

taskClearBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "task:state:clear" });
  // task:state 메시지가 broadcast 되어 renderTaskState 가 호출됨.
});

taskCancelBtn.addEventListener("click", async () => {
  if (!confirm(t("monitor.cancel.confirm"))) return;
  taskCancelBtn.disabled = true;
  taskCancelBtn.textContent = t("monitor.cancel.requesting");
  try {
    await chrome.runtime.sendMessage({ type: "task:cancel" });
  } catch {}
  // 실제 상태 전환은 task:state 메시지로 도착 — UI 재렌더에서 처리.
  setTimeout(() => {
    taskCancelBtn.disabled = false;
    taskCancelBtn.textContent = t("monitor.cancel");
  }, 3000);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "task:state") {
    renderTaskState(msg.state);
    // 스캔 완료 시점엔 lastScanResult 가 막 persist 됐으니, bulk:remote 완료 시점엔
    // 신규 카드 수가 줄어들었으니 — 둘 다 직전 스캔 패널 재렌더가 필요.
    // GitHub Contents API 의 list 는 PUT 직후 짧게 stale 일 수 있어 (자체 캐시 +
    // eventual consistency), 즉시 한 번 + 5초 후 한 번 더 갱신해 마지막 push 까지 반영.
    if (msg.state?.status === "completed" || msg.state?.status === "failed") {
      renderLastScanPanel();
      if (msg.state.task === "bulk:remote") {
        setTimeout(() => { renderLastScanPanel().catch(() => {}); }, 5000);
      }
    }
  }
});

// 옵션 페이지 첫 오픈 시 현재 상태 조회 — sweep 진행 중에 옵션을 열면 진행률이 바로 보임.
(async () => {
  try {
    const r = await chrome.runtime.sendMessage({ type: "task:state:get" });
    if (r?.state) renderTaskState(r.state);
  } catch {}
  await renderLastScanPanel();
})();

// ---------- 직전 스캔 결과 패널 ----------

const lastScanPanel = document.getElementById("last-scan-panel");
const lastScanWhenEl = document.getElementById("last-scan-when");
const lastScanSummaryEl = document.getElementById("last-scan-summary");
const lastScanDownloadBtn = document.getElementById("last-scan-download");
const lastScanRetryFailedBtn = document.getElementById("last-scan-retry-failed");
const lastScanRecountBtn = document.getElementById("last-scan-recount");
const lastScanClearBtn = document.getElementById("last-scan-clear");

async function renderLastScanPanel() {
  const r = await chrome.runtime.sendMessage({ type: "scan:result:get" }).catch(() => null);
  const result = r?.result;
  if (!result || !result.notebooks || result.notebooks.length === 0) {
    lastScanPanel.style.display = "none";
    refreshMonitorChrome();
    return;
  }
  const cardCount = result.notebooks.reduce((s, n) => s + (n.audios?.length || 0), 0);

  // 신규 카드 수는 background 의 scan:result:pushed 가 audio.isPushed 까지 박아주므로
  // (shortId + legacy 둘 다 반영) 그 플래그만 세면 됨. list:pushed 는 shortId 만 알아서
  // 옛 3-segment 파일이 영구 신규로 잡히는 갭이 있었음 — 같은 ghList 한 번이면 비용 동일.
  let newCount = 0;
  let placeholderCount = 0;
  let tooOldCount = 0;
  let skippedCount = 0;
  try {
    const enriched = await chrome.runtime.sendMessage({ type: "scan:result:pushed" });
    for (const nb of (enriched?.notebooks || [])) {
      for (const audio of (nb.audios || [])) {
        if (audio.isPlaceholder) { placeholderCount++; continue; }
        if (audio.isPushed) continue;
        // 옛 노트북 카드는 일괄 다운로드에서 스킵되므로 "신규" 로 안 셈.
        if (audio.isTooOld) { tooOldCount++; continue; }
        // 사용자가 명시 스킵한 카드도 "신규" 가 아님 — background 의 buildNewSelections 가
        // 어차피 거르므로 [신규 받기] 시 실제 다운로드되지 않는데, 이 카운트만 안 빼면
        // "신규 N개" 가 부풀려져 0건인데도 버튼이 활성화되는 혼란을 줬다.
        if (audio.isSkipped) { skippedCount++; continue; }
        newCount++;
      }
    }
  } catch {}

  // 직전 bulk 의 실패 카드 수 — retry 버튼 노출 결정.
  let failedCount = 0;
  try {
    const fr = await chrome.runtime.sendMessage({ type: "bulk:failed:list" });
    failedCount = fr?.cards?.length || 0;
  } catch {}

  const ageMs = Date.now() - (result.scannedAt || Date.now());
  lastScanWhenEl.textContent = formatElapsed(ageMs) + " " + t("time.ago.suffix");

  const parts = [
    t("monitor.summary.notebooks", { n: result.notebooks.length }),
    t("monitor.summary.cards", { n: cardCount }),
  ];
  if (placeholderCount > 0) parts.push(t("monitor.summary.placeholder", { n: placeholderCount }));
  if (tooOldCount > 0) parts.push(t("monitor.summary.tooOld", { n: tooOldCount }));
  if (skippedCount > 0) parts.push(t("monitor.summary.skipped", { n: skippedCount }));
  parts.push(t("monitor.summary.new", { n: newCount }));
  if (failedCount > 0) parts.push(t("monitor.summary.failed", { n: failedCount }));
  lastScanSummaryEl.textContent = parts.join(" · ");

  lastScanPanel.style.display = "block";
  lastScanDownloadBtn.disabled = newCount === 0;
  lastScanDownloadBtn.textContent = newCount === 0
    ? t("monitor.lastScan.noNew")
    : t("monitor.lastScan.newN", { n: newCount });

  if (failedCount > 0) {
    lastScanRetryFailedBtn.style.display = "inline-block";
    lastScanRetryFailedBtn.textContent = t("monitor.lastScan.retryFailed", { n: failedCount });
    lastScanRetryFailedBtn.disabled = false;
  } else {
    lastScanRetryFailedBtn.style.display = "none";
  }
  refreshMonitorChrome();
}

lastScanDownloadBtn.addEventListener("click", async () => {
  lastScanDownloadBtn.disabled = true;
  const r = await chrome.runtime.sendMessage({ type: "bulk:remote:from-last-scan" });
  if (!r?.ok) {
    show(`Bulk start failed: ${r?.error || "?"}`, "error");
    lastScanDownloadBtn.disabled = false;
    return;
  }
  // task:state 가 갱신되면서 진행 모니터에 자동으로 노출됨.
});

if (lastScanRetryFailedBtn) {
  lastScanRetryFailedBtn.addEventListener("click", async () => {
    lastScanRetryFailedBtn.disabled = true;
    const r = await chrome.runtime.sendMessage({ type: "bulk:remote:retry-failed" });
    if (!r?.ok) {
      show(`Retry failed: ${r?.error || "?"}`, "error");
      lastScanRetryFailedBtn.disabled = false;
      return;
    }
    // bulk start → task:state broadcast → renderLastScanPanel rerender.
  });
}

if (lastScanRecountBtn) {
  // GitHub Contents API 는 PUT 직후 list 응답이 짧게 stale 할 수 있어 (commit 51a5b42 참고),
  // bulk 완료 broadcast 로 자동 호출되는 renderLastScanPanel 이 가끔 옛 카운트를 그대로
  // 그릴 때가 있다. 사용자가 명시적으로 "지금 다시 봐줘" 를 누를 수 있도록 수동 새로고침.
  lastScanRecountBtn.addEventListener("click", async () => {
    lastScanRecountBtn.disabled = true;
    try {
      await renderLastScanPanel();
    } finally {
      lastScanRecountBtn.disabled = false;
    }
  });
}

lastScanClearBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "scan:result:clear" });
  lastScanPanel.style.display = "none";
  // 트리가 열려있으면 함께 정리.
  const pe = document.getElementById("last-scan-pick");
  if (pe) pe.style.display = "none";
  const tb = document.getElementById("last-scan-pick-toggle");
  if (tb) tb.textContent = t("monitor.lastScan.pick");
});

// ---------- 선택해서 받기 (cross-notebook 트리 + 카드별 체크박스) ----------
//
// 사용자가 [신규 받기] 의 "전부 다" 동작 대신 카드 단위로 골라 받고 싶을 때.
// 직전 스캔 결과 + 현재 repo 의 push 된 shortId 집합을 한 번에 가져와 트리로 표시:
//   ▾ 노트북 A  (3 신규 / 5 카드)
//      [✓] 카드1.mp3   [신규]
//      [✓] 카드2.mp3   [신규]
//      [ ] 카드3.mp3   [받음]   (default 미체크 + 흐림)
//      ...
// default: 신규 카드만 체크 + 이미 받은 카드는 숨김 (pick-show-pushed 로 토글).
// placeholder 제목 카드는 비활성 (다음 스캔에서 실제 제목 붙은 뒤 받게).

const lastScanPickToggleBtn = document.getElementById("last-scan-pick-toggle");
const pickEl = document.getElementById("last-scan-pick");
const pickTreeEl = document.getElementById("pick-tree");
const pickMasterEl = document.getElementById("pick-master");
const pickShowPushedEl = document.getElementById("pick-show-pushed");
const pickSummaryEl = document.getElementById("pick-summary");
const pickDownloadBtn = document.getElementById("pick-download");
const pickSkipBtn = document.getElementById("pick-skip");
const pickCancelBtn = document.getElementById("pick-cancel");
const pickStatusEl = document.getElementById("pick-status");

// 마지막으로 enrich 받은 데이터를 in-memory 보관 — 트리 redraw 시 재요청 안 함.
// shape: { notebooks: [...with audio.isPushed flagged...], scannedAt }
let pickState = null;

if (lastScanPickToggleBtn) {
  lastScanPickToggleBtn.addEventListener("click", async () => {
    if (pickEl.style.display === "block") {
      pickEl.style.display = "none";
      lastScanPickToggleBtn.textContent = t("monitor.lastScan.pick");
      return;
    }
    pickEl.style.display = "block";
    lastScanPickToggleBtn.textContent = t("monitor.lastScan.pickClose");
    pickStatusEl.textContent = t("pick.loading");
    pickTreeEl.innerHTML = "";
    try {
      const r = await chrome.runtime.sendMessage({ type: "scan:result:pushed" });
      if (!r?.ok) throw new Error(r?.error || "?");
      // background 가 audio.isPushed 를 직접 박아주므로 (shortId + legacy 둘 다 반영)
      // UI 는 그 플래그만 읽으면 됨. pushedSet 은 더 이상 필요 없음.
      pickState = {
        notebooks: r.notebooks || [],
        scannedAt: r.scannedAt || 0,
      };
      pickStatusEl.textContent = "";
      renderPickTree();
    } catch (e) {
      pickStatusEl.textContent = `Load failed: ${e.message}`;
    }
  });
}

if (pickCancelBtn) {
  pickCancelBtn.addEventListener("click", () => {
    pickEl.style.display = "none";
    lastScanPickToggleBtn.textContent = t("monitor.lastScan.pick");
  });
}

if (pickShowPushedEl) {
  pickShowPushedEl.addEventListener("change", () => renderPickTree());
}

if (pickMasterEl) {
  pickMasterEl.addEventListener("change", () => {
    const checked = pickMasterEl.checked;
    pickTreeEl.querySelectorAll(".pick-card-cb:not(:disabled)").forEach((cb) => {
      cb.checked = checked;
    });
    pickTreeEl.querySelectorAll(".pick-nb-cb").forEach((cb) => {
      cb.checked = checked;
      cb.indeterminate = false;
    });
    refreshPickSummary();
  });
}

function renderPickTree() {
  if (!pickState) return;
  const showPushed = !!pickShowPushedEl.checked;
  const frag = document.createDocumentFragment();
  let totalNew = 0;
  let totalPushed = 0;
  let totalPlaceholder = 0;
  let totalSkipped = 0;

  for (const nb of pickState.notebooks) {
    const nbDiv = document.createElement("div");
    nbDiv.className = "pick-nb";

    const head = document.createElement("div");
    head.className = "pick-nb-head";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "pick-nb-cb";
    const toggle = document.createElement("span");
    toggle.className = "pick-nb-toggle";
    toggle.textContent = "▾";
    const title = document.createElement("span");
    title.className = "pick-nb-title";
    title.textContent = nb.cover?.title || nb.url || "(untitled)";
    const meta = document.createElement("span");
    meta.className = "pick-nb-meta";
    head.appendChild(cb);
    head.appendChild(toggle);
    head.appendChild(title);
    head.appendChild(meta);
    nbDiv.appendChild(head);

    const cardsBox = document.createElement("div");
    cardsBox.className = "pick-cards";
    nbDiv.appendChild(cardsBox);

    let nbNew = 0, nbPushed = 0, nbPlaceholder = 0, nbSkipped = 0;
    let visibleCount = 0;
    (nb.audios || []).forEach((audio, idx) => {
      const isPushed = !!audio.isPushed;
      // 스킵 카드는 영구 제외 대상 — pushed 다음 우선순위로 분류해 "신규" 에서 뺀다.
      const isSkipped = !isPushed && !!audio.isSkipped;
      const isPlaceholder = !isPushed && !isSkipped && !!audio.isPlaceholder;
      if (isPushed) nbPushed++;
      else if (isSkipped) nbSkipped++;
      else if (isPlaceholder) nbPlaceholder++;
      else nbNew++;

      // pushed 와 마찬가지로 skipped 도 default 숨김 — "이미 받은 카드도 보기" 토글로
      // 같이 노출되지만, 다운로드 경로(runBulkRemote)가 어차피 거르므로 체크박스는
      // 비활성 + "스킵됨" 태그로만 표시.
      if ((isPushed || isSkipped) && !showPushed) return;

      visibleCount++;
      const row = document.createElement("div");
      row.className = "pick-card";
      if (isPushed) row.classList.add("is-pushed");
      if (isSkipped) row.classList.add("is-skipped");
      if (isPlaceholder) row.classList.add("is-placeholder");

      const cardCb = document.createElement("input");
      cardCb.type = "checkbox";
      cardCb.className = "pick-card-cb";
      cardCb.dataset.notebookUrl = nb.url || "";
      cardCb.dataset.cardIndex = String(idx);
      cardCb.dataset.artifactId = audio.artifactId || "";
      cardCb.dataset.episodeTitle = audio.title || "";
      // 스킵 처리 시 storage 에 메타도 같이 저장 — 옵션 페이지 스킵 패널에서
      // 어떤 파일이었는지 표시되도록.
      cardCb.dataset.coverDateAttr = nb.cover?.dateAttr || "";
      cardCb.dataset.notebookTitle = nb.cover?.title || "";
      cardCb.dataset.kind = isPushed ? "pushed" : isSkipped ? "skipped" : isPlaceholder ? "placeholder" : "new";
      // default: 신규만 체크. placeholder / skipped 는 disabled (다운로드 경로가 어차피 거절).
      cardCb.disabled = isPlaceholder || isSkipped;
      cardCb.checked = !isPushed && !isPlaceholder && !isSkipped;

      const lbl = document.createElement("label");
      const tagEl = document.createElement("span");
      tagEl.className = "pick-card-tag";
      tagEl.textContent = isPushed
        ? t("pick.tag.pushed")
        : isSkipped
          ? t("pick.tag.skipped")
          : isPlaceholder
            ? t("pick.tag.placeholder")
            : t("pick.tag.new");
      const titleEl = document.createElement("span");
      titleEl.className = "pick-card-title";
      titleEl.textContent = audio.title || `audio ${idx}`;
      lbl.appendChild(cardCb);
      lbl.appendChild(tagEl);
      lbl.appendChild(titleEl);
      row.appendChild(lbl);
      cardsBox.appendChild(row);

      cardCb.addEventListener("change", () => {
        updateNbHeadState(nbDiv);
        refreshPickSummary();
      });
    });

    totalNew += nbNew;
    totalPushed += nbPushed;
    totalPlaceholder += nbPlaceholder;
    totalSkipped += nbSkipped;

    const metaParts = [];
    metaParts.push(t("pick.nb.new", { n: nbNew }));
    if (nbPushed > 0) metaParts.push(t("pick.nb.pushed", { n: nbPushed }));
    if (nbSkipped > 0) metaParts.push(t("pick.nb.skipped", { n: nbSkipped }));
    if (nbPlaceholder > 0) metaParts.push(t("pick.nb.placeholder", { n: nbPlaceholder }));
    meta.textContent = metaParts.join(" · ");

    if (visibleCount === 0) {
      nbDiv.style.display = "none";
    }

    head.addEventListener("click", (e) => {
      // 헤더 자체 클릭은 토글, 체크박스 클릭은 별도.
      if (e.target === cb) return;
      const collapsed = cardsBox.style.display === "none";
      cardsBox.style.display = collapsed ? "" : "none";
      toggle.textContent = collapsed ? "▾" : "▸";
    });
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      cardsBox.querySelectorAll(".pick-card-cb:not(:disabled)").forEach((c) => {
        c.checked = cb.checked;
      });
      refreshPickSummary();
    });

    updateNbHeadState(nbDiv);
    frag.appendChild(nbDiv);
  }

  pickTreeEl.innerHTML = "";
  pickTreeEl.appendChild(frag);

  if (pickState.notebooks.length === 0) {
    pickTreeEl.innerHTML = `<div style="padding:12px; color:#6b7280; text-align:center;">${t("pick.empty")}</div>`;
  }

  refreshPickSummary();
}

function updateNbHeadState(nbDiv) {
  const head = nbDiv.querySelector(".pick-nb-cb");
  const cards = nbDiv.querySelectorAll(".pick-card-cb:not(:disabled)");
  if (cards.length === 0) {
    head.checked = false;
    head.indeterminate = false;
    head.disabled = true;
    return;
  }
  head.disabled = false;
  let on = 0;
  cards.forEach((c) => { if (c.checked) on++; });
  if (on === 0) {
    head.checked = false;
    head.indeterminate = false;
  } else if (on === cards.length) {
    head.checked = true;
    head.indeterminate = false;
  } else {
    head.checked = false;
    head.indeterminate = true;
  }
}

function collectPickedSelections() {
  const out = [];
  pickTreeEl.querySelectorAll(".pick-card-cb:not(:disabled)").forEach((cb) => {
    if (!cb.checked) return;
    out.push({
      notebookUrl: cb.dataset.notebookUrl,
      cardIndex: Number(cb.dataset.cardIndex),
      artifactId: cb.dataset.artifactId || "",
      episodeTitle: cb.dataset.episodeTitle || "",
    });
  });
  return out;
}

// [선택한 N개 스킵] 용 메타. addSkippedEntry 에 필요한 모든 필드를 미리 모아둠.
// artifactId 가 비어 있으면 shortId 도 못 만들어 스킵 등록 불가 — 그런 entry 는 제외.
function collectPickedSkipMeta() {
  const out = [];
  pickTreeEl.querySelectorAll(".pick-card-cb:not(:disabled)").forEach((cb) => {
    if (!cb.checked) return;
    const artifactId = cb.dataset.artifactId || "";
    if (!artifactId) return; // shortId 추출 불가 → 스킵 등록 불가
    out.push({
      artifactId,
      title: cb.dataset.episodeTitle || "",
      coverDateAttr: cb.dataset.coverDateAttr || "",
      notebookTitle: cb.dataset.notebookTitle || "",
    });
  });
  return out;
}

function refreshPickSummary() {
  const sels = collectPickedSelections();
  pickSummaryEl.textContent = t("pick.summary", { n: sels.length });
  pickDownloadBtn.disabled = sels.length === 0;
  pickDownloadBtn.textContent = sels.length === 0
    ? t("pick.download")
    : t("pick.downloadN", { n: sels.length });
  // 스킵 버튼도 같은 카운트 사용. artifactId 없는 카드는 collectPickedSkipMeta 가
  // 제외하므로 표시되는 N 과 실제 등록되는 수가 다를 수 있지만 흔치 않음.
  if (pickSkipBtn) {
    pickSkipBtn.disabled = sels.length === 0;
    pickSkipBtn.textContent = sels.length === 0
      ? t("pick.skip")
      : t("pick.skipN", { n: sels.length });
  }
  // master 상태 업데이트.
  const allCards = pickTreeEl.querySelectorAll(".pick-card-cb:not(:disabled)");
  if (allCards.length === 0) {
    pickMasterEl.checked = false;
    pickMasterEl.indeterminate = false;
  } else {
    let on = 0;
    allCards.forEach((c) => { if (c.checked) on++; });
    pickMasterEl.checked = on === allCards.length;
    pickMasterEl.indeterminate = on > 0 && on < allCards.length;
  }
}

if (pickDownloadBtn) {
  pickDownloadBtn.addEventListener("click", async () => {
    const selections = collectPickedSelections();
    if (selections.length === 0) return;
    pickDownloadBtn.disabled = true;
    pickStatusEl.textContent = t("pick.starting");
    const r = await chrome.runtime.sendMessage({
      type: "bulk:remote:selected",
      payload: { selections },
    });
    if (!r?.ok) {
      pickStatusEl.textContent = `Start failed: ${r?.error || "?"}`;
      pickDownloadBtn.disabled = false;
      return;
    }
    // 진행 모니터에 task 가 표시되므로 트리는 접고 사용자에게 모니터로 안내.
    pickEl.style.display = "none";
    lastScanPickToggleBtn.textContent = t("monitor.lastScan.pick");
    show(t("pick.startedN", { n: r.count || selections.length }), "success");
  });
}

if (pickSkipBtn) {
  pickSkipBtn.addEventListener("click", async () => {
    const items = collectPickedSkipMeta();
    if (items.length === 0) return;
    if (!confirm(t("pick.skipConfirm", { n: items.length }))) return;
    pickSkipBtn.disabled = true;
    pickStatusEl.textContent = t("pick.skipStarting");
    const r = await chrome.runtime.sendMessage({
      type: "bulk:skip:selected",
      payload: { items },
    });
    if (!r?.ok) {
      pickStatusEl.textContent = `Skip failed: ${r?.error || "?"}`;
      pickSkipBtn.disabled = false;
      return;
    }
    // 등록 성공 — fresh 데이터로 재렌더. scan:result:pushed 가 isSkipped 를 enrich 하고
    // renderPickTree 가 skipped 카드를 default 숨김 + "스킵됨" 태그로 처리하므로, 방금
    // 스킵된 카드는 자동으로 목록에서 사라진다 (별도 필터 불필요).
    pickStatusEl.textContent = t("pick.skipDoneN", { n: r.added || items.length });
    try {
      const rr = await chrome.runtime.sendMessage({ type: "scan:result:pushed" });
      if (rr?.ok) {
        pickState = {
          notebooks: rr.notebooks || [],
          scannedAt: rr.scannedAt || 0,
        };
        renderPickTree();
      }
    } catch {}
    pickSkipBtn.disabled = false;
    show(t("pick.skipDoneN", { n: r.added || items.length }), "success");
  });
}

// ---------- 팟캐스트 메타 (docs/podcast.json) ----------

const metaForm = document.getElementById("meta-form");
const metaTitleEl = document.getElementById("meta-title");
const metaDescriptionEl = document.getElementById("meta-description");
const metaOwnerNameEl = document.getElementById("meta-owner-name");
const metaOwnerEmailEl = document.getElementById("meta-owner-email");
const metaLanguageEl = document.getElementById("meta-language");
const metaCategoryEl = document.getElementById("meta-category");
const metaExplicitEl = document.getElementById("meta-explicit");
const metaImageEl = document.getElementById("meta-image");
const metaImagePreviewEl = document.getElementById("meta-image-preview");
const metaImageUploadEl = document.getElementById("meta-image-upload");
const metaMaxTotalMBEl = document.getElementById("meta-max-total-mb");
const metaReloadBtn = document.getElementById("meta-reload");
const metaStatusEl = document.getElementById("meta-status");

const DEFAULT_MAX_TOTAL_MB = 2000;

// repo 의 podcast.json 의 sha + 폼에 노출 안 하는 필드 (retention/transcode/baseUrl) 보존용.
let podcastJsonSha = null;
let podcastJsonOriginal = {};

function showMetaStatus(text, kind) {
  metaStatusEl.textContent = text;
  metaStatusEl.className = "status " + (kind || "");
  metaStatusEl.style.display = text ? "block" : "none";
}

function utf8Btoa(str) {
  // Korean / 한글 등 멀티바이트 안전한 base64 인코딩.
  return btoa(unescape(encodeURIComponent(str)));
}

function utf8Atob(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

function updateImagePreview() {
  const url = metaImageEl.value.trim();
  if (url) {
    metaImagePreviewEl.src = url;
    metaImagePreviewEl.style.display = "block";
    metaImagePreviewEl.onerror = () => { metaImagePreviewEl.style.display = "none"; };
  } else {
    metaImagePreviewEl.style.display = "none";
  }
}
metaImageEl.addEventListener("input", updateImagePreview);

function populateMetaForm(json) {
  podcastJsonOriginal = json || {};
  metaTitleEl.value = json?.title || "";
  metaDescriptionEl.value = json?.description || "";
  metaOwnerNameEl.value = json?.ownerName || "";
  metaOwnerEmailEl.value = json?.ownerEmail || "";
  metaLanguageEl.value = json?.language || "ko";
  // 카테고리가 select option 에 없는 값이면 첫 번째로.
  metaCategoryEl.value = json?.category || "Education";
  if (metaCategoryEl.value === "" && json?.category) {
    // option 이 없는 카테고리인 경우 — 그래도 input 에 값은 보존.
    metaCategoryEl.value = "Education";
  }
  metaExplicitEl.checked = !!json?.explicit;
  metaImageEl.value = json?.image || "";
  const mb = json?.retention?.maxTotalMB;
  metaMaxTotalMBEl.value = (typeof mb === "number" && mb > 0) ? mb : "";
  updateImagePreview();
}

async function loadPodcastMeta() {
  const stored = await cfgGet(["token", "repo"]);
  if (!stored.token || !stored.repo) {
    showMetaStatus("먼저 GitHub Token + Repo 를 저장하세요.", "");
    return;
  }
  if (!REPO_RE.test(stored.repo)) {
    showMetaStatus("Repo 형식이 잘못됐습니다 (owner/name).", "error");
    return;
  }
  showMetaStatus(t("meta.status.loading"), "");
  try {
    const r = await fetch(
      `https://api.github.com/repos/${stored.repo}/contents/docs/podcast.json`,
      { headers: ghHeaders(stored.token), cache: "no-store" },
    );
    if (r.status === 404) {
      podcastJsonSha = null;
      podcastJsonOriginal = {};
      showMetaStatus(t("meta.status.notFound"), "");
      return;
    }
    if (r.status === 401) {
      showMetaStatus(t("github.status.tokenInvalid"), "error");
      return;
    }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
    const data = await r.json();
    const text = utf8Atob(data.content.replace(/\n/g, ""));
    const json = JSON.parse(text);
    podcastJsonSha = data.sha;
    populateMetaForm(json);
    showMetaStatus(t("meta.status.loaded"), "success");
  } catch (e) {
    showMetaStatus(`Load failed: ${e.message}`, "error");
  }
}

metaReloadBtn.addEventListener("click", () => loadPodcastMeta());

metaForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const stored = await cfgGet(["token", "repo", "committerName", "committerEmail"]);
  if (!stored.token || !stored.repo) {
    showMetaStatus("먼저 GitHub Token + Repo 를 저장하세요.", "error");
    return;
  }
  if (!REPO_RE.test(stored.repo)) {
    showMetaStatus("Repo 형식이 잘못됐습니다 (owner/name).", "error");
    return;
  }

  // 폼에 노출 안 한 필드 (transcode / baseUrl 등) 는 그대로 보존. retention 은
  // 입력값으로 갱신 — maxTotalMB 만 폼에 노출, maxItems/maxAgeDays 등 다른 키는
  // 사용자가 podcast.json 에 직접 둔 경우 유지.
  const mbRaw = metaMaxTotalMBEl.value.trim();
  const mbVal = mbRaw ? parseFloat(mbRaw) : DEFAULT_MAX_TOTAL_MB;
  const updatedRetention = {
    ...(podcastJsonOriginal.retention || {}),
    maxTotalMB: Number.isFinite(mbVal) && mbVal > 0 ? mbVal : DEFAULT_MAX_TOTAL_MB,
  };
  const updated = {
    ...podcastJsonOriginal,
    title: metaTitleEl.value.trim() || "내 NotebookLM 팟캐스트",
    description: metaDescriptionEl.value.trim() || "NotebookLM 음성개요 자동 수집 피드.",
    language: metaLanguageEl.value || "ko",
    ownerName: metaOwnerNameEl.value.trim(),
    ownerEmail: metaOwnerEmailEl.value.trim(),
    image: metaImageEl.value.trim(),
    category: metaCategoryEl.value || "Education",
    explicit: metaExplicitEl.checked,
    retention: updatedRetention,
  };

  const content = JSON.stringify(updated, null, 2) + "\n";
  const b64 = utf8Btoa(content);

  showMetaStatus("저장 중…", "");
  const body = {
    message: "Update podcast metadata",
    content: b64,
  };
  if (podcastJsonSha) body.sha = podcastJsonSha;
  if (stored.committerName && stored.committerEmail) {
    body.committer = { name: stored.committerName, email: stored.committerEmail };
  }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${stored.repo}/contents/docs/podcast.json`,
      {
        method: "PUT",
        headers: { ...ghHeaders(stored.token), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!r.ok) {
      throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    const data = await r.json();
    podcastJsonSha = data.content?.sha || null;
    podcastJsonOriginal = updated;
    showMetaStatus(t("meta.status.saved"), "success");
    // retention.maxTotalMB 가 바뀌었으면 사용량 박스도 즉시 갱신.
    loadStorageUsage();
  } catch (e) {
    showMetaStatus(`Save failed: ${e.message}`, "error");
  }
});

metaImageUploadEl.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  if (!/^image\/(jpeg|png)$/.test(file.type)) {
    showMetaStatus("JPG / PNG 파일만 업로드 가능합니다.", "error");
    metaImageUploadEl.value = "";
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showMetaStatus(`이미지가 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(1)}MB > 5MB).`, "error");
    metaImageUploadEl.value = "";
    return;
  }

  const stored = await cfgGet(["token", "repo", "committerName", "committerEmail"]);
  if (!stored.token || !stored.repo) {
    showMetaStatus("먼저 GitHub Token + Repo 를 저장하세요.", "error");
    return;
  }

  showMetaStatus("이미지 읽는 중…", "");
  const reader = new FileReader();
  reader.onerror = () => showMetaStatus("이미지 읽기 실패.", "error");
  reader.onload = async () => {
    // data:image/png;base64,XXXXX → "XXXXX"
    const dataUrl = reader.result;
    const b64 = String(dataUrl).split(",")[1];
    if (!b64) {
      showMetaStatus("이미지 인코딩 실패.", "error");
      return;
    }
    const ext = file.type.includes("png") ? "png" : "jpg";
    const path = `docs/cover.${ext}`;

    // 같은 path 의 기존 sha 확인 (overwrite 시 필요).
    let existingSha = null;
    try {
      const r = await fetch(
        `https://api.github.com/repos/${stored.repo}/contents/${path}`,
        { headers: ghHeaders(stored.token), cache: "no-store" },
      );
      if (r.ok) existingSha = (await r.json()).sha;
    } catch {}

    showMetaStatus(`이미지 업로드 중 (${(file.size / 1024).toFixed(0)}KB)…`, "");
    const body = {
      message: `Upload podcast cover (${file.name})`,
      content: b64,
    };
    if (existingSha) body.sha = existingSha;
    if (stored.committerName && stored.committerEmail) {
      body.committer = { name: stored.committerName, email: stored.committerEmail };
    }

    try {
      const r = await fetch(
        `https://api.github.com/repos/${stored.repo}/contents/${path}`,
        {
          method: "PUT",
          headers: { ...ghHeaders(stored.token), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);

      const [owner, repoName] = stored.repo.split("/");
      const url = `https://${owner}.github.io/${repoName}/cover.${ext}`;
      metaImageEl.value = url;
      updateImagePreview();
      metaImageUploadEl.value = "";
      showMetaStatus(`✓ 이미지 업로드됨 → ${url} . [메타 저장] 까지 눌러야 podcast.json 의 image 가 갱신됩니다.`, "success");
    } catch (e) {
      showMetaStatus(`이미지 업로드 실패: ${e.message}`, "error");
    }
  };
  reader.readAsDataURL(file);
});

// 옵션 페이지 첫 오픈 + token/repo 가 이미 저장된 상태면 자동 로드.
// 에피소드 목록은 기본값으로 피드 순서로 보기 모드로 시작.
(async () => {
  const stored = await cfgGet(["token", "repo"]);
  if (stored.token && stored.repo && REPO_RE.test(stored.repo)) {
    loadPodcastMeta();
    await loadEpisodeList();
    enterFeedOrderViewMode();
  }
})();

// 다른 기기에서 push 된 sync 변경을 라이브 반영. 같은 옵션 페이지가 두 기기에서
// 동시에 열려 있을 때 한 쪽 [저장] → 다른 쪽 폼이 자동 갱신. token 같이 민감한
// 값이 다른 기기에서 들어오면 사용자가 인지할 수 있도록 status 라인에도 안내.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  const cfgChanged = Object.keys(changes).some((k) => CFG_KEYS.includes(k));
  if (!cfgChanged) return;

  for (const [k, { newValue }] of Object.entries(changes)) {
    if (!CFG_KEYS.includes(k)) continue;
    if (k === "uiLang") {
      if (newValue && i18nGetLang() !== newValue) {
        i18nSetLang(newValue);
        if (langSelectEl) langSelectEl.value = newValue;
        if (lastRenderedState) renderTaskState(lastRenderedState);
        renderLastScanPanel();
        if (epItems.length > 0) renderEpisodeTable();
        refreshHelpLink();
      }
      continue;
    }
    if (k === "autoDownloadNew") {
      fields.autoDownloadNew.checked = !!newValue;
      continue;
    }
    if (fields[k] && document.activeElement !== fields[k]) {
      fields[k].value = newValue ?? "";
      if (k === "repo") refreshFeedUrl();
    }
  }
  show(t("github.status.syncedFromOther"), "success");
});

// ---------- 에피소드 목록 (push 된 docs/episodes/ 의 row-level 관리) ----------

const epReloadBtn = document.getElementById("ep-reload");
const epGroupToggleBtn = document.getElementById("ep-group-toggle");
const epResetSortBtn = document.getElementById("ep-reset-sort");
const epSummaryEl = document.getElementById("ep-summary");
const epSelectedCountEl = document.getElementById("ep-selected-count");
const epBatchDeleteBtn = document.getElementById("ep-batch-delete");
const epStatusEl = document.getElementById("ep-status");
const epTableWrapEl = document.getElementById("ep-table-wrap");
const epTbody = document.getElementById("ep-tbody");
const epEmptyEl = document.getElementById("ep-empty");
// 우측 하단 floating "맨 위로" 버튼 — 페이지를 일정 이상 내리면 나타난다. 페이지 전체가
// (body) 스크롤되므로 window.scrollY 기준. 짧은 페이지에선 자연히 안 보임.
const scrollTopFab = document.getElementById("scroll-top-fab");
if (scrollTopFab) {
  const SHOW_AFTER = 300;
  const updateFabVisibility = () => {
    scrollTopFab.classList.toggle("visible", window.scrollY > SHOW_AFTER);
  };
  scrollTopFab.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  window.addEventListener("scroll", updateFabVisibility, { passive: true });
  updateFabVisibility();
}
const epCheckAll = document.getElementById("ep-check-all");
const epReorderToggleBtn = document.getElementById("ep-reorder-toggle");
const epFeedOrderViewBtn = document.getElementById("ep-feed-order-view");
const epReorderBar = document.getElementById("ep-reorder-bar");
const epReorderApplyBtn = document.getElementById("ep-reorder-apply");
const epReorderCancelBtn = document.getElementById("ep-reorder-cancel");
const epReorderResetBtn = document.getElementById("ep-reorder-reset");

let epItems = [];                    // 서버에서 받은 원본 (정렬 대상)
let epSortKey = "date";              // date / notebook / title / format / size
let epSortDir = "desc";              // asc / desc
let epGroupOn = false;
let epNotebookUrlMap = new Map();    // notebookSlug → notebookUrl (직전 스캔 결과 기반)
let epReorderMode = false;           // 순서 편집 모드 활성 여부
let epCustomOrder = [];              // 편집 중인 filename 순서 배열
let epDragSrc = null;                // 드래그 중인 row 의 filename
let epFeedOrderViewMode = false;     // 피드 순서로 보기 모드 활성 여부
let epFeedOrder = [];                // podcast.json 의 episodeOrder (filename 배열)

// background.js 의 slugify 와 동일 — 파일명의 노트북-슬러그를 lastScanResult 의
// 노트북 cover.title 과 매칭하기 위해 클라이언트에서도 같은 변환 필요. SLUG_MAX=40.
function epSlugify(text) {
  if (!text) return "";
  let s = text.trim().replace(/\s+/g, "-");
  s = s.replace(/[^0-9A-Za-z가-힣\-_]/g, "");
  return s.slice(0, 40);
}

async function refreshNotebookUrlMap() {
  // 두 소스 병합 — 영구 맵 (chrome.storage.local 의 notebookUrlMap, 모든 과거 스캔 누적)
  // 을 base 로 깔고, 직전 스캔 결과 (session 기반, 30분 freshness) 를 위에 layer.
  // 최근에 본 URL 이 우선이라 노트북 이름이 바뀌었거나 옮겨졌을 때 자동 갱신.
  epNotebookUrlMap.clear();
  try {
    const r = await chrome.runtime.sendMessage({ type: "notebook:url:map:get" });
    const map = r?.map || {};
    for (const [slug, url] of Object.entries(map)) {
      if (slug && url) epNotebookUrlMap.set(slug, url);
    }
  } catch {}
  try {
    const r = await chrome.runtime.sendMessage({ type: "scan:result:get" });
    const result = r?.result;
    if (!result?.notebooks) return;
    for (const nb of result.notebooks) {
      const slug = epSlugify(nb.cover?.title || "");
      if (slug && nb.url) epNotebookUrlMap.set(slug, nb.url);
    }
  } catch {}
}

function epFmtSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 공개 음성 URL — RSS feed enclosure 와 같은 base 를 사용. podcast.json 의 baseUrl
// (custom domain 등) 이 있으면 그걸 우선, 없으면 owner.github.io/repo 로 fallback.
function epShareUrl(filename) {
  const base = String(podcastJsonOriginal?.baseUrl || "").replace(/\/+$/, "");
  if (base) return `${base}/episodes/${filename}`;
  const repo = fields.repo.value.trim();
  if (!REPO_RE.test(repo)) return null;
  const [owner, name] = repo.split("/");
  return `https://${owner}.github.io/${name}/episodes/${filename}`;
}

async function epShare(item) {
  const url = epShareUrl(item.filename);
  if (!url) {
    epShowStatus(t("episodes.shareNoRepo"), "error");
    return;
  }
  const title = item.title || item.filename;
  // Web Share API — 데스크톱 Chrome on Windows 는 OS 공유 시트, 모바일은 네이티브 시트.
  // 미지원 또는 사용자가 시트를 닫지 않고 다른 실패가 나면 클립보드 복사로 fallback.
  if (typeof navigator.share === "function" &&
      (typeof navigator.canShare !== "function" || navigator.canShare({ url }))) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (e) {
      if (e?.name === "AbortError") return; // 사용자가 시트를 닫음 — 조용히 무시.
      // 그 외 (NotAllowedError 등) 는 fallback 으로 진행.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    epShowStatus(t("episodes.shareCopied", { url }), "success");
  } catch (e) {
    epShowStatus(t("episodes.shareFail", { msg: e.message }), "error");
  }
}

function epShowStatus(text, kind) {
  if (!text) { epStatusEl.style.display = "none"; return; }
  epStatusEl.textContent = text;
  epStatusEl.className = "status " + (kind || "");
  epStatusEl.style.display = "block";
}

async function loadEpisodeList() {
  epShowStatus(t("meta.status.loading"), "");
  epReloadBtn.disabled = true;
  try {
    // 직전 스캔 결과 매핑을 동시에 새로고침 — [편집] 버튼이 노트북 URL 을 알 수 있게.
    await refreshNotebookUrlMap();
    const r = await chrome.runtime.sendMessage({ type: "episodes:list:full" });
    if (!r?.ok) {
      epShowStatus(t("episodes.loadFail", { msg: r?.error || "?" }), "error");
      epTableWrapEl.style.display = "none";
      epEmptyEl.style.display = "none";
      return;
    }
    epItems = r.items || [];
    const totalMB = (r.totalSize || 0) / 1024 / 1024;
    epSummaryEl.textContent = t("episodes.summary", { n: epItems.length, sizeMB: totalMB.toFixed(1) });
    if (epItems.length === 0) {
      epTableWrapEl.style.display = "none";
      epEmptyEl.style.display = "block";
      epShowStatus("");
      return;
    }
    epTableWrapEl.style.display = "";
    epEmptyEl.style.display = "none";
    renderEpisodeTable();
    epShowStatus("");
  } catch (e) {
    epShowStatus(t("episodes.loadFail", { msg: e.message }), "error");
  } finally {
    epReloadBtn.disabled = false;
  }
}

function epSortedItems() {
  const sorted = epItems.slice().sort((a, b) => {
    let va = a[epSortKey], vb = b[epSortKey];
    if (epSortKey === "size") { va = +va; vb = +vb; }
    else { va = String(va || "").toLowerCase(); vb = String(vb || "").toLowerCase(); }
    if (va < vb) return epSortDir === "asc" ? -1 : 1;
    if (va > vb) return epSortDir === "asc" ? 1 : -1;
    return 0;
  });
  if (!epGroupOn) return sorted;
  // group on: notebook 안에서 이미 정렬된 순서 유지하면서 그룹 묶음.
  const groups = new Map();
  for (const it of sorted) {
    if (!groups.has(it.notebook)) groups.set(it.notebook, []);
    groups.get(it.notebook).push(it);
  }
  // 그룹 키 자체는 알파벳 순으로 정렬해 안정적.
  return Array.from(groups.keys()).sort().flatMap((nb) =>
    [{ __groupHeader: true, notebook: nb, count: groups.get(nb).length }, ...groups.get(nb)]
  );
}

// 피드 순서로 정렬 — epFeedOrder(filename 배열) 기준.
// episodeOrder 에 없는 파일은 날짜 내림차순으로 뒤에 붙음.
function epFeedOrderedItems() {
  if (epFeedOrder.length === 0) return epSortedItems();
  const orderMap = new Map(epFeedOrder.map((fn, i) => [fn, i]));
  return epItems.slice().sort((a, b) => {
    const ia = orderMap.has(a.filename) ? orderMap.get(a.filename) : Infinity;
    const ib = orderMap.has(b.filename) ? orderMap.get(b.filename) : Infinity;
    if (ia !== ib) return ia - ib;
    // 둘 다 없는 경우: 날짜 내림차순 → 파일명 내림차순
    return b.date.localeCompare(a.date) || b.filename.localeCompare(a.filename);
  });
}

function renderEpisodeTable() {
  // 정렬 화살표 표시 (편집/피드순 모드에선 무의미하지만 상태는 유지).
  document.querySelectorAll("#ep-table th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (!epReorderMode && !epFeedOrderViewMode && th.dataset.key === epSortKey)
      th.classList.add(epSortDir === "asc" ? "sort-asc" : "sort-desc");
  });

  if (epReorderMode) {
    renderEpisodeTableReorder();
    return;
  }

  const items = epFeedOrderViewMode ? epFeedOrderedItems() : epSortedItems();
  const editLabel = t("episodes.action.edit");
  const shareLabel = t("episodes.action.share");
  const shareTooltip = t("episodes.shareTooltip");
  const deleteLabel = t("episodes.action.delete");
  const skipLabel = t("episodes.action.skip");
  const skipTooltip = t("episodes.skipTooltip");
  const tooltipReady = t("episodes.editTooltipReady");
  const tooltipNoUrl = t("episodes.editTooltipNoUrl");
  const html = items.map((it) => {
    if (it.__groupHeader) {
      return `<tr class="group-header"><td colspan="7">📓 ${escapeHtml(it.notebook)}  (${it.count})</td></tr>`;
    }
    const ymd = it.date;
    const fmtClass = `format-tag ${escapeHtml(it.format)}`;
    const notebookSlug = epSlugify(it.notebook);
    const nbUrl = epNotebookUrlMap.get(notebookSlug);
    const editAttrs = nbUrl
      ? `data-nb-url="${escapeHtml(nbUrl)}" title="${escapeHtml(tooltipReady)}"`
      : `disabled title="${escapeHtml(tooltipNoUrl)}"`;
    const sidMatch = /__([0-9a-f]{8})__/.exec(it.filename);
    const sid = sidMatch ? sidMatch[1] : "";
    const skipAttrs = sid
      ? `data-sid="${escapeHtml(sid)}" title="${escapeHtml(skipTooltip)}"`
      : `disabled title="${escapeHtml(t("episodes.skipTooltipNoSid"))}"`;
    return `
      <tr class="ep-row" data-filename="${escapeHtml(it.filename)}" data-sha="${escapeHtml(it.sha)}" data-sid="${escapeHtml(sid)}">
        <td class="col-check"><input type="checkbox" class="ep-check"></td>
        <td title="${escapeHtml(ymd)}">${escapeHtml(ymd)}</td>
        <td class="notebook" title="${escapeHtml(it.notebook)}">${escapeHtml(it.notebook)}</td>
        <td class="title" title="${escapeHtml(it.filename)}">${escapeHtml(it.title)}</td>
        <td><span class="${fmtClass}">${escapeHtml(it.format)}</span></td>
        <td class="num">${escapeHtml(epFmtSize(it.size))}</td>
        <td class="col-actions">
          <button type="button" class="ep-action edit" ${editAttrs}>${escapeHtml(editLabel)}</button>
          <button type="button" class="ep-action share" title="${escapeHtml(shareTooltip)}">${escapeHtml(shareLabel)}</button>
          <button type="button" class="ep-action skip" ${skipAttrs}>${escapeHtml(skipLabel)}</button>
          <button type="button" class="ep-action danger">${escapeHtml(deleteLabel)}</button>
        </td>
      </tr>`;
  }).join("");
  epTbody.innerHTML = html;
  refreshBatchUI();
}

// 순서 편집 모드 전용 렌더러.
// epCustomOrder 배열 순서로 행을 그리고, 드래그 핸들(☰)과 ▲▼ 버튼을 표시.
// 체크박스 열 대신 드래그 핸들 열을 사용하므로 colspan=7 그대로 유지.
function renderEpisodeTableReorder() {
  const itemMap = new Map(epItems.map((it) => [it.filename, it]));
  const html = epCustomOrder.map((fn, idx) => {
    const it = itemMap.get(fn);
    if (!it) return "";
    const fmtClass = `format-tag ${escapeHtml(it.format)}`;
    const isFirst = idx === 0;
    const isLast = idx === epCustomOrder.length - 1;
    return `
      <tr class="ep-row" draggable="true"
          data-filename="${escapeHtml(fn)}" data-sha="${escapeHtml(it.sha)}" data-sid="">
        <td class="col-drag" title="드래그하여 순서 변경">☰</td>
        <td title="${escapeHtml(it.date)}">${escapeHtml(it.date)}</td>
        <td class="notebook" title="${escapeHtml(it.notebook)}">${escapeHtml(it.notebook)}</td>
        <td class="title" title="${escapeHtml(fn)}">${escapeHtml(it.title)}</td>
        <td><span class="${fmtClass}">${escapeHtml(it.format)}</span></td>
        <td class="num">${escapeHtml(epFmtSize(it.size))}</td>
        <td class="col-actions">
          <button type="button" class="ep-move ep-move-up" data-fn="${escapeHtml(fn)}"
            ${isFirst ? "disabled" : ""} title="위로">▲</button>
          <button type="button" class="ep-move ep-move-down" data-fn="${escapeHtml(fn)}"
            ${isLast ? "disabled" : ""} title="아래로">▼</button>
        </td>
      </tr>`;
  }).join("");
  epTbody.innerHTML = html;
}

function refreshBatchUI() {
  const checked = epTbody.querySelectorAll(".ep-check:checked").length;
  const total = epTbody.querySelectorAll(".ep-check").length;
  epSelectedCountEl.textContent = checked ? t("episodes.selected", { n: checked }) : "";
  epBatchDeleteBtn.disabled = checked === 0;
  const batchSkipBtn = document.getElementById("ep-batch-skip");
  if (batchSkipBtn) batchSkipBtn.disabled = checked === 0;
  epCheckAll.indeterminate = checked > 0 && checked < total;
  epCheckAll.checked = checked > 0 && checked === total;
}

epReloadBtn.addEventListener("click", () => loadEpisodeList());

// ---------- 순서 편집 모드 ----------

function enterReorderMode() {
  // 피드 순서로 보기 모드가 켜져 있으면 먼저 끄고 편집 모드로 전환.
  if (epFeedOrderViewMode) {
    epFeedOrderViewMode = false;
    epFeedOrder = [];
    epFeedOrderViewBtn.classList.remove("on");
    document.getElementById("ep-table-wrap").classList.remove("ep-feed-view-active");
    epShowStatus("");
  }
  epReorderMode = true;
  // 현재 화면에 표시된 순서를 초기 편집 순서로 사용 (그룹 헤더 제외).
  epCustomOrder = epSortedItems()
    .filter((it) => !it.__groupHeader)
    .map((it) => it.filename);
  epReorderToggleBtn.classList.add("on");
  epReorderBar.classList.add("visible");
  epGroupToggleBtn.disabled = true;
  epResetSortBtn.disabled = true;
  document.getElementById("ep-table-wrap").classList.add("ep-reorder-active");
  renderEpisodeTable();
}

function exitReorderMode() {
  epReorderMode = false;
  epCustomOrder = [];
  epDragSrc = null;
  epReorderToggleBtn.classList.remove("on");
  epReorderBar.classList.remove("visible");
  epGroupToggleBtn.disabled = false;
  epResetSortBtn.disabled = false;
  document.getElementById("ep-table-wrap").classList.remove("ep-reorder-active");
  renderEpisodeTable();
}

epReorderToggleBtn.addEventListener("click", () => {
  if (epReorderMode) exitReorderMode();
  else enterReorderMode();
});

// ---------- 피드 순서로 보기 ----------

async function enterFeedOrderViewMode() {
  // 피드 순서를 podcast.json 에서 읽어온 후 모드 진입.
  epShowStatus(t("episodes.feedOrderViewLoading"));
  epFeedOrderViewBtn.disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: "podcast:json:get" });
    epFeedOrder = Array.isArray(r?.data?.episodeOrder) ? r.data.episodeOrder : [];
    if (epFeedOrder.length === 0) {
      epShowStatus(t("episodes.feedOrderViewNone"));
    } else {
      epShowStatus("");
    }
  } catch (e) {
    epShowStatus(t("episodes.feedOrderViewFail", { msg: e.message }), "error");
    epFeedOrderViewBtn.disabled = false;
    return;
  }
  epFeedOrderViewMode = true;
  epFeedOrderViewBtn.classList.add("on");
  epGroupToggleBtn.disabled = true;
  epResetSortBtn.disabled = true;
  document.getElementById("ep-table-wrap").classList.add("ep-feed-view-active");
  epFeedOrderViewBtn.disabled = false;
  renderEpisodeTable();
}

function exitFeedOrderViewMode() {
  epFeedOrderViewMode = false;
  epFeedOrder = [];
  epFeedOrderViewBtn.classList.remove("on");
  epGroupToggleBtn.disabled = false;
  epResetSortBtn.disabled = false;
  document.getElementById("ep-table-wrap").classList.remove("ep-feed-view-active");
  epShowStatus("");
  renderEpisodeTable();
}

epFeedOrderViewBtn.addEventListener("click", () => {
  if (epFeedOrderViewMode) exitFeedOrderViewMode();
  else enterFeedOrderViewMode();
});

epReorderCancelBtn.addEventListener("click", () => exitReorderMode());

epReorderResetBtn.addEventListener("click", () => {
  // 기본 순서(날짜 내림차순)로 초기화 — epCustomOrder를 날짜 기준으로 재정렬.
  epCustomOrder = epItems.slice()
    .sort((a, b) => b.dateRaw.localeCompare(a.dateRaw) || b.filename.localeCompare(a.filename))
    .map((it) => it.filename);
  renderEpisodeTable();
});

epReorderApplyBtn.addEventListener("click", async () => {
  epReorderApplyBtn.disabled = true;
  epReorderApplyBtn.textContent = t("episodes.reorderSaving");
  try {
    const r = await chrome.runtime.sendMessage({
      type: "feed:order:save",
      order: epCustomOrder,
    });
    if (!r?.ok) throw new Error(r?.error || "?");
    epShowStatus(t("episodes.reorderSaved"), "success");
    exitReorderMode();
  } catch (e) {
    epShowStatus(t("episodes.reorderFail", { msg: e.message }), "error");
  } finally {
    epReorderApplyBtn.disabled = false;
    epReorderApplyBtn.textContent = t("episodes.reorderApply");
  }
});

// ---- 드래그 앤 드롭 ----
epTbody.addEventListener("dragstart", (e) => {
  const row = e.target.closest(".ep-row[draggable='true']");
  if (!row) return;
  epDragSrc = row.dataset.filename;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", epDragSrc); // Firefox 호환
  row.classList.add("dragging");
});

epTbody.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const row = e.target.closest(".ep-row[draggable='true']");
  if (!row || row.dataset.filename === epDragSrc) return;
  epTbody.querySelectorAll(".drag-over").forEach((r) => r.classList.remove("drag-over"));
  row.classList.add("drag-over");
});

epTbody.addEventListener("dragleave", (e) => {
  // tbody 밖으로 나가면 drag-over 제거 (tbody 자식 간 이동 시 오발 방지).
  if (!epTbody.contains(e.relatedTarget)) {
    epTbody.querySelectorAll(".drag-over").forEach((r) => r.classList.remove("drag-over"));
  }
});

epTbody.addEventListener("drop", (e) => {
  e.preventDefault();
  const targetRow = e.target.closest(".ep-row[draggable='true']");
  if (!targetRow || !epDragSrc || targetRow.dataset.filename === epDragSrc) return;
  const srcIdx = epCustomOrder.indexOf(epDragSrc);
  const tgtIdx = epCustomOrder.indexOf(targetRow.dataset.filename);
  if (srcIdx === -1 || tgtIdx === -1) return;
  epCustomOrder.splice(srcIdx, 1);
  epCustomOrder.splice(tgtIdx, 0, epDragSrc);
  epDragSrc = null;
  renderEpisodeTable();
});

epTbody.addEventListener("dragend", () => {
  epTbody.querySelectorAll(".dragging, .drag-over").forEach((r) => {
    r.classList.remove("dragging", "drag-over");
  });
  epDragSrc = null;
});

// ---- ▲▼ 이동 버튼 ----
epTbody.addEventListener("click", (e) => {
  if (!epReorderMode) return;
  const btn = e.target.closest(".ep-move-up, .ep-move-down");
  if (!btn) return;
  const fn = btn.dataset.fn;
  const idx = epCustomOrder.indexOf(fn);
  if (idx === -1) return;
  if (btn.classList.contains("ep-move-up") && idx > 0) {
    [epCustomOrder[idx - 1], epCustomOrder[idx]] = [epCustomOrder[idx], epCustomOrder[idx - 1]];
    renderEpisodeTable();
    // 이동 후 같은 행의 ▲ 버튼에 포커스 유지.
    epTbody.querySelector(`.ep-move-up[data-fn="${CSS.escape(fn)}"]`)?.focus();
  } else if (btn.classList.contains("ep-move-down") && idx < epCustomOrder.length - 1) {
    [epCustomOrder[idx], epCustomOrder[idx + 1]] = [epCustomOrder[idx + 1], epCustomOrder[idx]];
    renderEpisodeTable();
    epTbody.querySelector(`.ep-move-down[data-fn="${CSS.escape(fn)}"]`)?.focus();
  }
});

document.querySelectorAll("#ep-table th.sortable").forEach((th) => {
  th.addEventListener("click", (e) => {
    // 헤더 우측 가장자리의 너비 조절 핸들 클릭은 정렬로 이어지지 않게.
    if (e.target.classList.contains("col-resizer")) return;
    const key = th.dataset.key;
    if (epSortKey === key) epSortDir = epSortDir === "asc" ? "desc" : "asc";
    else { epSortKey = key; epSortDir = "asc"; }
    renderEpisodeTable();
  });
});

// ---------- 컬럼 너비 조절 (epColWidths 로 영구 저장) ----------
// 개별 컬럼 모델 — 잡은 컬럼 한 개만 폭이 변하고, 그 오른쪽 컬럼들은 폭은 그대로
// 유지한 채 옆으로 밀려남. 테이블 총폭 = sum(cols) 이므로 wrapper 가 가로 스크롤로
// 흡수. 마지막 컬럼도 핸들 단다 (오른쪽으로 밀려날 컬럼이 없을 뿐 폭 변경은 정상).
// MIN 폭 제한 없음 — 커서가 가는 곳까지 폭이 따라간다 (0 미만은 0 으로만 클램프).

function epColByKey(key) {
  return document.querySelector(`#ep-colgroup col[data-col="${key}"]`);
}

async function loadEpColumnWidths() {
  try {
    const r = await chrome.storage.local.get(["epColWidths"]);
    const widths = r.epColWidths || {};
    for (const [key, w] of Object.entries(widths)) {
      const col = epColByKey(key);
      if (col && w) col.style.width = w;
    }
  } catch {}
  syncEpTableWidth();
}

async function saveAllEpColumnWidths() {
  try {
    const widths = {};
    document.querySelectorAll("#ep-colgroup col[data-col]").forEach((col) => {
      if (col.style.width) widths[col.dataset.col] = col.style.width;
    });
    await chrome.storage.local.set({ epColWidths: widths });
  } catch {}
}

// 테이블 width 를 col 폭의 정확한 합으로 고정. width:auto + table-layout:fixed 만으론
// 브라우저가 콘텐츠 기반 auto 알고리즘으로 fallback 해 col.style.width 가 무시되는
// 케이스가 있음 (특히 col 폭이 콘텐츠보다 작을 때). 명시 px width 를 주면 fixed
// 레이아웃이 엄격히 적용되어 col 폭이 그대로 렌더링됨.
function syncEpTableWidth() {
  let sum = 0;
  document.querySelectorAll("#ep-colgroup col[data-col]").forEach((col) => {
    const w = parseInt(col.style.width, 10);
    if (!Number.isNaN(w)) sum += w;
  });
  if (sum > 0) {
    const table = document.getElementById("ep-table");
    if (table) table.style.width = `${sum}px`;
  }
}

function setupEpColumnResizers() {
  const ths = document.querySelectorAll("#ep-table thead th[data-col]");
  ths.forEach((th) => {
    if (th.querySelector(".col-resizer")) return;
    const handle = document.createElement("div");
    handle.className = "col-resizer";
    handle.addEventListener("mousedown", (e) => startEpColumnResize(e, th));
    th.appendChild(handle);
  });
}

function startEpColumnResize(e, th) {
  e.preventDefault();
  e.stopPropagation();
  const col = epColByKey(th.dataset.col);
  if (!col) return;

  const startWidth = th.offsetWidth;
  const startX = e.clientX;
  const handle = e.currentTarget;
  handle.classList.add("resizing");
  document.body.classList.add("col-resizing");

  const onMove = (ev) => {
    const w = Math.max(0, startWidth + (ev.clientX - startX));
    col.style.width = `${w}px`;
    syncEpTableWidth();
  };
  const onUp = () => {
    handle.classList.remove("resizing");
    document.body.classList.remove("col-resizing");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    saveAllEpColumnWidths();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

setupEpColumnResizers();
loadEpColumnWidths();

epResetSortBtn.addEventListener("click", () => {
  epSortKey = "date"; epSortDir = "desc"; renderEpisodeTable();
});

epGroupToggleBtn.addEventListener("click", () => {
  epGroupOn = !epGroupOn;
  epGroupToggleBtn.classList.toggle("on", epGroupOn);
  renderEpisodeTable();
});

epCheckAll.addEventListener("change", () => {
  epTbody.querySelectorAll(".ep-check").forEach((cb) => { cb.checked = epCheckAll.checked; });
  refreshBatchUI();
});

epTbody.addEventListener("change", (e) => {
  if (e.target.classList.contains("ep-check")) refreshBatchUI();
});

epTbody.addEventListener("click", async (e) => {
  // [편집 ↗] — 해당 NotebookLM 노트북을 새 탭으로 연다 (제목/내용 편집은 거기서).
  // 노트북 URL 은 직전 스캔 결과의 cover.title slug 매칭으로 lookup. 미스 시
  // 버튼이 disabled 상태로 렌더되어 여기까지 안 옴.
  if (e.target.classList.contains("edit")) {
    const nbUrl = e.target.dataset.nbUrl;
    if (nbUrl) chrome.tabs.create({ url: nbUrl });
    return;
  }
  // [공유 ↗] — Web Share API (지원 OS 면 네이티브 공유 시트) → 안 되면 클립보드 복사.
  if (e.target.classList.contains("share")) {
    const row = e.target.closest("tr.ep-row");
    if (!row) return;
    const fn = row.dataset.filename;
    const item = epItems.find((i) => i.filename === fn);
    if (item) await epShare(item);
    return;
  }
  // [스킵] — GitHub 파일 삭제 + 영구 스킵 등록 (공간 확보 + 우후 차단).
  // [삭제] 와 차이: [삭제] 는 파일만 지우고 미래 스캔에서 다시 받을 수 있음 vs
  // [스킵] 은 다음 일괄 다운로드에서도 영구 제외. 옛 3-segment 파일은 shortId
  // 없어 버튼 disabled — 여기까지 안 옴.
  if (e.target.classList.contains("skip")) {
    const row = e.target.closest("tr.ep-row");
    if (!row) return;
    const sid = e.target.dataset.sid;
    const fn = row.dataset.filename;
    const sha = row.dataset.sha;
    if (!sid || !fn || !sha) return;
    if (!confirm(t("episodes.confirmSkip", { filename: fn, sid }))) return;
    e.target.disabled = true;
    epShowStatus(t("episodes.deleting", { filename: fn }), "");
    // 스킵 목록 패널이 어떤 파일이었는지 보여줄 메타 — row 데이터에서 추출.
    const item = epItems.find((i) => i.filename === fn);
    try {
      const r = await chrome.runtime.sendMessage({
        type: "episodes:delete", filename: fn, sha, addToSkip: true,
        title: item?.title || "",
        date: item?.date || "",
        notebookTitle: item?.notebook || "",
      });
      if (!r?.ok) throw new Error(r?.error || "delete+skip failed");
      epShowStatus(t("episodes.deletedWithSkip", { filename: fn, sid: r.skippedShortId || sid }), "success");
      await loadEpisodeList();
      loadStorageUsage();
      if (document.getElementById("ep-skip-panel")?.style.display === "block") {
        renderSkipPanel();
      }
    } catch (err) {
      epShowStatus(t("episodes.skipFail", { msg: err.message }), "error");
      e.target.disabled = false;
    }
    return;
  }
  // 단일 [삭제] — GitHub 파일만 ghDelete. 스킵 등록 안 함 — 미래 스캔에서 다시
  // 받을 수 있음 (잘못 받은 카드를 NotebookLM 에서 제목/내용 고친 후 새로 받는
  // 흐름). 영구 제외하려면 옆의 [스킵] 버튼을 쓴다.
  if (e.target.classList.contains("danger")) {
    const row = e.target.closest("tr.ep-row");
    if (!row) return;
    const fn = row.dataset.filename;
    const sha = row.dataset.sha;
    if (!confirm(t("episodes.confirmDelete", { filename: fn }))) return;
    e.target.disabled = true;
    epShowStatus(t("episodes.deleting", { filename: fn }), "");
    try {
      const r = await chrome.runtime.sendMessage({
        type: "episodes:delete", filename: fn, sha, addToSkip: false,
      });
      if (!r?.ok) throw new Error(r?.error || "delete failed");
      epShowStatus(t("episodes.deleted", { filename: fn }), "success");
      await loadEpisodeList();
      loadStorageUsage();
    } catch (err) {
      epShowStatus(t("episodes.deleteFail", { msg: err.message }), "error");
      e.target.disabled = false;
    }
    return;
  }
});

// 다중선택 row 들에서 메타 (title/date/notebook) 까지 추출해서 episodes:delete
// 메시지에 같이 전달 — addToSkip=true 면 스킵 목록 패널에 메타가 그대로 보이도록.
function collectBatchTargets() {
  return Array.from(epTbody.querySelectorAll(".ep-check:checked")).map((cb) => {
    const row = cb.closest("tr.ep-row");
    const fn = row.dataset.filename;
    const item = epItems.find((i) => i.filename === fn);
    return {
      filename: fn,
      sha: row.dataset.sha,
      title: item?.title || "",
      date: item?.date || "",
      notebookTitle: item?.notebook || "",
    };
  });
}

async function runBatch(targets, addToSkip, confirmKey, doneKey) {
  if (targets.length === 0) return;
  if (!confirm(t(confirmKey, { n: targets.length }))) return;
  epBatchDeleteBtn.disabled = true;
  const batchSkipBtn = document.getElementById("ep-batch-skip");
  if (batchSkipBtn) batchSkipBtn.disabled = true;
  let ok = 0, fail = 0;
  for (let i = 0; i < targets.length; i++) {
    const tgt = targets[i];
    epShowStatus(t("episodes.bulkDoing", { i: i + 1, total: targets.length, filename: tgt.filename.slice(0, 50) }), "");
    try {
      const r = await chrome.runtime.sendMessage({
        type: "episodes:delete",
        filename: tgt.filename, sha: tgt.sha, addToSkip,
        title: tgt.title, date: tgt.date, notebookTitle: tgt.notebookTitle,
      });
      if (r?.ok) ok++; else fail++;
    } catch { fail++; }
  }
  epShowStatus(t(doneKey, { ok, fail }), fail > 0 ? "error" : "success");
  await loadEpisodeList();
  loadStorageUsage();
  if (document.getElementById("ep-skip-panel")?.style.display === "block") {
    renderSkipPanel();
  }
}

epBatchDeleteBtn.addEventListener("click", async () => {
  await runBatch(collectBatchTargets(), false, "episodes.confirmBulkDelete", "episodes.bulkDone");
});

const epBatchSkipBtn = document.getElementById("ep-batch-skip");
if (epBatchSkipBtn) {
  epBatchSkipBtn.addEventListener("click", async () => {
    await runBatch(collectBatchTargets(), true, "episodes.confirmBulkSkip", "episodes.bulkSkipDone");
  });
}

// ---------- 사이드바 라우팅 (hash 기반) ----------

const PAGES = ["monitor", "github", "meta", "episodes"];
const DEFAULT_PAGE = "monitor";

function showPage(name) {
  if (!PAGES.includes(name)) name = DEFAULT_PAGE;
  document.querySelectorAll(".page").forEach((p) => {
    p.classList.toggle("active", p.id === `page-${name}`);
  });
  document.querySelectorAll(".nav-item").forEach((a) => {
    a.classList.toggle("active", a.dataset.page === name);
  });
  refreshMonitorChrome();
  // 모니터 / 에피소드 페이지로 이동 시 저장소 사용량 자동 갱신.
  if (name === "monitor" || name === "episodes") loadStorageUsage();
}

// 진행 모니터 페이지의 "비어있음" 메시지 + 사이드바 [진행 모니터] 의 빨간 뱃지.
// task-panel 또는 last-scan-panel 이 visible 이면 empty 메시지 숨김. running task 면 뱃지.
function refreshMonitorChrome() {
  const taskPanel = document.getElementById("task-panel");
  const lastScanPanel = document.getElementById("last-scan-panel");
  const empty = document.getElementById("monitor-empty");
  if (empty && taskPanel && lastScanPanel) {
    const taskHidden = taskPanel.style.display === "none";
    const scanHidden = lastScanPanel.style.display === "none";
    empty.style.display = (taskHidden && scanHidden) ? "" : "none";
  }
  const badge = document.getElementById("nav-badge-monitor");
  if (badge) {
    const running = lastRenderedState && lastRenderedState.status === "running";
    badge.classList.toggle("show", !!running);
  }
}

// hash 변경 시 페이지 전환. 수동 location.hash = "..." 도 지원.
window.addEventListener("hashchange", () => {
  showPage(location.hash.replace("#", ""));
});

// 사이드바 버전 표시 — manifest 가 single source of truth.
try {
  const v = chrome.runtime.getManifest().version;
  const el = document.getElementById("sidebar-version");
  if (el) el.textContent = `v${v} · ${t("sidebar.subtitle")}`;
} catch {}

// 첫 로드: URL 의 hash 또는 default 로 페이지 표시.
showPage(location.hash.replace("#", ""));
