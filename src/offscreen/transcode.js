// offscreen document — m4a/mp4 → mp3 64k mono 재인코딩.
// SW 가 audio URL 만 보내고 여기서 직접 fetch + 디코드 + 인코드. SW↔offscreen
// 사이 메시지는 URL ~200 byte (요청) + ~5MB mp3 b64 (응답) 로 작게 유지 →
// 큰 m4a 30-50MB 를 base64 string 으로 양방향 보내던 이전 방식이 chrome.runtime
// 메시지 채널을 자주 끊어버린 문제 해소. credentials:include 는 익스텐션 컨텍스트
// 의 .google.com 세션 쿠키를 redirect 체인에 동행시키는 용도 (SW fetch 와 동일).

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // SW 의 ensureOffscreenDocument 가 createDocument 직후 ping 을 보내 listener 가
  // alive 한지 확인하는 용도 — 첫 카드 race ("channel closed") 방지.
  if (msg?.type === "offscreen:ping") {
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type !== "offscreen:transcode-url") return false;
  (async () => {
    const t0 = Date.now();
    try {
      const r = await fetch(msg.audioUrl, { credentials: "include" });
      if (!r.ok) throw new Error(`fetch ${r.status} ${r.statusText}`);
      const arrBuf = await r.arrayBuffer();
      const mp3 = await transcodeM4aToMp3(
        arrBuf,
        msg.bitrate || 64,
        msg.mono !== false,
      );
      const mp3B64 = arrayBufferToBase64(mp3);
      sendResponse({
        ok: true, mp3B64,
        sourceSize: arrBuf.byteLength,
        mp3Size: mp3.byteLength,
        elapsedMs: Date.now() - t0,
      });
    } catch (e) {
      sendResponse({ ok: false, error: e.message, elapsedMs: Date.now() - t0 });
    }
  })();
  return true; // async sendResponse
});

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function transcodeM4aToMp3(arrayBuffer, bitrateKbps, mono) {
  // 1. decode m4a/AAC → AudioBuffer (PCM Float32). Web Audio API 는 m4a 컨테이너
  // 의 AAC 코덱을 모든 modern Chrome 에서 디코드. 브라우저 native ffmpeg 사용.
  const ctx = new AudioContext();
  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    try { await ctx.close(); } catch {}
  }
  const sampleRate = audioBuffer.sampleRate;
  const lengthFrames = audioBuffer.length;

  // 2. mono 다운믹스 (NotebookLM 음성개요는 stereo 라도 양 채널 거의 동일 — 평균).
  let pcm;
  if (mono && audioBuffer.numberOfChannels >= 2) {
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.getChannelData(1);
    pcm = new Float32Array(lengthFrames);
    for (let i = 0; i < lengthFrames; i++) pcm[i] = (left[i] + right[i]) * 0.5;
  } else {
    pcm = audioBuffer.getChannelData(0);
  }

  // 3. Float32 [-1, 1] → Int16 PCM. 클리핑 가드.
  const samples = new Int16Array(lengthFrames);
  for (let i = 0; i < lengthFrames; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  // 4. lamejs 로 MP3 인코딩. block size 1152 = MPEG frame 단위.
  const channels = mono ? 1 : 2;
  const enc = new lamejs.Mp3Encoder(channels, sampleRate, bitrateKbps);
  const blockSize = 1152;
  const chunks = [];
  for (let i = 0; i < samples.length; i += blockSize) {
    const block = samples.subarray(i, i + blockSize);
    const out = enc.encodeBuffer(block);
    if (out.length > 0) chunks.push(out);
  }
  const flush = enc.flush();
  if (flush.length > 0) chunks.push(flush);

  // 5. 결과 chunk 들 합쳐 ArrayBuffer 로.
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}

// ready signal (background 가 createDocument 후 첫 메시지 보내기 전 대기 가능).
chrome.runtime.sendMessage({ type: "offscreen:ready" }).catch(() => {});
