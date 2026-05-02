// Service worker. content / popup 와 메시지로 연결되고, NotebookLM 이 발생시킨
// 다운로드를 가로채 `YYYYMMDD__노트북-슬러그__shortId__제목-슬러그.{ext}` 로 rename
// 한다. shortId 는 카드의 artifact UUID 첫 8자 — 제목이 바뀌어도 같은 audio 는
// 같은 shortId 를 가지므로 GitHub 폴더 list 후 substring 매칭으로 robust dedup.
//
// 흐름: popup → content("download") → content 가 background 에 "download:expect"
// 로 메타(노트북/제목/cover-date) 를 push → content 가 ⋮ → 다운로드 메뉴 클릭 →
// Chrome 다운로드 시작 → onDeterminingFilename 에서 큐 pop, suggest() 로 rename →
// 같은 audio URL 을 SW 에서 직접 fetch 해서 GitHub 로 PUT → rssMode 가 "extension"
// 이면 동시에 docs/feed.xml 도 재빌드해서 PUT.

import { rebuildFeed } from "./feed.js";
//
// audio URL 은 lh3.googleusercontent.com signed URL. path 의 토큰만으론 인증
// 부족해 CDN 이 accounts.google.com/ServiceLogin → lh3.google.com/rd-notebooklm
// 으로 redirect 시키므로 그 호스트들도 manifest host_permissions 에 포함시켜
// CORS 면제. credentials:"include" 로 .google.com 세션 쿠키를 redirect 체인
// 내내 동행시키면 ServiceLogin 이 자동 통과되어 최종 audio 응답까지 도달한다.
// (이전 시도들: SW fetch credentials:"omit" → ServiceLogin redirect target 이
// host_permissions 밖이라 CORS 차단; page-world fetch via executeScript →
// CDN 이 ACAO 헤더를 notebooklm origin 으로 안 줘서 CORS 차단.)

const expectedQueue = [];
const STALE_MS = 5 * 60 * 1000;
// content.js 가 동일한 가드를 갖지만, popup/content 우회로 들어오는 메시지에
// 대비한 2차 방어선 (IMPLEMENTATION_NOTES.md §1).
const PLACEHOLDER_TITLE_RE = /^audio[\s\-_]?\d+$/i;

// v1 의 episode 파일명 컨벤션. v2 는 노트북/오디오 슬러그 각각 40자로 잘라서
// MAX_PATH (260) / GitHub path 255-byte 제한을 처음부터 회피.
const SLUG_MAX = 40;

const MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};
// JS Date.toString() 의 cover-subtitle-date title 속성: "Wed May 21 2025 11:10:26 GMT+0200 …"
const DATE_RE = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d+) (\d{4}) (\d{2}):(\d{2}):(\d{2})/;

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "download:expect") {
    const title = msg.payload?.episodeTitle || "";
    if (PLACEHOLDER_TITLE_RE.test(title)) {
      sendResponse({ ok: false, error: "placeholder 제목은 큐잉하지 않음" });
      return false;
    }
    expectedQueue.push({ ...msg.payload, pushedAt: Date.now() });
    sendResponse({ ok: true, queued: expectedQueue.length });
    return false;
  }
  if (msg?.type === "task:cancel") {
    // 진행 중인 task 의 다음 iteration 에서 빠져나가도록 플래그 set.
    if (!inProgressTask) {
      // Zombie 탈출구: UI 는 "running" 인데 in-memory 루프는 없음 (SW 재시작 후
      // task:state 가 storage 에서 복원돼 그렇게 보이는 케이스). 이 경로 없으면
      // 사용자가 익스텐션 reload 외에 빠져나갈 방법이 없음.
      if (currentTaskState.status === "running") {
        setTaskState({
          status: "failed",
          message: `강제 중단 — SW 재시작으로 인한 zombie 상태 정리 (진행 ${currentTaskState.done || 0}/${currentTaskState.total || "?"}).`,
          endedAt: Date.now(),
        }).then(() => sendResponse({ ok: true, forced: true }));
        try { chrome.alarms.clear(KEEPALIVE_ALARM); } catch {}
        return true; // async sendResponse
      }
      sendResponse({ ok: false, error: "진행 중인 작업이 없습니다" });
      return false;
    }
    cancelRequested = true;
    sendResponse({ ok: true, task: inProgressTask });
    return false;
  }
  if (msg?.type === "scan:all") {
    if (inProgressTask) {
      sendResponse({ ok: false, error: "이미 진행 중인 작업이 있습니다" });
      return false;
    }
    sendResponse({ ok: true, started: true });
    inProgressTask = "scan:all";
    cancelRequested = false;
    runScanAll()
      .catch(async (e) => {
        console.error("[scan:all]", e);
        await setTaskState({
          status: "failed",
          message: `스캔 실패: ${e.message}`,
          endedAt: Date.now(),
        });
        emitEvent("scan:all:done", { ok: false, error: e.message });
      })
      .finally(async () => {
        await cleanupOwnedTabs();
        await stopKeepalive();
        inProgressTask = null;
      });
    return false;
  }
  if (msg?.type === "bulk:remote") {
    if (inProgressTask) {
      sendResponse({ ok: false, error: "이미 진행 중인 작업이 있습니다" });
      return false;
    }
    sendResponse({ ok: true, started: true });
    inProgressTask = "bulk:remote";
    cancelRequested = false;
    runBulkRemote(msg.selections || [])
      .catch(async (e) => {
        console.error("[bulk:remote]", e);
        await setTaskState({
          status: "failed",
          message: `Bulk 다운로드 실패: ${e.message}`,
          endedAt: Date.now(),
        });
        emitEvent("bulk:remote:done", { ok: false, error: e.message });
      })
      .finally(async () => {
        await cleanupOwnedTabs();
        await stopKeepalive();
        inProgressTask = null;
      });
    return false;
  }
  if (msg?.type === "task:state:get") {
    sendResponse({ ok: true, state: currentTaskState });
    return false;
  }
  if (msg?.type === "task:state:clear") {
    setTaskState({ ...INITIAL_TASK_STATE }).then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg?.type === "scan:result:get") {
    loadLastScanResult().then((result) => sendResponse({ ok: true, result }));
    return true; // async
  }
  if (msg?.type === "scan:result:clear") {
    clearLastScanResult().then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg?.type === "bulk:remote:from-last-scan") {
    // 직전 스캔 결과 + 현재 repo 상태 기준으로 신규 selections 만들어 바로 bulk:remote.
    if (inProgressTask) {
      sendResponse({ ok: false, error: "이미 진행 중인 작업이 있습니다" });
      return false;
    }
    sendResponse({ ok: true, started: true });
    inProgressTask = "bulk:remote";
    cancelRequested = false;
    (async () => {
      try {
        const cfg = await chrome.storage.local.get(["token", "repo"]);
        if (!cfg.token || !cfg.repo) throw new Error("GitHub 설정 없음");
        const last = await loadLastScanResult();
        if (!last?.notebooks?.length) throw new Error("저장된 스캔 결과 없음");
        const selections = await buildNewSelections(last.notebooks, cfg.repo, cfg.token);
        if (selections.length === 0) {
          await setTaskState({
            ...INITIAL_TASK_STATE,
            task: "bulk:remote", status: "completed",
            message: "신규 카드 없음 — 이미 모두 받음",
            startedAt: Date.now(), endedAt: Date.now(),
          });
          return;
        }
        await runBulkRemote(selections);
      } catch (e) {
        console.error("[bulk:remote:from-last-scan]", e);
        await setTaskState({
          status: "failed",
          message: `Bulk 다운로드 실패: ${e.message}`,
          endedAt: Date.now(),
        });
      } finally {
        await cleanupOwnedTabs();
        await stopKeepalive();
        inProgressTask = null;
      }
    })();
    return false;
  }
  if (msg?.type === "episodes:list:full") {
    // 옵션 페이지의 "푸시된 에피소드" 목록용. 파일명 4-segment 포맷을 풀어서
    // date / notebook / shortId / title / sha / size / format 까지 노출.
    // 옛 3-segment 포맷도 호환 (shortId 없음 — 표에선 빈칸).
    (async () => {
      try {
        const cfg = await chrome.storage.local.get(["token", "repo"]);
        if (!cfg.token || !cfg.repo) {
          sendResponse({ ok: false, error: "GitHub 설정 없음 (token/repo)" });
          return;
        }
        const list = await ghList(cfg.repo, "docs/episodes", cfg.token);
        const FILENAME_RE = /^(\d{8})__(.+?)__(?:([0-9a-f]{8})__)?(.+?)\.(m4a|mp3|mp4)$/i;
        const items = [];
        for (const f of list) {
          const m = FILENAME_RE.exec(f.name);
          if (!m) continue;
          const [, date, notebookSlug, shortId, titleSlug, ext] = m;
          items.push({
            filename: f.name,
            sha: f.sha,
            size: f.size,
            date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
            dateRaw: date,
            notebook: notebookSlug.replace(/-/g, " "),
            shortId: shortId || "",
            title: titleSlug.replace(/-/g, " "),
            format: ext.toLowerCase(),
          });
        }
        // 최신순
        items.sort((a, b) => b.dateRaw.localeCompare(a.dateRaw) || b.filename.localeCompare(a.filename));
        sendResponse({ ok: true, items, totalSize: items.reduce((s, i) => s + i.size, 0) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }
  if (msg?.type === "episodes:delete") {
    // 단일 파일 ghDelete. 옵션 페이지의 [삭제] 버튼.
    (async () => {
      try {
        const cfg = await chrome.storage.local.get(["token", "repo", "committerName", "committerEmail"]);
        if (!cfg.token || !cfg.repo) throw new Error("GitHub 설정 없음");
        if (!msg.filename || !msg.sha) throw new Error("filename/sha 누락");
        const committer = cfg.committerName && cfg.committerEmail
          ? { name: cfg.committerName, email: cfg.committerEmail } : null;
        await ghDelete(
          cfg.repo,
          `docs/episodes/${msg.filename}`,
          msg.sha,
          `Drop episode: ${msg.filename}`,
          cfg.token,
          committer,
        );
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }
  if (msg?.type === "list:pushed") {
    // popup 의 bulk 모드에서 "이미 받은 카드" 를 default 미체크로 두기 위한 사전 점검.
    // ghList 가 실패해도 popup 흐름이 멈추면 안 되므로 빈 배열로 fallback.
    (async () => {
      try {
        const cfg = await chrome.storage.local.get(["token", "repo"]);
        if (!cfg.token || !cfg.repo) {
          sendResponse({ ok: true, shortIds: [], names: [], reason: "no-config" });
          return;
        }
        const list = await ghList(cfg.repo, "docs/episodes", cfg.token);
        const shortIds = [];
        for (const f of list) {
          const m = /__([0-9a-f]{8})__/.exec(f.name);
          if (m) shortIds.push(m[1]);
        }
        sendResponse({ ok: true, shortIds, names: list.map((f) => f.name) });
      } catch (e) {
        console.warn("[list:pushed] 실패:", e.message);
        sendResponse({ ok: true, shortIds: [], names: [], reason: e.message });
      }
    })();
    return true; // async
  }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const fromNotebookLM =
    (item.referrer || "").includes("notebooklm.google.com") ||
    (item.url || "").includes("notebooklm.google.com");

  // 만료된 항목 정리
  const now = Date.now();
  while (expectedQueue.length && now - expectedQueue[0].pushedAt > STALE_MS) {
    expectedQueue.shift();
  }

  if (!fromNotebookLM || expectedQueue.length === 0) return false;

  const meta = expectedQueue.shift();
  const ext = extOf(item.filename) || ".m4a";
  const shortId = shortIdOf(meta.artifactId);
  const date = extractDate(meta);
  const titleSlug = slugify(meta.episodeTitle);
  const filename = buildFilename(meta, ext, shortId);
  suggest({ filename, conflictAction: "uniquify" });

  // 로컬 저장은 Chrome 이 그대로 진행. 동시에 SW 에서 audio URL 을 다시 fetch
  // 해서 GitHub 로 push. dedupHints 는 episodes/ list 의 어느 파일이 같은 audio
  // 인지 판정하는 키 — shortId 가 1차, 옛 포맷 파일은 (date, titleSlug) 로 매칭해
  // 노트북 rename 도 견딘다.
  const dedupHints = { shortId, date, titleSlug, ext };
  pushEpisode(item.url, filename, dedupHints).then((result) => {
    notifyPush({ ok: true, episodeTitle: meta.episodeTitle, filename, ...result });
  }).catch((err) => {
    console.error("[push]", filename, err);
    notifyPush({ ok: false, episodeTitle: meta.episodeTitle, filename, error: err.message });
  });
});

function notifyPush(detail) {
  chrome.runtime.sendMessage({ type: "push:result", ...detail }).catch(() => {
    // popup 이 닫혀 있으면 listener 없음 — 정상.
  });
  // bulk:remote 흐름이 같은 SW 안에서 push 결과를 await 할 수 있도록 로컬 dispatch.
  for (const fn of pushResultLocalListeners) {
    try { fn(detail); } catch {}
  }
  // 옵션 페이지의 진행 모니터에 라이브 push 활동 로그로 표시 — 마지막 30 건.
  // 단일 [받기] / 일괄 받기 / 자동 다운로드 어느 경로든 모두 여기로 모임.
  appendRecentPush(detail).catch(() => {});
}

async function appendRecentPush(detail) {
  const entry = {
    episodeTitle: detail.episodeTitle || "",
    filename: detail.filename || "",
    ok: !!detail.ok,
    skipped: !!detail.skipped,
    error: detail.error || "",
    reason: detail.reason || "",
    size: typeof detail.size === "number" ? detail.size : null,
    feedOk: !!detail.feed?.ok,
    feedError: detail.feedError || "",
    timestamp: Date.now(),
  };
  const recentPushes = [...(currentTaskState.recentPushes || []), entry].slice(-30);
  await setTaskState({ recentPushes });
}

const pushResultLocalListeners = new Set();
function waitPushResultLocal(episodeTitle, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const handler = (detail) => {
      if (done) return;
      if (detail.episodeTitle !== episodeTitle) return;
      done = true;
      pushResultLocalListeners.delete(handler);
      clearTimeout(timer);
      resolve(detail);
    };
    pushResultLocalListeners.add(handler);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      pushResultLocalListeners.delete(handler);
      resolve({ timeout: true });
    }, timeoutMs);
  });
}

// ---------- cross-notebook scan + bulk download (Option 2) ----------
//
// 사용자가 NotebookLM 홈 (`/`) 의 모든 노트북을 한 번에 sweep 하려는 흐름. 팝업
// 측 [모든 노트북 스캔] 클릭이 "scan:all" 메시지로 들어오면 백그라운드 탭을 순차로
// 열어가며 (a) 홈에서 노트북 URL 들 수집 (b) 각 노트북 페이지에서 audio 카드 수집.
// 결과는 progress 이벤트 ("scan:all:progress") 로 흘리고 마지막에 "scan:all:done".
// bulk download 도 같은 패턴 — 선택된 카드를 노트북 별로 묶어 탭 한 번씩 다시
// 열어 순차 다운로드.

const TAB_OPEN_TIMEOUT = 15000;
const CONTENT_PING_TIMEOUT = 8000;
const NOTEBOOK_CARDS_TIMEOUT = 12000;
// 단일 카드의 SW fetch + base64 + ghPut/ghPutLargeFile (Git Data API 7-call) +
// rebuildFeed 까지 합산. 긴 m4a (40분짜리 ~75 MB) 가 기준선이라 100~200초가
// 정상 범위. 마진 포함 600초 (10분). 실측: 사용자 bulk 에서 첫 2 카드가 195초
// 부근에서 180초 timeout 에 걸렸음 → 600 이면 안전.
const PUSH_RESULT_TIMEOUT = 600000;

let inProgressTask = null;
const ownedTabs = new Set(); // SW 가 연 탭 id — 정리용.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// chrome.tabs.sendMessage 는 receiving end 가 응답을 안 하면 영구 pending 가능
// (특히 NotebookLM SPA 가 freeze 되거나 content script 가 block 됐을 때). 명시적
// timeout 으로 wrap 해 stuck 을 방지.
async function sendMessageWithTimeout(tabId, msg, timeoutMs = 30000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`tabs.sendMessage timeout (${timeoutMs}ms)`)),
      timeoutMs,
    )),
  ]);
}

// MV3 service worker 는 활성 작업이 없으면 ~30초 idle 후 종료된다. 153개 카드를
// 한 번에 처리하면 (개당 30~60초 × 153 = 1.5~2.5시간) 중간에 retry sleep / sendMessage
// timeout 같은 idle 구간에서 SW 가 죽어 task 가 통째로 멈출 수 있음. chrome.alarms
// 를 30초마다 발화시켜 그 발화 자체로 SW 를 깨워 두는 패턴 — MV3 long-running task
// 의 표준 keepalive.
const KEEPALIVE_ALARM = "task-keepalive";

async function startKeepalive() {
  // alarms 의 production minimum period 는 30s. periodInMinutes: 0.5 = 30초.
  try {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } catch (e) {
    console.warn("[keepalive] create 실패 (alarms 권한 누락?):", e.message);
  }
}

async function stopKeepalive() {
  try { await chrome.alarms.clear(KEEPALIVE_ALARM); } catch {}
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // 발화 자체가 SW wake. inProgressTask 가 null 이면 zombie alarm — SW 재시작
  // 으로 task 의 in-memory 루프는 죽었는데 alarm 만 살아남은 상태. heartbeat 를
  // 갱신하지 말고 alarm 자체를 정리. (heartbeat 를 갱신하면 startup 의 zombie
  // 검지를 우회할 수 있는데, fix 후엔 startup 이 status==="running" 자체로 검지
  // 하므로 heartbeat 무관 — 그래도 무용한 alarm 발화는 끄는 게 깔끔.)
  if (!inProgressTask) {
    try { await chrome.alarms.clear(KEEPALIVE_ALARM); } catch {}
    return;
  }
  if (currentTaskState.status === "running") {
    currentTaskState.lastHeartbeatAt = Date.now();
    try { await chrome.storage.session.set({ currentTaskState }); } catch {}
  }
});

function emitEvent(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

// ---------- task state — 옵션 페이지 진행 모니터용 ----------
//
// scan:all / bulk:remote 같은 background-orchestrated 작업의 진행 상태를
// 단일 객체로 들고, 변경마다 chrome.storage.session 에 persist + "task:state"
// runtime message 로 broadcast. 옵션 페이지는 (a) 첫 오픈 시 task:state:get
// 으로 현재 상태 조회 (b) 이후 task:state 메시지로 라이브 갱신.

const INITIAL_TASK_STATE = {
  task: null,           // null | "scan:all" | "bulk:remote"
  status: "idle",       // "idle" | "running" | "completed" | "failed"
  phase: null,          // free-form (list / scan / open / download / done)
  message: "",
  total: 0,
  done: 0,
  notebookCount: 0,
  cardCount: 0,
  successCount: 0,
  errorCount: 0,
  errors: [],           // [{ url|episodeTitle, message }]
  recentPushes: [],     // 최근 N 건의 push 결과 — 옵션 페이지에 라이브 활동 로그로 노출.
  startedAt: null,
  endedAt: null,
  lastHeartbeatAt: null, // setTaskState 마다 갱신 — SW 재시작 시 stale running 감지용.
};
let currentTaskState = { ...INITIAL_TASK_STATE };

// 사용자 [강제 중단] 클릭 시 set. runScanAll / runBulkRemote 의 루프가 매 iteration
// 시작 시 체크해서 즉시 빠져나간다.
let cancelRequested = false;

// SW 재시작 시 마지막 상태 복원. status === "running" 이 살아남았다는 건 SW 가
// 한 번 죽었다 살아났다는 뜻 — MV3 SW 재시작은 항상 script 재실행이라 in-flight
// runBulkRemote/runScanAll 의 await 체인 (Promise / setTimeout 전부) 이 GC 됨.
// 즉 어떤 heartbeat 값이든 무관하게 "running" 은 zombie. heartbeat threshold 를
// 두고 90초 이내면 살려두려던 ad46faf 의 시도는 chrome.alarms keepalive 가 alarm
// handler 에서 heartbeat 를 갱신해버리기 때문에 우회당함 — UI 는 영원히 "진행 중"
// 으로 보이는데 실제 루프는 죽은 상태.

(async () => {
  try {
    let restored = null;
    try {
      const r = await chrome.storage.session.get(["currentTaskState"]);
      if (r.currentTaskState) restored = r.currentTaskState;
    } catch {}
    if (!restored) {
      try {
        const r = await chrome.storage.local.get(["currentTaskState"]);
        if (r.currentTaskState) restored = r.currentTaskState;
      } catch {}
    }
    if (!restored) return;

    if (restored.status === "running") {
      restored.status = "failed";
      restored.message =
        `SW 재시작으로 작업이 중단됐습니다 ` +
        `(진행 ${restored.done || 0}/${restored.total || "?"}). [초기화] 후 다시 시작하세요.`;
      restored.endedAt = Date.now();
    }
    currentTaskState = restored;

    // SW 재시작 후 task 가 더 이상 active 가 아니면 leftover keepalive 알람 정리.
    if (currentTaskState.status !== "running") {
      try { await chrome.alarms.clear(KEEPALIVE_ALARM); } catch {}
    }
  } catch {}
})();

async function setTaskState(updates) {
  currentTaskState = {
    ...currentTaskState,
    ...updates,
    lastHeartbeatAt: Date.now(), // 모든 setTaskState 호출이 heartbeat — SW 살아있음의 증거.
  };
  // errors 누적 방지 — 마지막 20개만 유지.
  if (currentTaskState.errors && currentTaskState.errors.length > 20) {
    currentTaskState.errors = currentTaskState.errors.slice(-20);
  }
  try { await chrome.storage.session.set({ currentTaskState }); }
  catch {
    try { await chrome.storage.local.set({ currentTaskState }); } catch {}
  }
  chrome.runtime.sendMessage({ type: "task:state", state: currentTaskState }).catch(() => {});
}

function pushTaskError(err) {
  const errors = [...(currentTaskState.errors || []), err];
  return setTaskState({ errors, errorCount: (currentTaskState.errorCount || 0) + 1 });
}

// 모든 노트북 sweep 결과를 session storage 에 저장. popup 이 닫혀 있다 다시 열려도
// 이전 결과를 그대로 보여주고, 관리 페이지의 [신규 받기] 도 같은 결과를 사용.
async function persistLastScanResult(notebooks) {
  const data = { notebooks, scannedAt: Date.now() };
  try { await chrome.storage.session.set({ lastScanResult: data }); }
  catch {
    try { await chrome.storage.local.set({ lastScanResult: data }); } catch {}
  }
}

async function loadLastScanResult() {
  try {
    const r = await chrome.storage.session.get(["lastScanResult"]);
    if (r.lastScanResult) return r.lastScanResult;
  } catch {}
  try {
    const r = await chrome.storage.local.get(["lastScanResult"]);
    return r.lastScanResult || null;
  } catch { return null; }
}

async function clearLastScanResult() {
  try { await chrome.storage.session.remove(["lastScanResult"]); } catch {}
  try { await chrome.storage.local.remove(["lastScanResult"]); } catch {}
}

// 노트북 array 와 ghList 결과로부터 "아직 repo 에 없는" 카드들의 selections 를 만든다.
// auto-download 와 관리 페이지의 [신규 받기] 양쪽이 공유.
async function buildNewSelections(notebooks, repo, token) {
  const pushedShortIds = new Set();
  try {
    const list = await ghList(repo, "docs/episodes", token);
    for (const f of list) {
      const m = /__([0-9a-f]{8})__/.exec(f.name);
      if (m) pushedShortIds.add(m[1]);
    }
  } catch (e) {
    console.warn("[buildNewSelections] ghList 실패:", e.message);
  }
  const selections = [];
  for (const nb of notebooks) {
    (nb.audios || []).forEach((audio, idx) => {
      if (audio.isPlaceholder) return;
      const sid = (audio.artifactId || "").slice(0, 8);
      if (sid && pushedShortIds.has(sid)) return;
      selections.push({
        notebookUrl: nb.url,
        cardIndex: idx,
        // artifactId 가 함께 가야 다운로드 시점에 lazy-render 로 인덱스가 바뀌어도
        // UUID 매칭으로 정확한 카드를 짚는다 (content.js findCard).
        artifactId: audio.artifactId || "",
        episodeTitle: audio.title,
      });
    });
  }
  return selections;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); resolve(ok); } };
    const listener = (tid, change) => {
      if (tid === tabId && change.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === "complete") finish(true);
    }).catch(() => finish(false));
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function waitForContentReady(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: "ping" });
      if (r?.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

// Chrome 의 chrome.tabs.create / .remove 는 가끔 transient error 를 던진다 —
// 메시지는 보통 "Tabs cannot be edited right now (user may be dragging a tab)".
// 실제 드래그뿐 아니라, 빠른 연속 create/close, 탭바 애니메이션 진행 중,
// 다른 익스텐션의 동시 조작 등에서도 발생. 일정 시간 backoff 후 재시도하면
// 거의 회복됨.
const TRANSIENT_TAB_ERROR_RE = /Tabs cannot be edited|may be dragging|tab strip|currently in use/i;

async function withTabRetry(fn, label, maxAttempts = 5) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!TRANSIENT_TAB_ERROR_RE.test(e.message)) throw e;
      lastErr = e;
      // 500ms, 1.5s, 3s, 5s, 8s 누적 — 첫 실패 후 ~18초 안에 5회 재시도.
      const delay = 500 + attempt * attempt * 500;
      console.log(`[tab] ${label} transient error, retry in ${delay}ms (${attempt + 1}/${maxAttempts}): ${e.message}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// bulk:remote 전용 popup window. NotebookLM 이 background tab (tab.active=false)
// 에서 download menu 클릭을 거부 — `chrome.downloads.onDeterminingFilename` 자체가
// fire 안 됨. 검증된 우회: 별도 popup window 를 focused:false 로 띄우면 *그 윈도우
// 안의 tab 은 active 상태* 를 유지하면서 메인 윈도우 focus 는 그대로. 페이지 측
// `document.visibilityState` 가 'visible' 로 보이고, NotebookLM 이 download 트리거
// 를 정상 발사. 작업 끝나면 윈도우 close — 사용자 메인 작업 흐름 방해 최소화.
let bulkWindowId = null;

async function ensureBulkWindow() {
  if (bulkWindowId !== null) {
    try {
      const w = await chrome.windows.get(bulkWindowId);
      console.log(`[bulkWindow] reuse id=${bulkWindowId} state=${w.state} focused=${w.focused}`);
      return bulkWindowId;
    } catch (e) {
      console.log(`[bulkWindow] stale id=${bulkWindowId}, recreating: ${e.message}`);
      bulkWindowId = null;
    }
  }
  console.log(`[bulkWindow] creating new popup window`);
  // focused:false — chrome.debugger.Input.dispatchMouseEvent 가 trusted input 을
  // 주입하므로 window focus 자체는 download 트리거에 불필요. 사용자 메인 윈도우
  // focus 그대로 두는 게 덜 거추장.
  const win = await withTabRetry(
    () => chrome.windows.create({
      url: "about:blank",
      type: "popup",
      focused: false,
      width: 800, height: 600,
    }),
    "windows.create",
  );
  bulkWindowId = win.id;
  console.log(`[bulkWindow] created id=${win.id} state=${win.state} focused=${win.focused} ` +
    `top=${win.top} left=${win.left} w=${win.width} h=${win.height} tabs=${win.tabs?.length}`);
  // about:blank 첫 탭은 placeholder. 첫 openManagedTab 호출이 진짜 NotebookLM URL
  // 로 새 탭을 만들면서 placeholder 는 살아있어도 무해 (closeBulkWindow 가 결국 정리).
  return bulkWindowId;
}

async function closeBulkWindow() {
  if (bulkWindowId === null) return;
  const id = bulkWindowId;
  bulkWindowId = null;
  try { await chrome.windows.remove(id); } catch {}
}

async function openManagedTab(url, opts = {}) {
  // bulk:remote 는 opts.bulkWindow=true 로 전용 popup window 사용 — NotebookLM 이
  // background tab 의 download 트리거 거부 + programmatic click 도 거부 (isTrusted/
  // userActivation). 둘 다 우회하려면 popup window + chrome.debugger 가 필요.
  const inBulkWindow = !!opts.bulkWindow;
  let createOpts;
  if (inBulkWindow) {
    const winId = await ensureBulkWindow();
    createOpts = { url, windowId: winId, active: true };
  } else {
    createOpts = { url, active: false };
  }
  const tab = await withTabRetry(() => chrome.tabs.create(createOpts), "create");
  ownedTabs.add(tab.id);
  await waitForTabComplete(tab.id, TAB_OPEN_TIMEOUT);
  if (inBulkWindow) {
    // chrome.debugger.attach — Input.dispatchMouseEvent 로 진짜 user input 을 주입할
    // 수 있게. 탭이 닫히면 자동 detach 라 lifecycle 추적 불필요. attach 시 노란
    // "디버깅 중" 배너가 popup window 상단에 뜸 (사용자가 popup 안 봐도 무방).
    try { await chrome.debugger.attach({ tabId: tab.id }, "1.3"); }
    catch (e) {
      console.warn(`[debugger] attach 실패 tab=${tab.id}: ${e.message}`);
      // attach 실패해도 일단 진행 — clickViaDebugger 가 throw 하면 그 카드만 fail
    }
  }
  const ready = await waitForContentReady(tab.id, CONTENT_PING_TIMEOUT);
  if (!ready) {
    let finalUrl = "";
    try { finalUrl = (await chrome.tabs.get(tab.id))?.url || ""; } catch {}
    if (finalUrl.includes("accounts.google.com") || finalUrl.includes("ServiceLogin")) {
      throw new Error("NotebookLM 에 로그인되어 있지 않습니다. 브라우저에서 먼저 로그인 후 재시도하세요.");
    }
    if (!finalUrl.startsWith("https://notebooklm.google.com")) {
      throw new Error(`NotebookLM 페이지로 이동되지 않음 (final=${finalUrl.slice(0, 80)}). 네트워크 / 로그인 상태 확인.`);
    }
    throw new Error("NotebookLM 페이지에서 content script 로딩 실패 (timeout). 페이지 새로고침 후 재시도.");
  }
  return tab.id;
}

async function closeManagedTab(tabId) {
  ownedTabs.delete(tabId);
  // chrome.debugger 는 탭이 닫히면 자동 detach 지만, 명시적 detach 가 더 깔끔.
  // 탭이 attached 가 아니면 throw — swallow.
  try { await chrome.debugger.detach({ tabId }); } catch {}
  try {
    await withTabRetry(() => chrome.tabs.remove(tabId), "remove", 3);
  } catch {} // 끝까지 못 닫혀도 다음 흐름 막지 않음 — 사용자가 직접 닫을 수 있음.
}

// ---- offscreen document 기반 transcode (m4a/mp4 → mp3 64k mono) ----
// AudioContext + lamejs 를 SW 에선 못 써서 offscreen document 가 처리. 50MB
// audio 가 ~5MB mp3 로 줄어 GitHub API 한계 사각지대를 회피. 한 번 생성한
// document 는 bulk 끝까지 재사용해 startup overhead 최소화.

const OFFSCREEN_URL = "src/offscreen/transcode.html";
let offscreenCreating = null;

async function ensureOffscreenDocument() {
  // hasDocument 는 매번 호출 가능 (가벼움). createDocument 는 race 가능 — 한 번에
  // 하나만 진행되도록 promise 캐시.
  // ⚠ createDocument resolve 됐어도 페이지의 JS (transcode.js) 가 로딩 끝났다는
  // 보장 없음 — listener 등록 전에 sendMessage 보내면 "channel closed" 즉시 에러.
  // 그래서 ping 폴링으로 listener alive 확인까지 한 다음 반환.
  if (await chrome.offscreen.hasDocument()) {
    // 이미 떠 있으면 ping 한 번만 — listener 가 살아있는지 확인.
    if (await pingOffscreen()) return;
    // 떠 있는데 응답 안 함 → 닫고 새로 만든다.
    try { await chrome.offscreen.closeDocument(); } catch {}
  }
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = (async () => {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      // Multi-reason — Chrome 은 OR 시멘틱 (어느 한 쪽이라도 active 면 살림).
      // AUDIO_PLAYBACK 만 쓰면 30초 안에 *실제 재생* 없으면 종료 → 큰 m4a (40초+
      // transcode) 가 못 넘김. BLOBS (ArrayBuffer 작업) + WORKERS 추가로 lifetime
      // 안정. offscreen 측에서 silent audio 도 같이 돌려 AUDIO_PLAYBACK 도 명시적
      // 만족 (belt-and-suspenders).
      reasons: ["AUDIO_PLAYBACK", "BLOBS", "WORKERS"],
      justification: "Decode m4a/AAC and re-encode to MP3 to fit GitHub API size limits",
    });
    // 100ms 폴링 × 30회 = 최대 3초 대기. 실측 ~100~300ms 안에 ready.
    for (let i = 0; i < 30; i++) {
      if (await pingOffscreen()) return;
      await sleep(100);
    }
    throw new Error("offscreen 준비 시간 초과 (3초)");
  })().finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}

async function pingOffscreen() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "offscreen:ping" });
    return r?.ok === true;
  } catch {
    return false;
  }
}

async function closeOffscreenDocument() {
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch {}
}

// background → offscreen: chrome.runtime.connect (port) 로 long-lived 연결.
// chrome.runtime.sendMessage 는 SW idle timer (30s) 와 race — 큰 카드 (40MB+)
// transcode 가 30+초 걸리면 SW 가 await 중 죽고 "channel closed" 로 reject.
// Port 는 *연결이 살아있는 동안 SW 도 살아있음* (Chrome 공식 보장) — 30+초
// transcode 도 안전. 메시지는 URL 만 보내고 offscreen 이 fetch + transcode.
async function transcodeViaOffscreen(audioUrl, bitrate = 64, mono = true) {
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "transcode" });
    let settled = false;
    port.onMessage.addListener((msg) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      if (msg?.ok) resolve(base64ToArrayBuffer(msg.mp3B64));
      else reject(new Error(msg?.error || "transcode 실패"));
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      const err = chrome.runtime.lastError?.message || "transcode 채널 비정상 종료";
      reject(new Error(err));
    });
    port.postMessage({ type: "transcode", audioUrl, bitrate, mono });
  });
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// chrome.debugger 의 Input.dispatchMouseEvent 로 진짜 user input 을 주입.
// programmatic .click() 은 isTrusted=false 라서 NotebookLM 이 거부 — 이 경로는
// 브라우저 C++ 레벨에서 합성된 trusted input 이라 "진짜 사용자 클릭" 으로 인식됨.
// CSS pixel 좌표 기준 (devicePixelRatio 변환 불필요).
async function clickViaDebugger(tabId, x, y) {
  const target = { tabId };
  const base = { x, y, button: "left", clickCount: 1, buttons: 0 };
  // 일부 페이지는 mouseMoved 가 선행되어야 hover state 진입. 안전하게 보냄.
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
    { ...base, type: "mouseMoved", button: "none" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
    { ...base, type: "mousePressed" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
    { ...base, type: "mouseReleased" });
}

async function cleanupOwnedTabs() {
  for (const tid of Array.from(ownedTabs)) {
    await closeManagedTab(tid);
  }
  // bulk window 는 작업 끝나면 닫는다 — placeholder 탭이 남아있어도 지저분하지 않게.
  await closeBulkWindow();
  // offscreen 도 같이 정리 — bulk 동안 열어두고 finally 에서 close.
  await closeOffscreenDocument();
}

async function scanHomePageForNotebookUrls() {
  const tabId = await openManagedTab("https://notebooklm.google.com/");
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "scan:list" });
    return r?.urls || [];
  } finally {
    await closeManagedTab(tabId);
  }
}

async function waitForAudioCards(tabId, timeoutMs) {
  const start = Date.now();
  let lastResult = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await sendMessageWithTimeout(tabId, { type: "scan" }, 5000);
      if (r?.ok) {
        lastResult = r;
        const audios = r.audios || [];
        if (audios.length > 0) {
          // 첫 카드라도 placeholder 가 아니면 OK 라고 본다.
          if (audios.some((a) => !a.isPlaceholder)) return r;
        }
      }
    } catch {}
    await sleep(700);
  }
  return lastResult;
}

async function scanOneNotebook(url) {
  const tabId = await openManagedTab(url);
  try {
    const r = await waitForAudioCards(tabId, NOTEBOOK_CARDS_TIMEOUT);
    if (!r) return { url, cover: { title: "", dateAttr: "" }, audios: [] };
    return { url, cover: r.cover, audios: r.audios };
  } finally {
    await closeManagedTab(tabId);
  }
}

async function runScanAll() {
  await startKeepalive();
  await setTaskState({
    ...INITIAL_TASK_STATE,
    task: "scan:all", status: "running", phase: "list",
    message: "노트북 목록 수집 중…",
    startedAt: Date.now(), endedAt: null,
  });
  emitEvent("scan:all:progress", { phase: "list", message: "노트북 목록 수집 중…" });

  const urls = await scanHomePageForNotebookUrls();
  await setTaskState({ phase: "list:done", total: urls.length, message: `노트북 ${urls.length}개 발견. 스캔 시작…` });
  emitEvent("scan:all:progress", { phase: "list:done", total: urls.length });

  const notebooks = [];
  let cardCount = 0;
  // 같은 transient tab error 가 연속으로 발생하면 더 이상 retry 가 의미 없음 —
  // 일정 횟수 넘으면 abort 해서 사용자에게 명확한 안내.
  const MAX_CONSEC_TAB_ERRORS = 5;
  let consecTabErrors = 0;
  for (let i = 0; i < urls.length; i++) {
    if (cancelRequested) {
      await setTaskState({
        status: "failed", phase: "cancelled",
        message: `사용자 중단 — 노트북 ${i}/${urls.length} 까지 완료`,
        endedAt: Date.now(),
      });
      return { notebooks };
    }
    await setTaskState({
      phase: "scan", done: i,
      message: `노트북 ${i + 1}/${urls.length} 스캔 중…`,
    });
    emitEvent("scan:all:progress", {
      phase: "scan", done: i, total: urls.length,
      message: `노트북 ${i + 1}/${urls.length} 스캔 중…`,
    });
    try {
      const r = await scanOneNotebook(urls[i]);
      notebooks.push(r);
      cardCount += (r.audios || []).length;
      consecTabErrors = 0;
    } catch (e) {
      console.warn(`[scan:all] ${urls[i]} 실패:`, e.message);
      notebooks.push({ url: urls[i], cover: { title: "" }, audios: [], error: e.message });
      await pushTaskError({ url: urls[i], message: e.message });
      if (TRANSIENT_TAB_ERROR_RE.test(e.message)) {
        consecTabErrors++;
        if (consecTabErrors >= MAX_CONSEC_TAB_ERRORS) {
          throw new Error(
            `Chrome 탭 API 잠김 (${consecTabErrors}회 연속). ` +
            `탭바 드래그를 해제하시거나, 다른 탭 조작 중인 익스텐션을 잠시 비활성화한 뒤 재시도하세요. ` +
            `이미 스캔된 ${notebooks.length - consecTabErrors}개 노트북은 결과에 포함됩니다.`,
          );
        }
      } else {
        consecTabErrors = 0;
      }
    }
    // 다음 탭 생성 전 짧은 breather — 빠른 연속 create/close 가 transient lock 의 원인.
    await sleep(200);
  }

  await persistLastScanResult(notebooks);
  await setTaskState({
    status: "completed", phase: "done",
    done: urls.length,
    notebookCount: urls.length, cardCount,
    message: `스캔 완료 — 노트북 ${urls.length}개, 카드 ${cardCount}개`,
    endedAt: Date.now(),
  });
  emitEvent("scan:all:done", { ok: true, notebooks });

  // 옵션의 autoDownloadNew 가 켜져 있으면 신규 카드들을 같은 SW 안에서 이어서
  // 다운로드. 직접 runBulkRemote 호출 — message 라우팅 우회. inProgressTask 는
  // 이미 "scan:all" 이라 외부 message 는 거부되지만, 우리가 호출한 건 통과.
  // task state 는 runBulkRemote 안에서 자동으로 "bulk:remote" 로 전환됨.
  try {
    const cfg = await chrome.storage.local.get(["autoDownloadNew", "token", "repo"]);
    if (cfg.autoDownloadNew && cfg.token && cfg.repo) {
      const selections = await buildNewSelections(notebooks, cfg.repo, cfg.token);
      if (selections.length > 0) {
        console.log(`[scan:all] auto-download: ${selections.length} 카드 시작`);
        await runBulkRemote(selections);
      } else {
        console.log("[scan:all] auto-download: 신규 카드 없음");
      }
    }
  } catch (e) {
    console.error("[scan:all] auto-download 실패:", e);
  }

  return { notebooks };
}

async function runBulkRemote(selections) {
  await startKeepalive();
  // selections: [{ notebookUrl, cardIndex, episodeTitle }, ...]
  const grouped = new Map();
  for (const s of selections) {
    if (!grouped.has(s.notebookUrl)) grouped.set(s.notebookUrl, []);
    grouped.get(s.notebookUrl).push(s);
  }
  const total = selections.length;
  await setTaskState({
    ...INITIAL_TASK_STATE,
    task: "bulk:remote", status: "running", phase: "open",
    total, done: 0,
    message: `${total}개 카드 다운로드 시작 — 노트북 ${grouped.size}개 순차 처리`,
    startedAt: Date.now(), endedAt: null,
  });

  let done = 0;
  let success = 0;
  const MAX_CONSEC_TAB_ERRORS = 5;
  let consecTabErrors = 0;
  for (const [url, items] of grouped) {
    await setTaskState({ phase: "open", message: `노트북 ${url.split("/notebook/")[1]?.slice(0, 8)}… 탭 여는 중` });
    emitEvent("bulk:remote:progress", {
      phase: "open", url, done, total,
      message: `${url.split("/").pop().slice(0, 8)}… 탭 여는 중`,
    });
    let tabId;
    try {
      // bulkWindow:true — NotebookLM 이 background tab 의 download 클릭을 거부하므로
      // 전용 popup window 안에서 active tab 으로 띄움. 메인 윈도우 focus 는 그대로.
      tabId = await openManagedTab(url, { bulkWindow: true });
      consecTabErrors = 0;
      const ready = await waitForAudioCards(tabId, NOTEBOOK_CARDS_TIMEOUT);
      if (!ready) {
        for (const item of items) {
          emitEvent("bulk:remote:result", {
            episodeTitle: item.episodeTitle, ok: false, error: "카드 로딩 타임아웃",
          });
          await pushTaskError({ episodeTitle: item.episodeTitle, message: "카드 로딩 타임아웃" });
          done++;
        }
        await setTaskState({ done });
        continue;
      }
    } catch (e) {
      for (const item of items) {
        emitEvent("bulk:remote:result", {
          episodeTitle: item.episodeTitle, ok: false, error: `탭 열기 실패: ${e.message}`,
        });
        await pushTaskError({ episodeTitle: item.episodeTitle, message: `탭 열기 실패: ${e.message}` });
        done++;
      }
      await setTaskState({ done });
      if (TRANSIENT_TAB_ERROR_RE.test(e.message)) {
        consecTabErrors++;
        if (consecTabErrors >= MAX_CONSEC_TAB_ERRORS) {
          throw new Error(
            `Chrome 탭 API 잠김 (${consecTabErrors}회 연속). ` +
            `탭바 드래그 해제 / 다른 익스텐션 비활성화 후 재시도. 성공 ${success} / 실패 ${done - success} 까지는 결과에 반영됨.`,
          );
        }
      } else {
        consecTabErrors = 0;
      }
      continue;
    }
    try {
      for (const item of items) {
        if (cancelRequested) {
          await setTaskState({
            status: "failed", phase: "cancelled",
            message: `사용자 중단 — 진행 ${done}/${total}`, endedAt: Date.now(),
          });
          return { ok: false, cancelled: true };
        }
        await setTaskState({ phase: "download", message: `다운로드 중: ${item.episodeTitle?.slice(0, 40) || "(제목 없음)"}` });
        emitEvent("bulk:remote:progress", {
          phase: "download", url, episodeTitle: item.episodeTitle, done, total,
        });
        try {
          // bulk:remote 는 chrome.debugger 로 진짜 user input 주입 (Input.dispatchMouseEvent).
          // programmatic .click() 으론 NotebookLM 이 isTrusted=false / no user activation
          // 으로 판단해 download 트리거를 안 발사. 실측 (focused popup window 안 active
          // 탭 + .click()) 으로 모든 카드 push 응답 타임아웃 확인 후 이 경로로 전환.
          const r = await sendMessageWithTimeout(
            tabId,
            { type: "download:prepare", index: item.cardIndex, artifactId: item.artifactId },
            30000,
          );
          if (!r?.ok) {
            emitEvent("bulk:remote:result", {
              episodeTitle: item.episodeTitle, ok: false, error: r?.error || "카드 prepare 실패",
            });
            await pushTaskError({ episodeTitle: item.episodeTitle, message: r?.error || "카드 prepare 실패" });
            done++;
            continue;
          }
          // ⋮ 버튼을 chrome.debugger 로 진짜 클릭 → 메뉴 등장 → 메뉴 항목 좌표 받기 →
          // 메뉴 항목도 진짜 클릭. 두 번의 trusted input 주입.
          try {
            await clickViaDebugger(tabId, r.moreX, r.moreY);
            await sleep(400); // 메뉴 popover 가 떠오를 시간
            const menuR = await sendMessageWithTimeout(tabId, { type: "download:menucoords" }, 5000);
            if (!menuR?.ok) throw new Error(menuR?.error || "메뉴 좌표 조회 실패");
            await clickViaDebugger(tabId, menuR.x, menuR.y);
          } catch (clickErr) {
            emitEvent("bulk:remote:result", {
              episodeTitle: item.episodeTitle, ok: false, error: `debugger click 실패: ${clickErr.message}`,
            });
            await pushTaskError({ episodeTitle: item.episodeTitle, message: `debugger click 실패: ${clickErr.message}` });
            done++;
            continue;
          }
          const result = await waitPushResultLocal(item.episodeTitle, PUSH_RESULT_TIMEOUT);
          if (result.timeout) {
            emitEvent("bulk:remote:result", {
              episodeTitle: item.episodeTitle, ok: false, error: "push 응답 타임아웃",
            });
            await pushTaskError({ episodeTitle: item.episodeTitle, message: "push 응답 타임아웃" });
          } else if (result.ok || result.skipped) {
            success++;
          } else if (result.error) {
            await pushTaskError({ episodeTitle: item.episodeTitle, message: result.error });
          }
          done++;
        } catch (e) {
          emitEvent("bulk:remote:result", {
            episodeTitle: item.episodeTitle, ok: false, error: e.message,
          });
          await pushTaskError({ episodeTitle: item.episodeTitle, message: e.message });
          done++;
        }
        await setTaskState({ done, successCount: success });
      }
    } finally {
      await closeManagedTab(tabId);
    }
  }
  await setTaskState({
    status: "completed", phase: "done",
    done, successCount: success,
    message: `bulk 완료 — 성공 ${success} / 실패 ${done - success} / 총 ${done}`,
    endedAt: Date.now(),
  });
  emitEvent("bulk:remote:done", { ok: true, done });
  return { ok: true, done };
}

async function pushEpisode(audioUrl, filename, dedupHints) {
  const cfg = await chrome.storage.local.get([
    "token", "repo", "rssMode", "committerName", "committerEmail",
  ]);
  if (!cfg.token || !cfg.repo) {
    return { skipped: true, reason: "GitHub 설정 없음" };
  }

  // episodes 폴더 list 후 두 경로로 dedup:
  //  (a) shortId 가 있으면 `__${shortId}__` 부분 문자열 매칭 — 새 4-segment 포맷.
  //  (b) shortId 없는 옛 3-segment 파일은 (date, titleSlug, ext) 로 매칭. 옛 포맷에는
  //      노트북-슬러그가 들어가지만 포함시키지 않음 — 사용자가 노트북 이름을
  //      바꾸고 다시 받아도 같은 audio 로 인식되도록.
  const committer = cfg.committerName && cfg.committerEmail
    ? { name: cfg.committerName, email: cfg.committerEmail }
    : null;
  const { shortId, date, titleSlug, ext } = dedupHints || {};

  let existingMatch = null;
  if (shortId || (date && titleSlug)) {
    try {
      const list = await ghList(cfg.repo, "docs/episodes", cfg.token);
      existingMatch = list.find((f) => {
        if (shortId && f.name.includes(`__${shortId}__`)) return true;
        if (date && titleSlug && legacyFilenameMatches(f.name, date, titleSlug, ext)) return true;
        return false;
      });
    } catch (e) {
      // 폴더가 없거나 list 실패 — 그대로 진행해서 PUT 단계에서 ghGet 으로 fallback
      console.warn(`[push] list 실패, fallback 진행: ${e.message}`);
    }
  }

  // 매칭된 파일이 있으면 SW fetch 자체를 건너뛰어 대역폭 절약.
  if (existingMatch) {
    console.log(`[push] ${filename} dedup hit (existing=${existingMatch.name} size=${existingMatch.size}), skip`);
    return {
      skipped: true,
      reason: existingMatch.name === filename ? "이미 존재" : `이미 존재 (${existingMatch.name})`,
      matchedFilename: existingMatch.name,
    };
  }

  const t0 = Date.now();
  let stageFilename = filename;
  const stageLog = (stage) => console.log(`[push] ${stageFilename} ${stage} (+${Math.round((Date.now() - t0) / 1000)}s)`);

  const urlHost = (() => { try { return new URL(audioUrl).host; } catch { return "(invalid)"; } })();

  // m4a/mp4 (NotebookLM 기본 256k stereo) 는 offscreen 이 직접 fetch + transcode
  // 한 mp3 buffer 를 받아온다. SW 가 fetch 후 b64 string 을 offscreen 으로 보내던
  // 이전 방식은 큰 카드 (30MB+) 에서 chrome.runtime 메시지 채널을 자주 끊어버림.
  // 이 경로는 SW↔offscreen 사이 메시지를 작게 (URL 200 byte + mp3 b64 ~5MB 응답)
  // 유지해서 채널 안정성 확보. v1 의 src/audio_tools.py:transcode_to_mp3 와 동등한
  // 결과 (64k mono mp3, ~5MB / 30분).
  let buf;
  let size;
  const filenameExt = (filename.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  const isAac = filenameExt === "m4a" || filenameExt === "mp4";

  if (isAac) {
    try {
      stageLog(`fetch+transcode (offscreen) m4a→mp3 64k mono...`);
      buf = await transcodeViaOffscreen(audioUrl, 64, true);
      size = buf.byteLength;
      filename = filename.replace(/\.(m4a|mp4)$/i, ".mp3");
      stageFilename = filename;
      stageLog(`transcoded → ${(size / 1024 / 1024).toFixed(1)}MB`);
      // dedup hint 의 ext 도 mp3 으로 동기 — legacy 매칭이 일관되도록.
      if (dedupHints) dedupHints.ext = ".mp3";
    } catch (e) {
      console.warn(`[push] offscreen transcode 실패, SW 가 원본 m4a 직접 fetch: ${e.message}`);
      // Fallback: SW 가 fetch 후 그대로 push. 큰 m4a 면 ghPut 가 GitHub blob 한계
      // 에러로 떨어질 수 있음.
      console.log(`[push] SW fetch host=${urlHost} url=${audioUrl.slice(0, 200)}`);
      const r = await fetch(audioUrl, { credentials: "include" });
      if (!r.ok) {
        throw new Error(`SW fetch 실패: ${r.status} ${r.statusText} host=${urlHost}`);
      }
      buf = await r.arrayBuffer();
      size = buf.byteLength;
      stageLog(`fallback fetched ${(size / 1024 / 1024).toFixed(1)}MB (m4a 그대로)`);
    }
  } else {
    // mp3 / 기타 — SW 가 fetch + push (transcode 불필요).
    console.log(`[push] SW fetch host=${urlHost} url=${audioUrl.slice(0, 200)}`);
    const r = await fetch(audioUrl, { credentials: "include" });
    if (!r.ok) {
      throw new Error(`SW fetch 실패: ${r.status} ${r.statusText} host=${urlHost} final=${r.url.slice(0, 80)}… redirected=${r.redirected}`);
    }
    buf = await r.arrayBuffer();
    size = buf.byteLength;
    stageLog(`fetched ${(size / 1024 / 1024).toFixed(1)}MB`);
  }

  const path = `docs/episodes/${filename}`;
  const b64 = arrayBufferToBase64(buf);
  stageLog(`base64 encoded`);

  // 정확 path 에 같은 크기 파일이 있으면 skip (list 실패 시 fallback 경로 + 이중 안전망).
  const existing = await ghGet(cfg.repo, path, cfg.token);
  stageLog(`ghGet existing=${existing ? existing.size : 'none'}`);
  let pushResult;
  if (existing && existing.size === size) {
    console.log(`[push] ${filename} 이미 존재 (같은 크기), skip`);
    pushResult = { skipped: true, reason: "이미 존재" };
  } else {
    await ghPut(cfg.repo, path, b64,
      `Add episode ${filename}`, existing?.sha, cfg.token, committer);
    stageLog(`pushed ${(size / 1024 / 1024).toFixed(1)}MB`);
    pushResult = { ok: true, size, filename };
  }

  // rssMode === "extension" 이면 audio push 가 끝난 직후 같은 SW 안에서 feed 도 재빌드.
  // skip 된 경우엔 audio 가 이미 있던 상태이므로 feed 도 그대로일 가능성이 높음 →
  // rebuildFeed 내부의 sha 비교가 unchanged 면 PUT 안 함, 그래서 호출은 무해함.
  if (cfg.rssMode === "extension") {
    try {
      const feed = await rebuildFeed({ repo: cfg.repo, token: cfg.token, committer });
      pushResult.feed = feed;
      if (feed.skipped) console.log(`[feed] skip (${feed.reason})`);
      else stageLog(`feed rebuilt (${feed.episodes} episodes)`);
      if (feed.missingMeta) console.warn("[feed] docs/podcast.json 없음 — default 메타로 생성됨. examples/feed-builder/docs/podcast.json 참고해서 추가 권장.");
    } catch (e) {
      console.error("[feed]", e);
      pushResult.feedError = e.message;
    }
  }
  stageLog(`done`);
  return pushResult;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
  }
  return btoa(parts.join(""));
}

function ghContentsUrl(repo, path) {
  // path 는 슬래시 보존하면서 segment 별로 인코딩.
  const segs = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${repo}/contents/${segs}`;
}

// GitHub Contents API 의 GET 응답은 `Cache-Control: private, max-age=60` 으로 들어와
// 브라우저 HTTP 캐시에 60초간 머문다. push 직후 같은 디렉토리를 다시 list 하면
// stale 한 listing 이 와서 dedup 매칭이 미스나는 문제가 있어 GET 전부 no-store.
async function ghGet(repo, path, token) {
  const r = await fetch(ghContentsUrl(repo, path), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`ghGet ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function ghList(repo, dirPath, token) {
  const r = await fetch(ghContentsUrl(repo, dirPath), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`ghList ${dirPath}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const arr = await r.json();
  return Array.isArray(arr) ? arr.filter((f) => f.type === "file") : [];
}

async function ghPut(repo, path, contentB64, message, sha, token, committer) {
  // 409 Conflict 는 동시 commit race 로 자주 발생 — bulk:remote 가 카드를 매
  // 20-30초씩 push 하는 동안 feed-builder workflow 가 "auto: rebuild feed" 로
  // repo HEAD 를 움직임. Contents API 는 stale parent 에 PUT 하면 409 + "is at
  // X but expected Y". sha 를 새로 받아 backoff 재시도.
  let currentSha = sha;
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = { message, content: contentB64 };
    if (currentSha) body.sha = currentSha;
    if (committer) body.committer = committer;
    const r = await fetch(ghContentsUrl(repo, path), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    const errText = (await r.text()).slice(0, 400);
    // Contents API 는 raw 50 MiB / base64 inflation 으로 실질 ~37 MiB 한계.
    // NotebookLM 의 m4a 는 종종 40~60 MB 라 대형 파일은 Git Data API 로 fallback.
    const isTooLarge = r.status === 422 && /too large/i.test(errText);
    if (isTooLarge) {
      console.log(`[ghPut] Contents API 422 too large, Git Data API 로 fallback`);
      return ghPutLargeFile(repo, path, contentB64, message, token, committer);
    }
    // Transient 재시도 케이스:
    //   409 = concurrent commit race (workflow rebuild 중 push)
    //   403 + "Rule was unable to be completed" = repo rule (workflow files
    //       restriction 등) 검증이 10초 안에 못 끝남, GitHub 측 부하
    const isRuleTimeout = r.status === 403 && /Rule was unable to be completed/i.test(errText);
    const isTransient = r.status === 409 || isRuleTimeout;
    if (isTransient && attempt < 3) {
      const wait = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
      const kind = r.status === 409 ? "409 conflict" : "403 rule timeout";
      console.log(`[ghPut] ${kind} (attempt ${attempt + 1}/4), refreshing sha + retry in ${wait}ms`);
      await sleep(wait);
      try {
        const fresh = await ghGet(repo, path, token);
        currentSha = fresh?.sha;
      } catch {
        currentSha = undefined;
      }
      continue;
    }
    throw new Error(`ghPut ${path}: ${r.status} ${errText.slice(0, 200)}`);
  }
  throw new Error(`ghPut ${path}: transient errors after 4 attempts (workflow racing or rule timeouts)`);
}

// Git Data API (blobs/trees/commits/refs) 로 50 MiB 초과 파일 push.
// Contents API 는 단일 PUT 으로 끝나지만 그쪽은 ~37 MiB 가 실질 한계라 NotebookLM
// 의 더 긴 m4a 는 못 올림. Git Data API 는 5번의 chained API 호출이지만
// 100 MiB 까지 지원 (blobs 의 hard limit). 큰 파일 push 의 timing 진단을 위해
// 각 단계의 elapsed 를 로그.
async function ghPutLargeFile(repo, path, contentB64, message, token, committer) {
  const t0 = Date.now();
  const elapsed = () => `+${Math.round((Date.now() - t0) / 1000)}s`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const ghCall = async (method, urlPath, body, label) => {
    const before = Date.now();
    const r = await fetch(`https://api.github.com/repos/${repo}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = (await r.text()).slice(0, 300);
      // /git/blobs 가 422 + "too large to process" 던지면 그건 GitHub 의 raw blob
      // 한계 (~40 MiB 실질). Contents API (~37 MiB) 와 사이에 좁은 사각지대.
      // 사용자가 어떤 카드가 한계 초과인지 알 수 있도록 친화적 메시지.
      if (urlPath === "/git/blobs" && r.status === 422 && /too large/i.test(errText)) {
        const sizeMB = (contentB64.length * 0.75 / 1024 / 1024).toFixed(1);
        throw new Error(
          `${path.split("/").pop()}: ~${sizeMB}MB 가 GitHub blob API 한계 (~40MB) 초과. ` +
          `client transcode (m4a→mp3 64k mono) 또는 외부 호스팅 필요. EXTERNAL_HOSTING.md 참고.`,
        );
      }
      throw new Error(`${method} ${urlPath}: ${r.status} ${errText.slice(0, 200)}`);
    }
    const out = await r.json();
    console.log(`[ghPutLargeFile] ${label} ${Math.round((Date.now() - before) / 1000)}s (total ${elapsed()})`);
    return out;
  };

  // 1. default branch 확인 (main 가정 안 함 — 사용자 repo 가 master 일 수 있음).
  const repoMeta = await ghCall("GET", "", null, "repo meta");
  const branch = repoMeta.default_branch || "main";

  // 2. 현재 ref 의 commit sha + tree sha.
  const ref = await ghCall("GET", `/git/ref/heads/${branch}`, null, `ref ${branch}`);
  const parentCommitSha = ref.object.sha;
  const parentCommit = await ghCall("GET", `/git/commits/${parentCommitSha}`, null, "parent commit");
  const baseTreeSha = parentCommit.tree.sha;

  // 3. blob 생성 (base64 그대로 업로드 — 큰 페이로드, 보통 가장 오래 걸림).
  const blob = await ghCall("POST", `/git/blobs`,
    { content: contentB64, encoding: "base64" }, `blob (${(contentB64.length / 1024 / 1024).toFixed(1)}MB b64)`);

  // 4. 새 tree (기존 tree 위에 path 만 추가/덮어쓰기).
  const tree = await ghCall("POST", `/git/trees`, {
    base_tree: baseTreeSha,
    tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
  }, "tree");

  // 5. 새 commit.
  const commitBody = { message, tree: tree.sha, parents: [parentCommitSha] };
  if (committer) {
    commitBody.author = committer;
    commitBody.committer = committer;
  }
  const commit = await ghCall("POST", `/git/commits`, commitBody, "commit");

  // 6. ref 를 새 commit 으로 advance.
  await ghCall("PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha }, "ref advance");

  // Contents API 의 응답 형태를 흉내내 호출자가 기대하는 모양으로 반환 (size 등).
  return { content: { sha: blob.sha, path }, commit };
}

function extOf(name) {
  const m = /\.([a-z0-9]{2,4})$/i.exec(name || "");
  return m ? "." + m[1].toLowerCase() : "";
}

function slugify(text, max = SLUG_MAX) {
  if (!text) return "episode";
  let s = text.trim().replace(/\s+/g, "-");
  s = s.replace(/[^0-9A-Za-z가-힣\-_]/g, "");
  return s.slice(0, max) || "episode";
}

function shortIdOf(artifactId) {
  // UUID 의 첫 8자 (16진수). 없거나 형식이 다르면 빈 문자열을 반환해 옛 포맷으로 동작.
  if (!artifactId) return "";
  const m = /^([0-9a-f]{8})/.exec(artifactId);
  return m ? m[1] : "";
}

function extractDate(meta) {
  const m = DATE_RE.exec(meta.coverDateAttr || "");
  if (m && MONTHS[m[1]]) {
    return (
      m[3] +
      String(MONTHS[m[1]]).padStart(2, "0") +
      m[2].padStart(2, "0")
    );
  }
  const n = new Date();
  return (
    n.getFullYear().toString() +
    String(n.getMonth() + 1).padStart(2, "0") +
    String(n.getDate()).padStart(2, "0")
  );
}

function buildFilename(meta, ext, shortId) {
  const date = extractDate(meta);
  const nb = slugify(meta.notebookTitle);
  const title = slugify(meta.episodeTitle);
  // shortId 가 있으면 ${date}__${nb}__${shortId}__${title}.ext, 없으면 옛 포맷.
  return shortId
    ? `${date}__${nb}__${shortId}__${title}${ext}`
    : `${date}__${nb}__${title}${ext}`;
}

// 옛 3-segment 파일 (UUID 도입 전 v0.4.0 이하) 을 (date, titleSlug, ext) 만으로
// 매칭. 노트북 슬러그는 매칭 키에서 제외 — 사용자가 NotebookLM 에서 노트북 이름을
// 바꾼 뒤 같은 카드를 다시 받는 케이스에서도 dedup 이 동작하도록.
// 4-segment (shortId 박힌) 파일은 여기서 매칭하지 않음 — shortId substring 매칭이 1차 키.
const LEGACY_DEDUP_RE = /^(\d{8})__.+?__(?:([0-9a-f]{8})__)?(.+?)\.(m4a|mp3|mp4)$/;
function legacyFilenameMatches(name, date, titleSlug, ext) {
  const m = LEGACY_DEDUP_RE.exec(name);
  if (!m) return false;
  const [, fDate, fShortId, fTitle, fExt] = m;
  if (fShortId) return false; // 4-segment 는 shortId 매칭으로 처리
  const wantExt = (ext || "").replace(/^\./, "").toLowerCase();
  return fDate === date && fTitle === titleSlug && fExt.toLowerCase() === wantExt;
}
