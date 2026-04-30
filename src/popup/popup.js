const scanBtn = document.getElementById("scan");
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
// episodeTitle → checkbox/[받기] 버튼. bulk 진행 중에 disable / re-enable 시 사용.
const controlsByTitle = new Map();

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

function renderCards(audios, tabId, pushedShortIds) {
  cardsEl.innerHTML = "";
  stateByTitle.clear();
  controlsByTitle.clear();
  const pushedSet = new Set(pushedShortIds || []);

  audios.forEach((a, i) => {
    const li = document.createElement("li");

    const sid = shortIdOf(a.artifactId);
    const alreadyPushed = sid && pushedSet.has(sid);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "sel";
    checkbox.dataset.idx = String(i);
    if (a.isPlaceholder) {
      checkbox.disabled = true;
      checkbox.checked = false;
      checkbox.title = "제목 확정 대기 중";
    } else {
      // placeholder 아니면서 아직 repo 에 없으면 default 체크. 이미 받은 카드는 default 미체크.
      checkbox.checked = !alreadyPushed;
    }
    checkbox.addEventListener("change", refreshBulkBar);

    const title = document.createElement("span");
    title.className = "ep-title";
    title.title = a.title || "(제목 없음)";
    title.textContent = `${i + 1}. ${a.title || "(제목 없음)"}`;

    const state = document.createElement("span");
    state.className = "ep-state";
    if (a.title) stateByTitle.set(a.title, state);

    const btn = document.createElement("button");
    btn.className = "dl";
    btn.textContent = "받기";
    if (a.isPlaceholder) {
      // NotebookLM 의 'audio N' 플레이스홀더 제목 단계에서 받으면 v1 처럼 다음
      // sync 에서 실제 제목으로 또 받는 중복이 생김 (IMPLEMENTATION_NOTES.md §1).
      btn.disabled = true;
      btn.title = "제목이 확정되면 활성화됩니다";
      setRow(state, "muted", "제목 확정 대기 중", "다시 스캔하면 활성화됩니다");
    } else if (alreadyPushed) {
      setRow(state, "muted", "↻ 이미 받음", "repo 의 docs/episodes/ 에 같은 shortId 존재");
    }
    btn.addEventListener("click", () => downloadOne(tabId, i));

    li.append(checkbox, title, state, btn);
    cardsEl.appendChild(li);

    if (a.title) controlsByTitle.set(a.title, { checkbox, btn });
  });
  refreshBulkBar();
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
  // 전체 선택 체크박스: eligible 중 모두 선택돼 있으면 checked, 일부면 indeterminate.
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

async function downloadOne(tabId, index) {
  const liEls = cardsEl.querySelectorAll("li");
  const li = liEls[index];
  if (!li) return { ok: false, error: "카드 없음" };
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
    return { ok: false, error: e.message };
  }
  if (resp?.ok) {
    setRow(state, "ok", "⬇ 받음, push 중…");
  } else {
    setRow(state, "err", "✗", resp?.error || "실패");
    if (btn) btn.disabled = false;
    if (checkbox) checkbox.disabled = false;
    return { ok: false, error: resp?.error };
  }
  // push:result 가 별도 onMessage 핸들러에서 도착해 state 를 갱신. 여기서는 그것까지 await
  // 해야 다음 카드가 동일한 NotebookLM 메뉴 popover 를 안전하게 열 수 있음.
  if (resp.episodeTitle) {
    await awaitPushResult(resp.episodeTitle);
  }
  if (btn) btn.disabled = false;
  if (checkbox) checkbox.disabled = false;
  return { ok: true };
}

// push:result 메시지를 episodeTitle 매칭으로 한 번만 기다림. timeout 시에도 resolve —
// bulk 흐름이 영구 대기하지 않도록.
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
      if (msg?.type === "push:result" && msg.episodeTitle === episodeTitle) {
        finish(msg);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
  });
}

bulkDlBtn.addEventListener("click", async () => {
  const tab = await activeNotebookTab();
  if (!tab) {
    setStatus("현재 탭이 NotebookLM 노트북 페이지가 아닙니다.", "error");
    return;
  }
  const indices = Array.from(cardsEl.querySelectorAll('input.sel:checked'))
    .map((cb) => Number(cb.dataset.idx));
  if (indices.length === 0) return;

  scanBtn.disabled = true;
  bulkDlBtn.disabled = true;
  selectAllEl.disabled = true;
  setStatus(`bulk: ${indices.length}개 다운로드 중 (0/${indices.length})`, "");
  let done = 0;
  for (const idx of indices) {
    await downloadOne(tab.id, idx);
    done += 1;
    setStatus(`bulk: ${indices.length}개 다운로드 중 (${done}/${indices.length})`, "");
  }
  setStatus(`bulk: ${indices.length}개 처리 완료.`, "success");
  scanBtn.disabled = false;
  selectAllEl.disabled = false;
  refreshBulkBar();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "push:result") return;
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
});

function feedSuffix(msg) {
  if (msg.feedError) return " ⚠ feed";
  if (msg.feed?.ok) return " + feed";
  if (msg.feed?.skipped) return "";
  return "";
}

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  setStatus("스캔 중…");
  cardsEl.innerHTML = "";
  bulkBarEl.style.display = "none";
  coverEl.style.display = "none";
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

    // bulk default 체크 상태 결정용으로 "이미 받은 shortId" 미리 조회. 실패해도 빈 배열로
    // 진행 — 그 경우 모든 카드가 default 체크되고 사용자가 알아서 미체크 가능.
    const pushed = await chrome.runtime.sendMessage({ type: "list:pushed" })
      .catch(() => ({ ok: false, shortIds: [] }));

    const total = resp.audios.length;
    const pending = resp.audios.filter((a) => a.isPlaceholder).length;
    const pushedShortIds = pushed?.shortIds || [];
    const alreadyCount = resp.audios.filter((a) => {
      const sid = shortIdOf(a.artifactId);
      return sid && pushedShortIds.includes(sid);
    }).length;

    if (!total) {
      setStatus("음성개요 0개", "");
    } else if (pending === total) {
      setStatus(`음성개요 ${total}개 — 모두 제목 확정 대기 중. 잠시 후 다시 스캔하세요.`, "");
    } else {
      const parts = [`음성개요 ${total}개`];
      if (pending > 0) parts.push(`${pending}개 제목 확정 대기 중`);
      if (alreadyCount > 0) parts.push(`${alreadyCount}개 이미 받음`);
      setStatus(parts.join(" · "), "success");
    }
    renderCards(resp.audios, tab.id, pushedShortIds);
  } catch (e) {
    setStatus(`오류: ${e.message}`, "error");
  } finally {
    scanBtn.disabled = false;
  }
});

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("open-help").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("src/help/help.html") });
});
