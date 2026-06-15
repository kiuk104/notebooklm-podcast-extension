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

  // NotebookLM 홈은 두 섹션으로 나뉜다: "추천 노트북"(Google 제공 샘플/공유) +
  // "최근 노트북"(내 노트북). 둘 다 같은 `/notebook/<id>` URL + 같은 카드 클래스
  // (project-button-card) 라 클래스로는 구분 불가. 문서 순서상 "추천" 헤딩과 다음
  // 헤딩 사이에 있는 카드가 추천 노트북이므로, 헤딩을 기준선 삼아 그 구간 URL 만
  // featured 로 분류한다. 헤딩 텍스트는 로케일별로 다르므로 ko/en/de/es/fr 마커를
  // 폭넓게 매칭. 매칭 실패 시엔 featured 가 비어 전부 포함 (= 기존 동작, 무회귀).
  const FEATURED_HEADING_RE = /추천|featured|empfohlen|vorgestellt|destacad|en vedette/i;
  function featuredNotebookUrlSet() {
    const set = new Set();
    // 헤딩과 노트북 링크를 문서 순서대로 한 번에 순회 (querySelectorAll 은 document
    // order 보장). 카드 제목은 h1~h3/[role=heading] 가 아니므로 (실측: 홈 헤딩은
    // "추천 노트북"/"최근 노트북" 2개뿐) 섹션 헤딩만 featured 토글을 건드린다.
    const nodes = document.querySelectorAll('h1,h2,h3,[role="heading"],a[href*="/notebook/"]');
    let featured = false;
    for (const el of nodes) {
      if (el.matches('a[href*="/notebook/"]')) {
        if (!featured) continue;
        const href = el.getAttribute("href") || "";
        if (!/\/notebook\/[a-zA-Z0-9-]{16,}/.test(href)) continue;
        try { set.add(new URL(href, location.origin).href); } catch {}
      } else {
        const t = (el.textContent || "").trim();
        if (t) featured = FEATURED_HEADING_RE.test(t);
      }
    }
    return set;
  }

  // 노트북 list 페이지 (https://notebooklm.google.com/) 의 노트북 카드들에서
  // 노트북 URL 만 뽑아내기. NotebookLM 의 list 페이지 DOM 클래스가 자주 바뀌므로
  // `a[href*="/notebook/"]` 의 href 패턴 매칭으로 robust 하게 처리.
  // 추천(Google 제공) 노트북은 제외 — 내 노트북만 동기화 대상.
  function getNotebookUrls() {
    const urls = new Set();
    const featured = featuredNotebookUrlSet();
    for (const a of document.querySelectorAll('a[href*="/notebook/"]')) {
      const href = a.getAttribute("href") || "";
      if (/\/notebook\/[a-zA-Z0-9-]{16,}/.test(href)) {
        try {
          const u = new URL(href, location.origin).href;
          if (featured.has(u)) continue;
          urls.add(u);
        } catch {}
      }
    }
    return Array.from(urls);
  }

  // 노트북 카드의 walk-up 루트 — Material Design / Angular 패턴 후보 + 폴백.
  // 너무 좁으면 (`a` 자체) hint 추출 불가, 너무 넓으면 (`body`) 다른 카드 정보가 섞임.
  function findCardContainer(a) {
    return a.closest('[role="article"]')
      || a.closest('mat-card')
      || a.closest('article')
      || a.closest('project-button')
      || a.closest('.project-button-content')
      || a.parentElement?.parentElement
      || a;
  }

  // 노트북 카드에서 "구조적 지문" 을 만든다 — 노트북에 변동 (새 음성개요 추가 / 이름 변경
  // / 소스 추가) 이 있으면 hint 가 변경되도록 안정 시그널만 사용. 상대 시간 "5분 전" 같은
  // 시간 흐름만으로 변하는 텍스트는 사용하지 않음.
  //
  // 우선순위:
  //   1) <time datetime="ISO"> — 표준 절대 시간.
  //   2) [title] 속성 안의 절대 날짜 문자열 (ISO / GMT / "+0200" 패턴).
  //   3) [aria-label] 안의 숫자 패턴 — "5 audio overviews" 같은 카운트 시그널.
  //
  // 하나도 없으면 null 반환 → background 가 cache 사용 안 하고 풀 스캔 fallback.
  // NotebookLM DOM 변경 시 graceful degrade (느려지지만 깨지진 않음).
  function extractModifiedHint(card) {
    if (!card) return null;
    const parts = [];
    for (const t of card.querySelectorAll("time[datetime]")) {
      const v = t.getAttribute("datetime");
      if (v) parts.push("t:" + v);
    }
    for (const el of card.querySelectorAll("[title]")) {
      const title = (el.getAttribute("title") || "").trim();
      // 절대 날짜 / 시간 패턴만 — UI 액션 힌트 ("Click to open") 등은 거름.
      if (title && /\d{4}|GMT|UTC|\+\d{2}:?\d{2}/.test(title)) {
        parts.push("T:" + title);
      }
    }
    for (const el of card.querySelectorAll("[aria-label]")) {
      const label = (el.getAttribute("aria-label") || "").trim();
      // 숫자가 들어간 label 만. NotebookLM 이 카운트 / 시간 정보를 aria-label 로 노출 가능성.
      if (label && /\d/.test(label) && label.length < 200) {
        parts.push("a:" + label.replace(/\s+/g, " "));
      }
    }
    if (parts.length === 0) return null;
    return parts.sort().join("|");
  }

  // 홈 페이지의 노트북 카드들에서 URL + modifiedHint 추출. (a) per-notebook 캐시의 키.
  // 캐시 재사용 판정: 직전 스캔의 동일 url 항목과 hint 가 같으면 그 노트북은 변동 없음 →
  // 풀 스캔 스킵 + 옛 audios 그대로 사용. hint 가 null 이면 매번 풀 스캔 fallback (안전).
  function getNotebookCards() {
    const seenUrls = new Set();
    const featured = featuredNotebookUrlSet();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/notebook/"]')) {
      const href = a.getAttribute("href") || "";
      if (!/\/notebook\/[a-zA-Z0-9-]{16,}/.test(href)) continue;
      let url;
      try { url = new URL(href, location.origin).href; } catch { continue; }
      if (featured.has(url)) continue; // 추천(Google 제공) 노트북 제외
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const card = findCardContainer(a);
      const modifiedHint = extractModifiedHint(card);
      out.push({ url, modifiedHint });
    }
    return out;
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
      // 응답에 notebooks: [{url, modifiedHint}, ...] 도 같이 — (a) per-notebook 캐시 용.
      // urls 키는 옛 API 호환 (혹시 다른 호출자가 있을 경우).
      (async () => {
        try {
          await scrollToLoadAll();
          const notebooks = getNotebookCards();
          // 진단 로그 — modifiedHint 가 몇 % 추출됐는지. 0% 면 selector 조정 필요.
          const withHint = notebooks.filter((n) => n.modifiedHint).length;
          console.log(`[scan:list] ${notebooks.length}개 노트북, modifiedHint 추출 ${withHint}개 (${notebooks.length > 0 ? Math.round(withHint * 100 / notebooks.length) : 0}%)`);
          sendResponse({
            ok: true,
            notebooks,
            urls: notebooks.map((n) => n.url),
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // async
    }
    if (msg?.type === "scan") {
      (async () => {
        // dedup 키 (artifactId, cover.dateAttr) 가 채워질 때까지 짧게 폴.
        // 카드 제목은 떠 있는데 `<span id="artifact-labels-{UUID}">` 와
        // `.cover-subtitle-date` 의 title 속성은 더 늦게 렌더되는 race 가
        // 자주 발생. 그 상태로 응답해버리면 모든 4-segment 파일은 shortId
        // 매칭만 되는데 빈 artifactId 로는 매칭 불가능 → 이미 받은 카드를
        // 매번 "신규" 로 잡아 같은 카드를 반복 다운로드. (legacy fallback 도
        // dateAttr 가 비면 today 로 fallback 해 매칭 어긋남.)
        const start = Date.now();
        let cover = getCover();
        let audios = getAudioCards();
        while (Date.now() - start < 3000) {
          const real = audios.filter((a) => !a.isPlaceholder);
          // 음성개요가 0개인 노트북은 real.length > 0 조건이 절대 true 가 되지 않아
          // 항상 3초를 다 기다리는 버그 수정. dateAttr 만 채워지면 즉시 반환.
          const ready = !!cover.dateAttr && (real.length === 0 || real.every((a) => a.artifactId));
          if (ready) break;
          await new Promise((r) => setTimeout(r, 100));
          cover = getCover();
          audios = getAudioCards();
        }
        sendResponse({ ok: true, cover, audios });
      })();
      return true; // async
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
