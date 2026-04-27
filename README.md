# NotebookLM Podcast Sync (Chrome 익스텐션)

NotebookLM 의 음성개요(Audio Overview)를 본인 GitHub repo 로 자동 push 해서 개인 팟캐스트 RSS 피드를 만드는 Chrome 익스텐션.

[notebooklm-podcast](https://github.com/kiuk104/notebooklm-podcast) (Python + Playwright + Flask 관리자) 의 v2 — Python/ffmpeg/Playwright 설치 없이 익스텐션만 깔면 동작하는 게 목표입니다.

## 상태

🚧 **개발 초기 — 스켈레톤 단계**. 현재는 노트북 페이지에서 cover 정보와 audio overview 목록을 스캔만 합니다.

## 로드맵

- [x] 프로젝트 골격 (manifest v3 + content/background/popup/options)
- [x] NotebookLM 페이지 스캔 (노트북 제목, audio overview 목록)
- [ ] audio overview 다운로드 트리거 (m4a)
- [ ] GitHub OAuth 또는 PAT 기반 commit/push
- [ ] RSS feed 자동 생성 (`docs/feed.xml`) + index.html
- [ ] Rolling window (오래된 에피소드 자동 정리, repo 용량 관리)
- [ ] m4a → mp3 transcode (ffmpeg.wasm — 선택)
- [ ] Chrome Web Store 등록

## 설치 (개발)

1. 이 repo 를 clone:
   ```
   git clone https://github.com/kiuk104/notebooklm-podcast-extension
   ```
2. Chrome 에서 `chrome://extensions/` → 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램 로드** → 이 폴더 선택
4. 익스텐션 아이콘 → ⚙ GitHub 설정 → Personal Access Token + repo 등록
5. NotebookLM 노트북 페이지를 열고 익스텐션 아이콘 → "현재 노트북 스캔"

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

## 라이선스

MIT
