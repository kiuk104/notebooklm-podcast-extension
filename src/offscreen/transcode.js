// offscreen document — m4a/mp4 → mp3 64k mono 재인코딩.
// SW (background) 와는 base64 string 으로 주고받는다 — chrome.runtime.sendMessage
// 가 JSON 직렬화를 써서 ArrayBuffer 를 그대로 못 보내기 때문 (binary → 빈 object
// 로 도착). 50MB raw m4a → 67MB b64 string → 디코드 → ArrayBuffer → AudioContext
// + lamejs → mp3 ArrayBuffer → 다시 base64 → SW 회신. 회신쪽 mp3 는 5MB 정도라
// 저렴.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "offscreen:transcode") return false;
  (async () => {
    const t0 = Date.now();
    try {
      const arrBuf = base64ToArrayBuffer(msg.audioBufferB64 || "");
      const mp3 = await transcodeM4aToMp3(
        arrBuf,
        msg.bitrate || 64,
        msg.mono !== false,
      );
      const mp3B64 = arrayBufferToBase64(mp3);
      sendResponse({ ok: true, mp3B64, elapsedMs: Date.now() - t0 });
    } catch (e) {
      sendResponse({ ok: false, error: e.message, elapsedMs: Date.now() - t0 });
    }
  })();
  return true; // async sendResponse
});

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

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
