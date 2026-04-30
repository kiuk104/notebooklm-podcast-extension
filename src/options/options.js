const fields = {
  token: document.getElementById("token"),
  repo: document.getElementById("repo"),
  rssMode: document.getElementById("rss-mode"),
  committerName: document.getElementById("committer-name"),
  committerEmail: document.getElementById("committer-email"),
};
const statusEl = document.getElementById("status");
const feedUrlEl = document.getElementById("feed-url");
const openFeedEl = document.getElementById("open-feed");
const copyFeedBtn = document.getElementById("copy-feed");

const KEYS = ["token", "repo", "rssMode", "committerName", "committerEmail"];
const RSS_MODE_DEFAULT = "actions";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

(async () => {
  const stored = await chrome.storage.local.get(KEYS);
  for (const k of KEYS) {
    if (stored[k]) fields[k].value = stored[k];
  }
  if (!stored.rssMode) fields.rssMode.value = RSS_MODE_DEFAULT;
  refreshFeedUrl();
})();

function refreshFeedUrl() {
  const repo = fields.repo.value.trim();
  if (!REPO_RE.test(repo)) {
    feedUrlEl.value = "";
    openFeedEl.href = "#";
    openFeedEl.style.pointerEvents = "none";
    openFeedEl.style.opacity = "0.4";
    copyFeedBtn.disabled = true;
    copyFeedBtn.style.opacity = "0.4";
    copyFeedBtn.style.cursor = "not-allowed";
    return;
  }
  const [owner, name] = repo.split("/");
  const url = `https://${owner}.github.io/${name}/feed.xml`;
  feedUrlEl.value = url;
  openFeedEl.href = url;
  openFeedEl.style.pointerEvents = "";
  openFeedEl.style.opacity = "1";
  copyFeedBtn.disabled = false;
  copyFeedBtn.style.opacity = "";
  copyFeedBtn.style.cursor = "pointer";
}

fields.repo.addEventListener("input", refreshFeedUrl);

copyFeedBtn.addEventListener("click", async () => {
  if (!feedUrlEl.value) return;
  try {
    await navigator.clipboard.writeText(feedUrlEl.value);
  } catch {
    feedUrlEl.focus();
    feedUrlEl.select();
    document.execCommand("copy");
  }
  const original = copyFeedBtn.textContent;
  copyFeedBtn.textContent = "✓ 복사됨";
  setTimeout(() => { copyFeedBtn.textContent = original; }, 1400);
});

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const repo = fields.repo.value.trim();
  if (!REPO_RE.test(repo)) {
    show("repo 형식이 잘못됐습니다 (owner/name)", "error");
    return;
  }
  await chrome.storage.local.set({
    token: fields.token.value.trim(),
    repo,
    rssMode: fields.rssMode.value || RSS_MODE_DEFAULT,
    committerName: fields.committerName.value.trim(),
    committerEmail: fields.committerEmail.value.trim(),
  });
  show("저장됨.", "success");
});

function show(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status " + kind;
  statusEl.style.display = "block";
}

document.getElementById("toggle-token").addEventListener("click", () => {
  const t = fields.token;
  const btn = document.getElementById("toggle-token");
  if (t.type === "password") {
    t.type = "text";
    btn.textContent = "🙈";
  } else {
    t.type = "password";
    btn.textContent = "👁";
  }
});

document.getElementById("verify").addEventListener("click", async () => {
  const token = fields.token.value.trim();
  const repo = fields.repo.value.trim();
  if (!token) return show("token 이 비어 있습니다.", "error");
  if (!REPO_RE.test(repo)) return show("repo 형식이 잘못됐습니다 (owner/name).", "error");
  show("검증 중…", "");
  try {
    const userR = await fetch("https://api.github.com/user", { headers: ghHeaders(token) });
    if (userR.status === 401) return show("✗ 토큰이 무효합니다 (401). 새로 발급해서 다시 입력하세요.", "error");
    if (!userR.ok) return show(`✗ /user ${userR.status}: ${(await userR.text()).slice(0, 120)}`, "error");
    const user = await userR.json();

    const repoR = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token) });
    if (repoR.status === 404) return show(`✓ 토큰 OK (${user.login}) / ✗ repo "${repo}" 안 보임 — private 권한 누락 또는 오타.`, "error");
    if (!repoR.ok) return show(`✗ /repos/${repo} ${repoR.status}: ${(await repoR.text()).slice(0, 120)}`, "error");
    const repoData = await repoR.json();
    const canPush = repoData.permissions?.push;
    if (canPush === false) return show(`✓ 토큰 OK (${user.login}) / ✗ repo 읽기만 가능, push 권한 없음. fine-grained 토큰의 Contents 권한 확인.`, "error");
    show(`✓ ${user.login} → ${repo} push 가능. 설정 정상.`, "success");
  } catch (e) {
    show(`✗ 네트워크 오류: ${e.message}`, "error");
  }
});

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
