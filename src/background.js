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
  const filename = buildFilename(meta, ext, shortId);
  // shortId 가 도입되기 전 포맷 — 마이그레이션 시점에 같은 audio 가 옛 이름으로
  // 이미 push 되어 있을 수 있어 dedup 매칭에 함께 사용.
  const legacyFilename = shortId ? buildFilename(meta, ext, "") : null;
  suggest({ filename, conflictAction: "uniquify" });

  // 로컬 저장은 Chrome 이 그대로 진행. 동시에 SW 에서 audio URL 을 다시 fetch
  // 해서 GitHub 로 push.
  pushEpisode(item.url, filename, shortId, legacyFilename).then((result) => {
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

async function pushEpisode(audioUrl, filename, shortId, legacyFilename) {
  const cfg = await chrome.storage.local.get([
    "token", "repo", "rssMode", "committerName", "committerEmail",
  ]);
  if (!cfg.token || !cfg.repo) {
    return { skipped: true, reason: "GitHub 설정 없음" };
  }

  // shortId 가 있으면 episodes 폴더 list 해서 같은 UUID 박힌 파일이 이미 있는지
  // 먼저 확인. 제목이 바뀌어도 UUID 기반으로 dedup. legacyFilename (UUID 없는
  // 옛 포맷) 도 함께 매칭해서 마이그레이션 이전 파일과의 충돌 회피.
  const committer = cfg.committerName && cfg.committerEmail
    ? { name: cfg.committerName, email: cfg.committerEmail }
    : null;

  let existingMatch = null;
  if (shortId || legacyFilename) {
    try {
      const list = await ghList(cfg.repo, "docs/episodes", cfg.token);
      existingMatch = list.find((f) => {
        if (shortId && f.name.includes(`__${shortId}__`)) return true;
        if (legacyFilename && f.name === legacyFilename) return true;
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

async function ghList(repo, dirPath, token) {
  const r = await fetch(ghContentsUrl(repo, dirPath), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
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

function buildFilename(meta, ext, shortId) {
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
  const nb = slugify(meta.notebookTitle);
  const title = slugify(meta.episodeTitle);
  // shortId 가 있으면 ${date}__${nb}__${shortId}__${title}.ext, 없으면 옛 포맷.
  return shortId
    ? `${date}__${nb}__${shortId}__${title}${ext}`
    : `${date}__${nb}__${title}${ext}`;
}
