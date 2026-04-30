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
  if (msg?.type === "scan:all") {
    if (inProgressTask) {
      sendResponse({ ok: false, error: "이미 진행 중인 작업이 있습니다" });
      return false;
    }
    sendResponse({ ok: true, started: true });
    inProgressTask = "scan:all";
    runScanAll()
      .catch((e) => {
        console.error("[scan:all]", e);
        emitEvent("scan:all:done", { ok: false, error: e.message });
      })
      .finally(async () => {
        await cleanupOwnedTabs();
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
    runBulkRemote(msg.selections || [])
      .catch((e) => {
        console.error("[bulk:remote]", e);
        emitEvent("bulk:remote:done", { ok: false, error: e.message });
      })
      .finally(async () => {
        await cleanupOwnedTabs();
        inProgressTask = null;
      });
    return false;
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
const PUSH_RESULT_TIMEOUT = 180000;

let inProgressTask = null;
const ownedTabs = new Set(); // SW 가 연 탭 id — 정리용.

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emitEvent(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
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

async function openManagedTab(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  ownedTabs.add(tab.id);
  await waitForTabComplete(tab.id, TAB_OPEN_TIMEOUT);
  await waitForContentReady(tab.id, CONTENT_PING_TIMEOUT);
  return tab.id;
}

async function closeManagedTab(tabId) {
  ownedTabs.delete(tabId);
  try { await chrome.tabs.remove(tabId); } catch {}
}

async function cleanupOwnedTabs() {
  for (const tid of Array.from(ownedTabs)) {
    await closeManagedTab(tid);
  }
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
      const r = await chrome.tabs.sendMessage(tabId, { type: "scan" });
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
  emitEvent("scan:all:progress", { phase: "list", message: "노트북 목록 수집 중…" });
  const urls = await scanHomePageForNotebookUrls();
  emitEvent("scan:all:progress", { phase: "list:done", total: urls.length });
  const notebooks = [];
  for (let i = 0; i < urls.length; i++) {
    emitEvent("scan:all:progress", {
      phase: "scan",
      done: i,
      total: urls.length,
      message: `노트북 ${i + 1}/${urls.length} 스캔 중…`,
    });
    try {
      const r = await scanOneNotebook(urls[i]);
      notebooks.push(r);
    } catch (e) {
      console.warn(`[scan:all] ${urls[i]} 실패:`, e.message);
      notebooks.push({ url: urls[i], cover: { title: "" }, audios: [], error: e.message });
    }
  }
  emitEvent("scan:all:done", { ok: true, notebooks });
  return { notebooks };
}

async function runBulkRemote(selections) {
  // selections: [{ notebookUrl, cardIndex, episodeTitle }, ...]
  const grouped = new Map();
  for (const s of selections) {
    if (!grouped.has(s.notebookUrl)) grouped.set(s.notebookUrl, []);
    grouped.get(s.notebookUrl).push(s);
  }
  const total = selections.length;
  let done = 0;
  for (const [url, items] of grouped) {
    emitEvent("bulk:remote:progress", {
      phase: "open", url, done, total,
      message: `${url.split("/").pop().slice(0, 8)}… 탭 여는 중`,
    });
    let tabId;
    try {
      tabId = await openManagedTab(url);
      const ready = await waitForAudioCards(tabId, NOTEBOOK_CARDS_TIMEOUT);
      if (!ready) {
        for (const item of items) {
          emitEvent("bulk:remote:result", {
            episodeTitle: item.episodeTitle, ok: false, error: "카드 로딩 타임아웃",
          });
          done++;
        }
        continue;
      }
    } catch (e) {
      for (const item of items) {
        emitEvent("bulk:remote:result", {
          episodeTitle: item.episodeTitle, ok: false, error: `탭 열기 실패: ${e.message}`,
        });
        done++;
      }
      continue;
    }
    try {
      for (const item of items) {
        emitEvent("bulk:remote:progress", {
          phase: "download", url, episodeTitle: item.episodeTitle, done, total,
        });
        try {
          const r = await chrome.tabs.sendMessage(tabId, { type: "download", index: item.cardIndex });
          if (!r?.ok) {
            emitEvent("bulk:remote:result", {
              episodeTitle: item.episodeTitle, ok: false, error: r?.error || "메뉴 클릭 실패",
            });
            done++;
            continue;
          }
          const result = await waitPushResultLocal(item.episodeTitle, PUSH_RESULT_TIMEOUT);
          if (result.timeout) {
            emitEvent("bulk:remote:result", {
              episodeTitle: item.episodeTitle, ok: false, error: "push 응답 타임아웃",
            });
          }
          done++;
        } catch (e) {
          emitEvent("bulk:remote:result", {
            episodeTitle: item.episodeTitle, ok: false, error: e.message,
          });
          done++;
        }
      }
    } finally {
      await closeManagedTab(tabId);
    }
  }
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

  const path = `docs/episodes/${filename}`;

  const urlHost = (() => { try { return new URL(audioUrl).host; } catch { return "(invalid)"; } })();
  console.log(`[push] SW fetch host=${urlHost} url=${audioUrl.slice(0, 200)}`);
  const r = await fetch(audioUrl, { credentials: "include" });
  if (!r.ok) {
    throw new Error(`SW fetch 실패: ${r.status} ${r.statusText} host=${urlHost} final=${r.url.slice(0, 80)}… redirected=${r.redirected}`);
  }
  const buf = await r.arrayBuffer();
  const size = buf.byteLength;
  const b64 = arrayBufferToBase64(buf);
  console.log(`[push] fetched ${(size / 1024 / 1024).toFixed(1)}MB`);

  // 정확 path 에 같은 크기 파일이 있으면 skip (list 실패 시 fallback 경로 + 이중 안전망).
  const existing = await ghGet(cfg.repo, path, cfg.token);
  let pushResult;
  if (existing && existing.size === size) {
    console.log(`[push] ${filename} 이미 존재 (같은 크기), skip`);
    pushResult = { skipped: true, reason: "이미 존재" };
  } else {
    await ghPut(cfg.repo, path, b64,
      `Add episode ${filename}`, existing?.sha, cfg.token, committer);
    console.log(`[push] ${filename} pushed (${(size / 1024 / 1024).toFixed(1)}MB)`);
    pushResult = { ok: true, size };
  }

  // rssMode === "extension" 이면 audio push 가 끝난 직후 같은 SW 안에서 feed 도 재빌드.
  // skip 된 경우엔 audio 가 이미 있던 상태이므로 feed 도 그대로일 가능성이 높음 →
  // rebuildFeed 내부의 sha 비교가 unchanged 면 PUT 안 함, 그래서 호출은 무해함.
  if (cfg.rssMode === "extension") {
    try {
      const feed = await rebuildFeed({ repo: cfg.repo, token: cfg.token, committer });
      pushResult.feed = feed;
      if (feed.skipped) console.log(`[feed] skip (${feed.reason})`);
      else console.log(`[feed] rebuilt with ${feed.episodes} episodes`);
      if (feed.missingMeta) console.warn("[feed] docs/podcast.json 없음 — default 메타로 생성됨. examples/feed-builder/docs/podcast.json 참고해서 추가 권장.");
    } catch (e) {
      console.error("[feed]", e);
      pushResult.feedError = e.message;
    }
  }
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
  const body = { message, content: contentB64 };
  if (sha) body.sha = sha;
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
  if (!r.ok) throw new Error(`ghPut ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
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
