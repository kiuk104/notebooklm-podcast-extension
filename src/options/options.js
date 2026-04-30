const fields = {
  token: document.getElementById("token"),
  repo: document.getElementById("repo"),
  rssMode: document.getElementById("rss-mode"),
  committerName: document.getElementById("committer-name"),
  committerEmail: document.getElementById("committer-email"),
  autoDownloadNew: document.getElementById("auto-download-new"),
};
const statusEl = document.getElementById("status");
const feedUrlEl = document.getElementById("feed-url");
const openFeedEl = document.getElementById("open-feed");
const copyFeedBtn = document.getElementById("copy-feed");

const KEYS = ["token", "repo", "rssMode", "committerName", "committerEmail", "autoDownloadNew"];
const RSS_MODE_DEFAULT = "actions";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

(async () => {
  const stored = await chrome.storage.local.get(KEYS);
  for (const k of KEYS) {
    if (k === "autoDownloadNew") {
      fields.autoDownloadNew.checked = !!stored.autoDownloadNew;
    } else if (stored[k]) {
      fields[k].value = stored[k];
    }
  }
  if (!stored.rssMode) fields.rssMode.value = RSS_MODE_DEFAULT;
  refreshFeedUrl();
})();

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
  copyFeedBtn.textContent = "✓ 복사됨";
  setTimeout(() => { copyFeedBtn.textContent = original; }, 1400);
});

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const repo = fields.repo.value.trim();
  if (!REPO_RE.test(repo)) {
    show("repo 형식이 잘못됐습니다 (owner/name)", "error");
    return;
  }
  await chrome.storage.local.set({
    token: fields.token.value.trim(),
    repo,
    rssMode: fields.rssMode.value || RSS_MODE_DEFAULT,
    committerName: fields.committerName.value.trim(),
    committerEmail: fields.committerEmail.value.trim(),
    autoDownloadNew: fields.autoDownloadNew.checked,
  });
  show("저장됨.", "success");
});

function show(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status " + kind;
  statusEl.style.display = "block";
}

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
  if (!token) return show("token 이 비어 있습니다.", "error");
  if (!REPO_RE.test(repo)) return show("repo 형식이 잘못됐습니다 (owner/name).", "error");
  show("검증 중…", "");
  try {
    const userR = await fetch("https://api.github.com/user", { headers: ghHeaders(token) });
    if (userR.status === 401) return show("✗ 토큰이 무효합니다 (401). 새로 발급해서 다시 입력하세요.", "error");
    if (!userR.ok) return show(`✗ /user ${userR.status}: ${(await userR.text()).slice(0, 120)}`, "error");
    const user = await userR.json();

    const repoR = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token) });
    if (repoR.status === 404) return show(`✓ 토큰 OK (${user.login}) / ✗ repo "${repo}" 안 보임 — private 권한 누락 또는 오타.`, "error");
    if (!repoR.ok) return show(`✗ /repos/${repo} ${repoR.status}: ${(await repoR.text()).slice(0, 120)}`, "error");
    const repoData = await repoR.json();
    const canPush = repoData.permissions?.push;
    if (canPush === false) return show(`✓ 토큰 OK (${user.login}) / ✗ repo 읽기만 가능, push 권한 없음. fine-grained 토큰의 Contents 권한 확인.`, "error");
    show(`✓ ${user.login} → ${repo} push 가능. 설정 정상.`, "success");
  } catch (e) {
    show(`✗ 네트워크 오류: ${e.message}`, "error");
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
const taskActionsEl = document.getElementById("task-actions");
const taskClearBtn = document.getElementById("task-clear");

const TASK_LABELS = {
  "scan:all": "모든 노트북 스캔",
  "bulk:remote": "일괄 다운로드 (cross-notebook)",
};
const STATUS_LABELS = {
  idle: "대기",
  running: "진행 중",
  completed: "완료",
  failed: "실패",
};

let lastRenderedState = null;
let elapsedTimer = null;

function formatElapsed(ms) {
  if (!ms || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}분 ${remSec}초`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}시간 ${remMin}분`;
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

  taskTitleEl.textContent = TASK_LABELS[state.task] || state.task;
  taskStatusEl.textContent = STATUS_LABELS[state.status] || state.status;

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
  if (state.notebookCount > 0) stats.push(`노트북 ${state.notebookCount}개`);
  if (state.cardCount > 0) stats.push(`카드 ${state.cardCount}개`);
  if (state.successCount > 0) stats.push(`성공 ${state.successCount}`);
  if (state.errorCount > 0) stats.push(`실패 ${state.errorCount}`);
  taskStatsEl.textContent = stats.join(" · ");

  if (state.errors && state.errors.length > 0) {
    taskErrorsEl.style.display = "block";
    taskErrorsEl.innerHTML = state.errors.map((err) => {
      const label = err.episodeTitle || err.url || "(unknown)";
      const safeLabel = String(label).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      const safeMsg = String(err.message || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      return `<div>· ${safeLabel}: ${safeMsg}</div>`;
    }).join("");
  } else {
    taskErrorsEl.style.display = "none";
  }

  if (state.status === "completed" || state.status === "failed") {
    taskActionsEl.style.display = "flex";
    stopElapsedTimer();
  } else {
    taskActionsEl.style.display = "none";
    startElapsedTimer();
  }
}

function startElapsedTimer() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    if (lastRenderedState && lastRenderedState.status === "running" && lastRenderedState.startedAt) {
      const ms = Date.now() - lastRenderedState.startedAt;
      taskElapsedEl.textContent = formatElapsed(ms);
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "task:state") {
    renderTaskState(msg.state);
    // 스캔 완료 시점엔 lastScanResult 가 막 persist 됐으니, bulk:remote 완료 시점엔
    // 신규 카드 수가 줄어들었으니 — 둘 다 직전 스캔 패널 재렌더가 필요.
    if (msg.state?.status === "completed" || msg.state?.status === "failed") {
      renderLastScanPanel();
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
const lastScanClearBtn = document.getElementById("last-scan-clear");

async function renderLastScanPanel() {
  const r = await chrome.runtime.sendMessage({ type: "scan:result:get" }).catch(() => null);
  const result = r?.result;
  if (!result || !result.notebooks || result.notebooks.length === 0) {
    lastScanPanel.style.display = "none";
    return;
  }
  const cardCount = result.notebooks.reduce((s, n) => s + (n.audios?.length || 0), 0);

  // 신규 카드 수는 ghList 기반으로 background 에서 계산할 수도 있지만, 일반 GET 한 번이면
  // 충분하니 popup 처럼 list:pushed 를 직접 호출.
  let newCount = 0;
  let placeholderCount = 0;
  try {
    const pushed = await chrome.runtime.sendMessage({ type: "list:pushed" });
    const pushedSet = new Set(pushed?.shortIds || []);
    for (const nb of result.notebooks) {
      for (const audio of (nb.audios || [])) {
        if (audio.isPlaceholder) { placeholderCount++; continue; }
        const sid = (audio.artifactId || "").slice(0, 8);
        if (sid && pushedSet.has(sid)) continue;
        newCount++;
      }
    }
  } catch {}

  const ageMs = Date.now() - (result.scannedAt || Date.now());
  lastScanWhenEl.textContent = formatElapsed(ageMs) + " 전";

  const parts = [`노트북 ${result.notebooks.length}개`, `카드 ${cardCount}개`];
  if (placeholderCount > 0) parts.push(`${placeholderCount}개 제목 대기`);
  parts.push(`신규 ${newCount}개`);
  lastScanSummaryEl.textContent = parts.join(" · ");

  lastScanPanel.style.display = "block";
  lastScanDownloadBtn.disabled = newCount === 0;
  lastScanDownloadBtn.textContent = newCount === 0 ? "신규 없음" : `신규 ${newCount}개 받기`;
}

lastScanDownloadBtn.addEventListener("click", async () => {
  lastScanDownloadBtn.disabled = true;
  const r = await chrome.runtime.sendMessage({ type: "bulk:remote:from-last-scan" });
  if (!r?.ok) {
    show(`Bulk 시작 실패: ${r?.error || "알 수 없음"}`, "error");
    lastScanDownloadBtn.disabled = false;
    return;
  }
  // task:state 가 갱신되면서 진행 모니터에 자동으로 노출됨.
});

lastScanClearBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "scan:result:clear" });
  lastScanPanel.style.display = "none";
});
