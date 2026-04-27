const scanBtn = document.getElementById("scan");
const statusEl = document.getElementById("status");

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  setStatus("스캔 중…");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith("https://notebooklm.google.com/notebook/")) {
      setStatus("현재 탭이 NotebookLM 노트북 페이지가 아닙니다.", "error");
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "scan" });
    if (!resp?.ok) {
      setStatus("응답 없음 — 페이지를 새로고침하세요", "error");
      return;
    }
    const lines = [
      `노트북: ${resp.cover.title || "(제목 없음)"}`,
      `생성일: ${resp.cover.dateAttr || "(?)"}`,
      `음성개요: ${resp.audios.length}개`,
      ...resp.audios.map((a, i) => `  ${i + 1}. ${a.title || "(제목 없음)"}`),
    ];
    setStatus(lines.join("\n"), "success");
  } catch (e) {
    setStatus(`오류: ${e.message}`, "error");
  } finally {
    scanBtn.disabled = false;
  }
});

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
