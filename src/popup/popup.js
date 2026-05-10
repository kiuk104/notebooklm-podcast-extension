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
const versionLineEl = document.getElementById("version-line");

// i18n: 옵션 페이지에서 사용자가 선택한 uiLang (chrome.storage.sync, 다기기 동기화)
// 또는 chrome.i18n.getUILanguage() (Chrome 브라우저 UI 언어) 기준. popup 자체엔
// 셀렉터 없음 — 옵션 페이지 셀렉터가 single source of truth. popup 매번 첫 오픈 시
// 초기화. sync 비어있으면 옛 local 위치도 fallback (background.js 의 마이그레이션이
// 완료되기 전 popup 이 먼저 열리는 경우 안전망).
async function initI18n() {
  const [s, l] = await Promise.all([
    chrome.storage.sync.get(["uiLang"]).catch(() => ({})),
    chrome.storage.local.get(["uiLang"]).catch(() => ({})),
  ]);
  let lang = s.uiLang ?? l.uiLang;
  if (!lang) {
    const chromeLang = (chrome.i18n?.getUILanguage?.() || navigator.language || "ko").toLowerCase().slice(0, 2);
    lang = chromeLang;
  }
  i18nSetLang(["ko", "en", "de"].includes(lang) ? lang : "ko");
  // bulk-dl 초기 텍스트 — data-i18n 으론 못 잡음 (선택 카운트가 동적).
  bulkDlBtn.textContent = t("popup.bulkDl", { n: 0 });
  // version line — data-i18n 이 textContent 를 이미 채웠으니 그 위에 prefix.
  if (versionLineEl) {
    const v = chrome.runtime.getManifest().version;
    versionLineEl.textContent = `v${v} · ${versionLineEl.textContent}`;
  }
}

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
    checkbox.title = t("popup.placeholder.cbTip");
  } else {
    checkbox.checked = !alreadyPushed;
  }
  checkbox.addEventListener("change", refreshBulkBar);

  const titleStr = audio.title || t("popup.untitled");
  const title = document.createElement("span");
  title.className = "ep-title";
  title.title = titleStr;
  title.textContent = `${idx + 1}. ${titleStr}`;

  const state = document.createElement("span");
  state.className = "ep-state";
  if (audio.title) stateByTitle.set(audio.title, state);

  const btn = document.createElement("button");
  btn.className = "dl";
  btn.textContent = t("popup.cardDl");
  if (audio.isPlaceholder) {
    btn.disabled = true;
    btn.title = t("popup.placeholder.btnTip");
    setRow(state, "muted", t("popup.placeholder.state"), t("popup.placeholder.stateTip"));
  } else if (alreadyPushed) {
    setRow(state, "muted", t("popup.alreadyPushed"), t("popup.alreadyPushed.tip"));
  }
  btn.addEventListener("click", () => {
    if (isRemote) {
      // remote 단건도 bulk:remote 1건으로 처리.
      runBulkRemote([{
        notebookUrl, cardIndex: idx,
        artifactId: audio.artifactId || "",
        episodeTitle: audio.title,
      }]);
    } else {
      downloadOneSingle(tabId, idx, audio.artifactId);
    }
  });

  li.append(checkbox, title, state, btn);
  cardsEl.appendChild(li);

  cardMeta.set(li, {
    notebookUrl,
    cardIndex: idx,
    artifactId: audio.artifactId || "",
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
  const tEl = document.createElement("span");
  tEl.className = "nb-h-title";
  tEl.textContent = title || t("popup.untitled");
  const d = document.createElement("span");
  d.className = "nb-h-date";
  d.textContent = dateAttr ? `· ${dateAttr.split(" ").slice(1, 4).join(" ")}` : "";
  li.append(tEl, d);
  if (!audios || audios.length === 0) {
    const empty = document.createElement("span");
    empty.className = "nb-h-empty";
    empty.textContent = t("popup.notebookEmpty");
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
  bulkDlBtn.textContent = t("popup.bulkDl", { n: selected });
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

async function downloadOneSingle(tabId, index, artifactId) {
  const liEls = cardsEl.querySelectorAll("li");
  // single 모드는 헤더 없이 카드만 있으므로 nth li = idx 와 일치 — viewMode === "single".
  const li = liEls[index];
  if (!li) return;
  const checkbox = li.querySelector("input.sel");
  const btn = li.querySelector("button.dl");
  const state = li.querySelector(".ep-state");
  if (checkbox) checkbox.disabled = true;
  if (btn) btn.disabled = true;
  setRow(state, "", t("popup.dl.fetching"));
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: "download", index, artifactId });
  } catch (e) {
    setRow(state, "err", "✗", e.message);
    if (btn) btn.disabled = false;
    if (checkbox) checkbox.disabled = false;
    return;
  }
  if (resp?.ok) {
    setRow(state, "ok", t("popup.dl.fetched"));
  } else {
    setRow(state, "err", "✗", resp?.error || t("popup.dl.fail"));
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
      setStatus(t("popup.notNotebookPage"), "error");
      return;
    }
    await runBulkLocal(tab.id, items);
  } else {
    runBulkRemote(items.map((i) => ({
      notebookUrl: i.notebookUrl, cardIndex: i.cardIndex,
      artifactId: i.artifactId, episodeTitle: i.episodeTitle,
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
  setStatus(t("popup.bulk.progress", { n: items.length, done: 0, total: items.length }), "");
  let done = 0;
  for (const item of items) {
    await downloadOneSingle(tabId, item.cardIndex, item.artifactId);
    done += 1;
    setStatus(t("popup.bulk.progress", { n: items.length, done, total: items.length }), "");
  }
  setStatus(t("popup.bulk.localDone", { n: items.length }), "success");
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
  setStatus(t("popup.bulk.remoteStart", { n: selections.length }), "");
  // 시작 카드 상태 모두 "대기"
  for (const s of selections) {
    const state = stateByTitle.get(s.episodeTitle);
    if (state) setRow(state, "", t("popup.dl.waiting"));
  }
  const ack = await chrome.runtime.sendMessage({ type: "bulk:remote", selections });
  if (!ack?.ok) {
    setStatus(t("popup.bulk.startFail", { error: ack?.error || "?" }), "error");
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
      const isWarn = msg.skipKind === "no-config";
      const label = isWarn ? t("popup.push.noconfig") : t("popup.push.skipped");
      setRow(state, isWarn ? "warn" : "ok", label + feedNote, msg.reason || "");
    } else if (msg.ok) {
      setRow(state, "ok", t("popup.push.ok") + feedNote, msg.filename);
    } else {
      setRow(state, "err", t("popup.push.fail"), msg.error || "");
    }
    return;
  }

  if (msg.type === "scan:all:progress") {
    if (msg.message) setStatus(msg.message, "");
    return;
  }

  if (msg.type === "scan:all:done") {
    if (!msg.ok) {
      setStatus(t("popup.scan.failPrefix", { error: msg.error }), "error");
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
      if (state) setRow(state, "", t("popup.dl.fetching"));
    } else if (msg.message) {
      setStatus(msg.message, "");
    }
    return;
  }

  if (msg.type === "bulk:remote:result") {
    const state = stateByTitle.get(msg.episodeTitle);
    if (state && !msg.ok) setRow(state, "err", "✗", msg.error || t("popup.dl.fail"));
    return;
  }

  if (msg.type === "bulk:remote:done") {
    if (msg.ok) {
      setStatus(t("popup.bulk.remoteDone", { n: msg.done }), "success");
    } else {
      setStatus(t("popup.bulk.startFail", { error: msg.error }), "error");
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
  setStatus(t("popup.scanning"));
  clearList();
  coverEl.style.display = "none";
  viewMode = "single";
  try {
    const tab = await activeNotebookTab();
    if (!tab) {
      setStatus(t("popup.notNotebookPage"), "error");
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "scan" });
    if (!resp?.ok) {
      setStatus(t("popup.noResponse"), "error");
      return;
    }
    nbTitleEl.textContent = resp.cover.title || t("popup.untitled");
    nbDateEl.textContent = resp.cover.dateAttr || t("popup.coverNoDate");
    coverEl.style.display = "block";

    // 옵션 페이지의 에피소드 목록 [편집 ↗] 바로가기가 다음에도 활성화되도록 — 이
    // 한 노트북 (slug → URL) 을 영구 맵에 넣어 두기. 매 스캔마다 호출, await 안 함.
    if (resp.cover.title) {
      chrome.runtime.sendMessage({
        type: "notebook:url:remember",
        title: resp.cover.title,
        url: tab.url,
      }).catch(() => {});
    }

    const pushed = await chrome.runtime.sendMessage({ type: "list:pushed" })
      .catch(() => ({ ok: false, shortIds: [] }));
    const pushedShortIds = pushed?.shortIds || [];

    const total = resp.audios.length;
    const pending = resp.audios.filter((a) => a.isPlaceholder).length;
    const alreadyCount = resp.audios.filter((a) => {
      const sid = shortIdOf(a.artifactId);
      return sid && pushedShortIds.includes(sid);
    }).length;

    if (!total) setStatus(t("popup.audioCount0"), "");
    else if (pending === total) setStatus(t("popup.audioAllPlaceholder", { n: total }), "");
    else {
      const parts = [t("popup.audioCount", { n: total })];
      if (pending > 0) parts.push(t("popup.placeholderN", { n: pending }));
      if (alreadyCount > 0) parts.push(t("popup.alreadyN", { n: alreadyCount }));
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
    setStatus(t("popup.error", { msg: e.message }), "error");
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
  setStatus(t("popup.scanAllStart"), "");
  const ack = await chrome.runtime.sendMessage({ type: "scan:all" });
  if (!ack?.ok) {
    setStatus(t("popup.startFail", { error: ack?.error || "?" }), "error");
    scanBtn.disabled = false;
    scanAllBtn.disabled = false;
  }
  // progress / done 은 onMessage 핸들러에서 처리.
});

async function renderAggregate(notebooks) {
  clearList();
  viewMode = "all";

  if (!notebooks || notebooks.length === 0) {
    setStatus(t("popup.noNotebooks"), "error");
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

  const parts = [
    t("popup.notebookN", { n: notebooks.length }),
    t("popup.cardN", { n: totalCards }),
  ];
  if (totalPlaceholder > 0) parts.push(t("popup.placeholderShort", { n: totalPlaceholder }));
  if (totalAlready > 0) parts.push(t("popup.alreadyN", { n: totalAlready }));
  if (totalEligible > 0) parts.push(t("popup.newN", { n: totalEligible }));
  if (totalCards === 0) parts.push(t("popup.noOverviews"));
  setStatus(parts.join(" · "), totalCards > 0 ? "success" : "");

  refreshBulkBar();
  scanBtn.disabled = false;
  scanAllBtn.disabled = false;
}

// popup 첫 오픈 시: i18n 초기화 후 직전 스캔 결과 자동 복원.
// 11분짜리 sweep 이후 popup 이 닫혔다 다시 열릴 때 [모든 노트북 스캔] 을 또 누르지
// 않아도 카드 list 가 그대로 보이도록. 단 (a) 진행 중인 task 가 있으면 그 흐름에
// 양보 (b) 30분 이상 지난 결과는 무시.
(async () => {
  await initI18n();
  try {
    const taskR = await chrome.runtime.sendMessage({ type: "task:state:get" });
    if (taskR?.state?.status === "running") return; // 진행 중이면 안 건드림.
    const r = await chrome.runtime.sendMessage({ type: "scan:result:get" });
    if (!r?.result?.notebooks?.length) return;
    const ageMs = Date.now() - (r.result.scannedAt || 0);
    if (ageMs > 30 * 60 * 1000) return; // 30분 넘으면 stale 로 보고 무시.
    await renderAggregate(r.result.notebooks);
    const ageMin = Math.round(ageMs / 60000);
    const ageStr = ageMin < 1
      ? t("popup.scanAgo.sec", { n: Math.round(ageMs / 1000) })
      : t("popup.scanAgo.min", { n: ageMin });
    setStatus(
      (statusEl.textContent || "").replace(/^\s*/, "") + t("popup.scanAgo.suffix", { age: ageStr }),
      "success",
    );
  } catch {}
})();

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

document.getElementById("open-help").addEventListener("click", (e) => {
  e.preventDefault();
  // 현재 언어에 맞는 help 파일로 — options 페이지의 도움말 링크 라우팅과 동일.
  const lang = i18nGetLang();
  const file = lang === "en" ? "help-en.html" : lang === "de" ? "help-de.html" : "help.html";
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/help/${file}`) });
});
