// Service worker. popup/content/options 사이의 라우팅, 다운로드 관리,
// 추후 GitHub API 호출이 여기서 일어난다.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});
