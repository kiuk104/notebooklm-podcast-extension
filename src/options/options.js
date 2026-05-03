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
const taskRecentHeadEl = document.getElementById("task-recent-head");
const taskRecentSummaryEl = document.getElementById("task-recent-summary");
const taskRecentEl = document.getElementById("task-recent");
const taskActionsEl = document.getElementById("task-actions");
const taskClearBtn = document.getElementById("task-clear");
const taskCancelBtn = document.getElementById("task-cancel");

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
  if (sec < 60) return `${sec}초전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분전`;
  const hr = Math.floor(min / 60);
  return `${hr}시간전`;
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
  let okN = 0, skipN = 0, errN = 0;
  for (const p of recent) {
    if (p.ok && typeof p.size === "number") totalBytes += p.size;
    if (p.ok) okN++;
    else if (p.skipped) skipN++;
    else errN++;
  }
  const summaryParts = [];
  if (okN > 0) summaryParts.push(`✓ ${okN}`);
  if (skipN > 0) summaryParts.push(`↻ ${skipN}`);
  if (errN > 0) summaryParts.push(`✗ ${errN}`);
  if (totalBytes > 0) summaryParts.push(formatBytes(totalBytes));
  taskRecentSummaryEl.textContent = summaryParts.join(" · ");

  taskRecentEl.innerHTML = reversed.map((p) => {
    const cls = p.ok ? "ok" : p.skipped ? "skip" : "err";
    const icon = p.ok ? "✓" : p.skipped ? "↻" : "✗";
    const title = escapeHtml(p.episodeTitle || p.filename || "(제목 없음)");
    let detail = "";
    if (p.skipped) {
      detail = `<span class="size">${escapeHtml(p.reason || "이미 있음")}</span>`;
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
      return `<div>· ${escapeHtml(label)}: ${escapeHtml(err.message || "")}</div>`;
    }).join("");
  } else {
    taskErrorsEl.style.display = "none";
  }

  renderRecentPushes(state.recentPushes);

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
  if (!confirm("현재 작업을 중단하시겠습니까? 다음 노트북/카드 처리 시작 전 빠져나갑니다.")) return;
  taskCancelBtn.disabled = true;
  taskCancelBtn.textContent = "중단 요청 중…";
  try {
    await chrome.runtime.sendMessage({ type: "task:cancel" });
  } catch {}
  // 실제 상태 전환은 task:state 메시지로 도착 — UI 재렌더에서 처리.
  setTimeout(() => {
    taskCancelBtn.disabled = false;
    taskCancelBtn.textContent = "강제 중단";
  }, 3000);
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
    refreshMonitorChrome();
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
  refreshMonitorChrome();
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
const metaReloadBtn = document.getElementById("meta-reload");
const metaStatusEl = document.getElementById("meta-status");

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
  updateImagePreview();
}

async function loadPodcastMeta() {
  const stored = await chrome.storage.local.get(["token", "repo"]);
  if (!stored.token || !stored.repo) {
    showMetaStatus("먼저 GitHub Token + Repo 를 저장하세요.", "");
    return;
  }
  if (!REPO_RE.test(stored.repo)) {
    showMetaStatus("Repo 형식이 잘못됐습니다 (owner/name).", "error");
    return;
  }
  showMetaStatus("로드 중…", "");
  try {
    const r = await fetch(
      `https://api.github.com/repos/${stored.repo}/contents/docs/podcast.json`,
      { headers: ghHeaders(stored.token), cache: "no-store" },
    );
    if (r.status === 404) {
      podcastJsonSha = null;
      podcastJsonOriginal = {};
      showMetaStatus("repo 에 docs/podcast.json 이 없습니다. 폼을 채우고 [메타 저장] 하면 새로 생성됩니다.", "");
      return;
    }
    if (r.status === 401) {
      showMetaStatus("토큰 무효 (401). [GitHub 설정] 의 [설정 검증] 으로 확인하세요.", "error");
      return;
    }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
    const data = await r.json();
    const text = utf8Atob(data.content.replace(/\n/g, ""));
    const json = JSON.parse(text);
    podcastJsonSha = data.sha;
    populateMetaForm(json);
    showMetaStatus("✓ 로드됨.", "success");
  } catch (e) {
    showMetaStatus(`로드 실패: ${e.message}`, "error");
  }
}

metaReloadBtn.addEventListener("click", () => loadPodcastMeta());

metaForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const stored = await chrome.storage.local.get(["token", "repo", "committerName", "committerEmail"]);
  if (!stored.token || !stored.repo) {
    showMetaStatus("먼저 GitHub Token + Repo 를 저장하세요.", "error");
    return;
  }
  if (!REPO_RE.test(stored.repo)) {
    showMetaStatus("Repo 형식이 잘못됐습니다 (owner/name).", "error");
    return;
  }

  // 폼에 노출 안 한 필드 (retention / transcode / baseUrl 등) 는 그대로 보존.
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
    showMetaStatus("✓ 메타 저장됨. 워크플로가 트리거되어 feed.xml 이 재빌드됩니다.", "success");
  } catch (e) {
    showMetaStatus(`저장 실패: ${e.message}`, "error");
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

  const stored = await chrome.storage.local.get(["token", "repo", "committerName", "committerEmail"]);
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
(async () => {
  const stored = await chrome.storage.local.get(["token", "repo"]);
  if (stored.token && stored.repo && REPO_RE.test(stored.repo)) {
    loadPodcastMeta();
    loadEpisodeList();
  }
})();

// ---------- 에피소드 목록 (push 된 docs/episodes/ 의 row-level 관리) ----------

const epReloadBtn = document.getElementById("ep-reload");
const epGroupToggleBtn = document.getElementById("ep-group-toggle");
const epResetSortBtn = document.getElementById("ep-reset-sort");
const epSummaryEl = document.getElementById("ep-summary");
const epSelectedCountEl = document.getElementById("ep-selected-count");
const epBatchDeleteBtn = document.getElementById("ep-batch-delete");
const epStatusEl = document.getElementById("ep-status");
const epTableEl = document.getElementById("ep-table");
const epTbody = document.getElementById("ep-tbody");
const epEmptyEl = document.getElementById("ep-empty");
const epCheckAll = document.getElementById("ep-check-all");

let epItems = [];                    // 서버에서 받은 원본 (정렬 대상)
let epSortKey = "date";              // date / notebook / title / format / size
let epSortDir = "desc";              // asc / desc
let epGroupOn = false;
let epNotebookUrlMap = new Map();    // notebookSlug → notebookUrl (직전 스캔 결과 기반)

// background.js 의 slugify 와 동일 — 파일명의 노트북-슬러그를 lastScanResult 의
// 노트북 cover.title 과 매칭하기 위해 클라이언트에서도 같은 변환 필요. SLUG_MAX=40.
function epSlugify(text) {
  if (!text) return "";
  let s = text.trim().replace(/\s+/g, "-");
  s = s.replace(/[^0-9A-Za-z가-힣\-_]/g, "");
  return s.slice(0, 40);
}

async function refreshNotebookUrlMap() {
  // 직전 스캔 결과 (background.js 의 lastScanResult) 에서 notebookSlug → URL.
  // 30분 freshness 안의 결과만 — stale 이면 빈 맵, [편집] 클릭 시 fallback (홈 열기).
  epNotebookUrlMap.clear();
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
function epShowStatus(text, kind) {
  if (!text) { epStatusEl.style.display = "none"; return; }
  epStatusEl.textContent = text;
  epStatusEl.className = "status " + (kind || "");
  epStatusEl.style.display = "block";
}

async function loadEpisodeList() {
  epShowStatus("목록 로드 중…", "");
  epReloadBtn.disabled = true;
  try {
    // 직전 스캔 결과 매핑을 동시에 새로고침 — [편집] 버튼이 노트북 URL 을 알 수 있게.
    await refreshNotebookUrlMap();
    const r = await chrome.runtime.sendMessage({ type: "episodes:list:full" });
    if (!r?.ok) {
      epShowStatus(`로드 실패: ${r?.error || "알 수 없음"}`, "error");
      epTableEl.style.display = "none";
      epEmptyEl.style.display = "none";
      return;
    }
    epItems = r.items || [];
    const totalMB = (r.totalSize || 0) / 1024 / 1024;
    epSummaryEl.textContent = `${epItems.length}개 · ${totalMB.toFixed(1)} MB`;
    if (epItems.length === 0) {
      epTableEl.style.display = "none";
      epEmptyEl.style.display = "block";
      epShowStatus("");
      return;
    }
    epTableEl.style.display = "";
    epEmptyEl.style.display = "none";
    renderEpisodeTable();
    epShowStatus("");
  } catch (e) {
    epShowStatus(`로드 실패: ${e.message}`, "error");
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

function renderEpisodeTable() {
  // 정렬 화살표 표시.
  document.querySelectorAll("#ep-table th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.key === epSortKey) th.classList.add(epSortDir === "asc" ? "sort-asc" : "sort-desc");
  });

  const items = epSortedItems();
  const html = items.map((it) => {
    if (it.__groupHeader) {
      return `<tr class="group-header"><td colspan="7">📓 ${escapeHtml(it.notebook)}  (${it.count}개)</td></tr>`;
    }
    const ymd = it.date;
    const fmtClass = `format-tag ${escapeHtml(it.format)}`;
    const notebookSlug = epSlugify(it.notebook);
    const nbUrl = epNotebookUrlMap.get(notebookSlug);
    const editAttrs = nbUrl
      ? `data-nb-url="${escapeHtml(nbUrl)}" title="NotebookLM 에서 이 노트북 열기"`
      : `disabled title="노트북 URL 미상 — [모든 노트북 스캔] 후 다시 시도"`;
    return `
      <tr class="ep-row" data-filename="${escapeHtml(it.filename)}" data-sha="${escapeHtml(it.sha)}">
        <td class="col-check"><input type="checkbox" class="ep-check"></td>
        <td>${escapeHtml(ymd)}</td>
        <td class="notebook">${escapeHtml(it.notebook)}</td>
        <td class="title" title="${escapeHtml(it.filename)}">${escapeHtml(it.title)}</td>
        <td><span class="${fmtClass}">${escapeHtml(it.format)}</span></td>
        <td class="num">${escapeHtml(epFmtSize(it.size))}</td>
        <td class="col-actions">
          <button type="button" class="ep-action edit" ${editAttrs}>편집 ↗</button>
          <button type="button" class="ep-action danger">삭제</button>
        </td>
      </tr>`;
  }).join("");
  epTbody.innerHTML = html;
  refreshBatchUI();
}

function refreshBatchUI() {
  const checked = epTbody.querySelectorAll(".ep-check:checked").length;
  const total = epTbody.querySelectorAll(".ep-check").length;
  epSelectedCountEl.textContent = checked ? `${checked}개 선택됨` : "";
  epBatchDeleteBtn.disabled = checked === 0;
  epCheckAll.indeterminate = checked > 0 && checked < total;
  epCheckAll.checked = checked > 0 && checked === total;
}

epReloadBtn.addEventListener("click", () => loadEpisodeList());

document.querySelectorAll("#ep-table th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (epSortKey === key) epSortDir = epSortDir === "asc" ? "desc" : "asc";
    else { epSortKey = key; epSortDir = "asc"; }
    renderEpisodeTable();
  });
});

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
  // 단일 삭제 — 편집 (제목 변경) 은 NotebookLM 원본에서. 잘못 받은 카드만
  // 여기서 ghDelete 하고, 다음 sweep 에서 새 제목으로 다시 받아오는 흐름.
  if (e.target.classList.contains("danger")) {
    const row = e.target.closest("tr.ep-row");
    if (!row) return;
    const fn = row.dataset.filename;
    const sha = row.dataset.sha;
    if (!confirm(`정말 삭제할까요?\n${fn}`)) return;
    e.target.disabled = true;
    epShowStatus(`삭제 중: ${fn}…`, "");
    try {
      const r = await chrome.runtime.sendMessage({
        type: "episodes:delete", filename: fn, sha,
      });
      if (!r?.ok) throw new Error(r?.error || "삭제 실패");
      epShowStatus(`✓ 삭제됨: ${fn}`, "success");
      await loadEpisodeList();
    } catch (err) {
      epShowStatus(`삭제 실패: ${err.message}`, "error");
      e.target.disabled = false;
    }
    return;
  }
});

epBatchDeleteBtn.addEventListener("click", async () => {
  const targets = Array.from(epTbody.querySelectorAll(".ep-check:checked")).map((cb) => {
    const row = cb.closest("tr.ep-row");
    return { filename: row.dataset.filename, sha: row.dataset.sha };
  });
  if (targets.length === 0) return;
  if (!confirm(`${targets.length}개 에피소드를 삭제할까요?`)) return;
  epBatchDeleteBtn.disabled = true;
  let ok = 0, fail = 0;
  for (let i = 0; i < targets.length; i++) {
    epShowStatus(`삭제 중 (${i + 1}/${targets.length}): ${targets[i].filename.slice(0, 50)}…`, "");
    try {
      const r = await chrome.runtime.sendMessage({
        type: "episodes:delete",
        filename: targets[i].filename, sha: targets[i].sha,
      });
      if (r?.ok) ok++; else fail++;
    } catch { fail++; }
  }
  epShowStatus(`✓ 삭제 완료 — 성공 ${ok} / 실패 ${fail}`, fail > 0 ? "error" : "success");
  await loadEpisodeList();
});

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
  if (el) el.textContent = `v${v} · 관리`;
} catch {}

// 첫 로드: URL 의 hash 또는 default 로 페이지 표시.
showPage(location.hash.replace("#", ""));
