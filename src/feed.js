// 익스텐션 직접 생성 모드 (rssMode = "extension"). audio push 직후 호출되어
// docs/episodes/ 를 list → docs/feed.xml 을 빌드 → PUT.
//
// 출력 포맷은 examples/feed-builder/scripts/build_feed.py 와 정확히 일치 — 두 모드를
// 왔다갔다 해도 RSS 가 그대로 유지되도록.

// 두 포맷 모두 수용:
//   옛 포맷: ${date}__${notebook}__${title}.ext           (3 segment)
//   새 포맷: ${date}__${notebook}__${shortId}__${title}.ext (4 segment, shortId = 8자 16진수)
// shortId 그룹은 옵셔널이라 기존 episode 들도 그대로 파싱된다 (IMPLEMENTATION_NOTES.md §1).
// i 플래그 — ext (m4a/mp3/mp4) 대소문자 무관 매칭. background.js 도 이 값을 import해 사용.
export const FILENAME_RE = /^(\d{8})__(.+?)__(?:([0-9a-f]{8})__)?(.+?)\.(m4a|mp3|mp4)$/i;
const MIME = { m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg" };

const DEFAULT_META = {
  title: "NotebookLM Podcast",
  description: "NotebookLM 음성개요 자동 수집 피드.",
  language: "ko",
  ownerName: "",
  ownerEmail: "",
  image: "",
  category: "",
  explicit: false,
};

export async function rebuildFeed({ repo, token, committer }) {
  const baseUrl = inferBaseUrl(repo);

  const meta = await loadMeta(repo, token);
  const all = await listEpisodes(repo, token);
  const { keep, drop } = applyRetention(all, meta.retention);

  // retention 으로 잘린 episode 들을 먼저 DELETE. 실패해도 feed 빌드는 진행 —
  // 다음 트리거 때 idempotent 하게 재시도되므로 best-effort.
  let dropped = 0;
  for (const ep of drop) {
    try {
      await ghDelete(repo, `docs/episodes/${ep.filename}`, ep.sha,
        `Drop episode (retention): ${ep.filename}`, token, committer);
      dropped++;
      console.log(`[feed] retention drop: ${ep.filename}`);
    } catch (e) {
      console.warn(`[feed] retention drop 실패: ${ep.filename}`, e.message);
    }
  }

  const xml = renderFeed({ ...meta, baseUrl }, applyEpisodeOrder(keep, meta.episodeOrder));

  const path = "docs/feed.xml";
  const existing = await ghGet(repo, path, token);
  const newB64 = utf8ToBase64(xml);
  if (existing && existing.content && stripBase64Whitespace(existing.content) === newB64) {
    return { skipped: true, reason: "feed unchanged", episodes: keep.length, dropped };
  }
  await ghPut(repo, path, newB64,
    `auto: rebuild feed (${keep.length} episodes)`, existing?.sha, token, committer);
  return { ok: true, episodes: keep.length, dropped, missingMeta: !meta._fromRepo };
}

// podcast.json 의 episodeOrder 배열(filename 목록)이 있으면 그 순서로 정렬.
// 배열에 없는 항목(새로 추가된 에피소드 등)은 날짜 내림차순으로 뒤에 붙임.
// 배열이 없거나 비어있으면 기존 날짜 내림차순 그대로 반환.
function applyEpisodeOrder(items, episodeOrder) {
  if (!Array.isArray(episodeOrder) || episodeOrder.length === 0) return items;
  const orderMap = new Map(episodeOrder.map((fn, i) => [fn, i]));
  return items.slice().sort((a, b) => {
    const ia = orderMap.has(a.filename) ? orderMap.get(a.filename) : Infinity;
    const ib = orderMap.has(b.filename) ? orderMap.get(b.filename) : Infinity;
    if (ia !== ib) return ia - ib;
    // 둘 다 order에 없으면 날짜 내림차순 유지
    return b.pubDate.getTime() - a.pubDate.getTime();
  });
}

function applyRetention(items, retention) {
  if (!retention || (typeof retention !== "object")) {
    return { keep: items, drop: [] };
  }
  let keep = items.slice().sort((a, b) => b.pubDate - a.pubDate);
  if (Number.isInteger(retention.maxItems) && retention.maxItems > 0) {
    keep = keep.slice(0, retention.maxItems);
  }
  if (Number.isInteger(retention.maxAgeDays) && retention.maxAgeDays > 0) {
    const cutoff = Date.now() - retention.maxAgeDays * 86400 * 1000;
    keep = keep.filter((it) => it.pubDate.getTime() >= cutoff);
  }
  // 용량 기반: 최신 순으로 누적해서 cap 넘으면 자름. GitHub Pages 1 GB artifact
  // 한도 회피 목적. 최신 1편은 항상 보존 — cap 보다 큰 단일 파일이라도 feed 가
  // 텅 비지 않게 (build_feed.py 의 apply_retention 과 byte-level 일치).
  if (typeof retention.maxTotalMB === "number" && retention.maxTotalMB > 0) {
    const cap = Math.floor(retention.maxTotalMB * 1024 * 1024);
    const fitted = [];
    let total = 0;
    for (const it of keep) { // 이미 최신순
      if (fitted.length > 0 && total + it.size > cap) break;
      fitted.push(it);
      total += it.size;
    }
    keep = fitted;
  }
  const keepSet = new Set(keep.map((it) => it.filename));
  const drop = items.filter((it) => !keepSet.has(it.filename));
  return { keep, drop };
}

function inferBaseUrl(repo) {
  // owner/name → https://owner.github.io/name/
  const [owner, name] = repo.split("/");
  return `https://${owner}.github.io/${name}/`;
}

async function loadMeta(repo, token) {
  const r = await ghGet(repo, "docs/podcast.json", token);
  if (!r) return { ...DEFAULT_META, _fromRepo: false };
  try {
    const text = base64ToUtf8(stripBase64Whitespace(r.content));
    const parsed = JSON.parse(text);
    return { ...DEFAULT_META, ...parsed, _fromRepo: true };
  } catch (e) {
    console.warn("[feed] podcast.json parse 실패, default 사용:", e);
    return { ...DEFAULT_META, _fromRepo: false };
  }
}

async function listEpisodes(repo, token) {
  const r = await fetch(ghContentsUrl(repo, "docs/episodes"), {
    headers: ghHeaders(token),
    cache: "no-store",
  });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`feed list: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const arr = await r.json();
  if (!Array.isArray(arr)) return [];

  const items = [];
  for (const f of arr) {
    if (f.type !== "file") continue;
    const m = FILENAME_RE.exec(f.name);
    if (!m) continue;
    const [, dateS, notebook, _shortId, title, ext] = m;
    items.push({
      filename: f.name,
      sha: f.sha,
      size: f.size,
      mime: MIME[ext.toLowerCase()],
      pubDate: parseDate(dateS),
      notebook: notebook.replace(/-/g, " "),
      title: title.replace(/-/g, " "),
    });
  }
  // 최신순
  items.sort((a, b) => {
    const t = b.pubDate.getTime() - a.pubDate.getTime();
    return t !== 0 ? t : b.filename.localeCompare(a.filename);
  });
  return items;
}

function parseDate(yyyymmdd) {
  const y = +yyyymmdd.slice(0, 4), mo = +yyyymmdd.slice(4, 6), d = +yyyymmdd.slice(6, 8);
  return new Date(Date.UTC(y, mo - 1, d));
}

function renderFeed(meta, items) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" '
      + 'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" '
      + 'xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${esc(meta.title)}</title>`,
    `    <link>${esc(meta.baseUrl)}</link>`,
    `    <atom:link href="${esc(meta.baseUrl)}feed.xml" rel="self" type="application/rss+xml"/>`,
    `    <description>${esc(meta.description || "")}</description>`,
    `    <language>${esc(meta.language || "ko")}</language>`,
  ];
  if (meta.ownerName) {
    lines.push(`    <itunes:author>${esc(meta.ownerName)}</itunes:author>`);
    lines.push('    <itunes:owner>');
    lines.push(`      <itunes:name>${esc(meta.ownerName)}</itunes:name>`);
    if (meta.ownerEmail) lines.push(`      <itunes:email>${esc(meta.ownerEmail)}</itunes:email>`);
    lines.push('    </itunes:owner>');
  }
  if (meta.image) lines.push(`    <itunes:image href="${esc(meta.image)}"/>`);
  if (meta.category) lines.push(`    <itunes:category text="${esc(meta.category)}"/>`);
  lines.push(`    <itunes:explicit>${meta.explicit ? "yes" : "no"}</itunes:explicit>`);

  for (const it of items) {
    const url = meta.baseUrl + "episodes/" + encodeURIComponent(it.filename);
    const epTitle = `${it.notebook} — ${it.title}`;
    lines.push('    <item>');
    lines.push(`      <title>${esc(epTitle)}</title>`);
    lines.push(`      <description>${esc(epTitle)}</description>`);
    lines.push(`      <pubDate>${rfc822(it.pubDate)}</pubDate>`);
    lines.push(`      <enclosure url="${esc(url)}" length="${it.size}" type="${it.mime}"/>`);
    lines.push(`      <guid isPermaLink="false">${esc(it.filename)}</guid>`);
    lines.push('    </item>');
  }

  lines.push('  </channel>', '</rss>', '');
  return lines.join("\n");
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function rfc822(d) {
  const dn = DAYS[d.getUTCDay()];
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mn = MONTHS[d.getUTCMonth()];
  const yy = d.getUTCFullYear();
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${dn}, ${dd} ${mn} ${yy} ${h}:${mi}:${s} GMT`;
}

function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function stripBase64Whitespace(s) {
  return (s || "").replace(/\s+/g, "");
}

function ghContentsUrl(repo, path) {
  const segs = path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${repo}/contents/${segs}`;
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghGet(repo, path, token) {
  // GitHub GET 은 60초 HTTP 캐시되므로 dedup/feed 정확성을 위해 no-store.
  const r = await fetch(ghContentsUrl(repo, path), {
    headers: ghHeaders(token),
    cache: "no-store",
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`feed ghGet ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function ghPut(repo, path, contentB64, message, sha, token, committer) {
  const body = { message, content: contentB64 };
  if (sha) body.sha = sha;
  if (committer) body.committer = committer;
  const r = await fetch(ghContentsUrl(repo, path), {
    method: "PUT",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`feed ghPut ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function ghDelete(repo, path, sha, message, token, committer) {
  const body = { message, sha };
  if (committer) body.committer = committer;
  const r = await fetch(ghContentsUrl(repo, path), {
    method: "DELETE",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`feed ghDelete ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
