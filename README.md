# NotebookLM Podcast Sync (Chrome 익스텐션)

NotebookLM 의 음성개요(Audio Overview)를 본인 GitHub repo 로 자동 push 해서 개인 팟캐스트 RSS 피드를 만드는 Chrome 익스텐션.

[notebooklm-podcast](https://github.com/kiuk104/notebooklm-podcast) (Python + Playwright + Flask 관리자) 의 v2 — Python/ffmpeg/Playwright 설치 없이 익스텐션만 깔면 동작하는 게 목표입니다.

## 상태

🚧 **개발 중 — v0.4.30**. NotebookLM 노트북 페이지에서 음성개요 목록을 스캔하고, 각 카드를 `YYYYMMDD__노트북__shortId__제목.{ext}` 파일명으로 다운로드 + 등록된 GitHub repo 의 `docs/episodes/` 로 자동 push 합니다 (`shortId` 는 카드의 NotebookLM artifact UUID 첫 8자 — 노트북 이름이나 카드 제목이 바뀌어도 같은 audio 로 인식되어 중복 push 가 방지됨). 단일 카드 / 현재 노트북 일괄 / 모든 노트북 sweep 세 가지 모드. **bulk sweep 은 별도 popup window + `chrome.debugger` 의 trusted input** 으로 NotebookLM 의 visibility / userActivation 게이트를 우회 (자세한 매커니즘은 [IMPLEMENTATION_NOTES §9, §10](IMPLEMENTATION_NOTES.md)). m4a/mp4 는 익스텐션 측에서 **자동으로 mp3 64k mono 로 transcode** (offscreen document + lamejs, port 기반 keepalive) — GitHub Contents/Git Data API 의 ~40 MB 사각지대 회피. 옛 m4a 가 repo 에 남아있다면 워크플로 측 ffmpeg transcode 도 함께 켤 수 있음. RSS feed (`docs/feed.xml`) 는 두 모드 — 사용자 repo 의 GitHub Actions 워크플로가 audio push 마다 자동 빌드 (default) / 익스텐션이 매 push 시마다 직접 생성. `docs/podcast.json` 의 `retention` (`maxItems` / `maxAgeDays` / `maxTotalMB`) 으로 보관 정책. **popup + 관리 페이지 + 도움말 모두 한·영·독 3개 언어 i18n** (`src/i18n.js` 공유 테이블, 사이드바 셀렉터로 즉시 전환 + `chrome.storage.local.uiLang` 영구 저장). 관리 페이지는 사이드바 네비게이션 (진행 모니터 / GitHub / 메타 / 에피소드) + 진행 모니터 라이브 뱃지. **직전 스캔 결과 패널의 [선택해서 받기 ▾]** 로 노트북별 트리 펼쳐 카드 단위 체크박스 선택 → 그 selections 만 다운로드 ([신규 받기] 의 "전부 다" 와 별개). bulk 종료 시 **OS 알림** (성공/실패 카운트), 실패 카드들은 [실패 N개 재시도] 버튼으로 같은 selection 재실행. 푸시된 에피소드 목록은 정렬 / 그룹 / 다중 삭제 / [편집 ↗] 원본 노트북으로 이동 / **[공유 ↗] Web Share API + clipboard fallback** / **컬럼 너비 드래그 리사이즈** (영구 저장). 노트북 URL 맵을 `chrome.storage.local` 에 영구 보존 — 세션 새로 시작해도 [편집 ↗] 가 다시 스캔 없이 동작. 활동 로그는 **no-config skip (⚠ amber)** 와 **dedup skip (↻ gray)** 를 구분 — 토큰/repo 미설정 상태에서 "push 가 진짜 일어났는가?" 모호함 제거. 표준 워크플로 한 벌은 [examples/feed-builder/](examples/feed-builder/), 사용법은 익스텐션 popup 의 [❓ 도움말].

> **v0.4.27 packaging fix ⚠**: v0.4.0 ~ v0.4.25 의 zip 빌드에 `vendor/lamejs.js` 가 통째로 빠져 있었습니다 ([scripts/package.py](scripts/package.py) 의 `INCLUDE_DIRS` 누락). GitHub Contents API 의 ~37 MiB 한계를 넘는 큰 파일은 offscreen transcode → mp3 압축 경로를 타야 하는데, 이 경로가 vendor 누락으로 404 에러를 냅니다. 평균 음성개요는 한계 내라 대부분 사용자가 못 느꼈지만, 긴 음성개요 (20분+) 는 영향. v0.4.26 이전 zip 으로 unpacked 로드한 경우 v0.4.27+ 로 업데이트 필요 (git clone 으로 직접 로드한 경우는 vendor/ 가 워킹트리에 항상 있어 무관).

## 로드맵

- [x] 프로젝트 골격 (manifest v3 + content/background/popup/options)
- [x] NotebookLM 페이지 스캔 (노트북 제목, audio overview 목록)
- [x] audio overview 다운로드 트리거 + `YYYYMMDD__노트북__shortId__제목.{ext}` 자동 rename (UUID 기반 안정 dedup)
- [x] PAT 기반 GitHub Contents API push (`docs/episodes/`) + Git Data API fallback (>37 MiB 파일)
- [x] 일괄 다운로드 — 카드별 체크박스 + [선택 받기] (현재 노트북 + 모든 노트북 sweep 양쪽)
- [x] cross-notebook scan — [모든 노트북 스캔] 으로 v1 cron sweep 동등 (background tab 으로 노트북 URL 수집 후 순차 방문)
- [x] bulk:remote download — 별도 popup window + `chrome.debugger` Input.dispatchMouseEvent (NotebookLM 의 trusted input 게이트 우회)
- [x] 관리 페이지 진행 모니터 — task state / 진행률 / 경과 시간 / GitHub push 활동 로그 라이브 표시
- [x] 직전 스캔 결과 persist — 30분간 유지, popup/관리 페이지 양쪽에서 [신규 받기] 트리거 가능
- [x] auto-download 옵션 — 스캔 후 신규 카드 자동 다운로드 (default OFF, 첫 사용은 수동 검수 권장)
- [x] Chrome tabs API transient error 자동 retry — 50+ 노트북 cascade fail 방지
- [x] ghPut 409/403 transient retry — concurrent commit race / repo rule timeout 자동 회복
- [x] zombie task detection — SW 재시작 후 stale running 상태 force-fail
- [x] RSS feed 자동 생성 — GitHub Actions 위임 모드 (사용자 repo 의 워크플로가 빌드)
- [x] RSS feed 자동 생성 — 익스텐션 직접 생성 모드 (옵션)
- [x] Rolling window (오래된 에피소드 자동 정리) — `retention.maxItems` / `maxAgeDays` / `maxTotalMB`
- [x] m4a → mp3 transcode — 워크플로 측 native ffmpeg (`docs/podcast.json` 의 `transcode` 필드)
- [x] m4a → mp3 transcode — **익스텐션 내장** (offscreen document + lamejs, v0.4.11). m4a/mp4 자동 mp3 64k mono 변환 후 push.
- [x] 푸시된 에피소드 목록 관리 (관리 페이지) — 정렬 / 노트북별 그룹 / 다중 선택 삭제 / [편집 ↗] 원본 노트북 새 탭으로 열기
- [x] 관리 페이지 사이드바 네비게이션 — 도구 / 설정 / 데이터 그룹화, hash 라우팅, 진행 모니터 라이브 뱃지
- [x] 관리 페이지 한·영·독 i18n — `data-i18n` 속성 + `t()` 헬퍼, 사이드바 언어 셀렉터로 즉시 전환 + storage 영구 저장 (v0.4.20)
- [x] popup i18n (한·영·독) — `src/i18n.js` 가 popup/options 양쪽 공유, popup 의 모든 라벨/상태 메시지가 `t()` 통과 (v0.4.23)
- [x] 도움말 페이지 영문/독문 (`src/help/help-en.html`, `help-de.html`) + 언어 스위처 — popup/options 의 [❓ 도움말] 링크가 현재 `uiLang` 에 따라 자동 라우팅 (v0.4.22)
- [x] 에피소드 목록 [공유 ↗] — Web Share API (모바일/지원 OS) + clipboard fallback. URL 은 `podcast.json` 의 `baseUrl` 우선, 없으면 `<owner>.github.io/<repo>/episodes/<filename>` (v0.4.24)
- [x] 노트북 URL 맵 영구 저장 — `chrome.storage.local` 의 slug→URL 맵을 popup/bulk 스캔 완료 시 자동 갱신. 새 세션에서도 [편집 ↗] 가 다시 스캔 없이 원본 노트북으로 이동 (v0.4.24)
- [x] 에피소드 테이블 컬럼 너비 드래그 리사이즈 — 헤더 우측 엣지 drag, 인접 컬럼만 영향, `chrome.storage.local.epColWidths` 영구 저장. 모니터/에피소드 페이지는 viewport 폭 활용 (v0.4.24)
- [x] bulk 완료 OS 알림 — `chrome.notifications` 로 성공/실패 카운트 즉시 안내 (관리 페이지 닫혀 있어도)
- [x] 실패 카드 재시도 — bulk 종료 후 실패 selection persist → 직전 스캔 패널의 [실패 N개 재시도] 버튼으로 같은 selection 재실행
- [x] offscreen transcode keepalive — multi-reason `["AUDIO_PLAYBACK","BLOBS","WORKERS"]` + 무음 audio loop + port 기반 SW 연결로 30s+ 지속 변환 안정화
- [x] 활동 로그 skip 종류 구분 — no-config (⚠ amber) vs dedup (↻ gray). 토큰/repo 미설정에서 "push 가 진짜 일어났는가?" 모호함 제거 (v0.4.27)
- [x] **packaging 버그 수정** — `vendor/lamejs.js` 가 v0.4.0~0.4.25 zip 에서 누락되어 있던 것을 fix. `scripts/package.py` 의 `INCLUDE_DIRS` 에 `vendor` 추가 (v0.4.27)
- [x] 옵션 페이지 repo-hint 강화 — `owner/name` 포맷, `github.com/new` 링크, PAT-owner 일치 경고, Pages 활성화 경로 (v0.4.27)
- [x] **다기기 동기화 (Chrome Sync)** — GitHub 설정 (PAT 포함) + UI 언어를 `chrome.storage.sync` 로 옮겨 같은 Google 계정의 다른 Chrome 과 자동 공유. 옛 `local` 데이터는 SW 시작 시 1회성 마이그레이션. 옵션 페이지에 동기화 안내 박스 + Chrome Sync 패스프레이즈 (E2EE) 권장 링크. 다른 기기에서 push 된 변경은 `storage.onChanged` 로 라이브 반영. 진행 상태 / 스캔 결과 / 노트북 URL 맵은 device-local 의미라 `local` 그대로 유지 (v0.4.28)
- [x] **선택해서 받기 (cross-notebook 카드 picker)** — [모든 노트북 스캔] 결과의 [선택해서 받기 ▾] 클릭 시 노트북별 트리 펼침. 카드별 체크박스 (default: 신규만 체크, 이미 받은 카드는 숨김 토글), 노트북별 마스터 / 전체 마스터, [신규/받음/제목 대기] 태그 + placeholder 카드 비활성. [선택한 N개 받기] → 선택된 selections 만 `runBulkRemote`. 기존 [신규 받기] 의 "전부 다" 동작은 그대로 (v0.4.29)
- [ ] Chrome Web Store 등록 — 자료 준비 완료 ([RELEASING.md](RELEASING.md), [STORE_LISTING.md](STORE_LISTING.md), [docs/privacy.html](docs/privacy.html)). 남은 사용자 측 작업: Pages 활성화 + 스크린샷 + Developer 계정 + zip 업로드.

## 설치 (개발 모드)

Chrome Web Store 에 아직 올리지 않았으므로 압축해제 모드로 직접 로드합니다.

1. **repo clone**
   ```
   git clone https://github.com/kiuk104/notebooklm-podcast-extension
   ```
2. **Chrome 확장 페이지 열기** — 주소창에 `chrome://extensions/`
3. **개발자 모드 ON** — 페이지 우측 상단 토글
4. **[압축해제된 확장 프로그램을 로드합니다]** 클릭 → clone 한 폴더 선택 (이 안에 `manifest.json` 이 있어야 함)

코드 수정 후 반영하려면 `chrome://extensions/` 의 해당 카드에서 **새로고침 (↻)** 클릭. content script 를 고친 경우 NotebookLM 탭도 **F5**.

## 사용

1. NotebookLM 에서 음성개요가 있는 노트북 페이지를 엽니다 (`https://notebooklm.google.com/notebook/<id>`)
2. **그 페이지에서 F5 한 번** — content script 가 inject 되도록
3. 툴바에서 익스텐션 아이콘 클릭 → **[현재 노트북 스캔]**
4. 노트북 제목 / 생성일 + 음성개요 목록이 표시됩니다
5. 받고 싶은 카드 옆 **[받기]** → Chrome 기본 다운로드 폴더에 다음 형식으로 저장:
   ```
   YYYYMMDD__노트북-슬러그__shortId__제목-슬러그.{m4a|mp3}
   ```
   - `YYYYMMDD` 는 NotebookLM 노트북의 cover 생성일 (`.cover-subtitle-date` 의 `title` 속성)
   - `shortId` 는 카드의 NotebookLM artifact UUID 첫 8자 (16진수). 제목이 바뀌어도 같은 UUID 면 같은 audio 로 인식되어 GitHub 측 중복 push 가 방지됨.
   - 슬러그는 한글/영숫자만 남기고 노트북·제목 각각 40자로 컷 (Windows MAX_PATH + GitHub path 255-byte 가드)

## 디버깅

| 대상 | 여는 방법 |
|---|---|
| popup | 팝업 위 우클릭 → **검사** |
| background (service worker) | `chrome://extensions/` 카드의 **service worker** 링크 클릭 |
| content script | NotebookLM 탭에서 **F12** → Console / Sources |

NotebookLM UI 가 바뀌어 동작이 깨지면 [src/content.js](src/content.js) 상단의 `SEL` 객체와 [src/background.js](src/background.js) 의 referrer 매칭 로직부터 점검하세요. v1 검증된 셀렉터 목록은 `notebooklm-podcast` repo 의 `src/downloader.py` 상단 상수 참고.

## 권한

| 권한 | 용도 |
|---|---|
| `activeTab`, `scripting` | 현재 NotebookLM 탭 + bulk sweep 의 background tab 에 content script 주입 |
| `storage` | GitHub token / repo 설정을 브라우저 로컬에 저장 |
| `downloads` | NotebookLM audio 받기 + 파일명 rename |
| `alarms` | 장시간 bulk 작업 중 SW idle 종료 방지 (30초 주기 keepalive) |
| `debugger` | bulk sweep 의 download 메뉴 클릭에 trusted input 주입 (NotebookLM 의 isTrusted/userActivation 게이트 우회) |
| `offscreen` | m4a/mp4 → mp3 transcode 를 위한 offscreen document (AudioContext + lamejs) |
| `notifications` | bulk 종료 시 OS 알림으로 성공/실패 카운트 안내 (관리 페이지 닫혀 있어도) |
| `host_permissions: notebooklm.google.com` | 페이지 DOM 스캔 |
| `host_permissions: *.googleusercontent.com, *.usercontent.google.com, accounts.google.com, lh3.google.com` | audio CDN + 인증 redirect 체인 통과 ([IMPLEMENTATION_NOTES §2](IMPLEMENTATION_NOTES.md)) |
| `host_permissions: api.github.com` | 본인 repo 에 audio / RSS push |

토큰은 `chrome.storage.sync` 에 저장되어 같은 Google 계정의 다른 Chrome 과 자동 동기화 (Chrome Sync 패스프레이즈 켜면 E2EE). 외부 서버로 전송되지 않으며 GitHub API 호출 시에만 Authorization 헤더로 사용됩니다. 자세한 권한 정당화: [help 페이지](src/help/help.html) §11 또는 [STORE_LISTING.md](STORE_LISTING.md).

## GitHub repo 준비

익스텐션이 push 할 빈 public repo 를 미리 만들어 두세요:
1. GitHub 에서 새 repo 생성 (public)
2. **Settings → Pages → Source: `main` branch / `/docs` folder** 로 활성화
3. 생성된 RSS URL: `https://<사용자>.github.io/<repo>/feed.xml`
4. 그 URL 을 팟캐스트 앱에 등록

## v1 에서 배운 함정

구현 시 주의할 NotebookLM DOM/동작 함정과 v1 의 대응책: [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md).

## 릴리스 / 버전 업데이트

- 릴리스 절차 (버전 정책, 패키징, sanity check, 업로드): [RELEASING.md](RELEASING.md)
- Chrome Web Store 등록정보 카피 (제목·요약·상세설명·권한 정당화·데이터 사용 선언·체크리스트): [STORE_LISTING.md](STORE_LISTING.md)
- 개인정보 처리방침: [docs/privacy.html](docs/privacy.html) (Pages 활성화 시 `https://kiuk104.github.io/notebooklm-podcast-extension/privacy.html`)

## 라이선스

MIT
