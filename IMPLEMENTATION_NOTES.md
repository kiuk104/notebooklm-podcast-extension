# Implementation Notes

v1 ([notebooklm-podcast](https://github.com/kiuk104/notebooklm-podcast)) 운영 중에 발견된 함정과 해결책. 익스텐션에서 다운로드 트리거 / dedup 로직을 구현할 때 같은 실수 안 하려고 기록.

---

## 1. 'audio N' 플레이스홀더 제목 → 중복 다운로드

### 증상

같은 음성개요가 두 번 받아져서 RSS 피드에 중복 에피소드로 노출됨. 예:

```
20260222__미중-패권-경쟁과-호주의-인도-태평양-전략-지형-변화__audio-0.mp3
20260222__미중-패권-경쟁과-호주의-인도-태평양-전략-지형-변화__미국-앞에서는-시가-아니라-영수증을-내밀어라.mp3
```

v1 누적 데이터에서는 이 패턴 중복이 102건 발생.

### 원인

NotebookLM 은 음성개요 생성 직후 `.artifact-title` 의 텍스트를 `audio 0`, `audio 1` 같은 플레이스홀더로 잠시 보여주다가, 비동기로 실제 제목 ("미국 앞에서는 시가 아니라 영수증을 내밀어라" 등) 으로 교체한다.

dedup 키에 카드 제목을 슬러그로 박는 구현이라면 (v1 의 `{date}__{notebook}__{episode_title}.mp3`):

- 1차 실행: 제목이 아직 `audio 0` → `__audio-0.mp3` 로 저장.
- 2차 실행: 제목이 실제 제목으로 바뀜 → 새 키로 인식되어 같은 오디오를 또 받음.

### 대응 (v1 패치)

다운로드 직전 제목이 플레이스홀더 패턴이면 그 카드는 스킵하고, 다음 실행에서 실제 제목이 붙은 뒤 받게 함.

```js
const PLACEHOLDER_TITLE_RE = /^audio[\s\-_]?\d+$/i;

if (PLACEHOLDER_TITLE_RE.test(episodeTitle)) {
  // skip; 다음 sync 에서 실제 제목으로 받자
  return;
}
```

v1 구현 위치: [downloader.py:50](https://github.com/kiuk104/notebooklm-podcast/blob/main/src/downloader.py#L50), [downloader.py:259-262](https://github.com/kiuk104/notebooklm-podcast/blob/main/src/downloader.py#L259-L262).

### 익스텐션에서의 함의

- 카드 스캔 결과를 바로 다운로드 큐에 넣지 말고, 위 정규식으로 한 번 거르자.
- 노트북에 음성개요가 N 개 있는데 모두 플레이스홀더라면 그 노트북은 이번 sync 에서 통째로 스킵하고 사용자에게 "제목 확정 대기 중" 정도로 알리는 게 좋다.
- 드물게 제목이 끝까지 안 붙는 경우가 있을 수 있으니, 같은 노트북을 N 회 (예: 3회) 연속 스킵하면 fallback 으로 `audio-0` 그대로 받게 하는 안전장치도 고려할 만함. v1 은 아직 이 fallback 이 없음.

### 익스텐션 구현 상태 (✅ 적용됨)

- [src/content.js](src/content.js): `PLACEHOLDER_TITLE_RE = /^audio[\s\-_]?\d+$/i`. `getAudioCards()` 가 카드별 `isPlaceholder` 플래그를 내고, `download` 핸들러는 플레이스홀더면 에러로 거절.
- [src/popup/popup.js](src/popup/popup.js): 플레이스홀더 카드의 "받기" 버튼 disabled + "제목 확정 대기 중" 라벨. 모든 카드가 플레이스홀더면 status bar 에 "잠시 후 다시 스캔하세요" 안내.
- [src/background.js](src/background.js): `download:expect` 큐잉 직전 동일 정규식으로 한 번 더 거름 (popup/content 우회 메시지에 대한 2차 방어선).
- 미구현: N 회 연속 스킵 시 `audio-N` fallback 강제 다운로드. 사용자가 수동으로 다시 스캔하면 되므로 우선순위 낮음.

### dedup 키 설계 일반 원칙

플레이스홀더 함정을 떠나서, 카드 제목은 시간이 지나면 바뀔 수 있는 mutable 한 값이다. 가능하면 dedup 키에는:

1. 노트북 ID (URL) — 안정적
2. cover 생성일 — 안정적
3. 카드 인덱스 또는 audio overview 가 NotebookLM 내부에서 갖는 고유 ID — 가장 안정적, 다만 DOM 에서 노출되는지 확인 필요

같은 식별자를 우선 쓰고, 사람이 읽을 제목은 파일명 표시용 보조 필드로 두는 게 안전하다. v1 은 사람이 읽을 파일명을 직접 dedup 키로 써서 위 함정에 걸렸다.

### 익스텐션 UUID 기반 dedup (✅ 적용됨)

NotebookLM 카드 안 `<span class="artifact-labels" id="artifact-labels-{UUID}">` 에 노출되는 artifact UUID 를 안정 식별자로 사용. UUID 의 첫 8자 (shortId) 를 파일명에 박는다.

- 파일명: `${date}__${nb-slug}__${shortId}__${title-slug}.ext` (shortId = 8자 16진수)
- dedup: 매 push 전 `docs/episodes/` 를 list 해서 `__${shortId}__` substring 매칭 — 제목이 바뀌어도 같은 UUID 면 same hit → push skip + SW fetch 자체 생략 (대역폭 절약)
- backward compat: shortId 가 도입되기 전 push 된 옛 3-segment 파일은 (date, titleSlug, ext) 매칭. 노트북 슬러그는 매칭 키에서 제외 — 사용자가 NotebookLM 에서 노트북 이름을 바꾼 뒤 같은 카드를 다시 받아도 dedup 이 동작하도록 (실제 마이그레이션 테스트에서 노트북 rename 시 매칭 미스가 발견되어 적용). feed.js / build_feed.py 의 `FILENAME_RE` 도 shortId 그룹 옵셔널로 양쪽 포맷 파싱.
- list 실패 시 fallback: 옛 ghGet 기반 path 일치 검사가 이중 안전망으로 남음.

구현 위치: [src/content.js](src/content.js) (`ARTIFACT_ID_RE` + `getArtifactId`), [src/background.js](src/background.js) (`shortIdOf`, `buildFilename(meta, ext, shortId)`, `legacyFilenameMatches`, `ghList`), [src/feed.js](src/feed.js) + [examples/feed-builder/scripts/build_feed.py](examples/feed-builder/scripts/build_feed.py) (`FILENAME_RE` 옵셔널 shortId 그룹).

#### GitHub Contents API HTTP 캐시 ⚠ 주의

GitHub `/repos/{owner}/{repo}/contents/...` GET 응답은 `Cache-Control: private, max-age=60` 으로 60초간 브라우저 HTTP 캐시에 머문다. PUT 직후 같은 디렉토리를 다시 list 하면 stale listing 이 와서 dedup 매칭이 미스 → 같은 audio 의 SW fetch 가 낭비되는 사고 발생 (실측에서 8.1MB push 직후 같은 카드 재클릭 시 list 가 새 파일을 못 찾아 fetch + 그 다음 ghGet 정확 path 폴백이 잡음). 모든 GitHub GET fetch 에 `cache: "no-store"` 적용 — extension push 흐름에서 dedup 정확성 > 60초 캐시 절약.

#### retention 영구 루프 + bulk skip cutoff + 영구 스킵 목록 (v0.4.32, 2026-05-10)

증상: bulk 81 직후 docs/episodes/ 사용량이 retention.maxTotalMB (900) 한도 초과 → workflow 가 막 push 한 episode 부터 옛것순 자동 삭제. 익스텐션의 다음 스캔이 그 카드를 신규로 재인식 → push → 즉시 retention 컷 → 영구 다운로드 루프. v0.4.31 의 artifact-labels race fix 와 titleKeys fallback 도 이 케이스엔 효과 없음 — GitHub 에 파일 자체가 안 남기 때문.

구조적 결함: retention 컷오프와 익스텐션 dedup 의 출처가 같은 곳 (docs/episodes/) 이라는 점. 한도 증액은 시간 벌기지 근본 fix 아님.

v0.4.32 의 세 갈래 fix:
1. **bulkSkipOlderDays cutoff (익스텐션 측)**: 노트북 cover-subtitle-date 가 N 일 이상 옛것이면 buildNewSelections 에서 통째로 스킵. default 730 (2년). 옵션 페이지에 입력란. retention.maxAgeDays 와 같은 기준을 익스텐션 측에 두면, 옛 노트북 카드가 push → workflow 즉시 컷 사이클이 처음부터 발동 안 함.
2. **영구 스킵 목록**: chrome.storage.sync 의 `skippedShortIds` (Set<8자 shortId>). 사용자가 에피소드 목록의 [삭제] / [스킵] 액션으로 명시 등록. buildNewSelections + scan:result:pushed 에 적용. 다기기 sync 공유. quota: shortId 8자 × 1만건 ≈ 80KB ≤ 100KB.
3. **저장소 사용량 + cutoff 안내 UI**: 진행 모니터 + 에피소드 목록 양쪽에 storage-usage-panel. 현재 사용량 / 한도 / % 진행바 (75% 노랑, 90% 빨강) + "한도 초과 시 옛것부터 자동 삭제 / 2년 이전 카드 스킵" 안내. background 의 `storage:usage` 핸들러가 ghList + podcast.json regex 로 maxTotalMB 추출.

에피소드 목록 row 에 [스킵] 액션 추가 — 삭제 안 하고 영구 스킵만 등록. [스킵 목록] 토글 버튼으로 패널 펼침 — 등록된 shortId 목록 + 개별 [해제] + [전체 해제].

#### artifact-labels 늦은 렌더 race (v0.4.31, 2026-05-10)

증상: bulk 다운로드 81개 성공 직후 다시 스캔하면 같은 81개 중 80개가 다시 "신규" 로 잡혀 같은 카드 반복 다운로드.

원인: content.js 의 `scan` 핸들러가 `getCover()` + `getAudioCards()` 를 동기적으로 한 번 부르고 즉시 응답. 카드 제목 (`.artifact-title`) 은 떠 있어도 `<span id="artifact-labels-{UUID}">` 와 `.cover-subtitle-date` 의 `title` 속성은 그보다 늦게 채워지는 경우가 잦다. 그 race 윈도우에서 응답하면 audios 의 `artifactId` 가 빈 문자열, cover 의 `dateAttr` 도 빈 문자열. 4-segment 파일 dedup 은 100% shortId 매칭이라 빈 artifactId 로는 절대 안 맞고, `dateAttr` 도 비어 있으면 legacy fallback 도 죽는다 → 모든 카드가 신규로 잡힘.

수정 (v0.4.31):
- content.js `scan` 핸들러를 async 로 바꿔 dedup 키 (artifactId, cover.dateAttr) 가 채워질 때까지 100ms 폴링, 최대 3초 budget 후 best-effort 응답.
- background.js `loadPushedIndex` 에 `titleKeys` 보조 인덱스 추가 — 4-segment 파일도 (date, titleSlug, ext) 키로 함께 인덱싱. `isAudioPushed` 가 shortId 미스 시 이 키로 fallback 매칭. push 경로의 `pushEpisode` 도 `titleFilenameMatches` 추가로 같은 fallback 적용.

향후 NotebookLM 이 DOM 구조를 바꿔 artifact-labels 가 영영 안 뜨면 다시 v1 처럼 (date, title) 기반 dedup 으로 운영 — fallback 인덱스가 그 안전망 역할도 겸한다.

#### v0.4.42 버그 수정 및 최적화 (2026-05-20)

10가지 버그/최적화 일괄 적용.

**버그 수정 4건**

1. **scan 폴링 — 음성개요 0개 노트북 3초 대기 (content.js)**
   - 원인: `scan` 핸들러의 ready 조건 `real.length > 0 && real.every(...)` 에서 음성개요가 없으면 `real.length === 0` 이라 항상 false → 3초 budget 을 전부 소진.
   - 수정: `real.length === 0 || real.every(a => a.artifactId)` — 음성개요가 없으면 dateAttr 가 채워지는 즉시 반환. scan:all 에서 빈 노트북이 많을수록 효과 큼.

2. **awaitPushResult 타임아웃 불일치 (popup.js)**
   - 원인: popup 의 `awaitPushResult` default timeout 이 180s (3분) 인데 background 의 `PUSH_HARD_TIMEOUT` 은 900s (15분). 큰 파일 (40MB+ m4a) push 가 3분 넘으면 popup 이 먼저 포기 — UI 는 응답 없음 상태로 멈추고 결과 배지가 표시되지 않음.
   - 수정: popup timeout 을 900s 로 background 와 일치.

3. **saveSkippedEntries sync quota 초과 처리 (background.js)**
   - 원인: `entries.length > 100` 조건으로 trim 여부를 결정했는데, entry 1건 ≈ 250byte 이고 chrome.storage.sync item 한도는 8KB. 32건만 넘어도 초과 가능 → 100건 이하면 그냥 throw 해서 저장 실패.
   - 수정: 건수 무관, quota 초과 시 항상 20% (가장 옛것) 잘라내고 재시도.

4. **notifyBulkComplete 알림 텍스트 항상 영어 (background.js)**
   - 원인: 알림 문자열이 하드코딩 영어 — 한국어/독어 설정 무시.
   - 수정: `cfgGet(["uiLang"])` 으로 현재 언어 읽어 한·영·독 분기. 함수를 async 로 변경, 호출부 `await` 추가.

**최적화 6건**

5. **setTaskState storage.session.set 쓰로틀 (background.js)**
   - offscreen 의 250ms 진행 비콘이 `emitCardProgress → setTaskState({ currentCardProgress })` 를 경유해 매번 `storage.session.set` 을 트리거. 메모리 갱신 + runtime broadcast 는 즉시 유지하면서, `currentCardProgress` 만 변경하는 호출의 storage write 를 500ms debounce. 상태 전환 (status/phase/done 등) 은 즉시 persist 그대로.

6. **ghList in-memory TTL 캐시 (background.js)**
   - `list:pushed`, `buildNewSelections`, `storage:usage`, `storage:cleanup`, `pushEpisode` 가 각각 독립적으로 `ghList("docs/episodes")` 를 호출 — 같은 SW 안에서 수십ms 안에 GitHub API 를 여러 번 hit. 30초 TTL 인메모리 캐시 추가. push 성공 후 `invalidateGhListCache` 로 즉시 무효화 — dedup 정확성 유지.

7. **FILENAME_RE 중복 정의 해소 (feed.js + background.js)**
   - `feed.js` 와 `background.js` 가 각각 독립적으로 `FILENAME_RE` 를 정의하되, feed.js 에는 `i` 플래그 없고 background.js 에는 있어 불일치. feed.js 에 `i` 플래그 추가 + `export`, background.js 에서 import 해 로컬 재정의 제거.

8. **AudioContext 재사용 (transcode.js)**
   - 트랜스코딩마다 `new AudioContext()` + `close()` 반복. bulk 81건이면 81번 생성/폐기. 모듈 레벨 `_sharedAudioCtx` 로 offscreen document 수명 동안 하나만 유지. `state === "closed"` 이면 재생성.

9. **waitForAudioCards 이중 폴링 구조 문서화**
   - background.js `waitForAudioCards` 가 700ms 간격으로 `sendMessageWithTimeout(scan, 5000)` 을 반복하고, content.js `scan` 핸들러도 내부적으로 100ms × 3000ms 폴링. 최악 8초. content.js fix #1 (빈 노트북 즉시 반환) 로 대다수 케이스에서 content.js 쪽 지연이 크게 줄었으므로 background 폴링 간격은 현행 유지 (추후 개선 여지 있음).

10. **list:pushed 이중 API 호출 (popup.js)**
    - popup 오픈 시 캐시 복원 → `renderAggregate` 가 `list:pushed` 를 호출하고, 이후 `scan:all:done` 이 다시 `renderAggregate` 를 호출해 두 번 fetch. background.js ghList 캐시 (#6) 가 두 번째 호출을 캐시 hit 으로 처리하므로 popup 레벨 별도 캐시 없이 해결됨.

---

## 2. audio URL 재fetch 의 인증/CORS 체인

### 배경

v0.3.0 ([af1cb2f](https://github.com/kiuk104/notebooklm-podcast-extension/commit/af1cb2f)) 부터 다운로드 트리거가 발사되는 순간 SW 가 같은 audio URL 을 한 번 더 fetch 해서 GitHub Contents API 로 PUT 한다 (Chrome 의 로컬 다운로드와 병렬). 문제는 그 audio URL 이 단순 정적 파일이 아니라는 점.

### 인증 체인의 실제 모양

NotebookLM 의 audio overview URL 은 `lh3.googleusercontent.com/...` signed URL 형태인데, path 토큰만으로는 인증이 부족해 CDN 이 다음과 같이 redirect 시킨다:

```
lh3.googleusercontent.com
  → accounts.google.com/ServiceLogin           (로그인 확인)
  → lh3.google.com/rd-notebooklm                (NotebookLM 전용 redirector)
  → drum.usercontent.google.com/...             (실제 audio 응답)
```

`.google.com` 세션 쿠키가 체인 내내 동행해야 ServiceLogin 이 자동 통과되고 마지막 응답까지 도달함.

### 시도 1: SW direct fetch + `credentials:"omit"` (af1cb2f)

- 결과: ServiceLogin redirect target 호스트가 `manifest.host_permissions` 밖이라 CORS 차단.
- 학습: SW fetch 도 chrome 익스텐션 origin 에서 나가는 거라 redirect 체인의 *모든* 호스트가 host_permissions 에 들어 있어야 CORS 면제됨.

### 시도 2: page-world fetch via `chrome.scripting.executeScript` ([6e2405a](https://github.com/kiuk104/notebooklm-podcast-extension/commit/6e2405a))

- 발상: notebooklm.google.com 페이지 컨텍스트에서 fetch 하면 same-origin 으로 통과하지 않을까.
- 결과: CDN 이 `Access-Control-Allow-Origin` 헤더를 notebooklm origin 으로 안 보내서 CORS 차단. credentials 설정과 무관하게 실패.
- 학습: page-world fetch 는 same-origin 일 때만 의미가 있고, cross-origin 이면 CDN 측 ACAO 에 의존 — 통제 불가.
- 비용: tabId 플러밍, executeScript 권한, 추가 메시지 holding — 그 모두를 [ac13fef](https://github.com/kiuk104/notebooklm-podcast-extension/commit/ac13fef) 에서 다시 걷어냄.

### 시도 3 (현재): SW direct fetch + `credentials:"include"` + 확장된 host_permissions (ac13fef)

- 변경: `manifest.json` 에 `accounts.google.com`, `lh3.google.com`, `*.usercontent.google.com` 추가. SW fetch 가 `credentials:"include"` 로 세션 쿠키 동행.
- 이론: host_permissions 가 redirect 체인의 모든 호스트를 커버하면 SW 가 각 hop 에서 CORS 면제 + 세션 쿠키로 ServiceLogin 자동 통과 → 최종 audio 응답 도달.
- 검증 상태: **✅ 작동 확인 (2026-04-29)**. 22.3MB m4a 가 SW devtools 에 `[push] fetched 22.3MB` 로 찍힘. 인증 체인은 닫힘.

### fallback 후보 (현재로선 불필요)

1. **`chrome.downloads.download({ url, ... }) ` 결과 파일을 SW 에서 read** — 시도 3 가 깨지면 Chrome 이 이미 받은 로컬 파일을 디스크에서 다시 읽어서 PUT.
2. **ArrayBuffer 를 page-world 에서 받아 SW 로 postMessage** — 시도 2 의 변형이지만 CORS 가 안 풀리면 의미 없음.
3. **`webRequest` 로 audio response 가로채서 body 캡처** — Manifest V3 에서는 `webRequest.filterResponseData` 가 빠져 있어 사실상 불가.

---

## 3. GitHub Contents API 401 Bad credentials (2026-04-29, 해결됨)

### 증상

시도 3 이 audio 를 정상적으로 가져온 직후 [src/background.js:138](src/background.js#L138) 의 `ghGet` 이:

```
401 {"message": "Bad credentials", "documentation_url": "https://docs.github.com/rest", "status": "401"}
```

audio fetch / 파일명 / 흐름 자체는 다 멀쩡하고 토큰 인증 단계만 실패.

### 원인

옵션 페이지에 저장된 PAT 가 무효. 코드 (저장 [src/options/options.js:25-30](src/options/options.js#L25-L30) ↔ 로드 [src/background.js:79-81](src/background.js#L79-L81), 둘 다 `.trim()`) 자체는 깨끗했음.

### 해결

옵션 페이지에서 token 새로 paste 후 동일 audio 재시도 → `[push] ... pushed (22.3MB)` 로그까지 정상 흐름 확인. 토큰 만료 / 잘못된 입력 / scope 부족 중 하나가 원인이었던 것으로 추정 (사용자 측 재입력으로 해결되었으므로 정확한 원인은 사후 추적 불가).

### 학습 포인트 (v0.4.0 에서 처리됨)

- 401 같은 인증 실패는 옵션 페이지로 바로 안내하는 동선이 더 친절함 → ✅ **v0.4.0 추가**: 옵션 페이지에 [설정 검증] 버튼 ([src/options/options.js](src/options/options.js)). `/user` 로 토큰 자체, `/repos/{repo}` 로 repo 접근/push 권한 확인. 401, 404, 권한 부족 케이스를 한 번에 잡아 저장 시점에서 사고 차단.

---

## 4. v0.4.0 디자인 결정 / 함정

### RSS 두 모드의 메타 source-of-truth = `docs/podcast.json`

옵션 페이지의 `rssMode` 가 두 모드를 가르지만, RSS 의 메타 (title/owner/image/retention/transcode) 는 양쪽 모두 repo 의 `docs/podcast.json` 에서 읽는다. 두 모드를 왔다갔다 해도 feed 가 동일하게 빌드되는 게 디자인 원칙. 익스텐션 옵션에 메타 폼을 추가하지 않은 이유 — 옵션이 source 가 되는 순간 두 모드 불일치 가능.

### `retention` 의 AND 의미

`maxItems` + `maxAgeDays` 둘 다 설정 시 둘 다 통과해야 keep — 더 짧은 정책이 실질 적용. 사용자가 "둘 다 설정하면 어느 쪽이 우선?" 으로 헷갈릴 수 있어 도움말 / example README 에 명시 필요. 한 쪽만 쓰려면 다른 쪽을 빼는 게 안전 (`0` 도 비활성으로 처리).

### transcode + 익스텐션 직접 RSS 모드 (4-2) 의 race

워크플로 transcode 를 켰는데 RSS 모드도 4-2 (익스텐션 직접) 면:
1. 익스텐션이 m4a push → 익스텐션이 m4a 기준 feed 빌드 (잠시 m4a URL 노출)
2. 워크플로가 트리거 → m4a → mp3 + retention + 워크플로 측 feed 재빌드 (mp3 URL 로 갱신)

30초~1분 사이에 팟캐스트 앱이 m4a URL 을 잡았다 mp3 로 바뀌면 또 받음. 동작 자체는 OK 지만 부담. 권장: transcode 켜면 RSS 모드도 4-1 (Actions 위임) 로 통일. 도움말 §6 에 명시.

### `host_permissions` 확장의 적정 경계

audio fetch 를 위해 `accounts.google.com`, `lh3.google.com`, `*.usercontent.google.com` 까지 host_permissions 에 들어 있다. Chrome Web Store 심사 시 "왜 그렇게 많이?" 가 질문될 수 있어 `host_permissions justification` 미리 준비 필요 (§2 의 redirect 체인 설명을 그대로 인용). 사용자 입장에서도 권한 페이지에서 보이는 호스트 목록이 길어 보임 — 도움말 §9 (권한 & 프라이버시) 에 redirect 체인 이유를 명시한 이유.

---

## 5. Chrome `chrome.tabs.create` / `.remove` 의 transient error (2026-04-30)

### 증상

cross-notebook sweep ([모든 노트북 스캔]) 중 50+ 노트북이 줄줄이:

```
Tabs cannot be edited right now (user may be dragging a tab).
```

스캔 자체는 통째로 실패해서 노트북 0개 / 카드 0개로 끝남. SW console 에 50줄 넘게 같은 메시지 도배.

### 원인

메시지가 시사하는 "사용자가 탭 드래그 중" 은 케이스의 일부일 뿐. 실제로는:

1. **빠른 연속 `chrome.tabs.create` / `.remove`** — 탭바의 슬라이드 애니메이션이 진행 중일 때 새 호출이 들어오면 reject. sweep 처럼 노트북 하나당 create + close 를 반복하면 첫 close 의 애니메이션이 끝나기 전에 다음 create 가 들어가기 쉬움.
2. **다른 익스텐션과의 충돌** — tab grouping / OneTab / session manager 류가 동시에 chrome.tabs API 를 만지면 서로 lock 충돌.
3. **Chrome 내부 rate limit** — 짧은 시간 내 너무 많은 tab 조작 (관찰: 100+ create/close/min 정도) 에서 일정 기간 reject.

한 번 reject 하면 그 다음 호출도 같은 패턴으로 reject 하는 경향 — 캐스케이드. 사용자 보기엔 "스캔이 통째로 실패" 처럼 보임.

### 대응 (v0.4.0 patch)

[src/background.js](src/background.js) 의 `withTabRetry` + 200ms breather + 5회 연속 실패 시 abort.

```js
const TRANSIENT_TAB_ERROR_RE = /Tabs cannot be edited|may be dragging|tab strip|currently in use/i;

async function withTabRetry(fn, label, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!TRANSIENT_TAB_ERROR_RE.test(e.message)) throw e;
      const delay = 500 + attempt * attempt * 500; // 500/1.5s/3s/5s/8s
      await sleep(delay);
    }
  }
  throw lastErr;
}
```

`chrome.tabs.create` / `chrome.tabs.remove` 모두 `withTabRetry` 로 감싸고, 노트북 사이마다 `await sleep(200)` breather 추가. 5회 연속 같은 transient error 면 task 자체를 abort (메시지: "Chrome 탭 API 잠김. 탭바 드래그 해제 / 다른 익스텐션 비활성화 후 재시도. 기존 성공 N개 결과는 보존됨.").

### 학습

- Chrome 의 tab API 는 내부 lock 이 자주 발생하는 영역이라 retry-with-backoff 가 정석.
- 다중 tab orchestration 코드는 모두 retry wrapper 통해 호출하는 게 안전.
- 메시지 string 매칭은 fragile 하지만 (`message` 자체가 Chrome 버전마다 미세하게 다를 수 있음) 더 나은 detection 수단이 없음 — `chrome.runtime.lastError` 도 같은 string 을 담음.

---

## 6. MV3 Service Worker idle 종료 + chrome.tabs.sendMessage 영구 pending (2026-04-30)

### 증상

bulk:remote 가 153 개 카드 중 0/153 에서 1시간 25분 동안 멈춤. 진행 모니터에 `다운로드 중: <첫 카드 제목>` 메시지가 떠 있고 경과 시간만 흘러감. 사용자 [강제 중단] 도 전엔 클리어할 방법 없음.

### 원인 — 두 갈래

**(a) `chrome.tabs.sendMessage` 영구 pending**: bulk 의 download 메시지가 첫 카드의 노트북 탭으로 갔는데 content script 가 응답을 못 함. NotebookLM SPA freeze / 탭 navigate / content script crash 어느 쪽이든 가능. Chrome 의 sendMessage 는 timeout 이 없어서 영원히 await 가 걸림.

**(b) MV3 service worker idle 종료**: 153 카드 × ~30~60초 = 1.5~2.5시간. SW 는 활성 작업 (Chrome API 호출) 이 ~30초 이상 없으면 종료. retry backoff 의 `sleep(8000)` 이나 sendMessage timeout (30초) 같은 idle 구간에서 SW 가 죽으면, 재시작 후 currentTaskState 는 session storage 에서 그대로 복원되어 status: "running" 로 유지 — 하지만 실제 함수는 죽었으므로 진행 0.

### 대응

**(a) sendMessageWithTimeout** — `Promise.race` 로 30초 timeout. 응답 없으면 throw → 기존 catch 에서 `done++` + 다음 카드.
```js
async function sendMessageWithTimeout(tabId, msg, timeoutMs = 30000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`tabs.sendMessage timeout (${timeoutMs}ms)`)), timeoutMs,
    )),
  ]);
}
```

**(b) 두 단계 방어**:

1. **chrome.alarms keepalive** (proactive). 30초 주기 알람을 task 시작 시 set, finally 에서 clear. 알람 발화 자체가 SW wake 이벤트라 SW 가 idle 로 죽지 않음. MV3 standard pattern.
   ```js
   await chrome.alarms.create("task-keepalive", { periodInMinutes: 0.5 });
   ```
   `manifest.json` 의 `permissions` 에 `"alarms"` 추가 필요.

2. **Heartbeat-based stale detection** (reactive, 안전망). `setTaskState` 마다 `lastHeartbeatAt: Date.now()` 갱신. SW init 시 복원된 state 의 heartbeat 가 90초+ 전이면 stalled 로 판단해 `status: "failed"` 로 전환. UI 가 영구 "running" 갇힘 방지.

3. **사용자 [강제 중단] 버튼**. 진행 모니터에 cancel 버튼 추가. `task:cancel` 메시지 → `cancelRequested = true` → 루프가 다음 iteration 시작 시 즉시 빠져나감.

### 학습

- 장시간 백그라운드 작업은 **반드시** chrome.alarms keepalive 로 SW 살려두기.
- Idle 종료 가능성을 가정한 **graceful failure** 가 필요 — heartbeat / cancel / state restoration 점검.
- 외부 API (sendMessage, fetch) 호출은 모두 명시적 timeout 으로 wrap. Chrome API 들은 reject 하지만 동기 응답을 기다리는 sendMessage 는 무한 대기 가능.

---

## 7. Zombie task — keepalive 가 stale 검지를 우회 (2026-05-01)

### 증상

bulk:remote 가 175개 카드 중 0/175 에서 33분 멈춤. 진행 모니터는 "진행 중" 배지 + `다운로드 중: <첫 카드 제목>` 메시지 + 경과 시간만 흐름. §6 fix (sendMessageWithTimeout + chrome.alarms keepalive + heartbeat stale 검지) 가 모두 들어간 상태에서 발생.

### 원인 — §6 fix 의 미스 매칭

§6 의 두 방어선이 서로 충돌:

- **chrome.alarms onAlarm handler 가 heartbeat 를 맹목적 갱신**:
  ```js
  if (currentTaskState.status === "running") {
    currentTaskState.lastHeartbeatAt = Date.now();
  }
  ```
  alarm 은 SW 죽음을 넘어 persist (Chrome 이 alarm 등록을 따로 보관). 그래서 SW 가 죽었다 살아나면 — `inProgressTask = null`, runBulkRemote 의 await 체인은 GC 됐는데 — alarm 만 30초 주기로 계속 발화하며 heartbeat 를 갱신.

- **startup IIFE 의 stale 검지가 90초 threshold 사용**:
  ```js
  if (stale > STALE_HEARTBEAT_MS) restored.status = "failed";
  ```
  alarm 이 30초마다 갱신하므로 heartbeat 는 항상 30초 이내 → 90초 threshold 에 안 걸림 → status: "running" 그대로 보존.

- **task:cancel handler 가 inProgressTask 만 봄**:
  ```js
  if (!inProgressTask) sendResponse({ ok: false, error: "진행 중인 작업이 없습니다" });
  ```
  Zombie 상태에서 `inProgressTask = null` 이라 [강제 중단] 클릭해도 "no task" 응답만 받고 UI 변화 없음 — 사용자가 익스텐션 reload 외에 빠져나갈 길 없음.

### 대응 (3 군데 동시 패치)

1. **Startup IIFE 강화**: heartbeat threshold 제거. `restored.status === "running"` 자체를 zombie 신호로 봄 — MV3 SW 재시작은 항상 script 재실행 = in-flight Promise/timer 모두 GC. 어떤 heartbeat 값이든 의미 없음.
   ```js
   if (restored.status === "running") {
     restored.status = "failed";
     restored.message = `SW 재시작으로 작업이 중단됐습니다 (진행 ${done}/${total}).`;
   }
   ```

2. **Alarm handler 가 inProgressTask 로 게이트**: zombie alarm 이 heartbeat 갱신해버리는 경로 차단. inProgressTask 가 null 이면 alarm 자체를 정리.
   ```js
   if (!inProgressTask) {
     await chrome.alarms.clear(KEEPALIVE_ALARM);
     return;
   }
   ```

3. **task:cancel zombie 탈출구**: `inProgressTask` 는 없는데 `currentTaskState.status === "running"` 인 경우 force-fail 처리. UI 의 [강제 중단] 이 zombie 상태에서도 작동하게.

### 학습

- **방어선이 여러 개일 때 서로 무력화하지 않는지 검토.** §6 의 keepalive (proactive) 와 stale 검지 (reactive) 가 상호작용해서 stale 검지가 무력화됨. 각 방어선의 trigger 조건을 분리해야 함.
- **`inProgressTask` 가 SW liveness 의 ground truth**. 모듈 스코프 변수라 SW 재시작에 살아남지 못함 = 재시작 직후 항상 null = zombie 검지에 활용 가능. heartbeat 값 자체는 alarm 에 오염되므로 신뢰하지 말 것.
- **SW 재시작 자체를 root cause 로 두지 말 것.** keepalive 가 있어도 아주 드물게 SW 가 죽을 수 있음 (Chrome 시스템 종료, 프로파일 sync, 메모리 압박, 사용자 알람 권한 회수 등). "절대 일어나면 안 됨" 이 아니라 "일어나도 회복 가능" 이 목표.

---

## 8. Contents API 50 MiB 한계 — Git Data API fallback (2026-05-01)

### 증상

```
ghPut docs/episodes/...m4a: 422
{"message":"Sorry, the file is too large to be processed.
 Consider creating/updating the file in a local clone and pushing
 it to GitHub."}
```

46.6 MB m4a 푸시 실패. NotebookLM 의 긴 음성개요 (20분+) 가 흔히 40~60 MB 라 빈발.

### 원인

GitHub Contents API 는 raw 50 MiB 한계가 있는데 base64 인코딩이 33% 부풀려 실질 한계는 ~37 MiB. 46.6 MB raw → 62 MB base64 → 한계 초과 → 422.

### 대응

`ghPut` 이 422 + "too large" 응답을 만나면 자동으로 `ghPutLargeFile` 로 fallback. Git Data API 의 5 단계 chained 호출:

```
1. GET   /repos/:repo                     → default_branch
2. GET   /git/ref/heads/:branch           → parent commit sha
3. GET   /git/commits/:sha                → base tree sha
4. POST  /git/blobs                       → blob sha (큰 파일 ←)
5. POST  /git/trees                       → new tree sha
6. POST  /git/commits                     → new commit sha
7. PATCH /git/refs/heads/:branch          → ref advance
```

Git Data API 는 100 MiB 까지 지원 (blobs hard limit). 호출이 7번이라 latency 는 길어지지만 large file 만 이 경로로 와서 평균 영향 작음.

### 학습

- **Contents API 는 small files 용**. 정확한 한계는 50 MiB raw 이지만 base64 inflation 으로 실질 ~37 MiB. Audio 같은 binary 는 Git Data API 가 정공법.
- Fallback 트리거를 `r.status === 422` 만으론 부족 — 422 는 validation 오류 등 다른 원인도 있어 응답 본문의 "too large" 매칭으로 좁혀야 함.
- default branch 가정 금지 (`main`/`master`/사용자 지정). `GET /repos/:repo` 의 `default_branch` 필드로 확인.
- Race condition: `git/ref` GET 과 `PATCH` 사이에 다른 commit 이 들어오면 "not a fast-forward" 422. bulk:remote 는 직렬이라 현재는 무관하지만, 다중 client 환경에선 retry 필요.

---

## 9. NotebookLM 이 background tab 의 download 트리거 거부 (2026-05-01)

### 증상

bulk:remote 가 모든 카드에서 "push 응답 타임아웃" 으로 실패 — 단건 popup download (active tab) 는 정상 작동. SW 콘솔에 `[scan:all] auto-download: 206 카드 시작` 로그만 있고 `[push] SW fetch host=...` 가 *전혀* 안 찍힘. `chrome://downloads` 에 NotebookLM 출처 다운로드가 *zero*.

### 원인

NotebookLM 내부 JS 가 다운로드 트리거 시 `document.visibilityState` (또는 유사한 가시성 검사) 를 확인하는 것으로 보임. content.js 가 background tab 에서 ⋮ → 다운로드 메뉴 클릭은 *성공* 시키지만 (메뉴 DOM 자체는 클릭 가능) NotebookLM 이 audio 스트림을 시작하지 않음 → `chrome.downloads.onDeterminingFilename` 자체가 발화 안 함 → pushEpisode 호출 안 됨 → waitPushResultLocal 영원히 대기.

`chrome.tabs.create({ active: false })` 는 tab 을 background 로 두는데, `document.visibilityState === 'hidden'` 이 됨. NotebookLM 은 이 상태에서 download 를 거부.

### 대응 — 전용 popup window

해결책: `chrome.windows.create({ focused: false, type: 'popup' })` 로 별도 popup window 를 띄우고 그 안에서 tab 을 만든다. 결과:

- 메인 윈도우 focus 유지 (사용자 작업 흐름 안 끊김)
- popup window 는 화면에 visible (background 라도 visibilityState='visible')
- 그 안의 tab 은 active (그 윈도우의 유일/현재 탭)
- NotebookLM 이 download 트리거 발사 → onDeterminingFilename 발화 → pushEpisode 정상

```js
let bulkWindowId = null;
async function ensureBulkWindow() {
  if (bulkWindowId !== null) {
    try { await chrome.windows.get(bulkWindowId); return bulkWindowId; }
    catch { bulkWindowId = null; }
  }
  const win = await chrome.windows.create({
    url: "about:blank", type: "popup", focused: false,
    width: 800, height: 600,
  });
  bulkWindowId = win.id;
  return bulkWindowId;
}
```

`openManagedTab(url, { bulkWindow: true })` 로 bulk:remote 만 이 경로 사용. scan:all 은 background tab 으로 충분 (스캔은 download 트리거 안 함).

### 학습 (이 fix 로 해결됨 — §10 으로 후속)

popup window 자체는 *부분 진전* — chrome.debugger 와 함께 쓰는 셋업 의 first stage. visibility 통과만으론 안 되고 진짜 user input 까지 필요하다는 게 이 stage 에서 드러남 (§10).

---

## 10. NotebookLM 의 user-activation gate — chrome.debugger 로 trusted input 주입 (2026-05-01)

### 증상

§9 의 popup window (focused:false → focused:true 까지 시도) 에도 불구하고 bulk:remote 의 모든 카드가 timeout. SW 콘솔에 `[bulkWindow] created focused=true` 까지는 찍히지만 `[push] SW fetch host=...` 는 *전혀* 안 나옴. 즉 popup 이 visible + focused 인 상태인데도 NotebookLM 이 download 트리거를 발사 안 함.

### 원인

NotebookLM 의 download flow 는 `isTrusted=true` event 또는 `userActivation` 을 요구. content.js 의 `element.click()` 은 programmatic 호출이라 `isTrusted=false` 이고, background SW 에서 시작된 호출 chain 은 user activation token 을 가지지 않음. 단건 download (popup 모드) 는 사용자가 *익스텐션 popup 버튼을 직접 클릭* 한 활성화가 chain 으로 propagate 돼서 통과 — bulk 는 그 origin 이 없음.

JS 에서 `isTrusted` / `userActivation` 은 read-only 로 fake 못 함. 브라우저 C++ 레벨의 input event 만 진짜 user gesture 로 인식됨.

### 대응 — chrome.debugger.Input.dispatchMouseEvent

`chrome.debugger` API 의 `Input.dispatchMouseEvent` 가 정확히 그 용도. 브라우저 input pipeline 에 mouse event 를 합성 — 페이지는 진짜 사용자 클릭으로 인식 (`isTrusted=true`, user activation 부여).

흐름:

```
content.js                background SW (debugger)
    │                            │
    │ download:prepare           │
    │   (find card, scroll,      │
    │    return moreButton x,y)  │
    │ ──────────────────────────▶│
    │                            │ clickViaDebugger(x, y)
    │                            │   = mouseMoved → mousePressed → mouseReleased
    │                            │ (NotebookLM 이 진짜 클릭으로 인식)
    │                            │
    │ download:menucoords        │
    │   (popover 메뉴의           │
    │    "다운로드" 좌표 반환)    │
    │ ──────────────────────────▶│
    │                            │ clickViaDebugger(menuX, menuY)
    │                            │
    │   (NotebookLM 이 audio      │
    │    fetch 시작 → Chrome      │
    │    onDeterminingFilename)  │
```

핵심 코드:
```js
async function clickViaDebugger(tabId, x, y) {
  const target = { tabId };
  const base = { x, y, button: "left", clickCount: 1, buttons: 0 };
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
    { ...base, type: "mouseMoved", button: "none" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
    { ...base, type: "mousePressed" });
  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent",
    { ...base, type: "mouseReleased" });
}
```

`openManagedTab` 의 `bulkWindow:true` 경로에서 탭 생성 후 즉시 `chrome.debugger.attach({ tabId }, "1.3")` — 탭 닫히면 자동 detach.

### 비용

- `manifest.json` 의 `permissions` 에 `"debugger"` 추가 → 익스텐션 업데이트 시 사용자 재승인 필요 ("This extension can debug your browser").
- attach 된 탭 상단에 노란 배너 *"Extension started debugging this browser"* 가 뜸 — popup window 안이라 메인 작업엔 안 보이지만 popup 봤을 때 거추장.
- chrome.debugger 는 다른 attached debugger 와 충돌 — 사용자가 같은 탭에 DevTools 열고 있으면 attach 실패.

### 학습

- **isTrusted / userActivation 은 read-only** — JS 에서 fake 불가. C++ 레벨 input pipeline 만 진짜 user gesture 부여.
- **chrome.scripting.executeScript 도 부족** — `world: "MAIN"` 으로 page world 에서 실행해도 그 자체로 user activation 발급 안 됨. 같은 일을 페이지 JS 가 직접 하는 거랑 동등.
- **단건 popup download 가 작동한 이유** — 사용자가 익스텐션 popup 버튼 클릭 → activation token → sendMessage chain 으로 content script 까지 전달 → click() 이 그 token 안에서 발사. bulk 는 SW 에서 시작이라 token 자체가 없음.
- **chrome.debugger 는 "사용자 자동화" 의 정공법** — Selenium, Puppeteer, 모든 browser automation 이 같은 메커니즘. permission cost 가 있지만 회피 불가능한 케이스가 명확하면 받아들여야 함.
- **§9 의 popup window 와 함께 써야 효과** — chrome.debugger 만 main window 의 background tab 에 attach 해도 NotebookLM 이 visibility 까지 검사할 수 있어 hybrid 가 안전. 둘 다 layered defense.

---

## 11. Offscreen transcode 의 30s lifetime 함정 (2026-05-02)

### 증상

20분+ 음성개요의 m4a → mp3 transcode 가 큰 파일에서 일관되게 실패. Offscreen 콘솔에 작업이 시작되지만 완료 직전에 document 가 사라지고, SW 측 `transcode:request` 의 `chrome.runtime.sendMessage` 가 `Could not establish connection. Receiving end does not exist.` 로 reject. 작은 m4a (수 MB) 는 정상.

### 원인 — 세 가지 lifetime 문제 동시 발생

(a) **`chrome.offscreen` document 의 reason 별 lifetime**: `reasons: ["WORKERS"]` 만 선언하면 brief lifetime 으로 처리되어 ~30 초 후 닫힘. `AUDIO_PLAYBACK` 만 다른 reason 들과 결합 가능한 long-lived 카테고리 (지속 oscillator/silent audio source 가 살아있어야 함).

(b) **`chrome.runtime.sendMessage` 의 single-shot JSON 직렬화**: ArrayBuffer 가 sendMessage 통과 시 plain `{}` 로 마감되어 lamejs 가 길이 0 buffer 받음. 우회 시도였던 base64 encoding 도 50 MB raw → 67 MB string → message channel close 로 실패.

(c) **Service worker idle 30s**: SW 가 sendMessage 의 await 중에 idle 로 죽으면 receiver (offscreen) 가 응답해도 reply 라우팅 끊김.

### 대응 — 3 단 패치 (`v0.4.14` ~ `v0.4.18`)

**1) Multi-reason offscreen + 무음 audio loop**:
```js
await chrome.offscreen.createDocument({
  url: "src/offscreen/transcode.html",
  reasons: ["AUDIO_PLAYBACK", "BLOBS", "WORKERS"],
  justification: "Decode m4a/mp4 + encode mp3 (lamejs); persistent over 30s for large files.",
});
```
offscreen.html 안에서 `new AudioContext()` + 무음 oscillator 가 계속 돌아 `AUDIO_PLAYBACK` reason 이 활성 상태로 유지됨. 큰 파일도 수 분 단위 변환 가능.

**2) SW ↔ offscreen 을 `chrome.runtime.connect` port 로 전환** (`v0.4.17`):
```js
const port = chrome.runtime.connect({ name: "transcode" });
port.postMessage({ type: "transcode", inputUrl, mime, ... });
port.onMessage.addListener((msg) => { /* progress / done / error */ });
```
port-based 연결은 **양방향 + open 상태가 SW 의 active activity 로 등록** — port 가 살아있는 동안 SW idle timer 가 reset. sendMessage 의 단발성 30s 이슈 회피 + 무한 transcode 시간 안전.

**3) Audio fetch 자체를 offscreen 에서 직접** (`v0.4.15`): SW 가 fetch → ArrayBuffer 를 sendMessage 로 넘기는 모델은 ArrayBuffer 직렬화 함정. offscreen 이 `inputUrl` 만 받아서 자기가 fetch (offscreen 도 host_permissions 같이 적용됨). buffer 가 message 경계를 안 넘어가니 30 MB+ 도 무손실.

**4) 첫 메시지 전 ping** (`v0.4.16`): offscreen 이 막 created 됐을 때 lamejs 모듈 import 가 끝나기 전에 첫 transcode 가 들어오면 race. SW 가 offscreen 에 `ping` 메시지 보내고 ready 응답 기다린 뒤 본 message 발사.

### 학습

- **`reasons` 배열은 lifetime 카테고리** — `AUDIO_PLAYBACK` 또는 `IFRAME_SCRIPTING` 가 들어가야 long-lived. 단순 `WORKERS` / `BLOBS` 는 brief.
- **대용량 binary 는 sendMessage 로 옮기지 말고 fetch 의 endpoint 자체를 옮긴다** — offscreen 이 fetch 하고 결과 blob 도 거기서 만들어 GitHub PUT body 까지 거기서. SW 는 control-plane 만.
- **장시간 작업의 SW liveness 는 port 가 정공법** — `chrome.alarms` 도 keepalive 지만 port 가 더 직접적 (SW 가 message 처리 중인 한 활성).
- **race condition 방어로 ping-pong handshake** — offscreen 이 idempotent 하게 ready 응답을 줄 수 있으면 안전.

구현 위치: [src/background.js](src/background.js) (`ensureOffscreenDocument`, `transcodeViaOffscreen`), [src/offscreen/transcode.html](src/offscreen/transcode.html), [src/offscreen/transcode.js](src/offscreen/transcode.js).

---

## 12. 관리 페이지 사이드바 + 3개 언어 i18n (2026-05-03)

### 배경

관리 페이지 v0.4.0~0.4.11 은 단일 long scrolling 페이지에 모든 폼 (GitHub 설정 / 메타 / 진행 모니터 / 에피소드 목록) 이 세로로 나열돼 있었음. 사용자가 push 진행 상태를 확인하려면 한참 스크롤. NotebookLM Web Importer 의 사이드바 레이아웃을 참고해 도구 / 설정 / 데이터 3개 그룹으로 분리.

추가 동기: 영어 / 독일어 사용자도 동일하게 쓸 수 있도록 i18n 인프라.

### 사이드바 라우팅 (v0.4.12, [`2d77c8f`](../../commit/2d77c8f))

- 4 개 page section (`#page-monitor` / `#page-github` / `#page-meta` / `#page-episodes`) + hash 기반 라우팅 (`location.hash` ↔ 활성 page).
- `nav-item` 클릭 → 해당 page `.active`, 다른 page hide. `monitor` 가 default.
- 진행 모니터 nav 항목에 빨간 dot 뱃지 — running task 시 자동 표시 (사용자가 다른 page 에 있어도 작업 진행 중 인지).
- 사이드바 하단 footer 에 manifest version + 도움말 링크.

### i18n 인프라 (v0.4.20, [`0affcb0`](../../commit/0affcb0))

`src/options/i18n.js` 가 ko/en/de 3개 언어 × ~120 키 테이블 + 3개 helper:

```js
function t(key, params)               // 현재 언어로 번역 (params 는 {n}, {user} 같은 substitution)
function i18nSetLang(lang)            // 언어 전환 + DOM 재적용
function applyTranslations()          // data-i18n / data-i18n-html / data-i18n-attr 속성 walking
```

**DOM 마킹 패턴 3 가지**:
- `<span data-i18n="github.token">…</span>` — `textContent` 교체 (HTML 태그 없는 평문)
- `<div data-i18n-html="github.token.hint">…</div>` — `innerHTML` 교체 (`<a>`, `<code>` 등 inline 마크업 포함)
- `<input data-i18n-attr="placeholder:github.feedUrl.placeholder">` — 임의 속성 (콤마 구분으로 여러 개)

**언어 영구 저장 + 자동 초기화**: 사이드바 `<select>` `change` 이벤트 → `chrome.storage.local.set({ uiLang })` + `i18nSetLang()`. 페이지 재방문 시 첫 IIFE 의 우선순위 — (1) `chrome.storage.local.uiLang` (사용자가 셀렉터로 명시 선택한 값) → (2) `chrome.i18n.getUILanguage()` (Chrome 브라우저 UI 언어, "ko-KR"/"en-US"/"de-DE" → 앞 2자) → (3) `navigator.language` fallback → (4) `ko`. `chrome.i18n.getUILanguage()` 가 `navigator.language` 보다 정확 — 후자는 페이지 측 preference 이고 전자는 Chrome 자체의 UI 언어 설정.

### Dynamic string — t() 와 함께 사용

정적 DOM 은 `data-i18n` 으로 끝나지만 JS 측 dynamic string (`렌더링 N개 카드`, status messages, time ago label 등) 은 `t("monitor.summary.cards", { n: 12 })` 로 호출. 언어 전환 시 dynamic 영역도 재렌더 필요:

```js
langSelectEl.addEventListener("change", async () => {
  await chrome.storage.local.set({ uiLang: v });
  i18nSetLang(v);
  if (lastRenderedState) renderTaskState(lastRenderedState);  // 진행 모니터 재렌더
  renderLastScanPanel();                                      // 직전 스캔 패널
  if (epItems.length > 0) renderEpisodeTable();               // 에피소드 테이블
});
```

### 학습

- **i18n 은 dynamic 과 static 양쪽** — DOM walker (`applyTranslations`) 만으론 `${var}개 선택됨` 같은 JS 측 string 미커버. `t(key, params)` 를 일관되게 통과시키는 게 핵심.
- **언어 전환 시 dynamic 재렌더가 필수** — 정적 DOM 은 자동 반영이지만 `lastRenderedState` 같은 캐시된 값으로 그린 영역은 명시적 재호출 필요.
- **사이드바 + hash 라우팅 → multi-page SPA** — section 의 `display: none` 토글 + hashchange listener 로 충분. 라이브러리 불필요.

---

## 13. bulk 종료 알림 + 실패 카드 재시도 (2026-05-03)

### 배경

bulk:remote 가 100+ 카드 처리 시 30분~2시간 소요. 사용자가 다른 일 보다가 끝났는지 모르고, 종료 후 관리 페이지 다시 열어 확인하는 패턴. 그 중 90%+ 성공이라도 실패 N개를 어떻게 다시 시도할지 분명치 않았음 (전체 sweep 다시 vs 옵션 페이지에서 카드 선택).

### Chrome notifications — bulk 완료 OS 알림

`chrome.notifications.create` 로 OS 네이티브 알림 발사. `manifest.permissions` 에 `"notifications"` 추가 필요. 메시지는 성공/실패 카운트 + retry 안내:

```js
function notifyBulkComplete(success, total) {
  const fail = total - success;
  const title = fail > 0
    ? `Podcast Sync — ${success} ok, ${fail} failed`
    : `Podcast Sync — ${success} pushed`;
  chrome.notifications.create({
    type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title, message: ..., priority: 1,
  });
}
```

`runBulkRemote` 의 성공/실패 종료 양쪽에서 호출. cancel 경로에서는 호출 안 함 (사용자 의도).

### 실패 카드 persist + retry-failed 핸들러

bulk 진행 중 push 응답 timeout / debugger click 실패 / 카드 prepare 실패 / 탭 열기 실패 — 4 가지 실패 경로마다 selection 객체를 `failedSelections` 배열에 push. 종료 시점에 `chrome.storage.session` (fallback `local`) 에 `bulkFailedSelections` 로 persist.

```js
async function persistFailedSelections(selections) {
  await chrome.storage.session.set({ bulkFailedSelections: { selections, savedAt: Date.now() }});
}
```

새 message handler 추가:
- `bulk:failed:list` → `loadFailedSelections()` 의 selections 반환 (옵션 페이지가 [실패 N개 재시도] 버튼 노출 결정)
- `bulk:remote:retry-failed` → 같은 selections 로 `runBulkRemote` 재실행. 새 bulk 시작 시 `clearFailedSelections()` 가 동작해 직전 리스트 비움.

### 옵션 페이지 통합

직전 스캔 패널에 [실패 N개 재시도] 버튼 (`#last-scan-retry-failed`). `renderLastScanPanel` 이 `bulk:failed:list` 응답으로 failedCount 받아 `display:none`/`inline-block` 토글. 클릭 시 `bulk:remote:retry-failed` 발사 → task:state broadcast → 패널 자동 재렌더.

### 학습

- **장시간 작업은 OS 알림이 큰 차이** — 사용자가 모니터링하지 않아도 되어 익스텐션 사용 패턴이 자유로워짐. permission cost 는 한 줄.
- **실패 메타 데이터를 잃지 않기** — 종료 시점 storage 에 selection 자체를 저장. 알림 메시지에 적힌 "fail N" 만 사용자에게 노출되고 retry 는 클릭 한 번.
- **3 store 분리 (lastScanResult / bulkFailedSelections / currentTaskState)** — 각자 lifecycle 다름. lastScanResult 는 30분 freshness, failedSelections 는 다음 bulk 시작 시 invalidate, currentTaskState 는 SW 재시작 시 zombie 검지.

구현 위치: [src/background.js](src/background.js) (`persistFailedSelections`, `notifyBulkComplete`, `bulk:failed:list`/`bulk:remote:retry-failed` handler), [src/options/options.js](src/options/options.js) (`#last-scan-retry-failed` button wiring), [manifest.json](manifest.json) (`"notifications"` permission).

---

## 14. ubuntu-latest 24.04 마이그레이션 — ffmpeg 빠짐 (2026-05-03)

### 증상

기존 워크플로 [examples/feed-builder/.github/workflows/build-feed.yml](examples/feed-builder/.github/workflows/build-feed.yml) 의 `transcode.py` step 이 `FileNotFoundError: 'ffmpeg'` 로 실패. 이전엔 정상 작동.

### 원인

GitHub Actions `ubuntu-latest` 가 2025년 4월부터 22.04 → 24.04 로 업그레이드. 24.04 image 의 default 패키지에서 ffmpeg 가 빠짐 ([공식 issue](https://github.com/actions/runner-images/issues)). 22.04 시절에 작성한 워크플로 가정이 깨짐.

### 대응

워크플로 step 에 명시적 `apt-get install`:
```yaml
- name: Install ffmpeg (for transcode)
  run: sudo apt-get install -y --no-install-recommends ffmpeg
```

`apt-get update` 는 생략 — runner image 의 apt 캐시가 이미 최신이라 update 없이도 install 통과 (빌드 시간 절약). 버전 핀도 안 함 — apt 가 알아서 최신 ffmpeg + libmp3lame 가져옴.

### 학습

- **runner OS 마이그레이션은 호환성 깨질 수 있음** — `ubuntu-latest` 는 가장 빠르게 변하는 라벨. 안정성이 중요한 워크플로는 `ubuntu-22.04` 로 핀하거나 모든 시스템 의존성을 명시 install.
- **워크플로 템플릿은 examples/feed-builder/ 가 source-of-truth** — 사용자 repo 에 복사돼 있는 워크플로도 같이 업데이트 권유 (사용자 측 작업).

---

## 15. 패키징 INCLUDE_DIRS 누락 — `vendor/` 가 25개 zip 에서 빠짐 (2026-05-07)

### 증상

수면 아래에서 v0.4.0 ~ v0.4.25 의 모든 zip 빌드가 `vendor/lamejs.js` 없이 출시. unpacked 로드한 사용자가 GitHub Contents API 한계 (~37 MiB) 를 넘는 큰 음성개요를 받으면 offscreen transcode 가 `import("./vendor/lamejs.js")` 단계에서 404 → mp3 인코딩 실패 → push 자체가 실패. 평균 음성개요는 한계 안이라 대다수 사용자에겐 보이지 않았고, 버그 리포트 0건. 개발자 본인이 git clone 으로 직접 로드해 워킹트리의 `vendor/` 가 항상 존재했기 때문에 self-test 에서도 안 잡힘.

### 원인

[scripts/package.py](scripts/package.py) 의 `INCLUDE_DIRS = ["src"]` — `vendor/` 디렉터리가 화이트리스트에서 빠져 있었음. lamejs 도입 (v0.4.11) 시점에 `src/offscreen/transcode.js` 의 `import` 경로는 `vendor/lamejs.js` 로 작성됐지만, 같은 패치에서 패키징 스크립트를 함께 손대지 않음.

### 대응 (v0.4.27)

```python
INCLUDE_DIRS = ["src", "vendor"]
```

한 줄 추가. zip 빌드 후 unzip 으로 `vendor/lamejs.js` 존재 확인. 추가 검증 필요한 경로:

1. 빌드된 zip 을 `chrome://extensions/` 에 unpacked 로드 → 큰 m4a 다운로드 → 콘솔에 `[transcode] mp3 written XX MB` 가 찍히는지.
2. offscreen 콘솔 (`chrome://extensions/` 의 service worker 카드에서 inspect → Frames 탭의 `transcode.html`) 에 `import` 404 가 없는지.

### 학습

- **화이트리스트 패키징은 새 디렉터리 추가 시 빠뜨리기 쉬움** — 신규 dependency 가 새 top-level dir 로 들어오는 PR 은 `package.py` (또는 `manifest.json` 의 `web_accessible_resources` 등) 도 함께 손대야 함. 검토 체크리스트에 "신규 import 경로의 root dir 가 빌드 화이트리스트에 있는가?" 추가.
- **개발 모드와 출시 모드의 갭이 silent bug 를 키움** — 개발자가 unpacked 로 git clone 폴더 로드하면 워킹트리의 모든 파일이 보여서 누락이 안 드러남. 출시 zip 을 *그 자체* 로 별도 디렉터리에 풀어서 한 번 더 unpacked 로드하는 sanity 단계가 필요. [RELEASING.md](RELEASING.md) 에 "패키징된 zip 으로 한 번 더 로드 테스트" 단계 명시 권장.
- **사용자 silence 는 버그 부재 신호가 아님** — 25개 버전 동안 0건 리포트였지만 실제로는 long-form 음성개요 사용자가 영향. 텔레메트리가 없는 익스텐션에서 silent failure 는 극히 발견하기 어려움. fallback path 가 의도대로 도달하는지 회귀 테스트 필요.
- **패키징 스크립트 자체에 self-check 가 있으면 좋음** — 빌드 후 zip 안에서 `manifest.json` 의 host_permissions / `src/**` 의 `import` 경로 모든 것을 grep 해서 zip 에 실제로 존재하는지 확인하는 단계. 한 줄 누락으로 25 버전이 조용히 깨질 수 있는 위험을 미리 잡는 layered defense.

---

## 16. 다기기 동기화 — `chrome.storage.sync` 로 분리 (2026-05-09)

### 배경

v0.4.0~v0.4.27 은 모든 영구 상태를 `chrome.storage.local` 에 보관 — 한 기기에 묶임. 사용자가 직장/집/노트북 등 여러 Chrome 에서 같은 NotebookLM 계정을 쓸 때 매번 PAT/repo 를 다시 입력하는 마찰. 익스텐션 설정의 다기기 자동 공유는 Chrome Sync 의 정공법인 `chrome.storage.sync` 로 해결 — 같은 Google 계정 + 같은 익스텐션 설치된 다른 Chrome 과 자동 공유.

### 디자인 결정 — sync vs local 의 분할 기준

키를 두 그룹으로 나눠 의미 기반으로 분리:

| 키 | 저장소 | 사유 |
|---|---|---|
| `token` (PAT) | `sync` | 사용자 입력 자격 증명. 다기기 공유가 핵심 가치 |
| `repo`, `rssMode`, `autoDownloadNew`, `committerName`, `committerEmail` | `sync` | 사용자 의도 — 어느 기기에서 보든 같은 결과 기대 |
| `uiLang` | `sync` | UI 선호. 한 번 정한 언어가 모든 기기에서 일관 |
| `currentTaskState` | `local` | 진행 중 작업은 그 기기 SW 의 in-flight Promise 와 짝 — 다른 기기에서 보면 stale |
| `lastScanResult` | `local` | 그 기기의 NotebookLM 세션이 본 결과. 다른 기기 세션과 무관 |
| `notebookUrlMap` | `local` | 누적 데이터 — sync quota 100KB 위험. 다른 기기에서 매핑 자동 채워짐 |
| `bulkFailedSelections` | `local` | 그 기기에서 실패한 selections. 다른 기기에서 retry 의미 없음 |
| `epColWidths` | `local` | 화면 폭 의존 UI 선호. 기기마다 적정 폭 다름 |

원칙: **사용자 의도 = sync, 기기 상태 = local**. PAT 는 의도이니 sync. 진행 중 task state 는 그 기기 SW 살아있는 동안만 의미 있어 local.

### PAT sync 의 보안 — 사용자에게 명시

`chrome.storage.sync` 는 사용자 Google 계정으로 암호화되어 Chrome Sync 백엔드에 저장. 두 모드:

- **Chrome Sync 패스프레이즈 켬**: end-to-end 암호화. 사용자 패스프레이즈만 키 — Google 도 못 읽음.
- **패스프레이즈 안 켬**: Google 계정 키로 암호화. Anthropic 같은 외부 서버엔 안 가지만 Google 은 이론상 접근 가능.

PAT 같은 자격 증명을 sync 에 보관하는 건 user trust 기반의 결정이라 옵션 페이지 GitHub 섹션 상단에 안내 박스 추가 (Chrome Sync 패스프레이즈 권장 링크 포함). 한·영·독 i18n 키 `github.syncNotice`. 도움말 §11 (권한 & 프라이버시) 의 토큰 저장 위치 설명도 동기화 함의 명시로 갱신.

### 구현 — `cfgGet` / `cfgSet` 헬퍼 + 1회성 마이그레이션

[src/background.js](src/background.js) 의 `CFG_KEYS` 화이트리스트 + `cfgGet` / `cfgSet` 헬퍼:

```js
const CFG_KEYS = [
  "token", "repo", "rssMode", "autoDownloadNew",
  "committerName", "committerEmail", "uiLang",
];

async function cfgGet(keys) {
  // sync 우선 + 비어있는 키만 local 에 fallback (마이그레이션 부분 실패 안전망).
  const want = keys ?? CFG_KEYS;
  const [s, l] = await Promise.all([
    chrome.storage.sync.get(want).catch(() => ({})),
    chrome.storage.local.get(want).catch(() => ({})),
  ]);
  const out = {};
  for (const k of want) out[k] = s[k] !== undefined ? s[k] : l[k];
  return out;
}

async function cfgSet(obj) {
  await chrome.storage.sync.set(obj);
  try { await chrome.storage.local.remove(Object.keys(obj)); } catch {}
}
```

마이그레이션은 SW 시작 시 한 번 (`migrateConfigToSync()`):
1. `local` + `sync` 의 `CFG_KEYS` 동시 fetch.
2. `local` 에만 있고 `sync` 가 비어있는 키만 `sync` 로 복사 (다른 기기에서 먼저 push 된 값은 보존).
3. `local` 의 같은 키들 제거 (두 저장소 분기 방지).

옵션 페이지 / popup 도 같은 헬퍼 inline 보관 (각자 모듈 / 클래식 스크립트라 import 경로가 갈림 — 30 줄 코드 중복 허용).

### 라이브 반영 — `storage.onChanged` 리스너

같은 옵션 페이지가 두 기기에서 동시에 열려 있을 때 한 쪽 [저장] → 다른 쪽 폼이 자동 갱신:

```js
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (!CFG_KEYS.includes(k)) continue;
    if (k === "uiLang") { i18nSetLang(newValue); ... }
    else if (k === "autoDownloadNew") fields.autoDownloadNew.checked = !!newValue;
    else if (fields[k] && document.activeElement !== fields[k]) {
      fields[k].value = newValue ?? "";
      if (k === "repo") refreshFeedUrl();
    }
  }
  show(t("github.status.syncedFromOther"), "success");
});
```

`document.activeElement` 가드로 사용자가 입력 중인 필드는 덮어쓰지 않음 — 동시 편집 race 방지.

### 함정 / 주의

- **Quota**: sync 는 8KB/item, 100KB 총합, 1800 writes/hour. 현재 `CFG_KEYS` 합계는 ~1KB 미만이라 여유 충분. `notebookUrlMap` 을 sync 에 넣었으면 누적되면서 100KB 넘을 위험 — 그래서 local 유지.
- **마이그레이션 idempotency**: 두 번째 SW 시작에선 `local` 이 이미 비어 있어 자동으로 no-op. 다른 기기가 먼저 sync 에 값을 푸시한 상태에서 새 기기가 깔리면 그 기기 `local` 은 비어 있어 마이그레이션 skip → sync 값 그대로 사용.
- **sync 비활성/오프라인**: `chrome.storage.sync` 는 Chrome Sync 가 꺼져 있어도 단일 기기 local store 처럼 동작. 따라서 익스텐션은 sync 상태와 무관하게 항상 안전.
- **patentially destructive sync overwrite**: 한 기기에서 잘못된 PAT 를 [저장] 하면 sync 가 다른 기기로 전파. 이건 의도된 동작 — [설정 검증] 버튼이 같은 기기에서 401 를 잡아주므로 사용자가 sync 전파 전에 인지 가능. cross-device 발견은 다른 기기의 다음 push 실패 시 진행 모니터에서 401 표시.

### 학습

- **storage 분리는 "사용자 의도 vs 기기 상태" 축으로**. 데이터 사이즈만 보면 다 sync 에 넣어도 quota 안에 들지만, 의미 안 맞으면 `currentTaskState` 가 다른 기기에서 stale 한 진행률을 표시하는 등 UX 사고. 분류 기준이 명확하면 의사결정이 빠름.
- **PAT 같은 자격 증명 sync 는 사용자 옵트인 명시 필요** — UI 박스로 "이게 어디 가는가, 패스프레이즈 켜면 더 안전" 한 번에 안내. 묵시적 sync 는 trust 위반.
- **`storage.onChanged` 의 area 구분**. 옛 코드가 `local` 을 가정하고 짠 곳이 있으면 area 필터로 가드 안 하면 sync 변경에 잘못 반응. listener 추가 시 항상 `if (area !== "sync") return;` 같은 명시.

구현 위치: [src/background.js](src/background.js) (`CFG_KEYS`, `cfgGet`, `cfgSet`, `migrateConfigToSync`), [src/options/options.js](src/options/options.js) (inline 헬퍼 + `storage.onChanged` 리스너), [src/popup/popup.js](src/popup/popup.js) (uiLang sync 우선 fetch), [src/options/options.html](src/options/options.html) (`github.syncNotice` 박스), [src/i18n.js](src/i18n.js) (`github.syncNotice` / `github.status.syncedFromOther` ko/en/de).

---

## 17. 일괄 다운로드 안정화 — SW base64 제거 / offscreen popup / idle watchdog (2026-05-13, v0.4.37)

### 배경

사용자 리포트:

1. "모든 노트북 스캔 + 다운로드 도중 popup/options UI 가 자주 freeze"
2. "다운로드 중 다른 웹페이지 보고 있는데 갑자기 NotebookLM 윈도우가 앞으로 튀어나옴"

두 증상 모두 v0.4.36 까지 미해결 — bulk:remote 의 SW 메인 스레드가 매 카드 1-2초씩 동기 작업으로 block 되고, bulk window 가 visible 화면에 떠 있는 게 원인.

### 원인 — 세 갈래

**(a) SW thread 가 매 카드마다 동기 base64 인코딩** — `arrayBufferToBase64(buf)` 가 `String.fromCharCode.apply` 를 5MB(mp3) ~ 40MB(m4a fallback) Uint8Array 에 chunk 별로 돌리고 `btoa(parts.join(""))`. 큰 카드에선 1-2초 동안 SW message loop 가 완전히 정지. 그 동안 popup ping / options 의 `task:state` 메시지가 응답 못 받아 "freeze" 로 보임. 거기에 더해 m4a 경로는 offscreen 이 b64 string 으로 SW 에 돌려준 걸 SW 가 *다시 ArrayBuffer 로 변환* (`base64ToArrayBuffer`) 한 뒤 *또 b64 로 변환* — 이중으로 낭비.

**(b) bulk window 가 visible 좌표에 위치** — `chrome.windows.create({type:"popup", focused:false, width:800, height:600})` 만으론 Windows 에서 popup 이 종종 메인 윈도우 앞으로 튀어나옴 (chromium 의 `focused:false` 를 OS 가 honor 안 하는 거동). 사용자는 다른 웹페이지 작업 중인데 NotebookLM popup 이 떠서 시야 가림.

**(c) Fixed 10분 timeout 이 stall 카드를 막아 다음 카드로 못 넘김** — `PUSH_RESULT_TIMEOUT = 600000`. NotebookLM 응답 / debugger click miss / 메뉴 미등장으로 한 카드가 stuck 되면 무조건 10분 대기. 사용자는 그 동안 "왜 안 움직이지" 로 인식.

### 대응 — 세 단 패치 (v0.4.37)

**1) `pushEpisode` 의 b64 변환을 offscreen 으로 완전 이관**

offscreen 의 port 핸들러에 `mode: "fetch"` (transcode 없이 fetch+b64) 추가, transcode 경로 (`mode: "transcode"`) 와 한 함수로 통일. 두 경로 모두 `{ b64, size, sourceSize }` 형태로 SW 에 반환 — SW 는 그 b64 string 을 `ghPut` body 에 그대로 넣음. SW thread 의 `arrayBufferToBase64` / `base64ToArrayBuffer` 모두 제거.

- 새 SW 헬퍼: [src/background.js](src/background.js) `fetchEncodeViaOffscreen(audioUrl, { transcode, onProgress })`
- 옛 `transcodeViaOffscreen` 삭제
- offscreen 측: [src/offscreen/transcode.js](src/offscreen/transcode.js) 의 port 핸들러가 두 mode 분기 + 진행률 비콘 emit (250ms throttle 로 fetch chunk 마다)

**2) bulk window 오프스크린 좌표화**

[src/background.js](src/background.js) `ensureBulkWindow()` 가 `chrome.windows.create({left:-32000, top:-32000, ...})` 로 생성 후 `chrome.windows.update` 로 한 번 더 nudge. Chrome 이 좌표 clamp 해도 두 단계 적용으로 거의 항상 화면 밖에 위치. `visibilityState` 는 윈도우 위치 무관하게 'visible' 유지되어 NotebookLM download 트리거는 정상 발사.

> ⚠ **후속 Chrome 업데이트로 이 접근 폐기** — §20 참고. v0.4.42 에서 `left: -399, top: 0` (50% 규칙을 딱 맞추는 가장자리 좌표) 로 교체됨.

**3) Fixed timeout 을 idle-watchdog 로 교체 + UI 라이브 진행률**

- `PUSH_IDLE_TIMEOUT = 90s` — 어떤 progress 비콘도 안 오면 stall 판정 → 다음 카드.
- `PUSH_HARD_TIMEOUT = 15min` — 마지노선 (무한 progress emit 사고 대비).
- offscreen fetch chunk + SW 의 ghGet/ghPut stage 가 모두 `emitCardProgress()` 로 비콘 발사. 활성 카드의 idle 타이머가 매번 reset 되어 정상 다운로드는 절대 timeout 안 됨.
- 새 헬퍼: [src/background.js](src/background.js) `waitPushResultLocalWithWatchdog`, `emitCardProgress`.
- `currentTaskState.currentCardProgress = { episodeTitle, stage, bytes, totalBytes }`. 옵션 페이지가 라이브 표시.
- UI: [src/options/options.html](src/options/options.html) 에 `#card-progress` 패널 추가, [src/options/options.js](src/options/options.js) 의 `renderCardProgress()` 가 stage 라벨 + bytes/totalBytes 막대 표시. i18n 키 ko/en/de 모두 추가.

### 학습

- **SW thread 의 동기 work 는 모두 message loop blocker** — `String.fromCharCode.apply` / `btoa` / 큰 `Uint8Array` 순회 등은 사용자 입장에선 "UI freeze" 와 구별 불가. offscreen document 가 있다면 무거운 동기 작업은 거기서 끝내고 SW 는 결과 string/object 만 받는 게 정공법.
- **`focused:false` 는 platform-dependent** — Windows / 일부 Linux 환경에선 무시 가능. 안 보이게 하려면 좌표를 화면 밖으로 미는 게 더 robust. 단 §20 처럼 Chrome 의 bounds 규칙이 강화되면 좌표 전략도 재검토 필요.
- **Fixed timeout 은 정상 케이스 / stall 케이스 둘 다 안 맞음** — 정상 카드는 5분이면 충분, stall 카드는 10분 끝까지 기다리는 게 무의미. idle-watchdog (= 활성 신호로 reset 되는 타이머) 가 두 케이스 모두 만족. 비용: progress 비콘을 발생시키는 위치를 빠짐없이 식별.
- **dedup hint 의 b64 string 그대로 흘리기** — 옛 코드는 SW 가 ArrayBuffer 로 들고 다니다 마지막에 b64 로 변환했는데, ghPut 도 결국 b64 받음. ArrayBuffer 표현이 필요한 곳이 없으면 처음부터 b64 로 들고 다니는 게 한 라운드의 변환을 절약.

### 검증 핸드오프

- popup/options 의 freeze 가 사라졌는지: 큰 카드 (40MB m4a) 다운로드 중 `task:state` 메시지가 매 250ms 마다 갱신되는지 확인. 진행률 패널의 stage 라벨이 fetching → fetched → transcoding → transcoded → encoding → encoded → ghGet → uploading → uploaded 순으로 흐름.
- 화면 밖 popup 검증: bulk 시작 후 새 popup window 가 보이지 않는지. `chrome://extensions/` 의 서비스 워커 로그에 `[bulkWindow] created … left=-32000` 표시.
- idle stall 검증: NotebookLM 페이지에서 의도적으로 ⋮ 메뉴 차단 시 90s 후 다음 카드로 넘어가는지 (옛 코드에선 10분 대기). 정상 카드는 idle 안 걸리는지.

### 다음 마일스톤 (v0.4.38+ 후보)

- **dedup 사전 계산** — bulk 시작 시 `ghList(docs/episodes)` 한 번만 받고 카드 N 개 push 동안 캐시. 현재는 매 `pushEpisode` 안에서 list 재호출 → API 호출 N+1배.
- **카드 단위 pipeline** — 다음 카드 클릭 + 이전 카드 push 병렬. throughput 2~3배 기대, 단 409 race 빈도 증가 — 이미 `ghPut` 의 4회 retry 가 견뎌야 함.
- **content script 회복 경로** — `waitFor` 가 timeout 시 `Escape` 합성 후 재시도. NotebookLM UI 가 다른 모달을 떠 있게 두는 race 회복.
- **bulk port 재사용으로 alarm 의존 제거** — 현재 30s alarm keepalive 는 SW 살리는 보조 수단인데, offscreen port 가 bulk 전체 동안 한 번만 열려있으면 SW 도 그 시간 동안 alive 보장 (Chrome 공식). port 한 번만 열고 카드별로 메시지 재사용하면 alarm 패턴 자체 불필요.

---

## 18. 일괄 스캔 가속 — 세션 캐시 + 노트북별 modifiedHint (2026-05-13, v0.4.38)

### 배경

`scan:all` 이 노트북 1개당 탭 open + 12s timeout 폴링 + close 의 sequential 흐름. 153개 노트북 보유 사용자 기준 10~15분 소요. 이 중 대부분의 노트북은 매 스캔 사이에 변동이 없음 — 매번 풀 스캔은 낭비.

### 두 단 캐시

**(c) Session-level 캐시 — `SCAN_CACHE_TTL_MS = 30분`**

`runScanAll(opts)` 시작 시 `lastScanResult` 가 30분 이내면 풀 스캔 전체를 단락:
- 옛 결과 그대로 `emitEvent("scan:all:done", { cacheUsed: true })`.
- task state 도 `completed` 로 즉시 전환 — popup/options 의 진행 모니터가 곧바로 결과 표시.
- `autoDownloadNew` 흐름은 그대로 동작 (캐시된 notebooks 로 `buildNewSelections`).

사용자 시나리오: autoDownload 받은 직후 [모든 노트북 스캔] 또 누름 / popup 닫고 다시 열어서 같은 결과 한 번 더 확인. 30분 안이면 0초 마무리.

**우회**: popup [모든 노트북 스캔] Shift+click → `scan:all` 메시지에 `force:true` 동봉 → 캐시 무시. 또는 옵션 페이지의 [지우기] 버튼 (`scan:result:clear`).

**(a) 노트북별 캐시 — `PER_NOTEBOOK_TTL_MS = 4시간`**

`runScanAll` 의 풀 스캔 분기 안에서, 홈 페이지에서 받은 각 노트북 entry 가 `prevScan` 의 같은 url 항목과 매치되고:
- `modifiedHint` 가 직전과 같고,
- `scannedAt` 이 4시간 이내,
- `audios` 배열이 캐시에 있으면,
→ 그 노트북의 탭은 열지 않고 옛 audios 그대로 `notebooks[]` 에 push.

`modifiedHint` 는 content.js 의 `extractModifiedHint(card)` 가 홈 페이지 카드 안의 안정 시그널만 모아 만든 "구조적 지문":

1. `<time datetime="ISO">` 의 datetime 속성.
2. `[title]` 속성 중 절대 날짜 패턴 (`/\d{4}|GMT|UTC|\+\d{2}:?\d{2}/` 매칭).
3. `[aria-label]` 중 숫자 포함 값 (e.g. "5 audio overviews", "Created Apr 30").

상대 시간 ("5분 전" / "1 hour ago") 같이 시간 흐름만으로 바뀌는 텍스트는 사용 안 함 — false invalidation 방지.

### Graceful degrade

NotebookLM 홈 페이지 DOM 이 위 셀렉터를 노출 안 하면 `extractModifiedHint` 가 `null` 반환 → 캐시 매치 자체가 동작 안 함 → 매 노트북 풀 스캔 (이전 동작과 동일, 속도만 손해). 깨지진 않음.

진단 로그: content.js 의 `[scan:list] N개 노트북, modifiedHint 추출 M개 (P%)`. P 가 0% 면 selector 조정 필요한 신호.

### Force 경로

`runScanAll({ force: true })` 호출하면 (c)/(a) 양쪽 캐시 모두 우회. popup Shift+click 또는 옵션 페이지의 [지우기] (캐시 데이터를 비움) 가 트리거.

### 변경 위치

- [src/content.js](src/content.js): `findCardContainer`, `extractModifiedHint`, `getNotebookCards`. `scan:list` 응답에 `notebooks: [{url, modifiedHint}, ...]` 추가 (옛 `urls` 키도 호환).
- [src/background.js](src/background.js): `SCAN_CACHE_TTL_MS`, `PER_NOTEBOOK_TTL_MS`. `runScanAll(opts)` 의 (c) 단락 + 루프 안 (a) 매치. `scanHomePageForNotebookUrls` 가 entries 배열 반환. lastScanResult 의 notebook 마다 `modifiedHint` + `scannedAt` 필드 저장.
- [src/popup/popup.js](src/popup/popup.js): scan-all 클릭 핸들러의 Shift 감지 → `force` flag. `renderAggregate(notebooks, {cacheUsed, cacheAgeMs})` 가 캐시 재사용 안내 status 표시. tooltip 추가.
- [src/i18n.js](src/i18n.js): `popup.scanAllForceStart`, `popup.scanAllTooltip`, `popup.scanAllCacheUsed` (ko/en/de).

### 학습

- **두 단 캐시는 의미가 다른 차원** — (c) 는 "사용자의 반복 클릭 흐름" 을, (a) 는 "노트북 단위 변동성" 을 추적. TTL 도 다른 시간 스케일 (30분 vs 4시간). 한 단으로 합치려고 하면 어느 쪽이든 trade-off 가 어색해짐.
- **safe fallback 이 deployment 비용을 0 으로** — modifiedHint 가 null 이어도 hash mismatch 가 아니라 "cache key not present" 라 매치 자체가 동작 안 함. NotebookLM 이 DOM 을 바꿔도 슬로우 모드로 떨어지지 깨지진 않음. 그래서 셀렉터 검증 없이 ship 가능.
- **상대시간을 hint 에서 배제** — "5분 전" / "1 hour ago" 는 invalidation 의 false signal. invalidation 의 신뢰성이 cache hit 률보다 더 중요한 사용자 가치 (놓친 새 음성개요는 영구 손실 vs. 캐시 미스는 단순 속도 손해).
- **진단 로그가 selector 회귀 안전망** — `[scan:list]` 로그의 hint 추출률 % 가 0 이면 사용자가 SW console 열어 확인 가능 — 침묵 실패 회피.

### 다음 마일스톤 (v0.4.39+ 후보)

- **per-notebook cache 의 hit 률 텔레메트리** — `cacheHits / total` 비율을 옵션 페이지에 표시 ("지난 스캔: 캐시 ?%"). 0% 면 사용자에게 selector 검증 안내.
- **modifiedHint TTL 자동 튜닝** — 사용자 패턴 (스캔 빈도) 학습 후 적응적 TTL.
- **homeEntries 순서 정렬로 cache miss 우선 처리** — 캐시 miss 노트북 먼저 풀 스캔 → 진행률 막대가 더 빨리 차오르는 시각적 효과.

---

## 19. 스킵 필터의 race 우회 버그 (2026-05-13, v0.4.39)

### 증상

사용자가 한 기기 (예: 노트북) 에서 음성개요를 스킵 등록 → 다른 기기 (예: 데스크탑) 에서 `scan:all` + auto-download 가 그 카드를 다시 받으려고 시도 → 실패로 처리. `chrome.storage.sync` 가 스킵 목록을 기기 간에 동기화하고 있는데도 발생.

### 원인

[src/background.js](src/background.js) `buildNewSelections` 의 스킵 필터:

```js
const sid = (audio.artifactId || "").slice(0, 8);
if (sid && skippedShortIds.has(sid)) return;
```

`audio.artifactId` 가 빈 문자열일 때 — NotebookLM 의 `artifact-labels` DOM 이 카드 첫 렌더 직후엔 비어 있는 lazy render race (§1 의 PLACEHOLDER 와 같은 family) — `sid` 가 빈 채로 들어와 `if (sid && …)` 의 첫 가드가 false → 스킵 체크 자체를 우회 → 카드가 selections 에 들어감 → 다운로드 시도.

이 race 는 dedup 쪽 (`isAudioPushed`) 에선 이미 (date, titleSlug) 폴백으로 해결되어 있는데 (§1, `titleFilenameMatches` 패턴), 스킵 쪽은 같은 폴백을 안 가져옴 — 같은 race 함정에 두 번째로 떨어진 것.

### 대응

스킵 필터에도 dedup 와 동일한 2차 키 도입:

1. `loadSkippedIndex()` 가 `{ shortIds: Set, titleKeys: Set<"${date}|${titleSlug}"> }` 두 인덱스를 같이 반환.
2. `isAudioSkipped(audio, coverDateAttr, skipIndex)` 가 shortId 1차 → (date, titleSlug) 2차 순으로 매칭.
3. `buildNewSelections` 와 `scan:result:pushed` 핸들러 양쪽 모두 새 함수 사용.

`addSkippedEntry` 는 이미 `{ shortId, filename, title, date, notebookTitle }` 메타를 같이 저장하고 있었음 (옵션 페이지 [스킵] 버튼이 row 메타를 같이 보냄). title 은 호출자별로 spaces 도 dashes 도 가능 → 인덱싱 시 `slugify(entry.title)` 로 canonicalize.

### 학습

- **같은 race 패턴은 모든 필터에 동시 적용 — chain-of-defense 가 일관되어야** §1 fix 가 dedup 만 보호하고 스킵을 안 보호한 게 이번 사고. lazy render race 는 한 군데 막아도 다른 군데로 새면 무의미. selections 에 영향을 주는 모든 필터 (push / skip / tooOld) 를 동일 폴백 set 으로 짜는 디자인 원칙.
- **메타가 이미 저장돼 있어도 인덱싱 안 하면 무용지물** — `addSkippedEntry` 가 `date` / `title` 을 저장하기 시작한 v0.4.33 이후로 폴백 매칭이 가능했는데도 1년 늦게 발견됨. 새 메타 필드를 추가할 땐 그 메타가 어디서 활용될지 동시에 식별.
- **다기기 시나리오의 silent failure** — 한 기기에서만 사용하면 race 빈도 낮아서 알아차리기 어려움. 두 기기 동시 사용자가 보고. 다기기 동기화 추가 (v0.4.30) 가 곧 다기기 회귀 테스트 필요성도 만든 셈.

### 진단 핸드오프

`buildNewSelections` 호출 직후 selections 안에 스킵 entry 와 같은 `episodeTitle` 있는지 확인. 있으면 그 audio 의 `artifactId` 가 빈 문자열인지 확인 (race 의 핵심 시그널). audio.title 에 `slugify` 적용한 값이 스킵 entry 의 `slugify(title)` 과 일치하는지 확인.

---

## 20. Chrome `windows.create` bounds 규칙 강화 — 오프스크린 좌표 전략 붕괴 (2026-05-20, v0.4.42)

### 증상

일괄 다운로드 시 모든 항목이 "탭 열기 실패: Invalid value for bounds. Bounds must be at least 50% within visible screen space." 오류로 실패. 성공 0건 / 실패 N건.

### 원인

Chrome 이 `chrome.windows.create` (및 `windows.update`) 의 `left`/`top` 좌표를 검증하는 규칙을 강화했다. **창 면적의 50% 이상이 화면 안에 있어야 한다**는 조건이 추가되어, 이전에 사용하던 `left: -32000, top: -32000` 이 에러를 throw. 이전 Chrome 버전에서는 좌표를 silent clamp(좌상단으로 이동) 하거나 그냥 통과시켰는데, 업데이트 후에는 명시적 에러로 차단됨.

### 시도 1 — `state: "minimized"` (실패)

```js
// v0.4.42a — 실패한 시도
chrome.windows.create({ url: "about:blank", type: "popup", focused: false, state: "minimized" })
```

bounds 검사는 통과하지만 두 가지 이유로 폐기:

1. **화면 전환 발생**: minimized 창에 `chrome.tabs.create({ active: true })` 를 하면 Chrome 이 창을 자동 복원(un-minimize)해서 사용자 화면 위로 튀어오름.
2. **`visibilityState = 'hidden'`**: minimized 창의 탭은 페이지 Visibility API 상 `'hidden'` — NotebookLM 의 download 트리거가 불안정해짐 (§9 / §10 이 요구하는 'visible' 조건 미충족).

### 시도 2 — 가장자리 좌표 (v0.4.42b, 채택)

```js
// v0.4.42b — 현재 구현
const BULK_WINDOW_OPTS = { left: -399, top: 0, width: 800, height: 600 };
chrome.windows.create({ url: "about:blank", type: "popup", focused: false, ...BULK_WINDOW_OPTS })
```

`left: -399` 이면 창의 오른쪽 401px (800의 50.1%) 가 화면 안에 위치 — 50% 규칙을 딱 초과해서 통과. 나머지 399px 은 화면 왼쪽 바깥에 숨겨짐. `focused: false` 로 메인 윈도우 포커스 비침 없음. 창이 이미 open 상태라 탭 추가시 화면 전환 없음.

**50% 면적 계산 근거**:
- 창 전체 면적: 800 × 600 = 480,000 px²
- 화면 내 가시 면적: 401 × 600 = 240,600 px² (50.125%) ✓

### 학습

- **`windows.create` 의 bounds 검사는 버전마다 강화될 수 있다** — 하드코딩된 음수 좌표는 취약한 전략. Chrome 정책이 언제든 바뀔 수 있다는 전제로 fallback 을 함께 설계해야 함.
- **`state: "minimized"` 는 bounds 우회용으로 사용 불가** — minimized 창에 `tabs.create(active:true)` 를 넣으면 Chrome 이 자동 복원한다. 그리고 minimized 상태에서는 `visibilityState='hidden'` 이라 download 트리거가 작동하지 않음.
- **`focused: false` + 유효 좌표 조합이 정공법** — 창이 열려 있어야 'visible', `focused: false` 여야 포커스 비침 없음. 이 두 조건을 모두 만족하면서 bounds 규칙도 통과하는 좌표를 유지해야 한다.
- **50% 규칙의 여유 마진 확보 권장** — `left: -399` 는 401/800 = 50.125% 로 매우 빡빡함. 만약 Chrome 이 "over 50%" 를 "strictly greater than" 이 아닌 "at least 401px" 같은 다른 단위로 검사하는 방식으로 변경될 경우 경계 케이스가 실패할 수 있음. 여유를 두려면 `left: -350` (450/800 = 56.25%) 정도가 안전.
- **사용자에게 보이는 부분 최소화 vs. 안정성 트레이드오프** — 가장자리 좌표는 창 일부가 화면에 보이지만 `focused: false` 덕분에 사용자 작업 흐름을 끊지 않음. 완전 숨김을 고집하다 download 트리거까지 깨지는 쪽보다 낫다.
- **좌표 전략 변경 시 §9/§10 의 전제 조건 재검증 필수** — `visibilityState='visible'` + `isTrusted=true` 의 두 조건이 유지되는지 항상 확인할 것.

### 향후 고려 사항

현재 `left: -399` 는 스크린 너비를 모름 — 스크린이 400px 미만인 극단적 케이스에서는 실패할 수 있음 (대부분의 데스크탑은 1024px 이상). 더 robust 하게 하려면:

```js
// 현재 포커스된 윈도우 위치에서 스크린 너비를 추론해 동적 계산 (미구현)
const cur = await chrome.windows.getLastFocused();
const screenW = cur.left + cur.width; // 추정값
const safeLeft = Math.max(-Math.floor(800 * 0.49), -399);
```

혹은 추후 Chrome 이 `chrome.system.display.getInfo()` 없이도 디스플레이 경계를 알 방법을 제공한다면 그쪽으로 이관.

---

## 21. Bulk popup 의 화면 전환 회귀 — 단일 탭 재사용 (2026-05-21, v0.4.45)

### 증상

§20 의 가장자리 좌표 (`left:-399, focused:false`) 가 적용된 v0.4.42 에서 초기 테스트는 화면 전환 없이 정상. 이후 Chrome 의 추가 거동 변화로 일괄 다운로드 중 **매 노트북마다** popup 창이 잠깐 사용자 화면 앞으로 튀어 올랐다 사라짐. 다운로드 자체는 성공 — UX 만 거추장스러움. 사용자 입장에선 "다운로드 시작할 때마다 화면 전환 반복" 으로 인지.

### 원인 — 두 갈래

(1) **`chrome.windows.create({focused:false})` 의 Windows honor 정책 약화**: §20 시점엔 `focused:false` 가 Windows 에서도 honor 돼 popup 이 메인 윈도우 뒤에 생성됐는데, 후속 Chrome 빌드에서 이 보장이 사라짐. popup 이 생성 시점에 OS foreground 로 올라옴.

(2) **`chrome.tabs.create({active:true, windowId: popup})` 의 SetForegroundWindow 트리거**: 매 노트북마다 새 탭을 popup 안에 active 로 생성하는데, Windows OS 가 이 호출에서 popup 창을 raise 시킴. `chrome.windows.update({focused:true})` 로 메인 복원 시도해도 Windows 의 SetForegroundWindow 제한 정책 (다른 프로세스가 사용자 입력 없이 포커스 강탈 불가) 에 막혀 무시되거나 taskbar flash 만 발생.

### 시도 — 즉시 refocus (실패, v0.4.44)

```js
// v0.4.44 시도
const tab = await chrome.tabs.create({active:true, windowId});
await refocusUserWindow();   // 즉시 메인 복원
await waitForTabComplete(tab.id);
await chrome.debugger.attach({tabId: tab.id}, "1.3");
await refocusUserWindow();   // attach 후 또 복원
// ... clickViaDebugger 후에도 매번 refocusUserWindow()
```

`chrome.windows.update({focused:true})` 자체가 Windows SetForegroundWindow 제한에 막혀 무시됨 — 복원 호출이 실행돼도 메인 윈도우가 실제로 foreground 로 올라오지 않음. 게다가 복원 호출 자체가 메인 윈도우에 focus 이벤트를 일으켜 사용자가 "전환" 으로 인지할 가능성도 있음. 폐기.

### 해결책 — 단일 탭 재사용 (v0.4.45 채택)

**근본 회피**: 매 노트북마다 `chrome.tabs.create` 를 호출하지 않는다. popup 안 단일 탭을 노트북 간에 `chrome.tabs.update(tabId, {url})` 로 navigate.

```js
// v0.4.45
let bulkWindowId = null;
let bulkTabId = null;
let bulkDebuggerAttached = false;

async function ensureBulkTab(url) {
  // 윈도우/탭 stale 검사…
  if (bulkTabId !== null) {
    // 재사용 — chrome.tabs.update 로 navigate. tabs.create 호출 없음 → 윈도우 raise 없음.
    await chrome.tabs.update(bulkTabId, { url });
    return bulkTabId;
  }
  // 첫 호출 — windows.create 에 url 을 함께 넘겨서 popup + 첫 탭을 한 번에.
  const win = await chrome.windows.create({
    url, type: "popup", focused: false, ...BULK_WINDOW_OPTS,
  });
  bulkWindowId = win.id;
  bulkTabId = win.tabs[0].id;
  return bulkTabId;
}
```

`openManagedTab` 의 bulk path 는 `ensureBulkTab` 만 호출, `chrome.tabs.create` 가 세션 전체에서 0번. 첫 노트북의 `windows.create` 1회만 raise 가능성 있음 (실측: 사용자 환경에서 화면 전환 안 보임).

추가로 `closeManagedTab(tabId)` 의 분기:
```js
if (tabId === bulkTabId) return;   // bulk 탭은 노트북 간 재사용 — 매번 닫지 않음
```

세션 끝의 `cleanupOwnedTabs` → `closeBulkWindow` 가 윈도우 닫으면서 탭도 같이 정리.

### debugger.attach 도 세션당 1회로

탭이 재사용되므로 `chrome.debugger.attach` 도 첫 노트북에서 1번만:
```js
if (inBulkWindow && !bulkDebuggerAttached) {
  await chrome.debugger.attach({ tabId }, "1.3");
  bulkDebuggerAttached = true;
}
```

노란 "디버깅 중" 배너 부착 시점도 popup 을 raise 시킬 수 있는데 1회로 한정 — 첫 노트북 windows.create 와 같은 시점이라 사용자는 1회 이내로만 인지.

### 학습

- **Chrome 의 `focused:false` 보장은 시간이 갈수록 약해진다** — 좌표 + focused:false 조합은 더 이상 충분조건이 아님. tab 단위 API 의 OS foreground 트리거를 회피하는 구조가 필요.
- **`chrome.tabs.create({active:true, windowId:popup})` 는 Windows 에서 popup 을 raise 시킨다** — 매번 새 탭을 만드는 패턴 자체가 화면 전환의 1차 원인. 같은 탭을 navigate 하는 패턴으로 우회.
- **`chrome.windows.update({focused:true})` 로의 복원은 Windows SetForegroundWindow 제한에 막혀 신뢰 불가** — 복원 전략은 fallback 으로만 두고, 1차 방어는 raise 자체를 발생시키지 않는 구조여야 함.
- **debugger.attach 의 부수효과 (디버그 배너 raise) 도 세션당 1회로 한정 가능** — 탭 재사용 패턴의 부산물. 의도하지 않은 이득.
- **구조 변경 시 closeManagedTab 의 분기 누락 주의** — bulk 탭이 노트북 단위로 닫히지 않도록 caller 가 알아서 비분기 처리하기보다, closeManagedTab 안에서 bulk 탭 ID 와 일치하면 no-op 하는 게 안전.

### 좌표 전략은 그대로 유지

§20 의 `BULK_WINDOW_OPTS = { left:-399, top:0 }` 는 v0.4.45 에서도 그대로 — Chrome 의 50% 규칙 통과 + 사용자에게 보이는 부분 최소화 목적. 단지 raise 가 안 일어나면 화면 전환도 안 일어남.

---

## 22. 추천 노트북이 스캔에 섞임 (2026-06-15, v0.4.48)

### 증상

`scan:all` 결과에 사용자가 만든 적 없는 영어 제목 노트북 (*Sherlock's Shadow*, *The World Ahead: 2025*, *AI-Powered Genetics* 등) 의 카드가 "신규" 로 잡힘. 스킵 등록해도 다음 스캔에 다시 신규로 올라옴. 노트북 수가 비정상적으로 큼 (228개).

### 원인

NotebookLM 홈 (`https://notebooklm.google.com/`) 은 두 섹션으로 구성: **"추천 노트북"** (Google 제공 샘플/공유) + **"최근 노트북"** (내 노트북). [src/content.js](src/content.js) 의 `getNotebookUrls` / `getNotebookCards` 가 `a[href*="/notebook/"]` 를 무차별 수집 → 추천 노트북까지 다 끌려옴.

구분이 어려운 이유 (2026-06-15 DOM 실측):
- 두 섹션 모두 같은 `/notebook/<id>` URL 패턴 → URL 로 구분 불가
- 두 섹션 모두 같은 카드 클래스 `mat-card.project-button-card .{color}-background` → 클래스로 구분 불가
- 단, 홈의 `h1~h3 / [role=heading]` 쿼리는 정확히 `['추천 노트북', '최근 노트북']` 2개만 반환 — **카드 제목은 heading 요소가 아님**. 이게 분류의 열쇠.

스킵해도 재출현하던 부작용: 추천 노트북 카드는 "Loading Notebook…" 상태 (cover/artifactId 미로딩) 로 잡히는 일이 잦아 `artifactId` 가 빈 채로 들어옴 → §19 가 *매칭* 쪽 폴백은 메웠지만 [src/background.js](src/background.js) `bulk:skip:selected` / `addSkippedEntry` 의 *저장* 쪽은 여전히 `if (!/^[0-9a-f]{8}$/.test(sid)) continue` 로 shortId 없으면 저장을 건너뜀 → 스킵이 영영 저장 안 됨.

### 대응

스킵 싸움 대신 **스캔 소스에서 추천 노트북 제외** — 한 번에 두 증상 해결:

```js
const FEATURED_HEADING_RE = /추천|featured|empfohlen|vorgestellt|destacad|en vedette/i;
function featuredNotebookUrlSet() {
  const set = new Set();
  // 헤딩 + 노트북 링크를 document order 로 한 번에 순회 (querySelectorAll 순서 보장).
  const nodes = document.querySelectorAll('h1,h2,h3,[role="heading"],a[href*="/notebook/"]');
  let featured = false;
  for (const el of nodes) {
    if (el.matches('a[href*="/notebook/"]')) {
      if (!featured) continue;
      // … href 검증 후 set.add(URL)
    } else {
      const t = (el.textContent || "").trim();
      if (t) featured = FEATURED_HEADING_RE.test(t);   // 섹션 헤딩이 토글
    }
  }
  return set;
}
```

`getNotebookUrls` / `getNotebookCards` 가 이 set 을 `continue` 로 제외.

### 학습

- **무회귀를 기본값으로** — 헤딩을 못 찾으면 (다른 로케일 / DOM 리디자인) featured set 이 비어 *전부 포함* = 기존 동작. 필터가 깨져도 내 노트북이 실수로 빠지는 일은 없게 설계. "잘못 제외" 보다 "안 제외" 쪽으로 fail.
- **문서 순서는 컨테이너 구조보다 robust** — 섹션을 감싸는 공통 ancestor 를 찾는 대신 `querySelectorAll` 의 document-order 보장에 기댐. Angular 컴포넌트 트리가 자주 바뀌어도 "헤딩 → 그 섹션 카드" 순서는 유지됨.
- **카드 제목이 heading 이 아니라는 전제에 의존** — 만약 향후 NotebookLM 이 카드 제목을 `<h3>` 로 렌더하면 featured 토글이 카드마다 흔들림. DOM 변경 시 `h*/[role=heading]` 쿼리가 여전히 섹션 헤딩만 반환하는지 재확인 ([[featured_notebooks_scan_exclude]] 메모리에도 기록).
- **저장 쪽 폴백 미완** — §19 가 매칭만 고치고 저장 (`bulk:skip:selected`) 은 그대로 둔 게 이 사고의 2차 원인. 추천 제외로 실사용 영향은 사라졌지만, 내 노트북도 로딩 race 중엔 동일 현상 가능 — (제목+날짜) 기반 스킵 저장 + 누락 건수 안내는 후속 과제로 남김.

### 진단 핸드오프

홈에서 `[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].map(h=>h.textContent.trim())` 로 섹션 헤딩 확인. 추천 섹션 헤딩 텍스트가 `FEATURED_HEADING_RE` 에 매칭되는지, 카드 수가 추천(소수)/최근(다수) 으로 갈리는지 검증.

---

## 23. feed.xml 이 episodes/ 보다 뒤처짐 — push 후 rebuild 누락 (2026-06-15, v0.4.48)

### 증상

다운로드/push 한 에피소드가 GitHub `docs/episodes/` 에는 올라갔는데 `docs/feed.xml` 에는 안 들어가 팟캐스트 앱 (YouTube Music 등) 에 안 보임. 실측: 6/4 에피소드가 6/5 push 됐는데 feed.xml 은 5/27 → 6/15 까지 19일간 재빌드 0회 → 10일간 stale. 6/15 의 다른 push 가 재빌드를 트리거하면서 비로소 6/4 까지 쓸려 들어감.

### 원인

[src/background.js](src/background.js) `pushEpisode` 는 **(1) audio PUT → (2) rebuildFeed** 2단계가 한 SW 안에서 순차. (1) 성공 후 (2) 가 실패하면:

```js
if (cfg.rssMode === "extension") {
  try { const feed = await rebuildFeed(...); ... }
  catch (e) { console.error("[feed]", e); pushResult.feedError = e.message; }  // 로그만, 재시도/복구 없음
}
```

- **SW idle 종료** (§6/§7): (1) 과 (2) 사이에 SW 가 죽으면 (2) 실행 못 함. 파일은 올라갔지만 feed 미반영.
- **transient GitHub 오류**: catch 가 삼키고 끝 → 다음 push 가 우연히 성공할 때까지 feed 가 episodes/ 보다 뒤처진 채 방치.

[[retention_dedup_loop]] / [[feed_lag_behind_episodes]] 와 같은 "episodes/ ↔ feed 불일치" 계열.

### 대응

```js
// 1) transient 오류 흡수 — rebuildFeed 는 idempotent (unchanged 면 PUT skip) 라 재시도 안전.
async function rebuildFeedWithRetry(opts, attempts = 3) { /* backoff 1s/2s */ }

// 2) 안전망 — episodes/ ↔ feed.xml 어긋남을 무조건 한 번 재빌드로 복구.
async function reconcileFeed(reason) {
  // rssMode==="extension" + token/repo 있을 때만, rebuildFeedWithRetry 호출
}
```

`reconcileFeed` 호출 지점 3곳:
- `bulk:remote` 작업 종료 `.finally` (개별 push 의 rebuild 가 누락돼도 작업 끝에 1회 권위 재빌드)
- `scan:all` 작업 종료 `.finally`
- `chrome.runtime.onStartup` (push 직후 SW 가 죽은 케이스의 마지막 그물 — 브라우저 재기동 시)

`pushEpisode` 의 per-push 재빌드도 `rebuildFeedWithRetry` 로 교체.

### 학습

- **idempotent 한 작업은 "끝에 한 번 더" 가 싸고 강력** — rebuildFeed 가 sha 비교로 unchanged 면 PUT 을 건너뛰므로, bulk/scan 끝과 SW 기동마다 무조건 호출해도 비용이 작음. "각 단계가 정확히 1회 성공" 을 보장하려 애쓰는 대신 "마지막에 reconcile" 패턴이 SW-death 같은 비결정적 실패에 더 견고.
- **catch 가 로그만 남기면 silent stale** — best-effort 라도 "다음 기회에 복구" 경로가 없으면 영구 누락. 외부 상태 (GitHub) 와의 동기화는 항상 reconcile 경로를 같이 둘 것.

### 진단 핸드오프

1. 라이브 피드: `curl https://<owner>.github.io/<repo>/feed.xml` → 최신 item pubDate + `Last-Modified` 헤더 (= 마지막 빌드 시각).
2. `GET api.github.com/repos/<repo>/commits?path=docs/feed.xml` 의 "auto: rebuild feed" 간격에 큰 공백이 있으면 그 기간 push 의 재빌드 누락.
3. 문제 에피소드 파일 커밋 시각 (`commits?path=docs/episodes/<urlencoded>`) vs feed.xml 재빌드 시각 비교. 파일이 먼저, feed 가 한참 뒤면 확정. (파일명 `YYYYMMDD` 는 NotebookLM cover 생성일이지 push 시각 아님 — 커밋 시각으로만 판단.)

---

## 24. 스킵 목록이 sync 8KB per-item 한도에 잘려 churn (2026-06-15, v0.4.49)

### 증상

사용자가 스킵 등록한 카드가 일괄 다운로드에서 다시 "신규" 로 잡혀 반복 시도 → 실패 (특히 NotebookLM 에서 삭제한 카드는 "카드 못 찾음"). SW 콘솔에 `[skip] sync quota 초과, 가장 옛것 10건 컷 (50 → 40)` 가 반복 출력. 진단 스니펫: `skippedShortIds` entry 43건 / 직렬화 7194 byte (8192 코앞).

### 원인

스킵 목록을 `chrome.storage.sync` 의 **단일 키** `skippedShortIds` 에 `{shortId, filename, title, date, notebookTitle, skippedAt}` **full 메타 배열**로 저장. `chrome.storage.sync` 는 두 한도가 있는데 — 총 100KB **그리고 per-item 8192 byte** — 단일 키 배열은 후자에 묶인다. 한글 title + notebookTitle 이 entry 당 ~150~400 byte 라 **~40건이면 8KB 초과**. `saveSkippedEntries` 의 quota catch 가 가장 옛것 20% 를 컷 → 목록이 ~40 에서 고정.

churn loop: 옛 스킵이 컷으로 증발 → 다음 스캔에 신규로 재인식 → selections 진입 → `runBulkRemote` choke-point 필터 (§22) 는 **그 시점 skipIndex 에 없으니** 통과시킴 → 다운로드 시도 → (삭제된 카드면) 실패 → auto-skip 재등록 (v0.4.47) → 또 8KB 초과 → **다른 10건 evict** → 그것들이 다음에 재출현. [[retention_dedup_loop]] 의 스킵 버전 — 영구 루프.

`§16` (CLAUDE.md) 의 "entry당 250byte × 400건 = 100KB" 서술이 **틀렸음** — per-item 8KB 한도를 간과해 실제 상한은 ~40건이었다.

### 대응

스킵 데이터를 8KB 제약이 없는 **`chrome.storage.local` 로 이전** (source-of-truth):
- `chrome.storage.local.skippedEntries` — full 메타 배열. local 은 ~10MB 라 수만 건 수용. 매칭(`loadSkippedIndex` 의 shortIds + titleKeys + titleSlugs)과 옵션 표시 모두 여기서.
- `chrome.storage.sync.skippedShortIds` — **shortId 문자열 배열만** cross-device 미러. ~12 byte/건 → 8KB 에 600+ 개. 넘쳐도 best-effort 컷 (local 은 전량 보존하므로 *그 기기* 매칭엔 무영향).

`loadSkippedEntries` 가 local + sync 를 shortId 기준으로 merge (local 우선, sync 가 다른 기기 발 스킵 보충). 옛 sync fat 포맷은 load 시 흡수 → 다음 `saveSkippedEntries` 때 새 포맷으로 정착 (마이그레이션 자동, 별도 단계 불필요). 단일 choke-point 인 load/save 만 변경 — `addSkippedEntry` / `bulk:skip:selected` / `loadSkippedIndex` / `removeSkippedShortId` 는 그대로 동작. `skip:clear` 는 local+sync 양쪽 비움.

### 학습

- **chrome.storage.sync 의 per-item 8KB 가 진짜 병목** — 총 100KB 만 보고 "여유" 라 오판하기 쉽다. *단일 키에 누적되는 배열*은 항상 8KB 에 먼저 막힌다. 누적형 데이터는 sync 에 두지 말 것 (또는 shard / 식별자만).
- **silent truncation 은 dedup/skip 류에서 영구 루프를 만든다** — 컷이 로그만 남기고 끝나면 [[retention_dedup_loop]] 와 동일한 자기증식. 한도형 저장엔 "넘치면 어디로 가는가" 를 설계 시 명시.
- **choke-point 필터는 데이터가 살아 있어야 의미** — §22 가 모든 경로에 skip 필터를 깔았어도, 저장이 evict 되면 필터가 볼 게 없다. 필터 일관성 + 저장 내구성은 한 쌍.

### 진단 핸드오프

옵션 페이지 콘솔: `chrome.storage.sync.get('skippedShortIds', r => console.log((r.skippedShortIds||[]).length, new Blob([JSON.stringify(r)]).size))`. bytes 가 8192 근처면 cap. `chrome.storage.local.get('skippedEntries', r => console.log((r.skippedEntries||[]).length))` 로 local 이전 여부 확인.

---

## 검증된 전체 흐름 (v0.4.0, 2026-04-29)

```
content.js (artifact-more-button → 다운로드 메뉴 polling 클릭)
  → background.onMessage("download:expect")  // 메타 큐잉
  → Chrome 다운로드 시작
  → background.onDeterminingFilename
       ├─ suggest({ filename: YYYYMMDD__노트북__제목.ext })  // 로컬 저장
       └─ pushEpisode(audioUrl, filename)
            ├─ SW fetch audioUrl (credentials:"include", host_permissions 확장)
            │    redirect: lh3.googleusercontent.com → ServiceLogin → lh3.google.com → drum.usercontent.google.com
            ├─ ghGet (sha 확인)
            ├─ ghPut (audio Contents API PUT)
            └─ if rssMode === "extension":
                rebuildFeed (src/feed.js)
                  ├─ ghGet docs/podcast.json (메타)
                  ├─ ghList docs/episodes/  (sha 포함)
                  ├─ applyRetention → ghDelete drop 대상
                  └─ ghPut docs/feed.xml

[ rssMode === "actions" 모드는 익스텐션이 audio 만 PUT.
  사용자 repo 의 .github/workflows/build-feed.yml 가 트리거되어
  transcode → build_feed (retention 포함) → commit ]
```

### 디버깅 핸드오프

`[push]` / `[feed]` prefix log:
- [src/background.js](src/background.js) — `[push] SW fetch host=...`, `[push] fetched XX MB`, `[push] ... pushed`
- [src/feed.js](src/feed.js) — `[feed] retention drop: ...`, `[feed] rebuilt with N episodes` 또는 `[feed] skip (feed unchanged)`

popup 에는 `notifyPush` 가 던지는 `push:result` 메시지로 ok/실패 + feed 결과 (`+ feed`, `⚠ feed`) 가 카드 상태에 노출되어 SW devtools 안 열어도 확인 가능.
