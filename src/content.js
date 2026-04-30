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

  async function clickDownload(index) {
    const cards = getAudioCardEls();
    const card = cards[index];
    if (!card) throw new Error(`card #${index} 없음`);

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
          const cover = getCover();
          const cards = getAudioCards();
          const card = cards[msg.index];
          if (!card) throw new Error(`card #${msg.index} 없음`);
          if (card.isPlaceholder) {
            throw new Error("제목이 아직 'audio N' 플레이스홀더입니다. 잠시 후 다시 시도하세요.");
          }

          await chrome.runtime.sendMessage({
            type: "download:expect",
            payload: {
              notebookTitle: cover.title,
              coverDateAttr: cover.dateAttr,
              episodeTitle: card.title,
              artifactId: card.artifactId,
            },
          });

          await clickDownload(msg.index);
          sendResponse({ ok: true, episodeTitle: card.title });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async
    }
  });
})();
