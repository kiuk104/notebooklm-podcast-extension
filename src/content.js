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
    return getAudioCardEls().map((card) => ({
      title: card.querySelector(SEL.cardTitle)?.textContent?.trim() ?? "",
    }));
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
