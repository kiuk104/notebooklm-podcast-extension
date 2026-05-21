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

import { rebuildFeed, FILENAME_RE } from "./feed.js";
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

// 다기기간 동기화: 사용자가 옵션 페이지에서 입력한 GitHub 설정 / UI 언어를
// chrome.storage.sync 에 보관 — 같은 Google 계정 + 같은 익스텐션이 설치된 다른
// 기기와 자동 공유. Chrome Sync 패스프레이즈 켜져 있으면 E2EE; 안 켜져 있으면
// Google 계정 키로 암호화 (Google 이 이론상 접근 가능). 옵션 페이지의 sync
// 안내 박스 참고. quota: 100KB 총합 / 8KB per item / 1800 writes/hour — token
// 56byte + repo + 메타 합쳐 ~수백 byte 로 여유 충분.
//
// runtime/ephemeral state (currentTaskState, lastScanResult, notebookUrlMap,
// bulkFailedSelections, epColWidths) 는 device-local 의미라 chrome.storage.local
// 그대로 유지. notebookUrlMap 은 누적 가능성이 있어 sync quota 도 위험.
const CFG_KEYS = [
  "token", "repo", "rssMode", "autoDownloadNew",
  "committerName", "committerEmail", "uiLang",
  "bulkSkipOlderDays", "deleteLocalOnPushSuccess",
];

// 일괄 다운로드에서 cover-subtitle-date 기준으로 N 일 이상 옛 노트북의 카드는 처음부터
// 스킵. 0 / 빈값이면 cutoff 안 함. default 730 (2년) — RSS retention.maxAgeDays 와
// 같은 기준을 익스텐션 측에 두면, 옛 노트북 카드를 push → workflow 가 즉시 retention
// 으로 삭제 → 다음 스캔에 신규 재인식 → 영구 루프 사고를 처음부터 회피. 사용자가 옛
// 노트북을 NotebookLM 에서 안 지워도 익스텐션이 알아서 무시함.
const DEFAULT_BULK_SKIP_OLDER_DAYS = 730;

async function cfgGet(keys) {
  // sync 우선 + 비어있는 키만 local 에 fallback. 마이그레이션 완료 후엔 local
  // 에 남아있는 게 정상적으론 없지만, 마이그레이션 실패 / 부분 실패 케이스 안전망.
  const want = keys ?? CFG_KEYS;
  const [s, l] = await Promise.all([
    chrome.storage.sync.get(want).catch(() => ({})),
    chrome.storage.local.get(want).catch(() => ({})),
  ]);
  const out = {};
  for (const k of want) {
    out[k] = s[k] !== undefined ? s[k] : l[k];
  }
  return out;
}

async function cfgSet(obj) {
  // sync 만 쓴다 (local 에도 쓰면 두 저장소가 분기되어 다음 cfgGet 이 어느 쪽
  // 우선인지 헷갈림). 마이그레이션 후 local 에 같은 키가 남아있으면 정리.
  await chrome.storage.sync.set(obj);
  try { await chrome.storage.local.remove(Object.keys(obj)); } catch {}
}

// 1회성 마이그레이션: 옛 버전이 chrome.storage.local 에 보관한 설정을 sync 로
// 옮긴다. sync 에 같은 키가 이미 있으면 (다른 기기에서 먼저 push 된 값) 덮지 않음.
async function migrateConfigToSync() {
  try {
    const [s, l] = await Promise.all([
      chrome.storage.sync.get(CFG_KEYS),
      chrome.storage.local.get(CFG_KEYS),
    ]);
    const toMigrate = {};
    const toRemoveLocal = [];
    for (const k of CFG_KEYS) {
      if (l[k] === undefined) continue;
      if (s[k] === undefined) toMigrate[k] = l[k];
      toRemoveLocal.push(k);
    }
    if (Object.keys(toMigrate).length > 0) {
      await chrome.storage.sync.set(toMigrate);
      console.log(`[cfg] migrated ${Object.keys(toMigrate).length} keys to sync`);
    }
    if (toRemoveLocal.length > 0) {
      await chrome.storage.local.remove(toRemoveLocal);
    }
  } catch (e) {
    console.warn("[cfg] migration failed:", e);
  }
}

// SW 시작 시 한 번. 빈 sync 또는 같은 기기에서 이전 버전 사용 흔적이 있으면 옮김.
migrateConfigToSync();

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
    // msg.force=true 면 캐시 우회 (강제 풀 스캔). popup [모든 노트북 스캔] shift-click /
    // 옵션 페이지 [↻ 재스캔] 이 이 플래그를 set. default false — 30분 이내 캐시 자동 재사용.
    runScanAll({ force: !!msg.force })
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
  if (msg?.type === "notebook:url:map:get") {
    loadNotebookUrlMap().then((map) => sendResponse({ ok: true, map }));
    return true; // async
  }
  if (msg?.type === "notebook:url:remember") {
    // popup [현재 노트북 스캔] 직후 호출 — 그 한 노트북만 영구 맵에 추가.
    // title 이 없으면 slugify 가 "episode" 로 fallback 하므로 명시 가드.
    if (!msg.title || !msg.url) {
      sendResponse({ ok: false, error: "title/url 누락" });
      return false;
    }
    const slug = slugify(msg.title);
    mergeNotebookUrlMap([{ slug, url: msg.url }]).then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg?.type === "bulk:failed:list") {
    loadFailedSelections().then((data) => {
      sendResponse({ ok: true, cards: data?.selections || [], savedAt: data?.savedAt || null });
    });
    return true; // async
  }
  if (msg?.type === "bulk:remote:retry-failed") {
    if (inProgressTask) {
      sendResponse({ ok: false, error: "이미 진행 중인 작업이 있습니다" });
      return false;
    }
    sendResponse({ ok: true, started: true });
    inProgressTask = "bulk:remote";
    cancelRequested = false;
    (async () => {
      try {
        const data = await loadFailedSelections();
        const sel = data?.selections || [];
        if (sel.length === 0) throw new Error("재시도할 실패 카드가 없습니다");
        await runBulkRemote(sel);
      } catch (e) {
        console.error("[bulk:remote:retry-failed]", e);
        await setTaskState({
          status: "failed",
          message: `Retry 실패: ${e.message}`,
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
  if (msg?.type === "bulk:remote:selected") {
    // 사용자가 직전 스캔 결과에서 직접 체크박스로 고른 카드들만 다운로드.
    // payload.selections: [{ notebookUrl, cardIndex, artifactId, episodeTitle }, ...]
    // (buildNewSelections 가 만드는 형태와 동일). 옵션 페이지의 [선택해서 받기]
    // 트리 UI 가 생성. dedup 은 pushEpisode 안에서 어차피 한 번 더 걸리므로
    // UI 단계의 "이미 받은 카드" 체크는 사용자가 강제로 켜면 그대로 진행됨.
    if (inProgressTask) {
      sendResponse({ ok: false, error: "이미 진행 중인 작업이 있습니다" });
      return false;
    }
    const sel = Array.isArray(msg.payload?.selections) ? msg.payload.selections : [];
    if (sel.length === 0) {
      sendResponse({ ok: false, error: "선택된 카드가 없습니다" });
      return false;
    }
    sendResponse({ ok: true, started: true, count: sel.length });
    inProgressTask = "bulk:remote";
    cancelRequested = false;
    (async () => {
      try {
        await runBulkRemote(sel);
      } catch (e) {
        console.error("[bulk:remote:selected]", e);
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
  if (msg?.type === "scan:result:pushed") {
    // 옵션 페이지의 선택 트리가 "이미 push 된 카드" 표시 / 기본 미체크용으로 사용.
    // 각 audio 에 isPushed 플래그를 직접 박아 반환 — UI 가 dedup 로직 (shortId + legacy)
    // 을 중복 구현할 필요 없게. pushedShortIds 도 같이 반환해 popup 의 별도 흐름 호환.
    (async () => {
      try {
        const last = await loadLastScanResult();
        if (!last?.notebooks?.length) {
          sendResponse({ ok: true, notebooks: [], pushedShortIds: [], scannedAt: 0 });
          return;
        }
        const cfg = await cfgGet(["token", "repo"]);
        const pushedIndex = (cfg.token && cfg.repo)
          ? await loadPushedIndex(cfg.repo, cfg.token)
          : { shortIds: new Set(), legacyKeys: new Set(), titleKeys: new Set() };
        const skipDays = await loadBulkSkipOlderDays();
        const skipIndex = await loadSkippedIndex();
        const enriched = last.notebooks.map((nb) => {
          const tooOld = isNotebookTooOld(nb.cover?.dateAttr || "", skipDays);
          const coverDateAttr = nb.cover?.dateAttr || "";
          return {
            ...nb,
            isTooOld: tooOld,
            audios: (nb.audios || []).map((a) => ({
              ...a,
              isPushed: isAudioPushed(a, coverDateAttr, pushedIndex),
              isTooOld: tooOld,
              // (date, titleSlug) 폴백 포함 — empty artifactId race 에서도 정확히 표시.
              isSkipped: isAudioSkipped(a, coverDateAttr, skipIndex),
            })),
          };
        });
        sendResponse({
          ok: true,
          notebooks: enriched,
          scannedAt: last.scannedAt || 0,
          pushedShortIds: Array.from(pushedIndex.shortIds),
          skipOlderDays: skipDays,
          skippedShortIds: Array.from(skipIndex.shortIds), // Set → array (옛 popup 호환)
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
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
        const cfg = await cfgGet(["token", "repo"]);
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
        const cfg = await cfgGet(["token", "repo"]);
        if (!cfg.token || !cfg.repo) {
          sendResponse({ ok: false, error: "GitHub 설정 없음 (token/repo)" });
          return;
        }
        const list = await ghList(cfg.repo, "docs/episodes", cfg.token);
        // FILENAME_RE 는 feed.js 에서 공유 import (중복 정의 제거).
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
  if (msg?.type === "feed:order:save") {
    // 옵션 페이지의 "피드 순서 편집 → 피드에 적용" 버튼.
    // podcast.json 에 episodeOrder 배열을 저장하고, extension 모드면 즉시 feed 재빌드.
    // episodeOrder: string[] (filename 배열, 표시하고 싶은 순서대로).
    // [] 빈 배열을 넘기면 커스텀 순서 초기화 (날짜 내림차순 복귀).
    (async () => {
      try {
        const cfg = await cfgGet(["token", "repo", "committerName", "committerEmail", "rssMode"]);
        if (!cfg.token || !cfg.repo) throw new Error("GitHub 설정 없음 (token/repo)");
        const committer = cfg.committerName
          ? { name: cfg.committerName, email: cfg.committerEmail || "noreply@example.com" }
          : null;
        // podcast.json 읽기 → episodeOrder 업데이트 → PUT
        const path = "docs/podcast.json";
        const existing = await ghGet(cfg.repo, path, cfg.token);
        let meta = {};
        if (existing?.content) {
          try {
            const raw = existing.content.replace(/\s/g, "");
            const text = new TextDecoder().decode(
              Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
            );
            meta = JSON.parse(text);
          } catch (e) {
            console.warn("[feed:order:save] podcast.json parse 실패, 빈 객체로 진행:", e.message);
          }
        }
        const order = Array.isArray(msg.order) ? msg.order : [];
        if (order.length > 0) {
          meta.episodeOrder = order;
        } else {
          delete meta.episodeOrder; // 빈 배열 → 커스텀 순서 제거 (날짜순 복귀)
        }
        const json = JSON.stringify(meta, null, 2);
        const bytes = new TextEncoder().encode(json);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        const newB64 = btoa(bin);
        await ghPut(cfg.repo, path, newB64,
          order.length > 0 ? "update: episode order" : "update: reset episode order",
          existing?.sha, cfg.token, committer);
        // extension 모드면 즉시 피드도 재빌드
        if (cfg.rssMode === "extension") {
          const feed = await rebuildFeed({ repo: cfg.repo, token: cfg.token, committer });
          sendResponse({ ok: true, feed });
        } else {
          sendResponse({ ok: true });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }
  if (msg?.type === "podcast:json:get") {
    // 옵션 페이지의 "피드 순서로 보기" — podcast.json 의 최신 내용을 읽어 반환.
    // episodeOrder 배열이 있으면 해당 배열을 포함한 전체 JSON 오브젝트를 돌려줌.
    (async () => {
      try {
        const cfg = await cfgGet(["token", "repo"]);
        if (!cfg.token || !cfg.repo) throw new Error("GitHub 설정 없음");
        const existing = await ghGet(cfg.repo, "docs/podcast.json", cfg.token);
        if (!existing?.content) { sendResponse({ ok: true, data: {} }); return; }
        const raw = existing.content.replace(/\s/g, "");
        const text = new TextDecoder().decode(
          Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
        );
        sendResponse({ ok: true, data: JSON.parse(text) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }
  if (msg?.type === "episodes:delete") {
    // 단일 파일 ghDelete. 옵션 페이지의 [삭제] 버튼.
    // addToSkip:true (default) 면 삭제와 동시에 그 카드의 shortId 를 영구 스킵
    // 목록에 등록 — 다음 일괄 다운로드에서 같은 카드 받지 않음. 사용자가 명시
    // 삭제한 카드를 retention 컷오프가 일으키는 영구 루프와 무관하게 영구히
    // 무시. 옛 3-segment 파일은 shortId 추출 불가 → skip 등록만 못 하지만 삭제는 진행.
    (async () => {
      try {
        const cfg = await cfgGet(["token", "repo", "committerName", "committerEmail"]);
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
        let skippedSid = null;
        if (msg.addToSkip !== false) {
          const sid = extractShortIdFromFilename(msg.filename);
          if (sid) {
            // 호출자가 row 의 메타 (title, date, notebookTitle) 를 넘기면 같이 저장.
            // 옵션 페이지의 스킵 목록 패널이 그 정보로 어떤 파일이었는지 보여줌.
            await addSkippedEntry({
              shortId: sid,
              filename: msg.filename,
              title: msg.title || "",
              date: msg.date || "",
              notebookTitle: msg.notebookTitle || "",
            });
            skippedSid = sid;
          }
        }
        sendResponse({ ok: true, skippedShortId: skippedSid });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }
  if (msg?.type === "storage:cleanup") {
    // 사용량이 retention.maxTotalMB 한도를 초과하면 옛 파일부터 ghDelete + 영구
    // 스킵 등록. workflow 도 같은 한도로 자르지만 그쪽은 익스텐션 스킵 목록에
    // 등록 안 해서 다음 스캔에 같은 카드 신규로 다시 잡히는 영구 루프 위험.
    // 익스텐션이 직접 정리하면 그 사고 회피 + 사용자가 명시 트리거.
    //
    // 파일명에서 (date, shortId, title, notebook) 추출 가능 — 4-segment 파일은
    // 스킵 등록 완전 (메타 포함). 옛 3-segment 파일은 shortId 없어 스킵 등록 못
    // 하지만 ghDelete 는 진행. workflow 의 build_feed.py 가 보존 정렬과 같은
    // pubDate 기준이라 결과가 일치.
    (async () => {
      try {
        const cfg = await cfgGet(["token", "repo", "committerName", "committerEmail"]);
        if (!cfg.token || !cfg.repo) {
          sendResponse({ ok: false, error: "no-config" });
          return;
        }
        const committer = cfg.committerName && cfg.committerEmail
          ? { name: cfg.committerName, email: cfg.committerEmail } : null;
        const list = await ghList(cfg.repo, "docs/episodes", cfg.token);
        // podcast.json 의 maxTotalMB 추출.
        let maxTotalMB = null;
        try {
          const pj = await ghGet(cfg.repo, "docs/podcast.json", cfg.token);
          if (pj?.content) {
            const decoded = atob(pj.content.replace(/\s/g, ""));
            const m = /"maxTotalMB"\s*:\s*(\d+(?:\.\d+)?)/.exec(decoded);
            if (m) maxTotalMB = parseFloat(m[1]);
          }
        } catch (e) {
          console.warn("[storage:cleanup] podcast.json 조회 실패:", e.message);
        }
        if (!maxTotalMB || maxTotalMB <= 0) {
          sendResponse({ ok: false, error: "no-retention-limit" });
          return;
        }
        const cap = Math.floor(maxTotalMB * 1024 * 1024);
        // 파일에서 pubDate 추출 (filename 의 YYYYMMDD prefix). 파싱 실패 시 epoch 0.
        const items = list.map((f) => {
          const m = /^(\d{8})__/.exec(f.name);
          let ts = 0;
          if (m) {
            const ymd = m[1];
            ts = Date.UTC(
              parseInt(ymd.slice(0, 4), 10),
              parseInt(ymd.slice(4, 6), 10) - 1,
              parseInt(ymd.slice(6, 8), 10),
            );
          }
          return { f, ts };
        });
        // 최신순 (build_feed.py 의 apply_retention 과 같은 정렬).
        items.sort((a, b) => b.ts - a.ts);
        // 누적 size 가 cap 넘는 시점부터 잘라냄. cap 보다 큰 단일 파일이 와도
        // 가장 최신 1편은 살림 — build_feed.py 의 안전망과 동일.
        const toKeep = [];
        const toDrop = [];
        let total = 0;
        for (const it of items) {
          if (toKeep.length === 0 || total + it.f.size <= cap) {
            toKeep.push(it.f);
            total += it.f.size;
          } else {
            toDrop.push(it.f);
          }
        }
        if (toDrop.length === 0) {
          sendResponse({
            ok: true, droppedCount: 0, droppedBytes: 0,
            currentBytes: total, maxTotalMB,
          });
          return;
        }
        // 옛것부터 ghDelete + 영구 스킵 등록. 실패 (race 409 등) 시 그 파일은
        // skip 하고 다음으로 — 한 번에 80개 정리하다 한 두 개 실패해도 진행 지속.
        let droppedCount = 0;
        let droppedBytes = 0;
        const errors = [];
        for (const f of toDrop) {
          try {
            await ghDelete(
              cfg.repo,
              `docs/episodes/${f.name}`,
              f.sha,
              `Retention cleanup: drop ${f.name}`,
              cfg.token,
              committer,
            );
            droppedCount++;
            droppedBytes += f.size || 0;
            // 4-segment 파일이면 스킵 목록에도 메타와 함께 등록. 메타는 filename
            // 에서 가능한 만큼 추출 (title 은 slug 라 raw 제목 못 복원 — 그대로 둠).
            const sid = extractShortIdFromFilename(f.name);
            if (sid) {
              const dm = /^(\d{8})__([^_]+?)__[0-9a-f]{8}__(.+?)\.(m4a|mp3|mp4)$/i.exec(f.name);
              await addSkippedEntry({
                shortId: sid,
                filename: f.name,
                title: dm ? dm[3] : "",
                date: dm ? dm[1] : "",
                notebookTitle: dm ? dm[2] : "",
              });
            }
          } catch (e) {
            errors.push({ filename: f.name, message: e.message });
          }
        }
        sendResponse({
          ok: true,
          droppedCount,
          droppedBytes,
          currentBytes: total,
          maxTotalMB,
          errors,
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async
  }
  if (msg?.type === "skip:list") {
    // 메타 포함된 entry 배열 반환. 옵션 페이지의 스킵 패널이 어떤 파일이었는지
    // (filename, title, date, notebookTitle, skippedAt) 같이 표시.
    (async () => {
      const entries = await loadSkippedEntries();
      sendResponse({
        ok: true,
        entries,
        // 옛 API 호환 — 기존 popup 코드가 shortIds 만 기대했을 경우 대비.
        shortIds: entries.map((e) => e.shortId),
      });
    })();
    return true;
  }
  if (msg?.type === "skip:add") {
    (async () => {
      try {
        const sid = (msg.shortId || "").toLowerCase();
        if (!/^[0-9a-f]{8}$/.test(sid)) {
          sendResponse({ ok: false, error: "invalid shortId" });
          return;
        }
        await addSkippedEntry({
          shortId: sid,
          filename: msg.filename || "",
          title: msg.title || "",
          date: msg.date || "",
          notebookTitle: msg.notebookTitle || "",
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg?.type === "bulk:skip:selected") {
    // 옵션 페이지의 [선택해서 받기] 트리에서 [선택 카드 스킵] 으로 한 번에 영구
    // 스킵 등록. payload.items: [{ artifactId, title, coverDateAttr, notebookTitle }, ...]
    // (notebookUrl / cardIndex 는 스킵에 불필요 — shortId 만 있으면 됨.)
    //
    // saveSkippedEntries 의 quota fallback 이 가장 옛것부터 컷하므로, N건을 한꺼번에
    // 등록하다 quota 를 초과해도 trim 후 재시도 — 다만 entry 마다 loadSkippedEntries
    // 가 호출되어 비효율이라 한 번에 모아서 save 하는 경로로 처리.
    (async () => {
      try {
        const items = Array.isArray(msg.payload?.items) ? msg.payload.items : [];
        if (items.length === 0) {
          sendResponse({ ok: false, error: "선택된 카드가 없습니다" });
          return;
        }
        const list = await loadSkippedEntries();
        const byShortId = new Map(list.map((e) => [e.shortId, e]));
        let added = 0;
        for (const it of items) {
          const sid = (it.artifactId || "").slice(0, 8).toLowerCase();
          if (!/^[0-9a-f]{8}$/.test(sid)) continue;
          const date = extractDateStrict(it.coverDateAttr || "");
          byShortId.set(sid, {
            shortId: sid,
            filename: "",
            title: it.title || "",
            date,
            notebookTitle: it.notebookTitle || "",
            skippedAt: Date.now(),
          });
          added++;
        }
        await saveSkippedEntries(Array.from(byShortId.values()));
        sendResponse({ ok: true, added });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg?.type === "skip:remove") {
    (async () => {
      const removed = await removeSkippedShortId(msg.shortId);
      sendResponse({ ok: true, removed });
    })();
    return true;
  }
  if (msg?.type === "skip:clear") {
    (async () => {
      await chrome.storage.sync.set({ skippedShortIds: [] });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === "list:pushed") {
    // popup 의 bulk 모드에서 "이미 받은 카드" 를 default 미체크로 두기 위한 사전 점검.
    // ghList 가 실패해도 popup 흐름이 멈추면 안 되므로 빈 배열로 fallback.
    (async () => {
      try {
        const cfg = await cfgGet(["token", "repo"]);
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
  if (msg?.type === "storage:usage") {
    // 옵션 페이지의 진행 모니터에서 "현재 docs/episodes/ 사용량 vs retention 한도"
    // 를 표시. retention 이 한도 도달하면 옛 episode 자동 삭제 + 익스텐션 측에서
    // 2년 이전 카드 push 스킵 — 둘의 동작 명시로 사용자가 사고 흐름을 미리 인지.
    (async () => {
      try {
        const cfg = await cfgGet(["token", "repo", "bulkSkipOlderDays"]);
        if (!cfg.token || !cfg.repo) {
          sendResponse({ ok: false, error: "no-config" });
          return;
        }
        const list = await ghList(cfg.repo, "docs/episodes", cfg.token);
        const totalBytes = list.reduce((s, f) => s + (f.size || 0), 0);
        let maxTotalMB = null;
        try {
          const pj = await ghGet(cfg.repo, "docs/podcast.json", cfg.token);
          if (pj?.content) {
            // base64 → 문자열. JSON 파싱 안 하고 maxTotalMB 만 regex 로 추출 —
            // 한글 등 non-ASCII 가 들어가도 atob 단독은 latin-1 으로 깨지므로
            // Uint8Array 우회. 다만 숫자 필드 regex 는 ASCII 라 단순 atob 로 충분.
            const decoded = atob(pj.content.replace(/\s/g, ""));
            const m = /"maxTotalMB"\s*:\s*(\d+(?:\.\d+)?)/.exec(decoded);
            if (m) maxTotalMB = parseFloat(m[1]);
          }
        } catch (e) {
          console.warn("[storage:usage] podcast.json 조회 실패:", e.message);
        }
        const skipDays = await loadBulkSkipOlderDays();
        sendResponse({
          ok: true,
          fileCount: list.length,
          totalBytes,
          maxTotalMB,
          skipOlderDays: skipDays,
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
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
  const downloadId = item.id;
  pushEpisode(item.url, filename, dedupHints, meta.episodeTitle).then((result) => {
    notifyPush({ ok: true, episodeTitle: meta.episodeTitle, filename, downloadId, ...result });
    // push 성공 시 로컬 다운로드 자동 삭제 (옵션 ON 일 때).
    // ok=true 면 GitHub 에 파일 있음 → 로컬은 잉여. skipped=true (dedup hit) 도
    // 같은 의미 — 이미 GitHub 에 있으니 로컬도 안 둠. push 실패 (catch 분기) 만
    // 보존 — 사용자가 재시도 또는 수동 업로드할 수 있게.
    deleteLocalDownloadIfEnabled(downloadId).catch((e) => {
      console.warn("[localDelete]", e.message);
    });
  }).catch((err) => {
    console.error("[push]", filename, err);
    notifyPush({ ok: false, episodeTitle: meta.episodeTitle, filename, downloadId, error: err.message });
    // push 실패 시 로컬 파일 유지 — 사용자가 재시도하거나 수동 GitHub 업로드 가능.
  });
});

// chrome.downloads.removeFile + erase 로 디스크 + history 정리. download 가 아직
// in-progress 면 onChanged 로 complete 대기 후 처리. 옵션 OFF 면 no-op.
async function deleteLocalDownloadIfEnabled(downloadId) {
  if (!downloadId) return;
  const cfg = await cfgGet(["deleteLocalOnPushSuccess"]);
  // default ON — 사용자가 명시적으로 false 설정하지 않은 한 자동 삭제.
  if (cfg.deleteLocalOnPushSuccess === false) return;
  const doRemove = async () => {
    try { await chrome.downloads.removeFile(downloadId); } catch {}
    try { await chrome.downloads.erase({ id: downloadId }); } catch {}
  };
  try {
    const items = await chrome.downloads.search({ id: downloadId });
    const it = items?.[0];
    if (!it) return;
    if (it.state === "complete") {
      await doRemove();
      return;
    }
    // in_progress — onChanged 로 complete 대기. 5분 timeout 으로 안전 그물.
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        chrome.downloads.onChanged.removeListener(listener);
        clearTimeout(timer);
        doRemove();
      } else if (delta.state?.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        clearTimeout(timer);
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
    }, 5 * 60 * 1000);
  } catch (e) {
    console.warn("[localDelete] search 실패:", e.message);
  }
}

function notifyPush(detail) {
  chrome.runtime.sendMessage({ type: "push:result", ...detail }).catch(() => {
    // popup 이 닫혀 있으면 listener 없음 — 정상.
  });
  // bulk:remote 흐름이 같은 SW 안에서 push 결과를 await 할 수 있도록 로컬 dispatch.
  for (const fn of pushResultLocalListeners) {
    try { fn(detail); } catch {}
  }
  // 카드 종료 — 진행률 패널을 비워 UI 가 다음 카드 진행률에 자리를 내준다.
  // setTaskState 가 broadcast 도 같이 해줘서 옵션 페이지가 라이브 반영.
  if (currentTaskState.currentCardProgress?.episodeTitle === detail.episodeTitle) {
    setTaskState({ currentCardProgress: null });
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
    skipKind: detail.skipKind || "",
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

// Idle-watchdog 기반 대기. 카드가 활성 (progress 비콘이 들어오면) 동안엔 timeout 이
// 계속 reset → "정상 다운로드 중인데 fixed 10분 timeout 으로 끊김" 사고 회피.
// idleMs 동안 어떤 progress 도 안 오면 "stall" 로 판정. hardMs 는 마지노선 (무한
// 진행률 emit 으로 영영 안 끝나는 사고도 막아둠).
const pushProgressBeacons = new Set();
function waitPushResultLocalWithWatchdog(episodeTitle, idleMs, hardMs) {
  return new Promise((resolve) => {
    let done = false;
    let idleTimer = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        resolve({ timeout: true, reason: "idle", idleMs });
      }, idleMs);
    };
    const handler = (detail) => {
      if (done) return;
      if (detail.episodeTitle !== episodeTitle) return;
      done = true;
      cleanup();
      resolve(detail);
    };
    const beacon = (title) => {
      if (done) return;
      if (title !== episodeTitle) return;
      armIdle();
    };
    const cleanup = () => {
      pushResultLocalListeners.delete(handler);
      pushProgressBeacons.delete(beacon);
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };
    pushResultLocalListeners.add(handler);
    pushProgressBeacons.add(beacon);
    const hardTimer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ timeout: true, reason: "hard", hardMs });
    }, hardMs);
    armIdle();
  });
}

// 카드 단위 byte/stage 진행률. pushEpisode 안의 reportProgress() → 여기.
// (a) currentTaskState.currentCardProgress 갱신해 옵션 페이지 라이브 표시
// (b) watchdog 비콘 fire — 활성 카드의 idle 타이머 reset.
function emitCardProgress(episodeTitle, progress) {
  const detail = {
    episodeTitle,
    stage: progress.stage || "",
    bytes: progress.bytes || 0,
    totalBytes: progress.totalBytes || null,
    updatedAt: Date.now(),
  };
  // setTaskState 는 매번 storage 쓰기 + broadcast 라 byte-by-byte chunk 모두 통과시키면
  // 부담. offscreen 측은 이미 250ms throttle 이라 여긴 그대로 통과.
  setTaskState({ currentCardProgress: detail });
  for (const fn of pushProgressBeacons) {
    try { fn(episodeTitle); } catch {}
  }
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
// v0.4.37 부터 fixed timeout 대신 idle-watchdog 방식. offscreen fetch/encode 의 byte
// chunk 비콘 + SW ghGet/ghPut stage 비콘이 활성 카드의 idle 타이머를 reset 한다.
// PUSH_IDLE_TIMEOUT 동안 *어떤 progress 도* 안 오면 stall 로 판정 → 다음 카드.
// 정상 다운로드 (40분짜리 ~75MB, 100-200초 소요) 는 fetch chunk 가 250ms 마다
// 들어오므로 idle 에 안 걸림. PUSH_HARD_TIMEOUT 은 무한 progress emit 사고
// (예: lamejs 가 무한 루프) 대비 마지노선.
const PUSH_IDLE_TIMEOUT = 90000;     // 90s 동안 progress 0건 → stall
const PUSH_HARD_TIMEOUT = 900000;    // 15분 — 단일 카드 절대 최대치

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
  // 현재 카드의 byte-단위 진행률. offscreen fetch/encode chunk + ghPut stage 가
  // emitCardProgress() 로 갱신. stage: fetch-start | fetching | fetched | transcoding
  //  | transcoded | encoding | encoded | ghGet | uploading | uploaded.
  currentCardProgress: null,
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

// currentCardProgress 업데이트 (offscreen 250ms 비콘) 가 매번 storage.session.set 을
// 트리거하지 않도록 storage write 를 500ms debounce. 메모리 갱신 + broadcast 는 즉시.
// 상태 전환 (status/phase 변경 등) 은 debounce 없이 즉시 persist — SW 재시작 복구 보장.
let _stateFlushTimer = null;

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
  // broadcast 는 항상 즉시.
  chrome.runtime.sendMessage({ type: "task:state", state: currentTaskState }).catch(() => {});

  // currentCardProgress 만 변경하는 고빈도 호출은 storage write debounce.
  // 그 외 (status/phase/done 등 상태 전환) 는 즉시 persist.
  const keys = Object.keys(updates);
  const isProgressOnly = keys.length === 1 && keys[0] === "currentCardProgress";
  if (isProgressOnly) {
    if (_stateFlushTimer) clearTimeout(_stateFlushTimer);
    _stateFlushTimer = setTimeout(() => {
      _stateFlushTimer = null;
      chrome.storage.session.set({ currentTaskState }).catch(() =>
        chrome.storage.local.set({ currentTaskState }).catch(() => {}),
      );
    }, 500);
    return;
  }
  // 즉시 persist (pending debounce 가 있으면 먼저 취소 — 이 쓰기가 더 최신).
  if (_stateFlushTimer) { clearTimeout(_stateFlushTimer); _stateFlushTimer = null; }
  try { await chrome.storage.session.set({ currentTaskState }); }
  catch {
    try { await chrome.storage.local.set({ currentTaskState }); } catch {}
  }
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

// 노트북 슬러그 → URL 영구 맵 (chrome.storage.local). 옵션 페이지의 에피소드 목록에서
// [편집 ↗] 버튼이 매번 스캔 없이도 활성화되도록 — lastScanResult 가 session 기반
// (브라우저 재시작 시 증발) 인 것과 별개로 살아남는다. runScanAll / 단일 노트북 스캔
// 양쪽에서 누적 merge.
async function loadNotebookUrlMap() {
  try {
    const r = await chrome.storage.local.get(["notebookUrlMap"]);
    return r.notebookUrlMap || {};
  } catch { return {}; }
}

async function mergeNotebookUrlMap(entries) {
  // entries: [{ slug, url }, ...] — slug 빈 값은 무시. 같은 slug 가 다른 URL 로 오면
  // 새 값으로 overwrite (노트북 제목이 동일해 슬러그가 충돌하는 매우 드문 경우 — 마지막
  // 본 URL 이 가장 최신/유효한 가능성).
  if (!Array.isArray(entries) || entries.length === 0) return;
  try {
    const existing = await loadNotebookUrlMap();
    let changed = false;
    for (const e of entries) {
      if (!e?.slug || !e?.url) continue;
      if (existing[e.slug] !== e.url) {
        existing[e.slug] = e.url;
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ notebookUrlMap: existing });
  } catch {}
}

// 직전 bulk:remote 의 실패 카드들 (selection 객체) — 옵션 페이지의 [실패 N개 재시도]
// 가 같은 selections 로 다시 runBulkRemote 호출. SW 가 죽었다 살아나도 살아남도록
// session 우선, fallback 으로 local. 새 bulk 가 시작되면 비워진다.
async function persistFailedSelections(selections) {
  const data = { selections, savedAt: Date.now() };
  try { await chrome.storage.session.set({ bulkFailedSelections: data }); }
  catch {
    try { await chrome.storage.local.set({ bulkFailedSelections: data }); } catch {}
  }
}
async function loadFailedSelections() {
  try {
    const r = await chrome.storage.session.get(["bulkFailedSelections"]);
    if (r.bulkFailedSelections) return r.bulkFailedSelections;
  } catch {}
  try {
    const r = await chrome.storage.local.get(["bulkFailedSelections"]);
    return r.bulkFailedSelections || null;
  } catch { return null; }
}
async function clearFailedSelections() {
  try { await chrome.storage.session.remove(["bulkFailedSelections"]); } catch {}
  try { await chrome.storage.local.remove(["bulkFailedSelections"]); } catch {}
}

// chrome.notifications 는 옵션 페이지가 닫혀 있어도 OS 알림으로 사용자에게 알림.
// bulk 가 수십 분 돌 때 사용자가 다른 일 보다 끝났는지 알 수 있게.
// uiLang 을 읽어 한·영·독 알림 텍스트를 분기 (이전엔 항상 영어였던 버그 수정).
async function notifyBulkComplete(success, total) {
  const fail = total - success;
  let lang = "ko";
  try {
    const cfg = await cfgGet(["uiLang"]);
    if (cfg.uiLang) lang = cfg.uiLang;
  } catch {}

  let title, msg;
  if (lang === "en") {
    title = fail > 0
      ? `Podcast Sync — ${success} ok, ${fail} failed`
      : `Podcast Sync — ${success} pushed`;
    msg = fail > 0
      ? `Open the admin page to retry the ${fail} failed cards.`
      : `All ${total} cards pushed to your repo.`;
  } else if (lang === "de") {
    title = fail > 0
      ? `Podcast Sync — ${success} ok, ${fail} fehlgeschlagen`
      : `Podcast Sync — ${success} hochgeladen`;
    msg = fail > 0
      ? `Adminseite öffnen, um ${fail} fehlgeschlagene Karten zu wiederholen.`
      : `Alle ${total} Karten wurden ins Repo hochgeladen.`;
  } else {
    // 한국어 (default)
    title = fail > 0
      ? `Podcast Sync — ${success} 완료, ${fail} 실패`
      : `Podcast Sync — ${success}개 푸시 완료`;
    msg = fail > 0
      ? `관리 페이지에서 실패한 ${fail}개를 재시도할 수 있습니다.`
      : `총 ${total}개 카드를 모두 레포에 올렸습니다.`;
  }
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message: msg,
      priority: 1,
    }, () => { void chrome.runtime.lastError; });
  } catch {}
}

// docs/episodes/ 한 번 list 해서 두 dedup 키를 동시에 만든다:
//  - shortIds: 4-segment 파일의 shortId (UUID 첫 8자) 집합
//  - legacyKeys: 3-segment (옛 v0.4.0 미만) 파일의 `${date}|${titleSlug}|${ext}` 집합
// pushEpisode 의 dedup hint (1차 shortId, 2차 legacy date+title) 와 동일한 두 경로를
// "신규 카드 판정" 쪽에서도 쓰기 위함. 한쪽만 쓰면 옛 포맷 파일이 영구 신규로 잡혀
// 매번 같은 카드를 다시 다운로드.
async function loadPushedIndex(repo, token) {
  const shortIds = new Set();
  const legacyKeys = new Set();
  // 4-segment 파일도 (date, titleSlug, ext) 키로 한 번 더 인덱싱. artifact-labels DOM
  // 이 늦게 렌더되어 scan 결과의 audio.artifactId 가 빈 문자열로 들어오는 race 가 있는데,
  // 그 케이스에선 shortId 매칭이 무조건 미스 → 이미 받은 카드도 "신규" 로 잡혀 반복
  // 다운로드. 같은 (date, titleSlug, ext) 보조 키로 fallback 매칭하면 회복됨.
  const titleKeys = new Set();
  try {
    const list = await ghList(repo, "docs/episodes", token);
    for (const f of list) {
      const m = LEGACY_DEDUP_RE.exec(f.name);
      if (!m) continue;
      const [, date, fShortId, fTitle, fExt] = m;
      const key = `${date}|${fTitle}|${fExt.toLowerCase()}`;
      if (fShortId) {
        shortIds.add(fShortId);
        titleKeys.add(key);
      } else {
        legacyKeys.add(key);
      }
    }
  } catch (e) {
    console.warn("[loadPushedIndex] ghList 실패:", e.message);
  }
  return { shortIds, legacyKeys, titleKeys };
}

// extractDate 의 strict 변형 — 못 파싱하면 null. legacy 매칭은 정확한 날짜가 있어야만
// 의미 있어서 "오늘 날짜 fallback" (extractDate 의 default) 을 쓰면 안 됨.
function extractDateStrict(coverDateAttr) {
  const m = DATE_RE.exec(coverDateAttr || "");
  if (m && MONTHS[m[1]]) {
    return m[3] + String(MONTHS[m[1]]).padStart(2, "0") + m[2].padStart(2, "0");
  }
  return null;
}

// cover-subtitle-date 기준 노트북 생성일이 skipDays 보다 옛것이면 true. skipDays 0 이면
// cutoff 안 함. dateAttr 파싱 실패 시 false (안전쪽 — 모르면 일단 push 시도).
function isNotebookTooOld(coverDateAttr, skipDays) {
  if (!skipDays || skipDays <= 0) return false;
  const ymd = extractDateStrict(coverDateAttr);
  if (!ymd) return false;
  const ms = Date.UTC(
    parseInt(ymd.slice(0, 4), 10),
    parseInt(ymd.slice(4, 6), 10) - 1,
    parseInt(ymd.slice(6, 8), 10),
  );
  const ageDays = (Date.now() - ms) / (24 * 60 * 60 * 1000);
  return ageDays > skipDays;
}

async function loadBulkSkipOlderDays() {
  const cfg = await cfgGet(["bulkSkipOlderDays"]);
  const raw = cfg.bulkSkipOlderDays;
  if (raw === "" || raw === null || raw === undefined) return DEFAULT_BULK_SKIP_OLDER_DAYS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BULK_SKIP_OLDER_DAYS;
}

// 영구 스킵 목록 — 사용자가 에피소드 목록에서 명시적으로 영구 제외한 음성개요.
// retention 으로 한 번 잘리면 dedup 출처 (docs/episodes/) 에서 사라져 영구 루프
// 가 생기는데, 사용자가 "이 카드는 다시 받지 않겠다" 라고 명시한 건 이 목록으로
// 항구적으로 기억. chrome.storage.sync 의 `skippedShortIds`. 다기기 공유.
//
// 데이터 형태: Array<{shortId, filename, title, date, notebookTitle, skippedAt}>.
// 옛 v0.4.32 에선 string array (shortId 만) — 로딩 시 자동 마이그레이션.
// 메타는 옵션 페이지의 스킵 목록 패널에서 어떤 파일이었는지 보여주기 위함.
// quota: entry 평균 ~250byte × 400건 = 100KB 한도. 일반 사용자 범위 (수십~수백)
// 에선 여유. 한계 도달 시 가장 옛것부터 자르는 fallback 으로 안전.
async function loadSkippedEntries() {
  const out = await chrome.storage.sync.get(["skippedShortIds"]).catch(() => ({}));
  const raw = Array.isArray(out.skippedShortIds) ? out.skippedShortIds : [];
  // 마이그레이션: 옛 string array → object array. shortId 만 있고 메타는 빈 string.
  return raw.map((x) => typeof x === "string"
    ? { shortId: x, filename: "", title: "", date: "", notebookTitle: "", skippedAt: 0 }
    : x).filter((e) => e && e.shortId);
}

// 스킵 목록을 두 키로 인덱싱 — shortId (1차) + (date, titleSlug) (2차, race 폴백).
// shortId 만 보면 `audio.artifactId` 가 lazy render 로 빈 채 들어오는 race 에서 스킵
// 카드가 다시 신규로 잡혀 다운로드 시도 → 실패 → "실패 N개 보존" 으로 누적. 사용자가
// 스킵한 카드를 다른 기기에서 또 받으려고 하는 사고.
//
// entry.title 은 호출자별로 spaces 또는 dashes 가 섞임 (옵션 페이지 [삭제] 는 displayed
// title 그대로 = spaces, storage:cleanup 은 filename 에서 추출 = dashes). slugify 로
// canonicalize 해서 audio.title 의 슬러그와 직접 비교.
async function loadSkippedIndex() {
  const list = await loadSkippedEntries();
  const shortIds = new Set();
  const titleKeys = new Set();
  for (const e of list) {
    if (e.shortId) shortIds.add(e.shortId);
    if (e.date && e.title) {
      titleKeys.add(`${e.date}|${slugify(e.title)}`);
    }
  }
  return { shortIds, titleKeys };
}

// 카드 하나가 스킵 목록에 들어 있는지 — 두 경로:
//   (1) shortId (artifactId 첫 8자) 일치.
//   (2) artifactId 가 빈 race 케이스 폴백: cover-subtitle-date + slugify(title) 일치.
// isAudioPushed 와 같은 패턴 — push dedup 도 이미 두 경로를 쓴다.
function isAudioSkipped(audio, coverDateAttr, skipIndex) {
  const sid = (audio.artifactId || "").slice(0, 8);
  if (sid && skipIndex.shortIds.has(sid)) return true;
  const date = extractDateStrict(coverDateAttr);
  const titleSlug = audio.title ? slugify(audio.title) : "";
  if (date && titleSlug && skipIndex.titleKeys.has(`${date}|${titleSlug}`)) return true;
  return false;
}

async function saveSkippedEntries(entries) {
  try {
    await chrome.storage.sync.set({ skippedShortIds: entries });
  } catch (e) {
    // quota 초과 — 20% 잘라내고 재시도. entry 1건 ≈ 250byte, sync item 한도 8KB 이므로
    // entries.length > 100 조건은 충분하지 않음 (소수 건도 quota 초과 가능). 건수 무관하게
    // 항상 80% 로 줄인 뒤 재시도 (최소 1건은 보존).
    const trimCount = Math.max(1, Math.ceil(entries.length * 0.2));
    const trimmed = entries.slice(trimCount);
    console.warn(`[skip] sync quota 초과, 가장 옛것 ${trimCount}건 컷 (${entries.length} → ${trimmed.length})`, e);
    await chrome.storage.sync.set({ skippedShortIds: trimmed });
  }
}

async function addSkippedEntry(meta) {
  if (!meta?.shortId) return;
  const list = await loadSkippedEntries();
  const idx = list.findIndex((e) => e.shortId === meta.shortId);
  const entry = {
    shortId: meta.shortId,
    filename: meta.filename || "",
    title: meta.title || "",
    date: meta.date || "",
    notebookTitle: meta.notebookTitle || "",
    skippedAt: Date.now(),
  };
  if (idx >= 0) list[idx] = entry; else list.push(entry);
  await saveSkippedEntries(list);
}

async function removeSkippedShortId(sid) {
  const list = await loadSkippedEntries();
  const next = list.filter((e) => e.shortId !== sid);
  if (next.length === list.length) return false;
  await saveSkippedEntries(next);
  return true;
}

// 파일명에서 shortId 추출. 4-segment 파일만 매칭, 3-segment 옛 파일은 null.
function extractShortIdFromFilename(name) {
  const m = /__([0-9a-f]{8})__/.exec(name || "");
  return m ? m[1] : null;
}

// 카드 하나가 이미 repo 에 push 됐는지. shortId (1차) → legacy date+titleSlug (2차) →
// 4-segment 파일의 titleSlug fallback (3차, artifactId 가 빈 채 들어오는 race 회복용).
// transcode 결과는 보통 .mp3 지만 raw m4a fallback 도 있어 세 ext 모두 본다.
function isAudioPushed(audio, coverDateAttr, pushedIndex) {
  const sid = (audio.artifactId || "").slice(0, 8);
  if (sid && pushedIndex.shortIds.has(sid)) return true;
  const date = extractDateStrict(coverDateAttr);
  const titleSlug = audio.title ? slugify(audio.title) : "";
  if (date && titleSlug) {
    for (const ext of ["mp3", "m4a", "mp4"]) {
      const key = `${date}|${titleSlug}|${ext}`;
      if (pushedIndex.legacyKeys.has(key)) return true;
      if (pushedIndex.titleKeys.has(key)) return true;
    }
  }
  return false;
}

// 노트북 array 와 ghList 결과로부터 "아직 repo 에 없는" 카드들의 selections 를 만든다.
// auto-download 와 관리 페이지의 [신규 받기] 양쪽이 공유.
async function buildNewSelections(notebooks, repo, token) {
  const pushedIndex = await loadPushedIndex(repo, token);
  const skipDays = await loadBulkSkipOlderDays();
  const skipIndex = await loadSkippedIndex();
  const selections = [];
  for (const nb of notebooks) {
    const coverDateAttr = nb.cover?.dateAttr || "";
    // skipDays 보다 옛 노트북은 통째로 스킵. retention 정책이 옛것 자르는 것과
    // 같은 기준을 익스텐션 측에 둬서 영구 루프 사고를 처음부터 회피.
    if (isNotebookTooOld(coverDateAttr, skipDays)) continue;
    (nb.audios || []).forEach((audio, idx) => {
      if (audio.isPlaceholder) return;
      if (isAudioPushed(audio, coverDateAttr, pushedIndex)) return;
      // 사용자가 에피소드 목록에서 명시 삭제한 카드는 영구 스킵 — shortId (1차) +
      // (date, titleSlug) (2차, race 폴백) 두 경로로 매칭.
      if (isAudioSkipped(audio, coverDateAttr, skipIndex)) return;
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
//
// v0.4.37 부턴 bulkWindow 를 사용자에게 방해 없이 처리.
//
// 핵심 조건:
//   (A) popup window 안 tab 이 active=true 여야 visibilityState='visible' → download 트리거 정상.
//   (B) focused:false 면 메인 윈도우 포커스를 빼앗지 않음 — tabs.create(active:true) 도
//       그 창 안에서만 active 가 바뀔 뿐, 전역 focus 는 메인 윈도우 그대로.
//
// 좌표 변천:
//   v0.4.37  (-32000, -32000) — 화면 완전 밖. Chrome 이 clamp 하거나 그냥 통과했음.
//   v0.4.41  Chrome 업데이트 → "Bounds must be at least 50% within visible screen space"
//            에러로 창 생성 자체 실패, 모든 다운로드 실패.
//   v0.4.42a state:"minimized" 시도 → minimized 창에 tabs.create(active:true) 를 넣으면
//            Chrome 이 창을 자동 복원(un-minimize) → 사용자 화면에 팝업이 튀어 오름.
//            또한 minimized 창의 visibilityState='hidden' 이라 download 트리거도 불안정.
//   v0.4.42b (현재) 화면 왼쪽 가장자리에 걸쳐 50% 조건만 충족하는 좌표 사용.
//            Chrome bounds 검사 통과 + focused:false 로 포커스 비침 없음 + 화면 전환 없음.
//            창 오른쪽 절반(400px) 이 화면 왼쪽 테두리 밖으로 숨겨짐 — 사용자에게 최소 노출.
//
// BULK_WINDOW_OPTS: left=-399 → 화면 안 visible 폭 401px (800의 50.1%) — 50% 규칙 통과.
// 높이는 0부터 시작해 전부 on-screen. 실제 NotebookLM UI 렌더 영역은 화면 안쪽 401px.
const BULK_WINDOW_OPTS = { left: -399, top: 0, width: 800, height: 600 };

let bulkWindowId = null;
// bulk window 안에서 노트북 간 재사용되는 단일 탭의 ID. 매 노트북마다 chrome.tabs.create
// 를 호출하면 Windows OS 가 SetForegroundWindow 로 popup 을 foreground 로 raise 시킴
// (focused:false 가 honor 되지 않는 거동, v0.4.43 시점 Chrome 에서 확인). 대신 단일 탭을
// chrome.tabs.update 로 navigate 만 하면 raise 트리거 자체가 없음.
let bulkTabId = null;
// debugger 는 탭 단위로 attach. 탭이 재사용되니 attach 도 세션당 1회.
let bulkDebuggerAttached = false;

// bulk window + 그 안의 단일 탭을 보장하고 `url` 로 navigate. 탭 ID 반환.
//
// 설계 의도 — 매 노트북마다 chrome.tabs.create 를 호출하지 않는다:
//   v0.4.43 시점 Chrome 에선 chrome.windows.create({focused:false}) 가 Windows OS 에서
//   honor 되지 않아 popup 이 foreground 로 raise 됨. tabs.create({active:true}) 도
//   동일한 raise 를 트리거. chrome.windows.update({focused:true}) 로 복원해도 Windows
//   SetForegroundWindow 제한 정책에 막혀 무시되거나 taskbar flash 만 발생.
//
// 회피: 노트북 1 에서 windows.create 가 popup + 첫 탭을 한 번에 만든다 (1회 raise 발생
// 가능성 있음). 노트북 2+ 에서는 같은 탭을 chrome.tabs.update(tabId, {url}) 로 navigate
// — tabs.create 호출이 없으니 raise 도 안 일어남. debugger.attach 도 1회만 → 디버그
// 배너 raise 도 1회만. 화면 전환 빈도가 세션당 최대 1회로 감소.
async function ensureBulkTab(url) {
  if (bulkWindowId !== null) {
    try { await chrome.windows.get(bulkWindowId); }
    catch (e) {
      console.log(`[bulkTab] window stale id=${bulkWindowId}: ${e.message}`);
      bulkWindowId = null;
      bulkTabId = null;
      bulkDebuggerAttached = false;
    }
  }
  if (bulkTabId !== null) {
    try { await chrome.tabs.get(bulkTabId); }
    catch {
      bulkTabId = null;
      bulkDebuggerAttached = false;
    }
  }

  if (bulkTabId !== null) {
    console.log(`[bulkTab] reusing tab=${bulkTabId}, navigating to ${url.slice(0, 60)}…`);
    await withTabRetry(() => chrome.tabs.update(bulkTabId, { url }), "tabs.update");
    return bulkTabId;
  }

  // 첫 호출 — windows.create 에 url 을 함께 넘겨서 popup + 첫 탭을 한 번에. 분리된
  // tabs.create 가 없어 raise 트리거가 발생할 여지가 가장 적은 형태.
  console.log(`[bulkTab] creating bulk window with initial url=${url.slice(0, 60)}…`);
  const win = await withTabRetry(
    () => chrome.windows.create({
      url,
      type: "popup",
      focused: false,
      ...BULK_WINDOW_OPTS,
    }),
    "windows.create",
  );
  bulkWindowId = win.id;
  bulkTabId = win.tabs?.[0]?.id ?? null;
  console.log(`[bulkTab] created window=${win.id} tab=${bulkTabId} state=${win.state} focused=${win.focused}`);
  if (bulkTabId === null) {
    throw new Error("bulk window 생성 직후 tabs[0] 없음 — 비정상 상태");
  }
  return bulkTabId;
}

async function closeBulkWindow() {
  if (bulkWindowId === null) return;
  const winId = bulkWindowId;
  const tabId = bulkTabId;
  bulkWindowId = null;
  bulkTabId = null;
  const wasAttached = bulkDebuggerAttached;
  bulkDebuggerAttached = false;
  if (tabId !== null) ownedTabs.delete(tabId);
  if (tabId !== null && wasAttached) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
  }
  try { await chrome.windows.remove(winId); } catch {}
}

async function openManagedTab(url, opts = {}) {
  // bulk:remote 는 opts.bulkWindow=true 로 전용 popup window 사용 — NotebookLM 이
  // background tab 의 download 트리거 거부 + programmatic click 도 거부 (isTrusted/
  // userActivation). 둘 다 우회하려면 popup window + chrome.debugger 가 필요.
  const inBulkWindow = !!opts.bulkWindow;
  let tabId;
  if (inBulkWindow) {
    // 단일 탭 재사용 — ensureBulkTab 이 첫 호출엔 window+tab 생성, 이후 호출엔
    // chrome.tabs.update 로 navigate (tabs.create 호출 없음 → 윈도우 raise 없음).
    tabId = await ensureBulkTab(url);
    ownedTabs.add(tabId);
  } else {
    const tab = await withTabRetry(() => chrome.tabs.create({ url, active: false }), "create");
    tabId = tab.id;
    ownedTabs.add(tabId);
  }
  await waitForTabComplete(tabId, TAB_OPEN_TIMEOUT);
  if (inBulkWindow && !bulkDebuggerAttached) {
    // chrome.debugger.attach — Input.dispatchMouseEvent 로 trusted user input 주입.
    // 탭 재사용 덕분에 세션당 1회만 호출 — 디버그 배너 raise 도 1회로 한정.
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      bulkDebuggerAttached = true;
    } catch (e) {
      if (/already attached/i.test(e.message)) {
        bulkDebuggerAttached = true;
      } else {
        console.warn(`[debugger] attach 실패 tab=${tabId}: ${e.message}`);
        // attach 실패해도 일단 진행 — clickViaDebugger 가 throw 하면 그 카드만 fail
      }
    }
  }
  const ready = await waitForContentReady(tabId, CONTENT_PING_TIMEOUT);
  if (!ready) {
    let finalUrl = "";
    try { finalUrl = (await chrome.tabs.get(tabId))?.url || ""; } catch {}
    if (finalUrl.includes("accounts.google.com") || finalUrl.includes("ServiceLogin")) {
      throw new Error("NotebookLM 에 로그인되어 있지 않습니다. 브라우저에서 먼저 로그인 후 재시도하세요.");
    }
    if (!finalUrl.startsWith("https://notebooklm.google.com")) {
      throw new Error(`NotebookLM 페이지로 이동되지 않음 (final=${finalUrl.slice(0, 80)}). 네트워크 / 로그인 상태 확인.`);
    }
    throw new Error("NotebookLM 페이지에서 content script 로딩 실패 (timeout). 페이지 새로고침 후 재시도.");
  }
  return tabId;
}

async function closeManagedTab(tabId) {
  // bulk 탭은 노트북 간 재사용 — 매 노트북 끝마다 닫지 않고 closeBulkWindow 시점까지 유지.
  if (tabId === bulkTabId) return;
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
// transcode 도 안전. 메시지는 URL 만 보내고 offscreen 이 fetch + (option) transcode + b64.
// b64 변환을 offscreen 안에서 끝내 SW thread 의 동기 String.fromCharCode 루프를 제거
// — 큰 카드 (40MB) 에서 popup/options UI 가 1-2초씩 freeze 되던 현상 해소.
async function fetchEncodeViaOffscreen(audioUrl, opts = {}) {
  // opts: { transcode: bool, bitrate, mono, onProgress({stage, bytes, totalBytes, elapsedMs}) }
  // 반환: { b64, size, sourceSize } — b64 는 ghPut body 에 그대로 들어갈 수 있는 string.
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "transcode" });
    let settled = false;
    port.onMessage.addListener((msg) => {
      if (settled) return;
      // progress 비콘 — settled 안 되고 onProgress 만 호출 + 계속 대기.
      if (msg?.progress) {
        try { opts.onProgress?.(msg); } catch {}
        return;
      }
      settled = true;
      try { port.disconnect(); } catch {}
      if (msg?.ok) resolve({ b64: msg.b64, size: msg.size, sourceSize: msg.sourceSize });
      else reject(new Error(msg?.error || "fetch+encode 실패"));
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      const err = chrome.runtime.lastError?.message || "transcode 채널 비정상 종료";
      reject(new Error(err));
    });
    port.postMessage({
      type: opts.transcode ? "transcode" : "fetch",
      audioUrl,
      bitrate: opts.bitrate || 64,
      mono: opts.mono !== false,
    });
  });
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
  // 반환: [{url, modifiedHint}, ...] — modifiedHint 는 content.js 가 카드 DOM 의
  // 안정 시그널 (time[datetime] / [title] 절대 시간 / [aria-label] 숫자 패턴) 로 생성한
  // "구조적 지문". 노트북 변경 시 hint 도 변경 → per-notebook 캐시 무효화 키.
  const tabId = await openManagedTab("https://notebooklm.google.com/");
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "scan:list" });
    if (Array.isArray(r?.notebooks) && r.notebooks.length > 0) return r.notebooks;
    // 옛 응답 호환 (urls 만 반환하는 옛 content.js 시점). hint 없음 → 캐시 안 탐.
    if (Array.isArray(r?.urls)) return r.urls.map((url) => ({ url, modifiedHint: null }));
    return [];
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

// (c) 직전 scan:all 결과의 session-level 캐시 TTL. 이 안에 들어오면 풀 스캔 안 하고
// 캐시 그대로 재사용 (popup 재오픈 / auto-download 후 사용자가 반복 클릭 흐름).
// 더 짧으면 cache hit 률 낮고, 더 길면 사용자가 NotebookLM 에서 새 음성개요 만들었는데
// 캐시가 안 깨져 놓치는 위험. 30분이 양쪽 trade-off 의 sweet spot.
const SCAN_CACHE_TTL_MS = 30 * 60 * 1000;

// (a) 노트북 단위 캐시 TTL. 같은 url 의 modifiedHint 가 변하지 않았고 이 시간 안에
// 한 번 스캔된 적 있으면 탭 열기 자체를 스킵. (c) 가 만료된 뒤에도 노트북별로는 더 길게
// 유효 — 사용자가 어제 받은 노트북은 오늘 다시 안 열어도 됨. modifiedHint 가 정확히
// 동작하면 4h 무관하게 새 음성개요 추가 시 hint 변경 → 자동 풀 스캔. hint 추출 실패
// (selector 못 찾음) 면 hint=null 이라 캐시 자체 동작 안 함 → 매번 풀 스캔 (안전).
const PER_NOTEBOOK_TTL_MS = 4 * 60 * 60 * 1000;

async function runScanAll(opts = {}) {
  // (c) Recent-scan auto-reuse — TTL 안의 캐시가 있으면 풀 스캔 단락. 사용자가
  // [모든 노트북 스캔] 을 짧은 간격으로 여러 번 누르는 시나리오 (예: autoDownload 직후
  // 결과 확인) 의 체감 시간을 거의 0 으로. force:true 면 우회.
  if (!opts.force) {
    const cached = await loadLastScanResult();
    if (cached?.notebooks?.length && cached.scannedAt) {
      const ageMs = Date.now() - cached.scannedAt;
      if (ageMs < SCAN_CACHE_TTL_MS) {
        const cardCount = cached.notebooks.reduce(
          (s, nb) => s + (nb.audios?.length || 0), 0,
        );
        const ageMin = Math.round(ageMs / 60000);
        const ageLabel = ageMin < 1
          ? `${Math.round(ageMs / 1000)}초 전`
          : `${ageMin}분 전`;
        console.log(`[scan:all] cache hit (${ageLabel}) — ${cached.notebooks.length}개 노트북 재사용`);
        await setTaskState({
          ...INITIAL_TASK_STATE,
          task: "scan:all", status: "completed", phase: "done",
          total: cached.notebooks.length, done: cached.notebooks.length,
          notebookCount: cached.notebooks.length, cardCount,
          message: `직전 스캔 결과 재사용 (${ageLabel}, 노트북 ${cached.notebooks.length}개, 카드 ${cardCount}개)`,
          startedAt: Date.now(), endedAt: Date.now(),
        });
        emitEvent("scan:all:done", {
          ok: true, notebooks: cached.notebooks,
          cacheUsed: true, cacheAgeMs: ageMs,
        });
        // 캐시 단락 후에도 auto-download 는 정상 동작 — 사용자 흐름 유지.
        try {
          const cfg = await cfgGet(["autoDownloadNew", "token", "repo"]);
          if (cfg.autoDownloadNew && cfg.token && cfg.repo) {
            const selections = await buildNewSelections(cached.notebooks, cfg.repo, cfg.token);
            if (selections.length > 0) {
              console.log(`[scan:all] cache hit + auto-download: ${selections.length} 카드 시작`);
              await runBulkRemote(selections);
            }
          }
        } catch (e) {
          console.error("[scan:all] cache hit auto-download 실패:", e);
        }
        return { notebooks: cached.notebooks, cacheUsed: true };
      }
    }
  }

  await startKeepalive();
  await setTaskState({
    ...INITIAL_TASK_STATE,
    task: "scan:all", status: "running", phase: "list",
    message: "노트북 목록 수집 중…",
    startedAt: Date.now(), endedAt: null,
  });
  emitEvent("scan:all:progress", { phase: "list", message: "노트북 목록 수집 중…" });

  const homeEntries = await scanHomePageForNotebookUrls();
  await setTaskState({ phase: "list:done", total: homeEntries.length, message: `노트북 ${homeEntries.length}개 발견. 스캔 시작…` });
  emitEvent("scan:all:progress", { phase: "list:done", total: homeEntries.length });

  // (a) per-notebook 캐시 준비 — 직전 lastScanResult 의 notebooks 를 URL 키로 인덱싱.
  // 같은 URL + 같은 modifiedHint + PER_NOTEBOOK_TTL_MS 이내면 풀 스캔 스킵 + 옛 audios
  // 그대로 사용. force:true 면 우회. hint 가 null 인 노트북은 매번 풀 스캔 (안전 fallback).
  const prevScan = await loadLastScanResult();
  const cachedByUrl = new Map();
  if (prevScan?.notebooks && !opts.force) {
    for (const nb of prevScan.notebooks) {
      if (nb.url) cachedByUrl.set(nb.url, nb);
    }
  }
  const nowMs = Date.now();
  let cacheHits = 0;

  const notebooks = [];
  let cardCount = 0;
  // 같은 transient tab error 가 연속으로 발생하면 더 이상 retry 가 의미 없음 —
  // 일정 횟수 넘으면 abort 해서 사용자에게 명확한 안내.
  const MAX_CONSEC_TAB_ERRORS = 5;
  let consecTabErrors = 0;
  for (let i = 0; i < homeEntries.length; i++) {
    if (cancelRequested) {
      await setTaskState({
        status: "failed", phase: "cancelled",
        message: `사용자 중단 — 노트북 ${i}/${homeEntries.length} 까지 완료`,
        endedAt: Date.now(),
      });
      return { notebooks };
    }
    const entry = homeEntries[i];
    const prev = cachedByUrl.get(entry.url);
    const canReuse = !opts.force
      && prev
      && entry.modifiedHint != null
      && prev.modifiedHint === entry.modifiedHint
      && typeof prev.scannedAt === "number"
      && (nowMs - prev.scannedAt) < PER_NOTEBOOK_TTL_MS
      && Array.isArray(prev.audios);
    if (canReuse) {
      notebooks.push({
        url: entry.url,
        cover: prev.cover || { title: "", dateAttr: "" },
        audios: prev.audios,
        modifiedHint: entry.modifiedHint,
        scannedAt: prev.scannedAt,
        cacheReused: true,
      });
      cardCount += (prev.audios || []).length;
      cacheHits++;
      await setTaskState({
        phase: "scan", done: i + 1,
        message: `노트북 ${i + 1}/${homeEntries.length} 캐시 재사용`,
      });
      // breather 도 줄임 — 탭 안 여니까 transient lock 위험 없음.
      continue;
    }
    await setTaskState({
      phase: "scan", done: i,
      message: `노트북 ${i + 1}/${homeEntries.length} 스캔 중…`,
    });
    emitEvent("scan:all:progress", {
      phase: "scan", done: i, total: homeEntries.length,
      message: `노트북 ${i + 1}/${homeEntries.length} 스캔 중…`,
    });
    try {
      const r = await scanOneNotebook(entry.url);
      // 캐시 키 (modifiedHint, scannedAt) 함께 저장 — 다음 scan:all 에서 재사용 가능하게.
      notebooks.push({
        ...r,
        modifiedHint: entry.modifiedHint || null,
        scannedAt: nowMs,
      });
      cardCount += (r.audios || []).length;
      consecTabErrors = 0;
    } catch (e) {
      console.warn(`[scan:all] ${entry.url} 실패:`, e.message);
      notebooks.push({
        url: entry.url, cover: { title: "" }, audios: [],
        modifiedHint: entry.modifiedHint || null,
        scannedAt: nowMs,
        error: e.message,
      });
      await pushTaskError({ url: entry.url, message: e.message });
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

  if (cacheHits > 0) {
    console.log(`[scan:all] per-notebook cache: ${cacheHits}/${homeEntries.length} 재사용 (탭 ${cacheHits}회 안 열어 시간 절약)`);
  }

  await persistLastScanResult(notebooks);
  // 영구 슬러그→URL 맵에 누적 — lastScanResult 가 session storage 라 브라우저 재시작
  // 시 사라져도 [편집 ↗] 바로가기는 살아남도록. cover.title 이 비어 있으면 slugify 가
  // "episode" 로 fallback 하므로 그 항목은 제외.
  await mergeNotebookUrlMap(
    notebooks
      .filter((nb) => nb.cover?.title && nb.url)
      .map((nb) => ({ slug: slugify(nb.cover.title), url: nb.url })),
  );
  const cacheNote = cacheHits > 0 ? ` (캐시 재사용 ${cacheHits}개)` : "";
  await setTaskState({
    status: "completed", phase: "done",
    done: homeEntries.length,
    notebookCount: homeEntries.length, cardCount,
    message: `스캔 완료 — 노트북 ${homeEntries.length}개, 카드 ${cardCount}개${cacheNote}`,
    endedAt: Date.now(),
  });
  emitEvent("scan:all:done", { ok: true, notebooks, cacheHits });

  // 옵션의 autoDownloadNew 가 켜져 있으면 신규 카드들을 같은 SW 안에서 이어서
  // 다운로드. 직접 runBulkRemote 호출 — message 라우팅 우회. inProgressTask 는
  // 이미 "scan:all" 이라 외부 message 는 거부되지만, 우리가 호출한 건 통과.
  // task state 는 runBulkRemote 안에서 자동으로 "bulk:remote" 로 전환됨.
  try {
    const cfg = await cfgGet(["autoDownloadNew", "token", "repo"]);
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
  // 새 bulk 시작 — 직전의 failed 리스트는 더 이상 의미 없음.
  await clearFailedSelections();


  let done = 0;
  let success = 0;
  // 실패한 selection 을 [실패 N개 재시도] 용으로 모은다. push 응답 timeout / debugger
  // click 실패 / 카드 prepare 실패 / 탭 열기 실패 모두 retry 후보.
  const failedSelections = [];
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
      // 전용 popup window 안에서 active tab 으로 띄움.
      tabId = await openManagedTab(url, { bulkWindow: true });
      consecTabErrors = 0;
      const ready = await waitForAudioCards(tabId, NOTEBOOK_CARDS_TIMEOUT);
      if (!ready) {
        for (const item of items) {
          emitEvent("bulk:remote:result", {
            episodeTitle: item.episodeTitle, ok: false, error: "카드 로딩 타임아웃",
          });
          await pushTaskError({ episodeTitle: item.episodeTitle, message: "카드 로딩 타임아웃" });
          failedSelections.push(item);
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
        failedSelections.push(item);
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
            failedSelections.push(item);
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
            failedSelections.push(item);
            done++;
            continue;
          }
          const result = await waitPushResultLocalWithWatchdog(
            item.episodeTitle, PUSH_IDLE_TIMEOUT, PUSH_HARD_TIMEOUT,
          );
          if (result.timeout) {
            const reasonMsg = result.reason === "idle"
              ? `진행률 ${Math.round(PUSH_IDLE_TIMEOUT / 1000)}s 동안 정지 (stall)`
              : `최대 ${Math.round(PUSH_HARD_TIMEOUT / 1000)}s 한도 초과`;
            emitEvent("bulk:remote:result", {
              episodeTitle: item.episodeTitle, ok: false, error: `push 타임아웃 (${reasonMsg})`,
            });
            await pushTaskError({ episodeTitle: item.episodeTitle, message: `push 타임아웃 (${reasonMsg})` });
            failedSelections.push(item);
          } else if (result.ok || result.skipped) {
            success++;
          } else if (result.error) {
            await pushTaskError({ episodeTitle: item.episodeTitle, message: result.error });
            failedSelections.push(item);
          }
          done++;
        } catch (e) {
          emitEvent("bulk:remote:result", {
            episodeTitle: item.episodeTitle, ok: false, error: e.message,
          });
          await pushTaskError({ episodeTitle: item.episodeTitle, message: e.message });
          failedSelections.push(item);
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
  if (failedSelections.length > 0) {
    await persistFailedSelections(failedSelections);
  } else {
    await clearFailedSelections();
  }
  await notifyBulkComplete(success, done);
  emitEvent("bulk:remote:done", { ok: true, done });
  return { ok: true, done };
}

async function pushEpisode(audioUrl, filename, dedupHints, episodeTitle) {
  const cfg = await cfgGet([
    "token", "repo", "rssMode", "committerName", "committerEmail",
  ]);
  if (!cfg.token || !cfg.repo) {
    return { skipped: true, skipKind: "no-config", reason: "GitHub 설정 없음" };
  }
  // 카드 단위 byte 진행률 이벤트 — offscreen 의 fetch/encode chunk 에서 비콘이 들어오고
  // SW 의 ghGet/ghPut stage 도 같은 채널로 흘려보냄. setTaskState 에 currentCardProgress
  // 를 한 군데로 모아 옵션 페이지가 라이브 표시, runBulkRemote 의 watchdog 가 idle 감지.
  const reportProgress = (stage, bytes, totalBytes) => {
    if (!episodeTitle) return;
    emitCardProgress(episodeTitle, { stage, bytes: bytes || 0, totalBytes: totalBytes || null });
  };

  // episodes 폴더 list 후 세 경로로 dedup:
  //  (a) shortId 가 있으면 `__${shortId}__` 부분 문자열 매칭 — 새 4-segment 포맷.
  //  (b) shortId 없는 옛 3-segment 파일은 (date, titleSlug, ext) 로 매칭. 옛 포맷에는
  //      노트북-슬러그가 들어가지만 포함시키지 않음 — 사용자가 노트북 이름을
  //      바꾸고 다시 받아도 같은 audio 로 인식되도록.
  //  (c) shortId 가 비었을 때 (artifact-labels 가 늦게 렌더되는 race) 4-segment 파일과도
  //      (date, titleSlug, ext) 로 매칭 — 같은 카드를 한 번 더 push 하는 사고 방지.
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
        if (!shortId && date && titleSlug && titleFilenameMatches(f.name, date, titleSlug, ext)) return true;
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
      skipKind: "dedup",
      reason: existingMatch.name === filename ? "이미 존재" : `이미 존재 (${existingMatch.name})`,
      matchedFilename: existingMatch.name,
    };
  }

  const t0 = Date.now();
  let stageFilename = filename;
  const stageLog = (stage) => console.log(`[push] ${stageFilename} ${stage} (+${Math.round((Date.now() - t0) / 1000)}s)`);

  const urlHost = (() => { try { return new URL(audioUrl).host; } catch { return "(invalid)"; } })();

  // m4a/mp4 (NotebookLM 기본 256k stereo) 는 offscreen 이 직접 fetch + transcode +
  // base64 인코딩까지 끝낸 string 을 돌려준다. SW thread 는 b64 변환 동기 루프를
  // 안 돌아 — 큰 카드 (40MB) 에서 1~2초씩 message 채널이 freeze 되던 현상 해소.
  // mp3 등 transcode 불필요 케이스도 같은 경로로 (mode: "fetch") 통과시켜 SW b64 제거.
  let b64;
  let size;
  const filenameExt = (filename.match(/\.([^.]+)$/) || [, ""])[1].toLowerCase();
  const isAac = filenameExt === "m4a" || filenameExt === "mp4";

  if (isAac) {
    try {
      stageLog(`fetch+transcode (offscreen) m4a→mp3 64k mono...`);
      ({ b64, size } = await fetchEncodeViaOffscreen(audioUrl, {
        transcode: true, bitrate: 64, mono: true,
        onProgress: (p) => reportProgress(p.stage, p.bytes, p.totalBytes),
      }));
      filename = filename.replace(/\.(m4a|mp4)$/i, ".mp3");
      stageFilename = filename;
      stageLog(`transcoded+b64 → ${(size / 1024 / 1024).toFixed(1)}MB`);
      // dedup hint 의 ext 도 mp3 으로 동기 — legacy 매칭이 일관되도록.
      if (dedupHints) dedupHints.ext = ".mp3";
    } catch (e) {
      console.warn(`[push] offscreen transcode 실패, fallback fetch (offscreen, transcode 없이): ${e.message}`);
      // Fallback: offscreen 으로 raw m4a 만 fetch + b64 하고 그대로 push. SW b64 회피.
      // 큰 m4a 는 ghPut 가 GitHub blob 한계 에러로 떨어질 수 있음 — 이건 sizing 문제라 회피 불가.
      ({ b64, size } = await fetchEncodeViaOffscreen(audioUrl, {
        transcode: false,
        onProgress: (p) => reportProgress(p.stage, p.bytes, p.totalBytes),
      }));
      stageLog(`fallback fetched+b64 ${(size / 1024 / 1024).toFixed(1)}MB (m4a 그대로) host=${urlHost}`);
    }
  } else {
    // mp3 / 기타 — offscreen 이 fetch + b64. SW thread 는 b64 안 돈다.
    ({ b64, size } = await fetchEncodeViaOffscreen(audioUrl, {
      transcode: false,
      onProgress: (p) => reportProgress(p.stage, p.bytes, p.totalBytes),
    }));
    stageLog(`fetched+b64 ${(size / 1024 / 1024).toFixed(1)}MB host=${urlHost}`);
  }

  const path = `docs/episodes/${filename}`;

  // 정확 path 에 같은 크기 파일이 있으면 skip (list 실패 시 fallback 경로 + 이중 안전망).
  reportProgress("ghGet", 0, null);
  const existing = await ghGet(cfg.repo, path, cfg.token);
  stageLog(`ghGet existing=${existing ? existing.size : 'none'}`);
  let pushResult;
  if (existing && existing.size === size) {
    console.log(`[push] ${filename} 이미 존재 (같은 크기), skip`);
    pushResult = { skipped: true, skipKind: "dedup", reason: "이미 존재" };
  } else {
    reportProgress("uploading", 0, size);
    await ghPut(cfg.repo, path, b64,
      `Add episode ${filename}`, existing?.sha, cfg.token, committer);
    stageLog(`pushed ${(size / 1024 / 1024).toFixed(1)}MB`);
    reportProgress("uploaded", size, size);
    pushResult = { ok: true, size, filename };
    // 성공적으로 push 됐으므로 episodes/ 캐시 무효화 — 다음 카드 dedup 체크가 fresh list 를 봄.
    invalidateGhListCache(cfg.repo, "docs/episodes");
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

// docs/episodes/ list 를 반복 호출하는 경우 (list:pushed, buildNewSelections, storage:usage,
// storage:cleanup, pushEpisode 등) 에 대한 in-memory TTL 캐시. GitHub GET 은 no-store
// 이지만 같은 SW 안에서 수십ms 안에 연속 호출되는 케이스를 줄임.
// TTL 30초 — push 후 즉시 무효화하므로 dedup 정확성에 영향 없음.
const GHLIST_CACHE_TTL_MS = 30_000;
const _ghListCache = new Map(); // key: `${repo}:${dirPath}` → { data: File[], ts: number }

async function ghList(repo, dirPath, token) {
  const cacheKey = `${repo}:${dirPath}`;
  const hit = _ghListCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < GHLIST_CACHE_TTL_MS) return hit.data;

  const r = await fetch(ghContentsUrl(repo, dirPath), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (r.status === 404) {
    _ghListCache.set(cacheKey, { data: [], ts: Date.now() });
    return [];
  }
  if (!r.ok) throw new Error(`ghList ${dirPath}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const arr = await r.json();
  const data = Array.isArray(arr) ? arr.filter((f) => f.type === "file") : [];
  _ghListCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// push 성공 후 호출 — stale 캐시로 dedup 미스가 나지 않도록 해당 디렉토리 캐시 무효화.
function invalidateGhListCache(repo, dirPath) {
  _ghListCache.delete(`${repo}:${dirPath}`);
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

// Contents API DELETE — path 의 file 을 sha 기반으로 삭제. 옵션 페이지의 [삭제] /
// [스킵] 버튼이 거쳐가는 episodes:delete 핸들러가 사용. workflow rebuild 와의 race
// 시 409 가 가능하지만 빈도가 낮고 사용자가 다시 누르면 됨 — retry 안 함.
async function ghDelete(repo, path, sha, message, token, committer) {
  const body = { message, sha };
  if (committer) {
    body.committer = committer;
    body.author = committer;
  }
  const r = await fetch(ghContentsUrl(repo, path), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = (await r.text()).slice(0, 200);
    throw new Error(`ghDelete ${path}: ${r.status} ${errText}`);
  }
  return r.json();
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

// shortId 가 비었을 때 (download:expect 시점에 artifact-labels 가 아직 안 떴음)
// 4-segment 파일과도 (date, titleSlug, ext) 로 매칭. legacyFilenameMatches 와 달리
// fShortId 가 있어도 통과 — race 케이스에서 같은 카드를 한 번 더 push 하는 사고 방지.
function titleFilenameMatches(name, date, titleSlug, ext) {
  const m = LEGACY_DEDUP_RE.exec(name);
  if (!m) return false;
  const [, fDate, , fTitle, fExt] = m;
  const wantExt = (ext || "").replace(/^\./, "").toLowerCase();
  return fDate === date && fTitle === titleSlug && fExt.toLowerCase() === wantExt;
}
