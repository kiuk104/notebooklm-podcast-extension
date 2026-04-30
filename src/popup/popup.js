const scanBtn = document.getElementById("scan");
const scanAllBtn = document.getElementById("scan-all");
const statusEl = document.getElementById("status");
const coverEl = document.getElementById("cover");
const nbTitleEl = document.getElementById("nb-title");
const nbDateEl = document.getElementById("nb-date");
const cardsEl = document.getElementById("cards");
const bulkBarEl = document.getElementById("bulk-bar");
const selectAllEl = document.getElementById("select-all");
const bulkDlBtn = document.getElementById("bulk-dl");

// episodeTitle → state span. background 의 push:result 메시지를 받았을 때 매칭용.
const stateByTitle = new Map();
// episodeTitle → { checkbox, btn }. bulk 진행 중 disable / re-enable.
const controlsByTitle = new Map();

// 현재 popup 의 모드 — "single" (active 노트북 스캔 결과) 또는 "all" (cross-notebook
// 결과). 모드에 따라 [선택 받기] 가 active tab 의 content script 직접 호출 vs.
// background 의 bulk:remote 호출로 분기.
let viewMode = "single";
// "all" 모드일 때 카드 → notebookUrl 매핑. notebookUrl + cardIndex 로 다운로드 라우팅.
const cardMeta = new Map(); // li → { notebookUrl, cardIndex, episodeTitle, isPlaceholder, alreadyPushed }

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function activeNotebookTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://notebooklm.google.com/notebook/")) {
    return null;
  }
  return tab;
}

function setRow(state, kind, text, title = "") {
  state.className = "ep-state" + (kind ? " " + kind : "");
  state.textContent = text;
  state.title = title;
}

function shortIdOf(artifactId) {
  if (!artifactId) return "";
  const m = /^([0-9a-f]{8})/.exec(artifactId);
  return m ? m[1] : "";
}

function clearList() {
  cardsEl.innerHTML = "";
  stateByTitle.clear();
  controlsByTitle.clear();
  cardMeta.clear();
  bulkBarEl.style.display = "none";
}

function appendCardRow({ idx, audio, alreadyPushed, notebookUrl, isRemote, tabId }) {
  const li = document.createElement("li");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "sel";
  if (audio.isPlaceholder) {
    checkbox.disabled = true;
    checkbox.checked = false;
    checkbox.title = "제목 확정 대기 중";
  } else {
    checkbox.checked = !alreadyPushed;
  }
  checkbox.addEventListener("change", refreshBulkBar);

  const title = document.createElement("span");
  title.className = "ep-title";
  title.title = audio.title || "(제목 없음)";
  title.textContent = `${idx + 1}. ${audio.title || "(제목 없음)"}`;

  const state = document.createElement("span");
  state.className = "ep-state";
  if (audio.title) stateByTitle.set(audio.title, state);

  const btn = document.createElement("button");
  btn.className = "dl";
  btn.textContent = "받기";
  if (audio.isPlaceholder) {
    btn.disabled = true;
    btn.title = "제목이 확정되면 활성화됩니다";
    setRow(state, "muted", "제목 확정 대기 중", "다시 스캔하면 활성화됩니다");
  } else if (alreadyPushed) {
    setRow(state, "muted", "↻ 이미 받음", "repo 의 docs/episodes/ 에 같은 shortId 존재");
  }
  btn.addEventListener("click", () => {
    if (isRemote) {
      // remote 단건도 bulk:remote 1건으로 처리.
      runBulkRemote([{ notebookUrl, cardIndex: idx, episodeTitle: audio.title }]);
    } else {
      downloadOneSingle(tabId, idx);
    }
  });

  li.append(checkbox, title, state, btn);
  cardsEl.appendChild(li);

  cardMeta.set(li, {
    notebookUrl,
    cardIndex: idx,
    episodeTitle: audio.title,
    isPlaceholder: audio.isPlaceholder,
    alreadyPushed,
    isRemote,
  });
  if (audio.title) controlsByTitle.set(audio.title, { checkbox, btn });
}

function appendNotebookHeader({ title, dateAttr, audios }) {
  const li = document.createElement("li");
  li.className = "nb-header";
  const t = document.createElement("span");
  t.className = "nb-h-title";
  t.textContent = title || "(제목 없음)";
  const d = document.createElement("span");
  d.className = "nb-h-date";
  d.textContent = dateAttr ? `· ${dateAttr.split(" ").slice(1, 4).join(" ")}` : "";
  li.append(t, d);
  if (!audios || audios.length === 0) {
    const empty = document.createElement("span");
    empty.className = "nb-h-empty";
    empty.textContent = "(음성개요 없음)";
    li.appendChild(empty);
  }
  cardsEl.appendChild(li);
}

function refreshBulkBar() {
  const eligible = cardsEl.querySelectorAll('input.sel:not(:disabled)').length;
  if (eligible === 0) {
    bulkBarEl.style.display = "none";
    return;
  }
  bulkBarEl.style.display = "flex";
  const selected = cardsEl.querySelectorAll('input.sel:checked').length;
  bulkDlBtn.textContent = `선택 받기 (${selected})`;
  bulkDlBtn.disabled = selected === 0;
  if (selected === 0) {
    selectAllEl.checked = false;
    selectAllEl.indeterminate = false;
  } else if (selected === eligible) {
    selectAllEl.checked = true;
    selectAllEl.indeterminate = false;
  } else {
    selectAllEl.checked = false;
    selectAllEl.indeterminate = true;
  }
}

selectAllEl.addEventListener("change", () => {
  const checked = selectAllEl.checked;
  cardsEl.querySelectorAll('input.sel:not(:disabled)').forEach((cb) => {
    cb.checked = checked;
  });
  refreshBulkBar();
});

// ----- Single 모드 다운로드 (active 탭의 content script 직접 호출) -----

async function downloadOneSingle(tabId, index) {
  const liEls = cardsEl.querySelectorAll("li");
  // single 모드는 헤더 없이 카드만 있으므로 nth li = idx 와 일치 — viewMode === "single".
  const li = liEls[index];
  if (!li) return;
  const checkbox = li.querySelector("input.sel");
  const btn = li.querySelector("button.dl");
  const state = li.querySelector(".ep-state");
  if (checkbox) checkbox.disabled = true;
  if (btn) btn.disabled = true;
  setRow(state, "", "받는 중…");
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: "download", index });
  } catch (e) {
    setRow(state, "err", "✗", e.message);
    if (btn) btn.disabled = false;
    if (checkbox) checkbox.disabled = false;
    return;
  }
  if (resp?.ok) {
    setRow(state, "ok", "⬇ 받음, push 중…");
  } else {
    setRow(state, "err", "✗", resp?.error || "실패");
    if (btn) btn.disabled = false;
    if (checkbox) checkbox.disabled = false;
    return;
  }
  if (resp.episodeTitle) await awaitPushResult(resp.episodeTitle);
  if (btn) btn.disabled = false;
  if (checkbox) checkbox.disabled = false;
}

function awaitPushResult(episodeTitle, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (msg) => {
      if (done) return;
      done = true;
      chrome.runtime.onMessage.removeListener(handler);
      clearTimeout(timer);
      resolve(msg);
    };
    const handler = (msg) => {
      if (msg?.type === "push:result" && msg.episodeTitle === episodeTitle) finish(msg);
    };
    chrome.runtime.onMessage.addListener(handler);
    const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
  });
}

// ----- Bulk 받기 (single + all 양쪽 진입점) -----

bulkDlBtn.addEventListener("click", async () => {
  const items = collectSelected();
  if (items.length === 0) return;
  if (viewMode === "single") {
    const tab = await activeNotebookTab();
    if (!tab) {
      setStatus("현재 탭이 NotebookLM 노트북 페이지가 아닙니다.", "error");
      return;
    }
    await runBulkLocal(tab.id, items);
  } else {
    runBulkRemote(items.map((i) => ({
      notebookUrl: i.notebookUrl, cardIndex: i.cardIndex, episodeTitle: i.episodeTitle,
    })));
  }
});

function collectSelected() {
  const out = [];
  cardsEl.querySelectorAll("li").forEach((li) => {
    const cb = li.querySelector("input.sel");
    if (!cb || !cb.checked) return;
    const meta = cardMeta.get(li);
    if (meta) out.push(meta);
  });
  return out;
}

async function runBulkLocal(tabId, items) {
  scanBtn.disabled = true;
  scanAllBtn.disabled = true;
  bulkDlBtn.disabled = true;
  selectAllEl.disabled = true;
  setStatus(`bulk: ${items.length}개 다운로드 중 (0/${items.length})`, "");
  let done = 0;
  for (const item of items) {
    await downloadOneSingle(tabId, item.cardIndex);
    done += 1;
    setStatus(`bulk: ${items.length}개 다운로드 중 (${done}/${items.length})`, "");
  }
  setStatus(`bulk: ${items.length}개 처리 완료.`, "success");
  scanBtn.disabled = false;
  scanAllBtn.disabled = false;
  selectAllEl.disabled = false;
  refreshBulkBar();
}

async function runBulkRemote(selections) {
  scanBtn.disabled = true;
  scanAllBtn.disabled = true;
  bulkDlBtn.disabled = true;
  selectAllEl.disabled = true;
  setStatus(`bulk(원격): ${selections.length}개 다운로드 시작…`, "");
  // 시작 카드 상태 모두 "대기"
  for (const s of selections) {
    const state = stateByTitle.get(s.episodeTitle);
    if (state) setRow(state, "", "대기 중…");
  }
  const ack = await chrome.runtime.sendMessage({ type: "bulk:remote", selections });
  if (!ack?.ok) {
    setStatus(`bulk: ${ack?.error || "시작 실패"}`, "error");
    scanBtn.disabled = false;
    scanAllBtn.disabled = false;
    selectAllEl.disabled = false;
    refreshBulkBar();
  }
  // 완료는 onMessage 의 bulk:remote:done 에서 처리.
}

// ----- background → popup 이벤트 -----

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;

  if (msg.type === "push:result") {
    const state = stateByTitle.get(msg.episodeTitle);
    if (!state) return;
    const feedNote = feedSuffix(msg);
    if (msg.skipped) {
      setRow(state, "ok", "↻ push 스킵" + feedNote, msg.reason || "");
    } else if (msg.ok) {
      setRow(state, "ok", "✓ push 완료" + feedNote, msg.filename);
    } else {
      setRow(state, "err", "✗ push 실패", msg.error || "");
    }
    return;
  }

  if (msg.type === "scan:all:progress") {
    if (msg.message) setStatus(msg.message, "");
    return;
  }

  if (msg.type === "scan:all:done") {
    if (!msg.ok) {
      setStatus(`스캔 실패: ${msg.error}`, "error");
      scanBtn.disabled = false;
      scanAllBtn.disabled = false;
      return;
    }
    renderAggregate(msg.notebooks);
    return;
  }

  if (msg.type === "bulk:remote:progress") {
    if (msg.episodeTitle) {
      const state = stateByTitle.get(msg.episodeTitle);
      if (state) setRow(state, "", "받는 중…");
    } else if (msg.message) {
      setStatus(msg.message, "");
    }
    return;
  }

  if (msg.type === "bulk:remote:result") {
    const state = stateByTitle.get(msg.episodeTitle);
    if (state && !msg.ok) setRow(state, "err", "✗", msg.error || "실패");
    return;
  }

  if (msg.type === "bulk:remote:done") {
    if (msg.ok) {
      setStatus(`bulk(원격): ${msg.done}개 처리 완료.`, "success");
    } else {
      setStatus(`bulk: ${msg.error}`, "error");
    }
    scanBtn.disabled = false;
    scanAllBtn.disabled = false;
    selectAllEl.disabled = false;
    refreshBulkBar();
    return;
  }
});

function feedSuffix(msg) {
  if (msg.feedError) return " ⚠ feed";
  if (msg.feed?.ok) return " + feed";
  return "";
}

// ----- 스캔: 단일 노트북 -----

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  scanAllBtn.disabled = true;
  setStatus("스캔 중…");
  clearList();
  coverEl.style.display = "none";
  viewMode = "single";
  try {
    const tab = await activeNotebookTab();
    if (!tab) {
      setStatus("현재 탭이 NotebookLM 노트북 페이지가 아닙니다.", "error");
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "scan" });
    if (!resp?.ok) {
      setStatus("응답 없음 — 페이지를 새로고침하세요.", "error");
      return;
    }
    nbTitleEl.textContent = resp.cover.title || "(제목 없음)";
    nbDateEl.textContent = resp.cover.dateAttr || "생성일 정보 없음";
    coverEl.style.display = "block";

    const pushed = await chrome.runtime.sendMessage({ type: "list:pushed" })
      .catch(() => ({ ok: false, shortIds: [] }));
    const pushedShortIds = pushed?.shortIds || [];

    const total = resp.audios.length;
    const pending = resp.audios.filter((a) => a.isPlaceholder).length;
    const alreadyCount = resp.audios.filter((a) => {
      const sid = shortIdOf(a.artifactId);
      return sid && pushedShortIds.includes(sid);
    }).length;

    if (!total) setStatus("음성개요 0개", "");
    else if (pending === total) setStatus(`음성개요 ${total}개 — 모두 제목 확정 대기 중. 잠시 후 다시 스캔하세요.`, "");
    else {
      const parts = [`음성개요 ${total}개`];
      if (pending > 0) parts.push(`${pending}개 제목 확정 대기 중`);
      if (alreadyCount > 0) parts.push(`${alreadyCount}개 이미 받음`);
      setStatus(parts.join(" · "), "success");
    }

    resp.audios.forEach((audio, idx) => {
      const sid = shortIdOf(audio.artifactId);
      const alreadyPushed = sid && pushedShortIds.includes(sid);
      appendCardRow({
        idx, audio, alreadyPushed,
        notebookUrl: tab.url, isRemote: false, tabId: tab.id,
      });
    });
    refreshBulkBar();
  } catch (e) {
    setStatus(`오류: ${e.message}`, "error");
  } finally {
    scanBtn.disabled = false;
    scanAllBtn.disabled = false;
  }
});

// ----- 스캔: 모든 노트북 (cross-notebook) -----

scanAllBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  scanAllBtn.disabled = true;
  clearList();
  coverEl.style.display = "none";
  viewMode = "all";
  setStatus("모든 노트북 스캔 시작 — 백그라운드 탭이 잠시 깜빡일 수 있습니다.", "");
  const ack = await chrome.runtime.sendMessage({ type: "scan:all" });
  if (!ack?.ok) {
    setStatus(`시작 실패: ${ack?.error || "알 수 없음"}`, "error");
    scanBtn.disabled = false;
    scanAllBtn.disabled = false;
  }
  // progress / done 은 onMessage 핸들러에서 처리.
});

async function renderAggregate(notebooks) {
  clearList();
  viewMode = "all";

  if (!notebooks || notebooks.length === 0) {
    setStatus(
      "노트북을 찾지 못했습니다. NotebookLM 홈에 노트북이 있는지 + 로그인 상태인지 확인하세요.",
      "error",
    );
    scanBtn.disabled = false;
    scanAllBtn.disabled = false;
    return;
  }

  const pushed = await chrome.runtime.sendMessage({ type: "list:pushed" })
    .catch(() => ({ ok: false, shortIds: [] }));
  const pushedShortIds = pushed?.shortIds || [];

  let totalCards = 0;
  let totalEligible = 0;
  let totalAlready = 0;
  let totalPlaceholder = 0;

  for (const nb of notebooks) {
    appendNotebookHeader({
      title: nb.cover?.title,
      dateAttr: nb.cover?.dateAttr,
      audios: nb.audios,
    });
    (nb.audios || []).forEach((audio, idx) => {
      const sid = shortIdOf(audio.artifactId);
      const alreadyPushed = sid && pushedShortIds.includes(sid);
      totalCards++;
      if (audio.isPlaceholder) totalPlaceholder++;
      else if (alreadyPushed) totalAlready++;
      else totalEligible++;
      appendCardRow({
        idx, audio, alreadyPushed,
        notebookUrl: nb.url, isRemote: true,
      });
    });
  }

  const parts = [`노트북 ${notebooks.length}개`, `카드 ${totalCards}개`];
  if (totalPlaceholder > 0) parts.push(`${totalPlaceholder}개 제목 대기`);
  if (totalAlready > 0) parts.push(`${totalAlready}개 이미 받음`);
  if (totalEligible > 0) parts.push(`${totalEligible}개 신규`);
  if (totalCards === 0) {
    parts.push("(스캔된 노트북에 음성개요 없음 — 카드 로딩이 늦어 timeout 됐을 수도)");
  }
  setStatus(parts.join(" · "), totalCards > 0 ? "success" : "");

  refreshBulkBar();
  scanBtn.disabled = false;
  scanAllBtn.disabled = false;
}

// popup 첫 오픈 시 직전 스캔 결과 자동 복원 — 11분짜리 sweep 이후 popup 이 닫혔다 다시
// 열릴 때 [모든 노트북 스캔] 을 또 누르지 않아도 카드 list 가 그대로 보이도록.
// 단 (a) 진행 중인 task 가 있으면 그 흐름에 양보 (b) 30분 이상 지난 결과는 무시.
(async () => {
  try {
    const taskR = await chrome.runtime.sendMessage({ type: "task:state:get" });
    if (taskR?.state?.status === "running") return; // 진행 중이면 안 건드림.
    const r = await chrome.runtime.sendMessage({ type: "scan:result:get" });
    if (!r?.result?.notebooks?.length) return;
    const ageMs = Date.now() - (r.result.scannedAt || 0);
    if (ageMs > 30 * 60 * 1000) return; // 30분 넘으면 stale 로 보고 무시.
    await renderAggregate(r.result.notebooks);
    const ageMin = Math.round(ageMs / 60000);
    const ageStr = ageMin < 1 ? `${Math.round(ageMs / 1000)}초 전` : `${ageMin}분 전`;
    setStatus((statusEl.textContent || "").replace(/^\s*/, "") + ` (${ageStr} 스캔)`, "success");
  } catch {}
})();

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("open-help").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("src/help/help.html") });
});
