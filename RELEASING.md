# 릴리스 / 버전 업데이트 가이드

Chrome Web Store 에 새 버전을 올릴 때마다의 절차. 첫 등록은 v0.4.0 (2026-04-30).

## 버전 정책

`manifest.json` 의 `version` 은 [Chrome Web Store 의 형식 규칙](https://developer.chrome.com/docs/extensions/reference/manifest/version) 만 지키면 됨 — 점으로 구분된 1~4 자리 숫자, 매 업로드마다 직전보다 큰 값. 그 이상의 의미 (SemVer) 는 자체 관습.

이 프로젝트는 다음 관습을 씀:
- **patch** (0.4.**0** → 0.4.**1**) — 버그 수정, 셀렉터 보정, 문서 수정.
- **minor** (0.**4**.0 → 0.**5**.0) — 새 기능 (새 옵션, 새 RSS 모드, 새 트리거 등).
- **major** (**0**.4.0 → **1**.0.0) — 첫 안정 릴리스, 또는 사용자 측 마이그레이션이 필요한 변경 (옵션 키 이름 변경, repo 구조 변경 등).

0.x 대는 "기능 완성됐지만 사용자 베이스 작아 미검증" 상태로 유지 — 영문 사용자 / 다양한 NotebookLM 계정에서 한 번 돌아본 뒤 1.0 으로 올림.

## 릴리스 절차

### 1. 코드 변경 + 커밋

평소처럼 작업 + 커밋. main 으로 머지된 상태가 되도록.

### 2. 버전 bump

[manifest.json](manifest.json) 의 `"version"` 한 줄만 수정:

```diff
-  "version": "0.4.0",
+  "version": "0.4.1",
```

### 3. (선택) 아이콘 재생성

아이콘 디자인을 바꾼 경우만 — `scripts/make_icons.py` 의 `BG` 등 상수 수정 후:

```bash
python scripts/make_icons.py
```

`icons/icon{16,48,128}.png` + `icons/store-icon-128.png` 가 다시 만들어짐. 변경된 PNG 도 commit.

### 4. 패키징

```bash
python scripts/package.py
```

→ `dist/notebooklm-podcast-sync-v{version}.zip` (보통 35~50 KB). zip 안에는 manifest, src/, icons/icon{16,48,128}.png, LICENSE 만 들어감 ([scripts/package.py](scripts/package.py) 의 `INCLUDE_*` 참고).

`dist/` 는 `.gitignore` 의 `*.zip` 패턴으로 자동 제외.

### 5. 로컬 sanity check

업로드 전에 zip 을 한 번 풀어서 압축해제 모드로 로드:

1. zip 을 임시 폴더에 풀기.
2. `chrome://extensions/` → 개발자 모드 ON → [압축해제된 확장 프로그램을 로드] → 그 폴더 선택.
3. **golden path** 한 바퀴 — NotebookLM 노트북 페이지 → [현재 노트북 스캔] → [받기] → 다운로드 + GitHub push 성공 + RSS 갱신까지.
4. SW console (`chrome://extensions/` 카드의 service worker 링크) 에서 `[push] ... pushed` / `[feed] rebuilt with N episodes` 로그 확인.

심사 통과해도 사용자 환경에서 깨지면 1~2 주 다음 릴리스까지 못 고치므로 이 단계 생략 X.

### 6. Chrome Web Store 업로드

1. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) 열기.
2. 첫 등록이면 [새 항목] → 두 번째부터는 기존 항목 → [패키지] 탭 → [새 버전 업로드].
3. zip 업로드 → 메타 폼 (제목/설명/스크린샷/권한 justification) 채우기 (B 묶음, 별도 작업).
4. [심사 제출].

심사 시간은 보통 며칠~2주. 거절되면 사유와 함께 알림 옴 — 수정 후 같은 버전 번호 그대로 재제출 가능.

### 7. 릴리스 후

- `git tag v{version}` + push 해서 코드 스냅샷 마킹.
- README.md 의 "상태" 섹션과 메모리 ([extension_context.md](https://github.com/kiuk104/notebooklm-podcast-extension)) 의 현재 버전 표기 업데이트.

## 업데이트 시 주의사항

### `host_permissions` 변경 시 사용자 재허락 필요

`manifest.json` 의 `host_permissions` 에 새 호스트가 추가되면 Chrome 이 익스텐션을 자동 disable 시키고 사용자에게 "권한 추가 승인" 을 다시 받음. 사용자는 이를 의심스러운 행위로 보기 쉬우므로:
- 호스트 추가는 가급적 묶어서 한 번에 처리.
- changelog / Web Store 의 "이 버전의 새로운 기능" 칸에 *왜* 새 호스트가 필요한지 한 줄 적기.

현재 `host_permissions` 7 개 (notebooklm + 6 개의 Google audio CDN/auth 호스트 + api.github.com) 는 audio fetch 의 redirect 체인 + GitHub Contents API 때문에 필요. 자세한 이유는 [IMPLEMENTATION_NOTES.md §2](IMPLEMENTATION_NOTES.md). 추가 호스트가 필요해지면 그 문서에 redirect 체인 / 새 의존성을 먼저 기록한 뒤 manifest 수정.

### 만일 v1 같은 큰 변경이 들어가면

- `version` 을 major bump (예: 1.0.0 → 2.0.0) 하더라도 Chrome 은 그냥 "0.x 보다 큰 숫자" 로만 봄.
- `chrome.storage.local` 의 옵션 키 (token / repo / rssMode 등) 이름이 바뀌면 옛 키에서 새 키로 마이그레이션하는 코드를 한 번만 background.js 의 `chrome.runtime.onInstalled` 핸들러에 넣기. 마이그레이션은 다음 메이저 릴리스에서 제거.

### 패키지에서 빠뜨리지 말 것

`scripts/package.py` 의 `INCLUDE_*` 가 화이트리스트라 새 파일이 들어가도 자동으로 안 잡힘. `src/` 안의 새 .js / .html / .css 는 `INCLUDE_DIRS = ["src"]` 에 의해 자동 포함되지만, 새 폴더 (예: `vendor/`, `wasm/`) 가 추가되면 그 폴더를 `INCLUDE_DIRS` 에 추가해야 함. 빠뜨리면 익스텐션이 로드 시점에 404 로 실패하므로 §5 의 sanity check 가 잡아줌.

### Web Store 측 메타 (제목/설명/스크린샷) 만 바꾸려면

zip 재업로드 없이 Developer Dashboard 의 [스토어 등록정보] 탭에서 바로 수정 가능. 메타 변경도 별도 심사가 들어가지만 보통 빠름 (몇 시간~하루).
