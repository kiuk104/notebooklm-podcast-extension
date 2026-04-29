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
  };
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

  function getAudioCards() {
    return getAudioCardEls().map((card) => {
      const title = card.querySelector(SEL.cardTitle)?.textContent?.trim() ?? "";
      return {
        title,
        isPlaceholder: PLACEHOLDER_TITLE_RE.test(title),
      };
    });
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
