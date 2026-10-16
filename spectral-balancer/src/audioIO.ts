import { BANDS, BAND_Q } from "./dsp";

/** Applica HPF + EQ a un buffer in modo offline (stessa catena del preview). */
export async function renderProcessed(
  buffer: AudioBuffer,
  hpfHz: number,
  gains: number[]
): Promise<AudioBuffer> {
  const off = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const src = off.createBufferSource();
  src.buffer = buffer;

  const hpf = off.createBiquadFilter();
  hpf.type = "highpass";
  hpf.frequency.value = hpfHz;
  hpf.Q.value = 0.707;
  src.connect(hpf);

  let prev: AudioNode = hpf;
  BANDS.forEach((f, i) => {
    const p = off.createBiquadFilter();
    p.type = "peaking";
    p.frequency.value = f;
    p.Q.value = BAND_Q;
    p.gain.value = gains[i] ?? 0;
    prev.connect(p);
    prev = p;
  });
  prev.connect(off.destination);
  src.start();
  return off.startRendering();
}

/** WAV PCM 24 bit; se il picco supera -0.3 dBFS il file viene riscalato. */
export function encodeWav24(buffer: AudioBuffer): Blob {
  const ch = buffer.numberOfChannels;
  const len = buffer.length;
  const channels: Float32Array[] = [];
  let peak = 0;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    channels.push(d);
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  const scale = peak > 0.966 ? 0.966 / peak : 1;

  const bytesPerSample = 3;
  const dataSize = len * ch * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, buffer.sampleRate, true);
  v.setUint32(28, buffer.sampleRate * ch * bytesPerSample, true);
  v.setUint16(32, ch * bytesPerSample, true);
  v.setUint16(34, 24, true);
  writeStr(36, "data");
  v.setUint32(40, dataSize, true);

  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i] * scale));
      const n = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
      v.setUint8(o, n & 0xff);
      v.setUint8(o + 1, (n >> 8) & 0xff);
      v.setUint8(o + 2, (n >> 16) & 0xff);
      o += 3;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
