// NotebookLM 노트북 페이지에 inject. popup/background 메시지를 받아 카드를
// 스캔하거나 ⋮ → 다운로드 메뉴를 자동 클릭한다.
//
// 주의: NotebookLM DOM 클래스 (`.artifact-item-button`, `.artifact-title`,
// `.cover-title`, `.cover-subtitle-date`) 는 v1 (notebooklm-podcast) 에서
// 검증된 셀렉터다. UI 가 바뀌면 여기와 popup 양쪽을 갱신해야 한다.

(() => {
  const SEL = {
    cards: ".artifact-item-button",
    cardTitle: ".artifact-title",
    play: 'button[aria-label="재생"], button[aria-label="Play"]',
    moreButton: "button.artifact-more-button",
    coverTitle: ".cover-title",
    coverDate: ".cover-subtitle-date",
    menuItem: '[role="menuitem"], button[mat-menu-item]',
    artifactLabels: '[id^="artifact-labels-"]',
  };
  // 카드 안의 `<span class="artifact-labels" id="artifact-labels-{UUID}">` 에서
  // UUID 를 뽑는 정규식. UUID 는 NotebookLM 내부 artifact ID 라 카드 제목이
  // 바뀌어도 동일하게 유지되므로 dedup 키로 안전 (IMPLEMENTATION_NOTES.md §1).
  const ARTIFACT_ID_RE = /^artifact-labels-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  const DL_LABEL_RE = /다운로드|Download/;
  // NotebookLM 은 음성개요 직후 `audio 0`, `audio 1` 같은 플레이스홀더 제목을
  // 잠시 보여주다가 실제 제목으로 비동기 교체. 이 시점에 받으면 v1 처럼 다음
  // sync 에서 같은 오디오를 실제 제목으로 또 받는 중복이 생기므로 스킵.
  // (IMPLEMENTATION_NOTES.md §1)
  const PLACEHOLDER_TITLE_RE = /^audio[\s\-_]?\d+$/i;

  function getCover() {
    return {
      title: document.querySelector(SEL.coverTitle)?.textContent?.trim() ?? "",
      dateAttr: document.querySelector(SEL.coverDate)?.getAttribute("title") ?? "",
    };
  }

  // bulk:remote 가 카드 ready 와 동시에 download:prepare 를 보내면 `.cover-title` 이
  // 아직 비어있는 경우가 있다 — 그 상태로 download:expect 가 나가면 background 의
  // slugify("") 가 "episode" 폴백을 만들어 노트북 슬러그가 사라진 파일이 생긴다
  // (예: 20260510__episode__shortId__title.mp3). 카드는 이미 떠 있으니 cover 도
  // 곧 채워짐 — 짧게 폴링.
  async function getCoverWaitingTitle(timeoutMs = 2000) {
    let cover = getCover();
    const start = Date.now();
    while (!cover.title && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
      cover = getCover();
    }
    return cover;
  }

  function getAudioCardEls() {
    return Array.from(document.querySelectorAll(SEL.cards)).filter((card) =>
      card.querySelector(SEL.play),
    );
  }

  function getArtifactId(card) {
    const labelEl = card.querySelector(SEL.artifactLabels);
    const m = ARTIFACT_ID_RE.exec(labelEl?.id || "");
    return m ? m[1] : "";
  }

  function getAudioCards() {
    return getAudioCardEls().map((card) => {
      const title = card.querySelector(SEL.cardTitle)?.textContent?.trim() ?? "";
      return {
        title,
        artifactId: getArtifactId(card),
        isPlaceholder: PLACEHOLDER_TITLE_RE.test(title),
      };
    });
  }

  // 노트북 list 페이지 (https://notebooklm.google.com/) 의 노트북 카드들에서
  // 노트북 URL 만 뽑아내기. NotebookLM 의 list 페이지 DOM 클래스가 자주 바뀌므로
  // `a[href*="/notebook/"]` 의 href 패턴 매칭으로 robust 하게 처리.
  function getNotebookUrls() {
    const urls = new Set();
    for (const a of document.querySelectorAll('a[href*="/notebook/"]')) {
      const href = a.getAttribute("href") || "";
      if (/\/notebook\/[a-zA-Z0-9-]{16,}/.test(href)) {
        try {
          urls.add(new URL(href, location.origin).href);
        } catch {}
      }
    }
    return Array.from(urls);
  }

  // home 페이지가 lazy render 인 경우 끝까지 스크롤해서 모든 카드를 DOM 에 올린다.
  async function scrollToLoadAll() {
    let lastHeight = -1;
    for (let i = 0; i < 30; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => setTimeout(r, 350));
      const h = document.documentElement.scrollHeight;
      if (h === lastHeight) break;
      lastHeight = h;
    }
    window.scrollTo(0, 0);
  }

  function waitFor(predicate, timeoutMs = 3000, intervalMs = 80) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const v = predicate();
        if (v) return resolve(v);
        if (Date.now() - start > timeoutMs) {
          return reject(new Error("timeout"));
        }
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // artifactId (UUID) 가 주어지면 그걸로 카드 찾고, 없으면 index 로 fallback.
  // 이 두 단계를 한 번 시도해 실패하면 lazy-render 가 미완료된 케이스를 가정해
  // scrollToLoadAll 후 재탐색. NotebookLM 이 카드를 비동기로 추가하는 동안
  // bulk:remote 가 download 메시지를 보내면 첫 시도는 빈 DOM 을 본다.
  async function findCard({ artifactId, index }) {
    const tryFind = () => {
      const cards = getAudioCardEls();
      if (artifactId) {
        const byId = cards.find((c) => getArtifactId(c) === artifactId);
        if (byId) return byId;
      }
      if (typeof index === "number" && cards[index]) return cards[index];
      return null;
    };

    let card = tryFind();
    if (card) return card;

    // 첫 탐색 실패 — 페이지가 lazy render 중일 가능성. 짧게 한 번 더 기다려본다.
    await new Promise((r) => setTimeout(r, 800));
    card = tryFind();
    if (card) return card;

    // 여전히 없음 — scrollToLoadAll 로 강제 렌더 후 마지막 시도.
    await scrollToLoadAll();
    card = tryFind();
    if (card) return card;

    if (artifactId) throw new Error(`artifact ${artifactId.slice(0, 8)} 카드 못 찾음 (lazy render 미완료 또는 카드 삭제됨)`);
    throw new Error(`card #${index} 없음`);
  }

  async function clickDownload({ artifactId, index }) {
    const card = await findCard({ artifactId, index });

    const more = card.querySelector(SEL.moreButton);
    if (!more) throw new Error("⋮ 버튼을 못 찾음");
    more.scrollIntoView({ block: "center" });
    more.click();

    const item = await waitFor(() => {
      for (const el of document.querySelectorAll(SEL.menuItem)) {
        if (DL_LABEL_RE.test(el.textContent || "")) return el;
      }
      return null;
    }).catch(() => {
      throw new Error("'다운로드' 메뉴 항목을 못 찾음");
    });
    item.click();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "ping") {
      // background 의 tab orchestration 에서 content script 가 살아 있는지 확인용.
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === "scan:list") {
      // home 페이지에서 노트북 URL 일괄 수집. lazy render 대비 끝까지 스크롤.
      (async () => {
        try {
          await scrollToLoadAll();
          sendResponse({ ok: true, urls: getNotebookUrls() });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async
    }
    if (msg?.type === "scan") {
      sendResponse({ ok: true, cover: getCover(), audios: getAudioCards() });
      return false;
    }
    if (msg?.type === "download") {
      (async () => {
        try {
          const cover = await getCoverWaitingTitle();
          // artifactId 우선 매칭 + lazy render fallback. msg.artifactId 가 없으면
          // 옛 popup (single download) 처럼 index 만으로 동작.
          const targetEl = await findCard({ artifactId: msg.artifactId, index: msg.index });
          const cardData = {
            title: targetEl.querySelector(SEL.cardTitle)?.textContent?.trim() ?? "",
            artifactId: getArtifactId(targetEl),
            isPlaceholder: false,
          };
          cardData.isPlaceholder = PLACEHOLDER_TITLE_RE.test(cardData.title);
          if (cardData.isPlaceholder) {
            throw new Error("제목이 아직 'audio N' 플레이스홀더입니다. 잠시 후 다시 시도하세요.");
          }

          await chrome.runtime.sendMessage({
            type: "download:expect",
            payload: {
              notebookTitle: cover.title,
              coverDateAttr: cover.dateAttr,
              episodeTitle: cardData.title,
              artifactId: cardData.artifactId,
            },
          });

          await clickDownload({ artifactId: cardData.artifactId, index: msg.index });
          sendResponse({ ok: true, episodeTitle: cardData.title });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async
    }
    // bulk:remote 가 chrome.debugger API 로 진짜 user input 을 주입하기 위해 사용.
    // content.js 는 카드 / 메뉴 항목의 viewport 좌표만 반환, click 자체는 background
    // 에서 Input.dispatchMouseEvent 로. NotebookLM 이 programmatic click (isTrusted=
    // false / no user activation) 을 거부하기 때문.
    if (msg?.type === "download:prepare") {
      (async () => {
        try {
          const cover = await getCoverWaitingTitle();
          const targetEl = await findCard({ artifactId: msg.artifactId, index: msg.index });
          const cardData = {
            title: targetEl.querySelector(SEL.cardTitle)?.textContent?.trim() ?? "",
            artifactId: getArtifactId(targetEl),
          };
          if (PLACEHOLDER_TITLE_RE.test(cardData.title)) {
            throw new Error("제목이 아직 'audio N' 플레이스홀더입니다.");
          }
          const more = targetEl.querySelector(SEL.moreButton);
          if (!more) throw new Error("⋮ 버튼을 못 찾음");
          more.scrollIntoView({ block: "center" });
          // 스크롤이 layout 적용되도록 잠깐 양보 — 다음 frame 후 rect 측정.
          await new Promise((r) => requestAnimationFrame(() => r()));
          const rect = more.getBoundingClientRect();

          // download:expect 를 여기서 등록 — 클릭이 background 에서 일어나도 큐는 같음.
          await chrome.runtime.sendMessage({
            type: "download:expect",
            payload: {
              notebookTitle: cover.title,
              coverDateAttr: cover.dateAttr,
              episodeTitle: cardData.title,
              artifactId: cardData.artifactId,
            },
          });

          sendResponse({
            ok: true,
            episodeTitle: cardData.title,
            artifactId: cardData.artifactId,
            moreX: rect.x + rect.width / 2,
            moreY: rect.y + rect.height / 2,
            // devicePixelRatio: chrome.debugger 의 Input.dispatchMouseEvent 는 CSS pixel
            // 기준이라 변환 불필요. 디버깅용으로만 남김.
            devicePixelRatio: window.devicePixelRatio || 1,
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async
    }
    if (msg?.type === "download:menucoords") {
      // ⋮ 클릭 후 떠오른 popover 의 "다운로드" 메뉴 항목 좌표 반환.
      (async () => {
        try {
          const item = await waitFor(() => {
            for (const el of document.querySelectorAll(SEL.menuItem)) {
              if (DL_LABEL_RE.test(el.textContent || "")) return el;
            }
            return null;
          }, 3000).catch(() => {
            throw new Error("'다운로드' 메뉴 항목을 못 찾음");
          });
          const rect = item.getBoundingClientRect();
          sendResponse({
            ok: true,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async
    }
  });
})();
