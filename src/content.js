// NotebookLM 노트북 페이지에 inject. 카드 정보 추출과 다운로드 트리거를
// background/popup 으로부터 message 받아 처리한다.
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
  };

  function getCover() {
    return {
      title: document.querySelector(SEL.coverTitle)?.textContent?.trim() ?? "",
      dateAttr: document.querySelector(SEL.coverDate)?.getAttribute("title") ?? "",
    };
  }

  function getAudioCards() {
    return Array.from(document.querySelectorAll(SEL.cards))
      .filter((card) => card.querySelector(SEL.play))
      .map((card) => ({
        title: card.querySelector(SEL.cardTitle)?.textContent?.trim() ?? "",
      }));
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "scan") {
      sendResponse({ ok: true, cover: getCover(), audios: getAudioCards() });
      return true;
    }
  });
})();
