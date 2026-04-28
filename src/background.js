// Service worker. content / popup 와 메시지로 연결되고, NotebookLM 이 발생시킨
// 다운로드를 가로채 `YYYYMMDD__노트북-슬러그__제목-슬러그.{ext}` 로 rename 한다.
//
// 흐름: popup → content("download") → content 가 background 에 "download:expect"
// 로 메타(노트북/제목/cover-date + sender tabId) 를 push → content 가 ⋮ →
// 다운로드 메뉴 클릭 → Chrome 다운로드 시작 → onDeterminingFilename 에서 큐 pop,
// suggest() 로 rename → chrome.scripting.executeScript({world:"MAIN"}) 로
// NotebookLM 페이지 컨텍스트에서 audio URL 을 fetch (page-world 는 사용자
// Google 로그인 세션을 가짐. SW 직접 fetch 는 third-party cookie 취급으로
// CORS+401 redirect 를 맞아 막힘). 결과 base64 를 받아 GitHub Contents API 로
// docs/episodes/ 에 PUT.

const expectedQueue = [];
const STALE_MS = 5 * 60 * 1000;

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "download:expect") {
    expectedQueue.push({
      ...msg.payload,
      tabId: sender?.tab?.id,
      pushedAt: Date.now(),
    });
    sendResponse({ ok: true, queued: expectedQueue.length });
    return false;
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
  const filename = buildFilename(meta, ext);
  suggest({ filename, conflictAction: "uniquify" });

  // 로컬 저장은 Chrome 이 그대로 진행. 동시에 NotebookLM 탭의 page world 에서
  // audio URL 을 fetch 해서 (사용자 로그인 세션 사용) GitHub 로 push.
  pushFromTab(item.url, filename, meta).then((result) => {
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
}

async function pushFromTab(audioUrl, filename, meta) {
  const cfg = await chrome.storage.local.get([
    "token", "repo", "committerName", "committerEmail",
  ]);
  if (!cfg.token || !cfg.repo) {
    return { skipped: true, reason: "GitHub 설정 없음" };
  }
  if (!meta.tabId) throw new Error("download 요청 tab id 누락");
  const path = `docs/episodes/${filename}`;

  console.log(`[push] page-world fetch: ${audioUrl.slice(0, 100)}…`);
  const { b64, size } = await fetchInPageWorld(meta.tabId, audioUrl);
  console.log(`[push] fetched ${(size / 1024 / 1024).toFixed(1)}MB`);

  const existing = await ghGet(cfg.repo, path, cfg.token);
  if (existing && existing.size === size) {
    console.log(`[push] ${filename} 이미 존재 (같은 크기), skip`);
    return { skipped: true, reason: "이미 존재" };
  }

  const committer = cfg.committerName && cfg.committerEmail
    ? { name: cfg.committerName, email: cfg.committerEmail }
    : null;
  await ghPut(cfg.repo, path, b64,
    `Add episode ${filename}`, existing?.sha, cfg.token, committer);
  console.log(`[push] ${filename} pushed (${(size / 1024 / 1024).toFixed(1)}MB)`);
  return { ok: true, size };
}

// chrome.scripting.executeScript world:"MAIN" 으로 NotebookLM 페이지의 자바스크립트
// 컨텍스트 안에서 fetch 를 수행. 페이지가 이미 사용자 Google 세션으로 로그인되어
// 있으므로 audio URL (lh3.googleusercontent.com 등) 이 same-site cookie 로 인증됨.
// SW 직접 fetch 는 third-party cookie 취급되어 ServiceLogin 으로 리다이렉트되며 CORS 차단됨.
async function fetchInPageWorld(tabId, url) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (u) => {
      // Chrome <117 의 executeScript 는 throw 된 에러를 별도 필드로 돌려주지 않으므로
      // 항상 try/catch 로 잡아 직접 직렬화한다.
      try {
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) {
          return { ok: false, error: `fetch ${r.status} ${r.statusText}`, finalUrl: r.url, redirected: r.redirected };
        }
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const CHUNK = 0x8000;
        const parts = [];
        for (let i = 0; i < bytes.length; i += CHUNK) {
          parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
        }
        return { ok: true, b64: btoa(parts.join("")), size: bytes.length, finalUrl: r.url, redirected: r.redirected };
      } catch (e) {
        return {
          ok: false,
          error: String(e?.message || e || "unknown"),
          name: e?.name,
        };
      }
    },
    args: [url],
  });
  const out = results?.[0]?.result;
  if (!out) {
    throw new Error("page-world 결과 없음 (executeScript 자체 실패?)");
  }
  if (!out.ok) {
    const detail = [
      out.error,
      out.name ? `(${out.name})` : "",
      out.finalUrl ? `final=${out.finalUrl.slice(0, 80)}…` : "",
      out.redirected ? "redirected" : "",
    ].filter(Boolean).join(" ");
    throw new Error(`page-world fetch 실패: ${detail}`);
  }
  return out;
}

function ghContentsUrl(repo, path) {
  // path 는 슬래시 보존하면서 segment 별로 인코딩.
  const segs = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${repo}/contents/${segs}`;
}

async function ghGet(repo, path, token) {
  const r = await fetch(ghContentsUrl(repo, path), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`ghGet ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
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

function buildFilename(meta, ext) {
  let date;
  const m = DATE_RE.exec(meta.coverDateAttr || "");
  if (m && MONTHS[m[1]]) {
    date =
      m[3] +
      String(MONTHS[m[1]]).padStart(2, "0") +
      m[2].padStart(2, "0");
  } else {
    const n = new Date();
    date =
      n.getFullYear().toString() +
      String(n.getMonth() + 1).padStart(2, "0") +
      String(n.getDate()).padStart(2, "0");
  }
  return `${date}__${slugify(meta.notebookTitle)}__${slugify(meta.episodeTitle)}${ext}`;
}
