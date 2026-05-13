// offscreen document — m4a/mp4 → mp3 64k mono 재인코딩.
// SW 가 audio URL 만 보내고 여기서 직접 fetch + 디코드 + 인코드. SW↔offscreen
// 사이 메시지는 URL ~200 byte (요청) + ~5MB mp3 b64 (응답) 로 작게 유지 →
// 큰 m4a 30-50MB 를 base64 string 으로 양방향 보내던 이전 방식이 chrome.runtime
// 메시지 채널을 자주 끊어버린 문제 해소. credentials:include 는 익스텐션 컨텍스트
// 의 .google.com 세션 쿠키를 redirect 체인에 동행시키는 용도 (SW fetch 와 동일).

// SW ↔ offscreen 메시징은 두 가지 — sendMessage (ping 만) + connect/port (transcode).
// transcode 는 long-lived port 사용 — port 가 열려있는 동안 SW 도 살아있어서
// 30+초 transcode 도 idle 종료 race 안 걸림. ping 은 createDocument 직후 listener
// alive 확인용이라 sendMessage 한 번이면 충분.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "offscreen:ping") {
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// Chrome 이 offscreen 을 30초 idle 에 종료하는 걸 방지. 한 번 시작 후 transcode
// 작업 중엔 계속 재생, 작업 없을 때만 멈춰서 background 음원 부담 없음. 음량 0
// data URL 이라 사용자에겐 들리지 않음.
let _silentAudio = null;
function ensureSilentAudio() {
  if (_silentAudio && !_silentAudio.paused) return;
  if (!_silentAudio) {
    _silentAudio = new Audio();
    // 짧은 silence WAV (1KB 미만), 무한 loop.
    _silentAudio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";
    _silentAudio.loop = true;
    _silentAudio.volume = 0;
  }
  _silentAudio.play().catch(() => {});
}
function stopSilentAudio() {
  try { _silentAudio?.pause(); } catch {}
}

let _activeTranscodes = 0;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "transcode") return;
  port.onMessage.addListener(async (msg) => {
    const t0 = Date.now();
    // "transcode": m4a/mp4 → mp3 64k mono. "fetch": 그냥 fetch + b64 (mp3 같은 통과 케이스).
    // 두 모드를 한 핸들러로 묶어 SW 측 b64 변환을 완전히 제거. SW 는 b64 string 만 받아 ghPut 으로 직행.
    if (msg?.type !== "transcode" && msg?.type !== "fetch") return;
    const doTranscode = msg.type === "transcode";
    _activeTranscodes++;
    ensureSilentAudio();
    // 진행률 비콘 — SW 의 watchdog 가 idle 감지에 사용 + 옵션 페이지 라이브 표시.
    const emit = (stage, bytes, totalBytes) => {
      try {
        port.postMessage({
          progress: true,
          stage,
          bytes: bytes || 0,
          totalBytes: totalBytes || null,
          elapsedMs: Date.now() - t0,
        });
      } catch {}
    };
    try {
      emit("fetch-start", 0, null);
      const r = await fetch(msg.audioUrl, { credentials: "include" });
      if (!r.ok) throw new Error(`fetch ${r.status} ${r.statusText}`);
      const totalHeader = parseInt(r.headers.get("content-length") || "0", 10) || null;
      // 스트림 읽기 — chunk 마다 progress 이벤트. body.getReader 미지원 환경엔 arrayBuffer 폴백.
      let arrBuf;
      const reader = r.body?.getReader?.();
      if (reader) {
        const chunks = [];
        let received = 0;
        let lastEmit = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.byteLength;
          // 너무 잦은 emit 은 메시지 채널 부담 — 250ms 또는 1MB 마다.
          const now = Date.now();
          if (now - lastEmit > 250) {
            emit("fetching", received, totalHeader);
            lastEmit = now;
          }
        }
        emit("fetching", received, totalHeader);
        const merged = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
        arrBuf = merged.buffer;
      } else {
        arrBuf = await r.arrayBuffer();
        emit("fetching", arrBuf.byteLength, arrBuf.byteLength);
      }
      const sourceSize = arrBuf.byteLength;
      emit("fetched", sourceSize, sourceSize);

      let payload;
      if (doTranscode) {
        emit("transcoding", 0, null);
        payload = await transcodeM4aToMp3(
          arrBuf,
          msg.bitrate || 64,
          msg.mono !== false,
        );
        emit("transcoded", payload.byteLength, payload.byteLength);
      } else {
        payload = arrBuf;
      }
      emit("encoding", 0, payload.byteLength);
      const b64 = arrayBufferToBase64(payload);
      emit("encoded", b64.length, payload.byteLength);
      // postMessage 는 disconnect 된 port 에 보내면 throw — settled 플래그 없이도 try
      // 안에서 알아서 처리.
      try {
        port.postMessage({
          ok: true,
          b64,
          size: payload.byteLength,
          sourceSize,
          transcoded: doTranscode,
          // 옛 호환: 일부 경로가 mp3B64 키를 보던 시기 코드 — 새 b64 키와 동일 값.
          mp3B64: doTranscode ? b64 : undefined,
          mp3Size: doTranscode ? payload.byteLength : undefined,
          elapsedMs: Date.now() - t0,
        });
      } catch {}
    } catch (e) {
      try {
        port.postMessage({ ok: false, error: e.message, elapsedMs: Date.now() - t0 });
      } catch {}
    } finally {
      _activeTranscodes--;
      if (_activeTranscodes <= 0) {
        _activeTranscodes = 0;
        stopSilentAudio();
      }
    }
  });
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
