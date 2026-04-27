const fields = {
  token: document.getElementById("token"),
  repo: document.getElementById("repo"),
  committerName: document.getElementById("committer-name"),
  committerEmail: document.getElementById("committer-email"),
};
const statusEl = document.getElementById("status");

const KEYS = ["token", "repo", "committerName", "committerEmail"];

(async () => {
  const stored = await chrome.storage.local.get(KEYS);
  for (const k of KEYS) {
    if (stored[k]) fields[k].value = stored[k];
  }
})();

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const repo = fields.repo.value.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    show("repo 형식이 잘못됐습니다 (owner/name)", "error");
    return;
  }
  await chrome.storage.local.set({
    token: fields.token.value.trim(),
    repo,
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
