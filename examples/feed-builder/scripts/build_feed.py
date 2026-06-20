#!/usr/bin/env python3
# docs/episodes/*.{m4a,mp3,mp4} 를 스캔해서 docs/feed.xml 을 만든다.
# 익스텐션이 PUT 한 파일명 규약: YYYYMMDD__노트북-슬러그__제목-슬러그.{ext}
# 외부 의존성 없음 — 표준 라이브러리만 사용 (GitHub Actions setup-python 으로 충분).

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
EPISODES_DIR = ROOT / "docs" / "episodes"
CONFIG_FILE = ROOT / "docs" / "podcast.json"
OUTPUT_FILE = ROOT / "docs" / "feed.xml"

# 익스텐션의 buildFilename 규약 ([src/background.js] buildFilename) 과 정확히 일치해야 함.
# 두 포맷 수용:
#   옛 포맷: YYYYMMDD__노트북__제목.ext              (3 segment)
#   새 포맷: YYYYMMDD__노트북__shortId__제목.ext      (4 segment, shortId = 8자 16진수)
FILENAME_RE = re.compile(r"^(\d{8})__(.+?)__(?:([0-9a-f]{8})__)?(.+?)\.(m4a|mp3|mp4)$")
MIME = {"m4a": "audio/mp4", "mp4": "audio/mp4", "mp3": "audio/mpeg"}


def load_config() -> dict:
    if not CONFIG_FILE.exists():
        sys.exit(f"missing config: {CONFIG_FILE.relative_to(ROOT)}")
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    base = cfg.get("baseUrl") or os.environ.get("BASE_URL", "")
    if not base:
        sys.exit("baseUrl not set (docs/podcast.json: baseUrl, or BASE_URL env)")
    if not base.endswith("/"):
        base += "/"
    cfg["baseUrl"] = base
    return cfg


def parse_date(yyyymmdd: str) -> datetime:
    # 자정 UTC. NotebookLM cover 의 정확한 시각은 잃지만 RSS 는 날짜 단위 정렬로 충분.
    return datetime.strptime(yyyymmdd, "%Y%m%d").replace(tzinfo=timezone.utc)


def collect_episodes() -> list[dict]:
    if not EPISODES_DIR.exists():
        return []
    items: list[dict] = []
    for path in EPISODES_DIR.iterdir():
        if not path.is_file():
            continue
        m = FILENAME_RE.match(path.name)
        if not m:
            print(f"skip (unrecognized filename): {path.name}", file=sys.stderr)
            continue
        date_s, notebook_slug, _short_id, title_slug, ext = m.groups()
        items.append({
            "filename": path.name,
            "size": path.stat().st_size,
            "mime": MIME[ext.lower()],
            "pubDate": parse_date(date_s),
            "notebook": notebook_slug.replace("-", " "),
            "title": title_slug.replace("-", " "),
        })
    items.sort(key=lambda x: (x["pubDate"], x["filename"]), reverse=True)
    return items


# 같은 날짜(YYYYMMDD) 에피소드는 parse_date 가 모두 자정으로 만들어 pubDate 가 동일해진다
# → 팟캐스트 앱은 피드 item 순서를 무시하고 pubDate 로 정렬하므로, 같은 날 묶음의 순서가
# 불안정해 재빌드 때마다 목록이 뒤섞여 보인다. items 는 이미 표시 순서(최신순)로 정렬돼
# 있으므로, 같은 날 그룹 안에서 그 순서를 보존하도록 초 단위 합성 시각을 부여한다 — 그 날
# 첫(최신) 항목이 가장 늦은 시각. 자정 기준 N초 이내라 날짜 표시는 그대로 유지된다.
# feed.js 의 stampPubDates 와 동일 로직 (byte 일치).
def stamp_pubdates(items: list[dict]) -> list[dict]:
    counts: dict = {}
    for it in items:
        k = it["pubDate"].date()
        counts[k] = counts.get(k, 0) + 1
    seen: dict = {}
    out: list[dict] = []
    for it in items:
        k = it["pubDate"].date()
        idx = seen.get(k, 0)
        seen[k] = idx + 1
        offset = counts[k] - 1 - idx  # 그 날 첫 항목이 최대
        out.append({**it, "pubDate": it["pubDate"] + timedelta(seconds=offset)})
    return out


def render(cfg: dict, items: list[dict]) -> str:
    items = stamp_pubdates(items)
    lines: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0" '
        'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" '
        'xmlns:atom="http://www.w3.org/2005/Atom">',
        '  <channel>',
        f'    <title>{escape(cfg["title"])}</title>',
        f'    <link>{escape(cfg["baseUrl"])}</link>',
        f'    <atom:link href="{escape(cfg["baseUrl"])}feed.xml" rel="self" type="application/rss+xml"/>',
        f'    <description>{escape(cfg.get("description", ""))}</description>',
        f'    <language>{escape(cfg.get("language", "ko"))}</language>',
    ]
    if cfg.get("ownerName"):
        lines.append(f'    <itunes:author>{escape(cfg["ownerName"])}</itunes:author>')
        lines.append('    <itunes:owner>')
        lines.append(f'      <itunes:name>{escape(cfg["ownerName"])}</itunes:name>')
        if cfg.get("ownerEmail"):
            lines.append(f'      <itunes:email>{escape(cfg["ownerEmail"])}</itunes:email>')
        lines.append('    </itunes:owner>')
    if cfg.get("image"):
        img = escape(cfg["image"])
        lines.append(f'    <itunes:image href="{img}"/>')
    if cfg.get("category"):
        lines.append(f'    <itunes:category text="{escape(cfg["category"])}"/>')
    lines.append(f'    <itunes:explicit>{"yes" if cfg.get("explicit") else "no"}</itunes:explicit>')

    for it in items:
        url = cfg["baseUrl"] + "episodes/" + quote(it["filename"])
        ep_title = f'{it["notebook"]} — {it["title"]}'
        lines += [
            '    <item>',
            f'      <title>{escape(ep_title)}</title>',
            f'      <description>{escape(ep_title)}</description>',
            f'      <pubDate>{format_datetime(it["pubDate"], usegmt=True)}</pubDate>',
            f'      <enclosure url="{escape(url)}" length="{it["size"]}" type="{it["mime"]}"/>',
            f'      <guid isPermaLink="false">{escape(it["filename"])}</guid>',
            '    </item>',
        ]

    lines += ['  </channel>', '</rss>', '']
    return "\n".join(lines)


def apply_retention(items: list[dict], retention: dict | None) -> tuple[list[dict], list[dict]]:
    if not retention or not isinstance(retention, dict):
        return items, []
    keep = sorted(items, key=lambda x: x["pubDate"], reverse=True)
    n = retention.get("maxItems")
    if isinstance(n, int) and n > 0:
        keep = keep[:n]
    d = retention.get("maxAgeDays")
    if isinstance(d, int) and d > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=d)
        keep = [it for it in keep if it["pubDate"] >= cutoff]
    # 용량 기반: 최신 순으로 누적해서 cap 넘으면 그 뒤(=더 오래된 것) 자름.
    # GitHub Pages 의 1 GB artifact 권장 한도 회피 목적. 가장 최신 1편은 무조건
    # 살려둠 — cap 보다 큰 단일 파일이 들어와도 feed 가 텅 비지 않도록 안전망.
    mb = retention.get("maxTotalMB")
    if isinstance(mb, (int, float)) and mb > 0:
        cap = int(mb * 1024 * 1024)
        fitted: list[dict] = []
        total = 0
        for it in keep:  # 이미 최신순
            if fitted and total + it["size"] > cap:
                break
            fitted.append(it)
            total += it["size"]
        keep = fitted
    keep_set = {it["filename"] for it in keep}
    drop = [it for it in items if it["filename"] not in keep_set]
    return keep, drop


def main() -> None:
    cfg = load_config()
    items = collect_episodes()
    keep, drop = apply_retention(items, cfg.get("retention"))
    for it in drop:
        path = EPISODES_DIR / it["filename"]
        try:
            path.unlink()
            print(f"removed (retention): {it['filename']}")
        except OSError as e:
            print(f"remove failed: {it['filename']}: {e}", file=sys.stderr)
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(render(cfg, keep), encoding="utf-8")
    print(f"wrote {OUTPUT_FILE.relative_to(ROOT)} ({len(keep)} episodes; {len(drop)} removed)")


if __name__ == "__main__":
    main()
