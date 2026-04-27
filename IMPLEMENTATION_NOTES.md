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

### dedup 키 설계 일반 원칙

플레이스홀더 함정을 떠나서, 카드 제목은 시간이 지나면 바뀔 수 있는 mutable 한 값이다. 가능하면 dedup 키에는:

1. 노트북 ID (URL) — 안정적
2. cover 생성일 — 안정적
3. 카드 인덱스 또는 audio overview 가 NotebookLM 내부에서 갖는 고유 ID — 가장 안정적, 다만 DOM 에서 노출되는지 확인 필요

같은 식별자를 우선 쓰고, 사람이 읽을 제목은 파일명 표시용 보조 필드로 두는 게 안전하다. v1 은 사람이 읽을 파일명을 직접 dedup 키로 써서 위 함정에 걸렸다.
