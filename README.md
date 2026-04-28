# NotebookLM Podcast Sync (Chrome 익스텐션)

NotebookLM 의 음성개요(Audio Overview)를 본인 GitHub repo 로 자동 push 해서 개인 팟캐스트 RSS 피드를 만드는 Chrome 익스텐션.

[notebooklm-podcast](https://github.com/kiuk104/notebooklm-podcast) (Python + Playwright + Flask 관리자) 의 v2 — Python/ffmpeg/Playwright 설치 없이 익스텐션만 깔면 동작하는 게 목표입니다.

## 상태

🚧 **개발 중 — v0.3.0**. NotebookLM 노트북 페이지에서 음성개요 목록을 스캔하고, 각 카드를 `YYYYMMDD__노트북__제목.{ext}` 파일명으로 다운로드 + 등록된 GitHub repo 의 `docs/episodes/` 로 자동 push 합니다. RSS feed 자동 생성은 아직 미구현.

## 로드맵

- [x] 프로젝트 골격 (manifest v3 + content/background/popup/options)
- [x] NotebookLM 페이지 스캔 (노트북 제목, audio overview 목록)
- [x] audio overview 다운로드 트리거 + `YYYYMMDD__노트북__제목.{ext}` 자동 rename
- [x] PAT 기반 GitHub Contents API push (`docs/episodes/`)
- [ ] RSS feed 자동 생성 (`docs/feed.xml`) + index.html
- [ ] Rolling window (오래된 에피소드 자동 정리, repo 용량 관리)
- [ ] m4a → mp3 transcode (ffmpeg.wasm — 선택)
- [ ] Chrome Web Store 등록

## 설치 (개발 모드)

Chrome Web Store 에 아직 올리지 않았으므로 압축해제 모드로 직접 로드합니다.

1. **repo clone**
   ```
   git clone https://github.com/kiuk104/notebooklm-podcast-extension
   ```
2. **Chrome 확장 페이지 열기** — 주소창에 `chrome://extensions/`
3. **개발자 모드 ON** — 페이지 우측 상단 토글
4. **[압축해제된 확장 프로그램을 로드합니다]** 클릭 → clone 한 폴더 선택 (이 안에 `manifest.json` 이 있어야 함)

> ⚠️ 아이콘 누락 경고: `icons/` 폴더가 비어 있어 카드에 빨간 오류가 뜰 수 있지만 기능은 정상 동작합니다. 배포 단계에서 16/48/128px PNG 를 채워 넣을 예정.

코드 수정 후 반영하려면 `chrome://extensions/` 의 해당 카드에서 **새로고침 (↻)** 클릭. content script 를 고친 경우 NotebookLM 탭도 **F5**.

## 사용

1. NotebookLM 에서 음성개요가 있는 노트북 페이지를 엽니다 (`https://notebooklm.google.com/notebook/<id>`)
2. **그 페이지에서 F5 한 번** — content script 가 inject 되도록
3. 툴바에서 익스텐션 아이콘 클릭 → **[현재 노트북 스캔]**
4. 노트북 제목 / 생성일 + 음성개요 목록이 표시됩니다
5. 받고 싶은 카드 옆 **[받기]** → Chrome 기본 다운로드 폴더에 다음 형식으로 저장:
   ```
   YYYYMMDD__노트북-슬러그__제목-슬러그.{m4a|mp3}
   ```
   - `YYYYMMDD` 는 NotebookLM 노트북의 cover 생성일 (`.cover-subtitle-date` 의 `title` 속성)
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
| `activeTab`, `scripting` | 현재 NotebookLM 탭에 content script 주입 |
| `host_permissions: notebooklm.google.com` | NotebookLM 페이지에서 카드 정보 읽기 |
| `host_permissions: api.github.com` | 사용자 본인 repo 에 mp3/RSS push |
| `storage` | GitHub token / repo 설정을 브라우저 로컬에 저장 |
| `downloads` | NotebookLM 이 내려준 mp3 받기 |

토큰은 `chrome.storage.local` 에만 저장되고 외부로 전송되지 않습니다 (GitHub API 호출 시에만 사용).

## GitHub repo 준비

익스텐션이 push 할 빈 public repo 를 미리 만들어 두세요:
1. GitHub 에서 새 repo 생성 (public)
2. **Settings → Pages → Source: `main` branch / `/docs` folder** 로 활성화
3. 생성된 RSS URL: `https://<사용자>.github.io/<repo>/feed.xml`
4. 그 URL 을 팟캐스트 앱에 등록

## v1 에서 배운 함정

구현 시 주의할 NotebookLM DOM/동작 함정과 v1 의 대응책: [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md).

## 라이선스

MIT
