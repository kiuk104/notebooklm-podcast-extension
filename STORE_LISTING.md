# Chrome Web Store 등록정보 (제출용 사본)

[Developer Dashboard](https://chrome.google.com/webstore/devconsole) 의 "스토어 등록정보 / Store listing" 폼에 그대로 붙여넣기 위한 카피. 한국어 우선 — 익스텐션 UI 가 한국어 전용이라 1차 타겟이 한국어 사용자.

---

## 1. 기본 정보

### 1-1. 항목 이름 (Item name) — 최대 75자
```
NotebookLM Podcast Sync
```
> 한·영 동일. Web Store 검색에 단순한 영문 키워드가 잡히도록.

### 1-2. 요약 / Summary — 최대 132자, 검색 결과에 노출되는 한 줄

**한국어 (1차)**
```
NotebookLM 음성개요를 본인 GitHub 저장소로 push 해서 개인 팟캐스트 RSS 피드를 만듭니다. 서버 불필요, 토큰은 브라우저에만 저장.
```
> 길이: 86자. 여유 있음.

**영어 (다른 언어 추가 시)**
```
Push NotebookLM Audio Overviews to your own GitHub repo and turn them into a personal podcast RSS feed. No server. Token stays local.
```
> 길이: 132자. 한도 내.

### 1-3. 카테고리
- **Productivity (생산성)** — NotebookLM 보조도구 위치.
- (서브 카테고리가 있으면) **Workflow & Planning Tools**.

### 1-4. 언어
- 1차: **한국어 (ko)** — 익스텐션 UI 와 도움말이 한국어.
- 추가: **영어 (en)** — 검색 도달용. 타이틀·요약은 위 영문, 상세 설명은 §1-5 의 영문 본문.

---

## 1-5. 상세 설명 (Detailed description) — 최대 16,000자

### 한국어 본문

```
NotebookLM 의 음성개요(Audio Overview)는 NotebookLM 안에서만 들을 수 있어 모바일·차량·러닝 같은 일상 청취 환경에 어울리지 않습니다. 이 익스텐션은 음성개요를 사용자 본인 GitHub 저장소로 자동 push 해서, 일반 팟캐스트 앱 (Apple Podcasts, Pocket Casts, Overcast 등) 으로 들을 수 있는 개인 RSS 피드를 만들어 줍니다.

— 작동 방식 —

1. NotebookLM 노트북 페이지에서 익스텐션 아이콘 → [현재 노트북 스캔].
2. 음성개요 카드 옆 [받기] 한 번 클릭.
3. Chrome 이 audio 를 다운로드 + 익스텐션이 같은 audio 를 본인 GitHub 저장소의 docs/episodes/ 로 자동 push.
4. (옵션) 같은 저장소의 GitHub Actions 워크플로가 RSS feed (docs/feed.xml) 를 자동 생성, 또는 익스텐션이 매 push 시마다 직접 생성.
5. GitHub Pages 의 RSS URL 을 팟캐스트 앱에 등록.

이후 새 음성개요가 생길 때마다 [받기] 한 번이면 끝 — 팟캐스트 앱이 알아서 새 에피소드를 가져옵니다.

— 주요 기능 —

• 안정 dedup: 카드의 NotebookLM artifact UUID 를 파일명에 박아, NotebookLM 측에서 노트북 이름·카드 제목을 바꿔도 같은 audio 로 인식 — 중복 push 방지.
• 두 가지 RSS 모드: GitHub Actions 워크플로 위임 (권장) 또는 익스텐션 직접 생성. 옵션에서 전환.
• 보관 정책: docs/podcast.json 의 retention 필드로 maxItems / maxAgeDays 자동 정리. 저장소 용량 통제.
• Transcode (옵션): 워크플로 측 ffmpeg 로 m4a → mp3 자동 변환. 1시간 audio 가 5~10초.
• 설정 검증 버튼: 토큰·저장소 권한이 실제로 통하는지 다운로드 흐름 전에 확인.
• 한국어 음성개요 제목·노트북 제목을 슬러그 + UUID 형태로 안전하게 처리 (Windows MAX_PATH, GitHub path 255-byte 가드).

— 한 번만 셋업하면 끝 —

GitHub PAT (Personal Access Token) 발급 → 빈 public 저장소 만들기 → Pages 활성화 → 익스텐션 옵션에 token + repo 입력. 자세한 단계는 익스텐션 popup 의 [도움말] 페이지 (한국어).

— 프라이버시 —

GitHub PAT 는 chrome.storage.local 에만 저장되며, api.github.com 호출의 Authorization 헤더로만 사용됩니다. 익스텐션 개발자나 제3자에게는 어떤 데이터도 전송되지 않습니다. 자세한 내용은 개인정보 처리방침 참고.

— 오픈소스 —

MIT 라이선스. 소스코드: https://github.com/kiuk104/notebooklm-podcast-extension
```

### 영어 본문

```
NotebookLM's Audio Overviews live inside NotebookLM. This extension lets you back them up to your own GitHub repository and turn them into a personal podcast RSS feed — playable in any podcast app (Apple Podcasts, Pocket Casts, Overcast, etc.).

— How it works —

1. On a NotebookLM notebook page, click the extension icon → [Scan current notebook].
2. Click [Download] next to an audio overview card.
3. Chrome downloads the audio while the extension simultaneously pushes the same audio to docs/episodes/ in your own GitHub repository.
4. (Optional) A GitHub Actions workflow in the same repo rebuilds the RSS feed (docs/feed.xml) on each push — or have the extension build it directly.
5. Subscribe to the GitHub Pages RSS URL from your podcast app.

After setup, every new audio overview is just one click away.

— Highlights —

• Stable dedup: NotebookLM artifact UUIDs are embedded into the filename, so renaming notebooks or audio titles in NotebookLM never causes duplicate pushes.
• Two RSS modes: delegate to a GitHub Actions workflow (recommended) or have the extension build feed.xml directly. Switchable from options.
• Retention policy: the retention field in docs/podcast.json (maxItems / maxAgeDays) prunes old episodes automatically — keeps your repo small.
• Optional transcode: m4a → mp3 via workflow-side ffmpeg. A one-hour audio takes 5–10 seconds.
• "Verify settings" button checks that your token and repository actually work before any download flow.
• Korean filename safety: notebook + audio titles are slugified and length-capped to stay within Windows MAX_PATH and GitHub's 255-byte path limit.

— One-time setup —

Create a GitHub Personal Access Token, an empty public repo, enable Pages, and paste the token + repo into the extension options. Step-by-step guide is built into the extension's [Help] page.

— Privacy —

Your GitHub token is stored in chrome.storage.local on your device and is sent only to api.github.com as an Authorization header. The extension author cannot access any of your data. See the privacy policy for details.

— Open source —

MIT licensed. Source: https://github.com/kiuk104/notebooklm-podcast-extension
```

---

## 2. Single Purpose 선언 (개인 정보 보호 관행 탭)

> Web Store 의 "Single purpose" 입력란. 리뷰어가 가장 먼저 보는 한 줄.

```
This extension archives a user's NotebookLM Audio Overviews to a GitHub repository they own, and exposes them as a personal podcast RSS feed.
```

한국어 가이드 (참고용, 폼에는 영어로 입력):
> NotebookLM 음성개요를 사용자 본인 GitHub 저장소에 백업하고 개인 팟캐스트 RSS 피드로 노출하는 단일 목적 익스텐션.

---

## 3. 권한 정당화 (Permission justifications)

> "개인 정보 보호 관행" 탭의 각 권한 박스에 입력. 리뷰가 까다롭게 보는 부분 — 권한 이름과 정확히 매칭되는 사용 흐름을 적어야 함.

### 3-1. `activeTab` justification
```
Used together with `scripting` to inject the content script into the user's currently open NotebookLM notebook tab when they click the toolbar icon. The content script reads audio overview metadata (titles, artifact UUIDs, cover date) from the page DOM and triggers downloads. No other tabs are accessed.
```

### 3-2. `scripting` justification
```
Programmatically injects the content script (src/content.js) into the active NotebookLM notebook tab when the user invokes "Scan current notebook" from the popup. Required because content_scripts in manifest only auto-inject on page load — users typically open the popup on an already-loaded tab.
```

### 3-3. `storage` justification
```
Persists the user's GitHub Personal Access Token, target repository (owner/name), committer name/email, and RSS-mode preference in `chrome.storage.local`. These settings are read on every download to authenticate API calls. Nothing is synced to Google or any external server.
```

### 3-4. `downloads` justification
```
Listens to `chrome.downloads.onDeterminingFilename` to rename audio overview downloads to the canonical pattern `YYYYMMDD__notebook__shortId__title.{m4a|mp3}`. The shortId (8-character artifact UUID prefix) is the dedup key — without rename, downloads land with NotebookLM's opaque server-generated filename and cannot be deduplicated.
```

### 3-5. Host permission: `https://notebooklm.google.com/*`
```
The content script reads audio overview metadata from this page's DOM: card titles (.artifact-title), artifact UUIDs (artifact-labels-{uuid} span IDs), the notebook cover title (.cover-title), and the cover date (.cover-subtitle-date title attribute). It also clicks the .artifact-more-button → "Download" menu item to trigger Chrome's download. No data is read from any other page.
```

### 3-6. Host permission: `https://*.googleusercontent.com/*`, `https://*.usercontent.google.com/*`, `https://accounts.google.com/*`, `https://lh3.google.com/*`
```
NotebookLM's audio overview URLs go through a multi-hop redirect chain that requires the extension's service worker to be CORS-cleared on each hop:
  lh3.googleusercontent.com  →  accounts.google.com/ServiceLogin  →  lh3.google.com/rd-notebooklm  →  drum.usercontent.google.com
The service worker re-fetches the audio with `credentials: "include"` so the user's existing Google session cookies authorize each redirect. Without these host_permissions, the cross-origin re-fetch fails and the GitHub upload cannot happen. The extension does not store or transmit any of these cookies — Chrome handles them automatically.
```

### 3-7. Host permission: `https://*.googleapis.com/*`
```
Reserved for NotebookLM's googleapis.com endpoints used during audio playback URL resolution. The extension does not call any Google API directly; this is a defensive host_permission to ensure the audio re-fetch chain isn't broken if NotebookLM redirects through googleapis.com on certain accounts.
```

### 3-8. Host permission: `https://api.github.com/*`
```
Uploads the audio file (PUT /repos/{owner}/{repo}/contents/docs/episodes/{filename}) and the RSS feed (PUT /repos/{owner}/{repo}/contents/docs/feed.xml) to the user's own GitHub repository via the Contents API. Also calls GET on the same paths to check existing-file SHAs and to list the episodes directory for dedup. The repository owner/name is provided by the user in the options page.
```

---

## 4. Data usage 선언 (체크리스트)

> "개인 정보 보호 관행" 탭의 "사용자 데이터" 섹션. 어떤 카테고리의 데이터를 다루는지 체크.

| 카테고리 | 처리? | 설명 |
|---|---|---|
| 개인 식별 정보 (Personally identifiable info) | ❌ | 이름·주소·이메일·전화 등 일체 처리 안 함. |
| 건강 정보 (Health info) | ❌ | 해당 없음. |
| 금융·결제 정보 (Financial info) | ❌ | 해당 없음. |
| **인증 정보 (Authentication info)** | ✅ | **GitHub Personal Access Token. `chrome.storage.local` 에만 저장, `api.github.com` Authorization 헤더로만 사용.** |
| 개인 통신 (Personal communications) | ❌ | 해당 없음. |
| 위치 (Location) | ❌ | 해당 없음. |
| 웹 기록 (Web history) | ❌ | 해당 없음. |
| 사용자 활동 (User activity) | ❌ | 다운로드 트리거는 사용자 명시 클릭만 — 분석·추적 없음. |
| **웹 사이트 콘텐츠 (Website content)** | ✅ | **NotebookLM 페이지의 음성개요 카드 제목·UUID·노트북 cover 날짜·오디오 파일. 사용자 본인 GitHub 저장소로만 push.** |

### "인증 사용 약관 / Certifications" 체크박스 (모두 체크해야 함)
- ☑ 데이터를 익스텐션의 단일 목적 외 용도로 사용/전송하지 않음.
- ☑ 신용도 평가나 대부 목적으로 데이터를 사용/전송하지 않음.
- ☑ 데이터를 제3자에게 판매하지 않음.

---

## 5. 개인정보 처리방침 URL (Privacy policy URL)

저장소의 `docs/privacy.html` 을 사용:

```
https://kiuk104.github.io/notebooklm-podcast-extension/privacy.html
```

> 전제: 본 저장소의 GitHub Pages 가 활성화되어 있어야 함 ([Settings → Pages → Source: main / /docs](https://github.com/kiuk104/notebooklm-podcast-extension/settings/pages)). Pages 활성화 후 1~2분 뒤 위 URL 이 200 응답하는지 브라우저에서 확인 후 폼에 붙여넣기.

대안 (Pages 셋업이 부담스러우면): 
```
https://github.com/kiuk104/notebooklm-podcast-extension/blob/main/docs/privacy.html
```
GitHub 의 raw HTML viewer 도 Web Store 가 받음 — 단 렌더링이 GitHub UI 안에서 됨.

---

## 6. 시각 자료 (사용자 측 작업)

### 6-1. 스토어 아이콘 — 128×128 PNG
이미 있음: `icons/store-icon-128.png` (manifest 의 icon128 과 같은 아트워크). 그대로 업로드.

### 6-2. 스크린샷 — 1280×800 또는 640×400, 최소 1장, 권장 3~5장

찍어야 할 화면:
1. NotebookLM 노트북 페이지 + popup 열어 [현재 노트북 스캔] 결과 (음성개요 목록 + [받기] 버튼이 보이도록).
2. 다운로드 진행 중 ~ 완료 상태 (`✓ push 완료 + feed`).
3. 옵션 페이지 (token / repo / RSS 모드 / [설정 검증] 버튼).
4. 도움말 페이지 (한 화면이라도 — Korean UI 임을 명확히).
5. (선택) 팟캐스트 앱에 RSS 등록되어 에피소드 목록 보이는 화면.

각 스크린샷은 1280×800 이 권장. Chrome 의 1배 해상도에서 popup·옵션 창 + NotebookLM 페이지 한 부분이 같이 잡히도록 캡처.

### 6-3. (선택) Promo tile — 440×280, 마케팅 카드용
지금은 생략 가능. 나중에 디자인 시간이 나면 추가.

### 6-4. (선택) Marquee — 1400×560, Web Store 배너 위치
Featured 등록되지 않는 한 거의 안 쓰임. 생략.

---

## 7. 배포 지역 / 가격

- 가격: **무료**.
- 배포 지역: **모든 국가** (한국어 사용자가 1차 타겟이지만 차단할 이유 없음).
- 연령: **모든 연령** — NotebookLM 자체가 13세 이상 대상.

---

## 8. 제출 직전 체크리스트

- [ ] `manifest.json` 의 `version` 이 직전 업로드보다 큰가?
- [ ] `dist/notebooklm-podcast-sync-v{version}.zip` 가 새로 빌드되었나? (`python scripts/package.py`)
- [ ] 압축해제 모드로 새 zip 을 한 번 로드해서 다운로드 + push 흐름이 정상인가?
- [ ] §5 의 privacy URL 이 브라우저에서 200 응답하나? (GitHub Pages 반영 확인)
- [ ] 스크린샷 3장 이상 준비됐나?
- [ ] 스토어 아이콘 128×128 (`icons/store-icon-128.png`) 업로드 준비됐나?
- [ ] 권한 justification (§3) 의 7개 박스가 모두 채워졌나?
- [ ] Single purpose 선언 (§2) 이 한 줄로 정리됐나?
- [ ] Data usage 카테고리 (§4) 의 두 개 (Authentication info, Website content) 가 체크됐나?
- [ ] "데이터를 단일 목적 외에 사용/판매/평가에 안 씀" 3개 인증 체크박스 모두 ☑ 됐나?

심사 거절은 보통 권한 justification (§3) 부족 또는 single purpose (§2) 와 매뉴얼 동작 불일치에서 발생. §3 의 각 박스가 *왜 그 권한이 단일 목적 달성에 꼭 필요한지* 한 흐름으로 읽히도록 다시 한번 확인.
