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
