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

### 학습

- **`active: false` ≠ `visibilityState: 'visible'`**: tab 의 active 상태와 페이지의 visibility 는 다름. tab.active 는 "그 윈도우 안에서 보이는 tab 인가"이고, visibility 는 "그 tab 이 화면에 나타나는가". popup 윈도우 안에서 tab 이 active 면 visibility 는 'visible' — focus 는 별개.
- **`chrome.windows` API 는 별도 permission 안 필요** — base extension capability. manifest 수정 없음.
- **검증되지 않은 background tab 호환**을 가정하지 말 것. content script 가 *click* 까지 성공해도 페이지 측 reaction 이 다를 수 있음. download 같은 Chrome API event 가 발화 여부로 진단해야 함.
- **사용자 검증된 단건 흐름 vs bulk 의 차이는 *환경*** — 같은 코드라도 active vs background tab 에서 페이지가 다르게 동작할 수 있음.

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
