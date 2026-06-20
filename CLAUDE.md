# NotebookLM Podcast Sync — Claude 참조 가이드

이 프로젝트에서 Claude(코워크/코드)가 작업할 때 반드시 알아야 할 컨텍스트.

---

## 프로젝트 개요

NotebookLM Audio Overview를 GitHub repo에 push해서 개인 팟캐스트 RSS 피드를 만드는 Chrome 익스텐션(MV3).

- **스토어**: https://chromewebstore.google.com/detail/notebooklm-podcast-sync/kcgedhigobhicnaedgkmojhiceacmjmo
- **현재 버전**: manifest.json의 `"version"` 참고
- **상태**: 스토어 출시 완료. 개발 포커스는 버그 수정 및 기능 개선.

---

## 핵심 파일

| 파일 | 역할 |
|------|------|
| `src/background.js` | Service Worker. 핵심 로직 전체 (다운로드, push, feed, bulk, skip 등) |
| `src/content.js` | NotebookLM 페이지 DOM 스캔. 카드 추출, 클릭 좌표 반환 |
| `src/offscreen/transcode.js` | m4a → mp3 64k mono 트랜스코딩 + fetch/encode |
| `src/feed.js` | RSS feed XML 빌드 |
| `src/options/options.js` | 관리 페이지 (진행 모니터, 에피소드 목록, 설정) |
| `src/i18n.js` | 한/영/독 3개 언어 |
| `vendor/lamejs.js` | MP3 인코더 (수정 금지) |
| `manifest.json` | 버전 번호, 권한 선언 |
| `scripts/package.py` | Web Store 업로드용 zip 생성 |

---

## 릴리스 절차 요약

1. `manifest.json` 의 `"version"` 버전 bump
2. `python scripts/package.py` → `dist/notebooklm-podcast-sync-v{버전}.zip`
3. [Chrome Web Store 대시보드](https://chrome.google.com/webstore/devconsole) → 새 버전 업로드

자세한 내용은 `RELEASING.md` 참고.

---

## 알려진 함정 — 작업 전 반드시 확인

자세한 내용은 `IMPLEMENTATION_NOTES.md` 의 해당 섹션 참고.

### bulk window 좌표 + 단일 탭 재사용 [§17, §20, §21]

**배경**: bulk 다운로드는 NotebookLM의 `visibilityState='visible'` + `isTrusted=true` 요건을 충족하기 위해 전용 popup window 안의 active tab에서 실행된다. 이 창은 사용자에게 보이지 않아야 하므로 "화면 밖"에 위치시키는 전략을 사용했음.

**Chrome bounds 규칙 강화 (2026-05, §20)**: `windows.create` / `windows.update` 에서 창 면적의 50% 이상이 화면 안에 있어야 한다는 조건이 추가됨. 기존 `left:-32000, top:-32000` 이 에러로 차단 → `left:-399, top:0` 가장자리 좌표로 교체.

**`focused:false` honor 약화 + tab.create raise 회귀 (v0.4.45, §21)**: 후속 Chrome 빌드에서 `chrome.windows.create({focused:false})` 가 Windows 에서 더 이상 보장되지 않고, 매 `chrome.tabs.create({active:true, windowId:popup})` 가 popup 을 OS foreground 로 raise. `chrome.windows.update({focused:true})` 복원도 Windows SetForegroundWindow 제한에 막혀 신뢰 불가.

**창 너비 = 카드 렌더 (v0.4.54, ⚠️ 다운로드 성패의 직접 원인)**: NotebookLM 새 반응형 레이아웃이 **viewport 폭 ~800px 에서 음성개요(Studio) 패널을 접어 `.artifact-item-button` 을 0개로 렌더**한다 (실측: 넓은 화면=1개, 800px=0개). bulk 탭은 popup 창의 inner width 로 레이아웃되므로 창이 좁으면 "보이는 카드=[없음]" → `findCard`/menucoords 실패 → bulk 전체가 "카드 못 찾음"/"메뉴 항목 못 찾음" 으로 실패한다. **해결: `width` 를 800 → 1280 으로 확대해 desktop 3-pane 레이아웃 강제.** 50% 규칙(§20)상 창이 커지면 화면 안 visible 영역도 커지지만 `left` 를 음수로 최대한 밀어 노출 최소화 (`left:-620` → visible 660px = 1280 의 51.6%). **bulk 가 전부 "카드 못 찾음" 으로 실패하면 가장 먼저 창 너비부터 의심** — 좌표(§20)나 §27 race 보다 이 viewport 폭이 1차 용의자.

**현재 채택된 해결책 (v0.4.45 단일 탭 + v0.4.54 너비)**:
```js
const BULK_WINDOW_OPTS = { left: -620, top: 0, width: 1280, height: 600 };
let bulkTabId = null;
let bulkDebuggerAttached = false;

async function ensureBulkTab(url) {
  if (bulkTabId !== null) {
    // 재사용 — tabs.create 호출 없음 → 윈도우 raise 트리거 없음.
    await chrome.tabs.update(bulkTabId, { url });
    return bulkTabId;
  }
  // 첫 호출 — windows.create 에 url 을 함께 넘김. tabs.create 분리 호출 없음.
  const win = await chrome.windows.create({ url, type:"popup", focused:false, ...BULK_WINDOW_OPTS });
  bulkTabId = win.tabs[0].id;
  return bulkTabId;
}
```
- `chrome.tabs.create` 가 세션 전체에서 0번 → 매 노트북마다 발생하던 popup raise 가 사라짐
- `chrome.debugger.attach` 도 세션당 1회만 → 디버그 배너 raise 도 1회만
- `closeManagedTab(tabId)` 는 `if (tabId === bulkTabId) return` 으로 분기 — bulk 탭은 세션 끝까지 살림
- 좌표 전략 (`-620, top:0`) 은 §20 (50% 규칙) 충족하면서 너비 1280 을 수용

**Bulk 관련 코드 변경 시 체크리스트**:
0. 창 inner width 가 desktop 폭(≥~1100px, 현재 1280)인가? — 좁으면 `.artifact-item-button` 0개 → 전부 "카드 못 찾음" (위 v0.4.54 함정)
1. 창 면적의 50% 이상이 화면 안에 있는가? (§20)
2. `chrome.tabs.create` 가 bulk path 에서 호출되는가? — 호출되면 화면 전환 회귀 (§21)
3. `chrome.tabs.update(bulkTabId, {url})` navigate 로 노트북 전환하는가?
4. `chrome.debugger.attach` 가 첫 노트북에서 1회만 호출되는가?
5. `visibilityState='visible'` 이 유지되는가? (minimized 금지, §9/§10)
6. `closeManagedTab` 이 bulk 탭을 매 노트북마다 닫지 않는가? (분기 체크)

### 새 음성개요 카드 탐색 race + 잘못된 자동 skip [§27, §28]

새로 만든 음성개요는 `artifact-labels` UUID 가 fresh navigation 직후 lazy render 되는데, `waitForAudioCards` 가 *다른 옛 카드* 기준으로 ready 를 통과시키면 `findCard` 가 아직 안 뜬 새 카드를 못 찾아 "카드 못 찾음" → `runBulkRemote` 가 이를 *삭제* 로 단정해 멀쩡한 새 에피소드를 자동 skip 매장 (§27). 그 자동 skip 이 **date 없이** 저장되면 다음 스캔에서 UUID race 때 titleKeys 폴백도 못 잡아 신규로 재출현 → churn (§28).
- `findCard` ([src/content.js](src/content.js)) 는 artifactId 를 `FIND_CARD_TIMEOUT`(14s) 폴링; index 는 그 뒤에만 쓰는 약한 폴백. `download:prepare` 타임아웃은 40s (폴링 합산보다 위).
- selection 에 `coverDateAttr` 동반 (`buildNewSelections`/`collectPickedSelections`) → 자동 skip 이 `extractDateStrict(date)` 저장 → 수동 skip 과 매칭 대칭. **skip 저장/매칭 키 집합은 항상 대칭으로 유지.**

### download 트리거 조건 [§9, §10]

NotebookLM은 두 가지 조건을 모두 요구:
- **`visibilityState='visible'`**: `active:false` 백그라운드 탭이면 거부 → popup window 안 active tab 필요
- **`isTrusted=true`**: programmatic `.click()` 거부 → `chrome.debugger.Input.dispatchMouseEvent` 로 C++ 레벨 마우스 이벤트 주입 필요

이 두 조건을 건드리는 변경은 `clickViaDebugger` / `openManagedTab` / `ensureBulkWindow` 수정 후 실 다운로드로 검증 필수.

### push 는 성공인데 bulk 는 "성공 0 / 실패 N" — stall 워치독 오판 [§29]

같은 에피소드가 모니터의 **실패 목록** 과 **최근 GitHub push 활동(✓)** 에 동시에 뜨면 이것. bulk 워치독(`waitPushResultLocalWithWatchdog`)이 "다운로드 메뉴 클릭" 직후 켜지는데, 첫 진행률 비콘은 NotebookLM 이 실제 다운로드를 개시해 `pushEpisode` 가 돌아야 나온다. bulk 탭은 화면 밖 popup (§21) 이라 throttle + 서버 준비 지연으로 이 "시작 전 빈 구간" 이 90s 를 넘기면 *전송 중 stall* 로 오판해 실패 집계 → 그 뒤 push 는 멀쩡히 성공해 GitHub 엔 ✓. (타임아웃뿐 아니라 "debugger click 실패: 메뉴 항목 못 찾음" 처럼 메뉴 클릭은 에러로 보고됐는데 다운로드는 발사돼 ✓ 가 찍히는 경로도 같은 모순.) 두 갈래로 해결: **(1)** 첫 비콘 전엔 `PUSH_START_GRACE`(180s), 후엔 `PUSH_IDLE_TIMEOUT`(90s) 로 분리 (reason `no-start`/`idle`/`hard`). **(2)** 늦은 `notifyPush({ok})` 가 오면 `reconcileBulkLateSuccess` 가 **failedSelections 멤버십** 기준(실패 원인 불문)으로 실패→성공 정정 — 정상 성공 카드는 애초에 목록에 없어 no-op. bulk 카운터는 **모듈 `_bulkTally` 공유** 여야 정정이 loop 의 다음 `setTaskState` 에 안 덮인다. **bulk 워치독/카운터 수정 시**: start-grace↔idle 분리, 모든 실패 경로가 `failedSelections.push`, `_bulkTally` 공유, notifyPush 의 reconcile 호출 4개가 유지되는지 확인.

### Service Worker idle 종료 [§6, §7]

MV3 SW는 30초 idle이면 종료됨. bulk 작업 중 SW가 죽으면 다운로드 흐름 전체가 끊김. keepalive 알람(`chrome.alarms`)과 offscreen document port로 alive 유지. SW를 오래 살려야 하는 로직 추가 시 이 메커니즘 확인.

### `chrome.storage.sync` quota [§16, §24]

설정값은 `sync`에 저장 (다기기 공유). **주의: sync 는 총 100KB 와 별개로 per-item 8192 byte 한도가 있다** — 단일 키에 누적되는 배열은 후자에 먼저 막힌다 (§24 에서 `skippedShortIds` full-meta 배열이 ~40건에서 잘려 churn 사고). 누적형 데이터는 sync 에 두지 말고 `local` (≈10MB) 을 source-of-truth 로, sync 엔 식별자만 미러. 스킵 목록이 그 패턴 — `local.skippedEntries`(full) + `sync.skippedShortIds`(shortId 만).

### GitHub Contents API 캐시 [§1 dedup 주석]

`Cache-Control: max-age=60`. `ghList` 호출에 `cache:"no-store"` 필수 — 빠뜨리면 PUT 직후 같은 파일이 신규로 재인식되어 중복 push 발생.

### `scripts/package.py` INCLUDE_DIRS [§15]

화이트리스트 방식. `src/`, `vendor/` 외 새 폴더 추가 시 `INCLUDE_DIRS`에 명시 필요. 빠뜨리면 zip에서 누락되어 익스텐션 로드 실패.

### 추천 노트북 스캔 제외 [§22]

NotebookLM 홈은 **"추천 노트북"(Google 제공 샘플/공유) + "최근 노트북"(내 노트북)** 두 섹션. 둘 다 같은 `/notebook/<id>` URL + 같은 카드 클래스라 구분 불가 → `content.js` 의 `featuredNotebookUrlSet()` 가 홈 헤딩 (`h1~h3/[role=heading]`) 을 document-order 기준선으로 삼아 "추천" 섹션 카드를 분류, `getNotebookUrls`/`getNotebookCards` 에서 제외. **노트북 수집 셀렉터 수정 시 주의**: 카드 제목이 heading 요소가 아니라는 전제에 의존 (현재 홈 헤딩은 2개뿐). NotebookLM 이 카드 제목을 `<h3>` 등으로 바꾸면 featured 토글이 흔들림. 헤딩 미매칭 시 전부 포함 = 무회귀. **단 "최근 노트북" 헤딩이 heading 요소가 아니게 바뀌면 featured 토글이 안 꺼져 추천 이후 전부 제외 → 0개 (§26)**; `getNotebookCards`/`getNotebookUrls` 에 "featured 가 전부를 제외하면 전부 포함" fallback 가드를 둠.

### feed.xml reconcile — push 후 rebuild 누락 복구 [§23]

`pushEpisode` 의 audio PUT 은 성공했는데 직후 feed 재빌드가 SW idle 종료/transient 오류로 누락되면 `feed.xml` 이 `episodes/` 보다 뒤처진 채 방치됨 (실측 10일 stale → 팟캐스트 앱에 새 에피소드 안 보임). `rebuildFeedWithRetry`(backoff 3회) + `reconcileFeed()` 를 `bulk:remote`/`scan:all` 종료 `.finally` 와 `chrome.runtime.onStartup` 에서 호출해 복구. `rebuildFeed` 는 idempotent (unchanged 면 PUT skip) 라 매번 호출 안전. **feed 빌드 경로 / push 흐름 수정 시**: reconcile 3개 호출 지점이 유지되는지, rebuildFeed 의 idempotency (sha 비교 후 skip) 가 깨지지 않는지 확인.

**⚠ "YT Music 에 새 에피소드 안 보임" = 이 §23 (feed stale) 아니라 YT Music 의 느린 서버측 재크롤이 1차 용의자** (2026-06-20 확인). 코드 의심 전에 **`feed.xml` 을 AntennaPod 같은 즉시-갱신 앱에 넣어 판별**: AntennaPod 에 최신까지 정상이면 feed 정상 = 클라이언트(YT Music) 지연 (기다리면 됨), AntennaPod 에서도 빠지면 그제서야 §23 stale 의심. raw 확인은 `curl -s <feed.xml> | grep -c '<item>'` (WebFetch 요약은 fast model 이라 item 존재/수를 종종 틀림).

### 같은 날짜 에피소드 pubDate 합성 [§25]

파일명에 시각이 없어 `parseDate`/`parse_date` 가 자정 Date 를 만든다 → 같은 날 에피소드는 `<pubDate>` 가 동일 → 팟캐스트 앱이 pubDate 정렬할 때 순서 비결정 (목록 뒤섞임). `feed.js` `stampPubDates` / `build_feed.py` `stamp_pubdates` 가 렌더 직전 같은 날 그룹에 표시 순서대로 초 단위 시각을 부여 (첫=최신 항목이 가장 늦은 시각). **pubDate/렌더 로직 수정 시**: 두 빌더 동일 로직 유지 (byte 일치 불변식), retention/episodeOrder 는 자정 Date 사용·렌더 직전에만 stamp.

### "모든 노트북 스캔" 0개 조기 완료 [§26]

`runScanAll` 완료 루프는 `homeEntries` 전체를 돈다 → 0개 완료 = 홈 목록 수집이 0개. 두 경로: **(A)** SPA 카드 렌더 전에 읽음 — `scan:list` 에 카드 대기(`waitFor`, 최대 15s)를 둬야 함 (개별 스캔 `waitForAudioCards` 의 홈 버전). **(B)** featured 과매칭 (위 §22 가드 참고). **노트북 목록 수집 (`scan:list`/`getNotebookCards`/`scanHomePageForNotebookUrls`) 수정 시**: 카드 출현 대기 + featured 전부-제외 가드 두 개가 유지되는지 확인.

---

## 검증 체크리스트 (코드 변경 후)

- [ ] `python scripts/package.py` 성공
- [ ] zip을 압축 해제 후 `chrome://extensions/` 개발자 모드로 로드 성공
- [ ] 단건 다운로드 (popup → 받기) 정상
- [ ] bulk 다운로드 1~2개 테스트 — "탭 열기 실패" 없음
- [ ] 다운로드 중 다른 창 작업 시 화면 전환 없음
- [ ] 스캔 결과에 추천 노트북(영어 샘플) 안 섞임 — 내 "최근 노트북"만 잡힘 (§22)
- [ ] [모든 노트북 스캔] 시 SW 콘솔 `[scan:list] N개 노트북` 이 실제 노트북 수와 일치 (0개 조기 완료 없음, §26)
- [ ] 팟캐스트 앱에서 같은 날 에피소드 순서가 재빌드해도 안정 (§25)
- [ ] bulk/scan 종료 시 SW 콘솔에 `[feed] reconcile (...)` 로그 확인 (§23)
- [ ] SW 콘솔에 `[push] ... pushed` / `[feed] rebuilt` 로그 확인
