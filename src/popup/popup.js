const scanBtn = document.getElementById("scan");
const statusEl = document.getElementById("status");
const coverEl = document.getElementById("cover");
const nbTitleEl = document.getElementById("nb-title");
const nbDateEl = document.getElementById("nb-date");
const cardsEl = document.getElementById("cards");

// episodeTitle → state span. background 의 push:result 메시지를 받았을 때 매칭용.
const stateByTitle = new Map();

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

function renderCards(audios, tabId) {
  cardsEl.innerHTML = "";
  stateByTitle.clear();
  audios.forEach((a, i) => {
    const li = document.createElement("li");

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
      setRow(state, "", "제목 확정 대기 중", "다시 스캔하면 활성화됩니다");
    }
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      setRow(state, "", "받는 중…");
      try {
        const resp = await chrome.tabs.sendMessage(tabId, {
          type: "download",
          index: i,
        });
        if (resp?.ok) {
          setRow(state, "ok", "⬇ 받음, push 중…");
        } else {
          setRow(state, "err", "✗", resp?.error || "실패");
        }
      } catch (e) {
        setRow(state, "err", "✗", e.message);
      } finally {
        btn.disabled = false;
      }
    });

    li.append(title, state, btn);
    cardsEl.appendChild(li);
  });
}

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
    const total = resp.audios.length;
    const pending = resp.audios.filter((a) => a.isPlaceholder).length;
    if (!total) {
      setStatus("음성개요 0개", "");
    } else if (pending === total) {
      setStatus(`음성개요 ${total}개 — 모두 제목 확정 대기 중. 잠시 후 다시 스캔하세요.`, "");
    } else if (pending > 0) {
      setStatus(`음성개요 ${total}개 (${pending}개 제목 확정 대기 중)`, "success");
    } else {
      setStatus(`음성개요 ${total}개`, "success");
    }
    renderCards(resp.audios, tab.id);
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
