import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, RefreshCw, Volume2, VolumeX, Music, Download, FileAudio } from "lucide-react";
import {
  BANDS,
  BAND_Q,
  FFT_SIZE,
  analyze,
  bandLabel,
  bandPowerDb,
  clamp,
  hpfFromExcess,
  logSpaced,
  targetRel,
} from "./dsp";
import { downloadBlob, encodeWav24, renderProcessed } from "./audioIO";

type SourceType = "muddy" | "harsh" | "noise" | "mic" | "file";

const NB = BANDS.length;
const LEARN_MS = 2000;
const DB_LO = -110;
const DB_HI = -20;
const SPEC_PTS = 220;
const LOG_F = logSpaced(SPEC_PTS);
const EQ_PTS = 160;
const EQ_F = logSpaced(EQ_PTS);

const makeBuf = (n: number) => new Float32Array(n);
type Buf = ReturnType<typeof makeBuf>;
const EQ_FREQ_BUF = (() => {
  const b = makeBuf(EQ_PTS);
  EQ_F.forEach((f, i) => (b[i] = f));
  return b;
})();

const SLOPE_PRESETS = [
  { label: "Pink", value: -3 },
  { label: "Mix", value: -4.5 },
  { label: "Dark", value: -6 },
];

const xOf = (f: number, w: number) => (Math.log10(f / 20) / 3) * w;
const yOf = (db: number, h: number) => h * (1 - clamp((db - DB_LO) / (DB_HI - DB_LO), 0, 1));

export default function SpectralBalancer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [sourceType, setSourceType] = useState<SourceType>("muddy");
  const [sourceNonce, setSourceNonce] = useState(0);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [isBypassed, setIsBypassed] = useState(false);
  const [amount, setAmount] = useState(100);
  const [mode, setMode] = useState<"continuous" | "hold">("continuous");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [slope, setSlope] = useState(-4.5);
  const [maxCorr, setMaxCorr] = useState(9);
  const [autoHpf, setAutoHpf] = useState(true);
  const [hpfManual, setHpfManual] = useState(30);
  const [hpfCutoff, setHpfCutoff] = useState(30);
  const [bandCorrections, setBandCorrections] = useState<number[]>(() => BANDS.map(() => 0));
  const [exporting, setExporting] = useState(false);

  // Audio graph
  const audioCtxRef = useRef<AudioContext | null>(null);
  const inputBusRef = useRef<GainNode | null>(null);
  const hpfNodeRef = useRef<BiquadFilterNode | null>(null);
  const eqNodesRef = useRef<BiquadFilterNode[]>([]);
  const dryGainRef = useRef<GainNode | null>(null);
  const wetGainRef = useRef<GainNode | null>(null);
  const preAnalyserRef = useRef<AnalyserNode | null>(null); // ingresso (pre-EQ): usato per l'analisi
  const postAnalyserRef = useRef<AnalyserNode | null>(null); // uscita: solo display
  const noiseBufferRef = useRef<AudioBuffer | null>(null);
  const userAudioBufferRef = useRef<AudioBuffer | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const sourceCleanupRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const startIdRef = useRef(0);
  const playingRef = useRef(false);
  const sourceTypeRef = useRef<SourceType>(sourceType);
  sourceTypeRef.current = sourceType;

  // Stato dell'analisi
  const rawRef = useRef<number[]>(BANDS.map(() => 0));
  const learnAccRef = useRef({ sum: BANDS.map(() => 0), n: 0 });
  const subExcessRef = useRef(0);
  const hpfAutoRef = useRef(30);
  const refDispRef = useRef<number | null>(null);
  const preBufRef = useRef<Buf | null>(null);
  const postBufRef = useRef<Buf | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const settingsRef = useRef({
    playing: false,
    bypassed: false,
    amount: 100,
    mode: "continuous" as "continuous" | "hold",
    learning: false,
    autoHpf: true,
    hpfManual: 30,
    slope: -4.5,
    maxCorr: 9,
  });
  useEffect(() => {
    settingsRef.current = {
      playing: isPlaying,
      bypassed: isBypassed,
      amount,
      mode,
      learning: isAnalyzing,
      autoHpf,
      hpfManual,
      slope,
      maxCorr,
    };
  });

  // ---------------------------------------------------------------- audio
  const initAudio = useCallback(() => {
    if (audioCtxRef.current) return audioCtxRef.current;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    const inputBus = ctx.createGain();

    const preAnalyser = ctx.createAnalyser();
    preAnalyser.fftSize = FFT_SIZE;
    preAnalyser.smoothingTimeConstant = 0.8;
    preAnalyser.minDecibels = -120;
    preAnalyser.maxDecibels = 0;

    const postAnalyser = ctx.createAnalyser();
    postAnalyser.fftSize = FFT_SIZE;
    postAnalyser.smoothingTimeConstant = 0.8;
    postAnalyser.minDecibels = -120;
    postAnalyser.maxDecibels = 0;

    const hpf = ctx.createBiquadFilter();
    hpf.type = "highpass";
    hpf.frequency.value = 30;
    hpf.Q.value = 0.707;

    let prev: AudioNode = hpf;
    const filters: BiquadFilterNode[] = BANDS.map((f) => {
      const p = ctx.createBiquadFilter();
      p.type = "peaking";
      p.frequency.value = f;
      p.Q.value = BAND_Q;
      p.gain.value = 0;
      prev.connect(p);
      prev = p;
      return p;
    });

    const wet = ctx.createGain();
    const dry = ctx.createGain();
    const master = ctx.createGain();
    master.gain.value = 0.7;
    const bypassed = settingsRef.current.bypassed;
    wet.gain.value = bypassed ? 0 : 1;
    dry.gain.value = bypassed ? 1 : 0;

    inputBus.connect(preAnalyser);
    inputBus.connect(hpf);
    inputBus.connect(dry);
    prev.connect(wet);
    wet.connect(master);
    dry.connect(master);
    master.connect(postAnalyser);
    postAnalyser.connect(ctx.destination);

    inputBusRef.current = inputBus;
    hpfNodeRef.current = hpf;
    eqNodesRef.current = filters;
    wetGainRef.current = wet;
    dryGainRef.current = dry;
    preAnalyserRef.current = preAnalyser;
    postAnalyserRef.current = postAnalyser;

    // Pink noise (Paul Kellet)
    const size = ctx.sampleRate * 2;
    const nb = ctx.createBuffer(1, size, ctx.sampleRate);
    const out = nb.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < size; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    noiseBufferRef.current = nb;
    return ctx;
  }, []);

  const stopSource = useCallback(() => {
    sourceCleanupRef.current?.();
    sourceCleanupRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
  }, []);

  const startSource = useCallback(async () => {
    const myId = ++startIdRef.current;
    const ctx = initAudio();
    if (ctx.state === "suspended") await ctx.resume();
    if (myId !== startIdRef.current) return;
    stopSource();

    const bus = inputBusRef.current;
    if (!bus) return;
    const type = sourceTypeRef.current;

    if (type === "noise") {
      if (!noiseBufferRef.current) return;
      const n = ctx.createBufferSource();
      n.buffer = noiseBufferRef.current;
      n.loop = true;
      n.connect(bus);
      n.start();
      sourceCleanupRef.current = () => {
        try { n.stop(); } catch { /* già fermo */ }
        n.disconnect();
      };
    } else if (type === "muddy" || type === "harsh") {
      const nodes: AudioNode[] = [];
      const oscs: OscillatorNode[] = [];
      const chordGain = ctx.createGain();
      chordGain.gain.value = 0.25;
      nodes.push(chordGain);

      const freqs =
        type === "muddy" ? [110, 164.8, 220, 329.6] : [440, 659.2, 880, 1318.5, 3520];
      freqs.forEach((f) => {
        const osc = ctx.createOscillator();
        osc.type = type === "muddy" ? "sawtooth" : "square";
        osc.frequency.setValueAtTime(f, ctx.currentTime);
        if (type === "muddy" && f <= 220) {
          const res = ctx.createBiquadFilter();
          res.type = "peaking";
          res.frequency.value = 180;
          res.gain.value = 9;
          osc.connect(res);
          res.connect(chordGain);
          nodes.push(res);
        } else {
          osc.connect(chordGain);
        }
        osc.start();
        oscs.push(osc);
      });
      chordGain.connect(bus);
      sourceCleanupRef.current = () => {
        oscs.forEach((o) => {
          try { o.stop(); } catch { /* già fermo */ }
          o.disconnect();
        });
        nodes.forEach((n) => n.disconnect());
      };
    } else if (type === "file") {
      if (!userAudioBufferRef.current) return;
      const fs = ctx.createBufferSource();
      fs.buffer = userAudioBufferRef.current;
      fs.loop = true;
      fs.connect(bus);
      fs.start();
      sourceCleanupRef.current = () => {
        try { fs.stop(); } catch { /* già fermo */ }
        fs.disconnect();
      };
    } else if (type === "mic") {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (err) {
        console.error("Accesso al microfono negato:", err);
        setSourceType("muddy");
        return;
      }
      if (myId !== startIdRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micStreamRef.current = stream;
      const ms = ctx.createMediaStreamSource(stream);
      ms.connect(bus);
      sourceCleanupRef.current = () => ms.disconnect();
    }
  }, [initAudio, stopSource]);

  const togglePlay = useCallback(async () => {
    if (playingRef.current) {
      startIdRef.current++;
      stopSource();
      playingRef.current = false;
      setIsPlaying(false);
    } else {
      playingRef.current = true;
      setIsPlaying(true);
      await startSource();
    }
  }, [startSource, stopSource]);

  const togglePlayRef = useRef(togglePlay);
  togglePlayRef.current = togglePlay;

  // Cambio sorgente (o nuovo file) mentre si ascolta: un solo avvio
  useEffect(() => {
    if (playingRef.current) void startSource();
  }, [sourceType, sourceNonce, startSource]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const ctx = initAudio();
      if (ctx.state === "suspended") await ctx.resume();
      const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
      userAudioBufferRef.current = decoded;
      setUploadedFileName(file.name);
      setSourceType("file");
      playingRef.current = true;
      setIsPlaying(true);
      setSourceNonce((n) => n + 1);
    } catch (err) {
      console.error("Errore di decodifica audio:", err);
    }
  };

  // Bypass: crossfade wet/dry
  useEffect(() => {
    const ctx = audioCtxRef.current;
    if (!ctx || !wetGainRef.current || !dryGainRef.current) return;
    const now = ctx.currentTime;
    wetGainRef.current.gain.setTargetAtTime(isBypassed ? 0 : 1, now, 0.02);
    dryGainRef.current.gain.setTargetAtTime(isBypassed ? 1 : 0, now, 0.02);
  }, [isBypassed]);

  // Scorciatoie: Spazio = play/stop, B = bypass
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "BUTTON" || t.tagName === "SELECT")) return;
      if (e.code === "Space") {
        e.preventDefault();
        void togglePlayRef.current();
      } else if (e.code === "KeyB") {
        setIsBypassed((b) => !b);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Pulizia allo smontaggio
  useEffect(() => {
    return () => {
      startIdRef.current++;
      stopSource();
      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      inputBusRef.current = null;
      preAnalyserRef.current = null;
      postAnalyserRef.current = null;
      hpfNodeRef.current = null;
      eqNodesRef.current = [];
      wetGainRef.current = null;
      dryGainRef.current = null;
      playingRef.current = false;
      if (ctx && ctx.state !== "closed") void ctx.close();
    };
  }, [stopSource]);

  // ------------------------------------------------------------ analisi + canvas
  useEffect(() => {
    let raf = 0;
    let lastUi = 0;

    const render = (time: number) => {
      raf = requestAnimationFrame(render);
      const s = settingsRef.current;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const g = canvas.getContext("2d");
      if (!g) return;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      if (w === 0 || h === 0) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      // Griglia dB
      g.font = "9px monospace";
      g.lineWidth = 1;
      for (let db = -100; db <= -30; db += 10) {
        const y = yOf(db, h);
        g.strokeStyle = "rgba(255,255,255,0.05)";
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();
        if (db % 20 === 0) {
          g.fillStyle = "rgba(255,255,255,0.2)";
          g.fillText(`${db}`, 4, y - 2);
        }
      }
      // Griglia frequenze
      [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => {
        const x = xOf(f, w);
        g.strokeStyle = "rgba(255,255,255,0.05)";
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
        g.fillStyle = "rgba(255,255,255,0.25)";
        g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, h - 5);
      });

      const ctx = audioCtxRef.current;
      const pre = preAnalyserRef.current;
      const post = postAnalyserRef.current;
      const live = !!(ctx && pre && post && s.playing);

      if (live && ctx && pre && post) {
        if (!preBufRef.current || preBufRef.current.length !== pre.frequencyBinCount) {
          preBufRef.current = makeBuf(pre.frequencyBinCount);
          postBufRef.current = makeBuf(post.frequencyBinCount);
        }
        const preBuf = preBufRef.current;
        const postBuf = postBufRef.current!;
        pre.getFloatFrequencyData(preBuf);
        post.getFloatFrequencyData(postBuf);
        const binHz = ctx.sampleRate / pre.fftSize;

        // Analisi sul segnale d'ingresso (pre-EQ => nessun feedback)
        if (s.mode === "continuous" || s.learning) {
          const res = analyze(preBuf, binHz, s.slope, s.maxCorr);
          if (res.valid) {
            if (s.learning) {
              const acc = learnAccRef.current;
              res.corrections.forEach((c, i) => (acc.sum[i] += c));
              acc.n++;
            } else {
              for (let i = 0; i < NB; i++) {
                rawRef.current[i] = rawRef.current[i] * 0.96 + res.corrections[i] * 0.04;
              }
            }
            subExcessRef.current = subExcessRef.current * 0.95 + res.subExcess * 0.05;
            hpfAutoRef.current = hpfFromExcess(subExcessRef.current);
            refDispRef.current =
              refDispRef.current === null ? res.refDb : refDispRef.current * 0.9 + res.refDb * 0.1;
          }
        }

        // Spettri (smoothing 1/6 d'ottava)
        const SM = Math.pow(2, 1 / 12);
        const drawSpec = (data: Buf, stroke: string, fill: string | null) => {
          g.beginPath();
          LOG_F.forEach((f, i) => {
            const x = xOf(f, w);
            const y = yOf(bandPowerDb(data, binHz, f / SM, f * SM), h);
            if (i === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          });
          g.strokeStyle = stroke;
          g.lineWidth = 1.5;
          g.stroke();
          if (fill) {
            g.lineTo(w, h);
            g.lineTo(0, h);
            g.closePath();
            g.fillStyle = fill;
            g.fill();
          }
        };
        drawSpec(preBuf, "rgba(161,161,170,0.55)", null);
        drawSpec(
          postBuf,
          s.bypassed ? "rgba(239,68,68,0.85)" : "rgba(56,189,248,0.9)",
          s.bypassed ? "rgba(239,68,68,0.07)" : "rgba(56,189,248,0.09)"
        );
      }

      // DSP: guadagni (scalati da Amount) e HPF
      const hpfNow = s.autoHpf ? hpfAutoRef.current : s.hpfManual;
      if (ctx && hpfNodeRef.current) {
        const now = ctx.currentTime;
        hpfNodeRef.current.frequency.setTargetAtTime(hpfNow, now, 0.08);
        eqNodesRef.current.forEach((f, i) =>
          f.gain.setTargetAtTime((rawRef.current[i] ?? 0) * (s.amount / 100), now, 0.08)
        );
      }

      // Curva target ancorata al livello misurato a 1 kHz
      const anchor = refDispRef.current ?? -50;
      g.beginPath();
      LOG_F.forEach((f, i) => {
        const x = xOf(f, w);
        const y = yOf(anchor + targetRel(f, s.slope), h);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.strokeStyle = "rgba(16,185,129,0.65)";
      g.setLineDash([5, 4]);
      g.lineWidth = 2;
      g.stroke();
      g.setLineDash([]);

      // Risposta reale dei filtri (HPF + EQ)
      if (ctx && hpfNodeRef.current) {
        const total = new Array<number>(EQ_PTS).fill(0);
        const mag = makeBuf(EQ_PTS);
        const phase = makeBuf(EQ_PTS);
        [hpfNodeRef.current, ...eqNodesRef.current].forEach((node) => {
          node.getFrequencyResponse(EQ_FREQ_BUF, mag, phase);
          for (let i = 0; i < EQ_PTS; i++) total[i] += 20 * Math.log10(Math.max(mag[i], 1e-6));
        });
        const baseY = h * 0.2;
        const pxPerDb = h * 0.011;
        g.strokeStyle = "rgba(255,255,255,0.12)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(0, baseY);
        g.lineTo(w, baseY);
        g.stroke();
        g.beginPath();
        total.forEach((db, i) => {
          const x = xOf(EQ_F[i], w);
          const y = baseY - clamp(db, -16, 16) * pxPerDb;
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        g.strokeStyle = s.bypassed ? "rgba(255,255,255,0.25)" : "rgba(250,250,250,0.9)";
        g.lineWidth = 1.75;
        g.stroke();
      }

      // Marker HPF
      const hx = xOf(hpfNow, w);
      g.strokeStyle = "#eab308";
      g.lineWidth = 1.5;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(hx, 0);
      g.lineTo(hx, h);
      g.stroke();
      g.setLineDash([]);

      // UI React a ~15 Hz
      if (time - lastUi > 65) {
        lastUi = time;
        setBandCorrections([...rawRef.current]);
        setHpfCutoff(Math.round(hpfNow));
      }
    };

    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Canvas HiDPI + resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // ------------------------------------------------------------- azioni
  const handleLearn = () => {
    if (!isPlaying || isAnalyzing) return;
    learnAccRef.current = { sum: BANDS.map(() => 0), n: 0 };
    setIsAnalyzing(true);
    window.setTimeout(() => {
      const { sum, n } = learnAccRef.current;
      if (n > 0) rawRef.current = sum.map((v) => v / n);
      setIsAnalyzing(false);
      setMode("hold");
    }, LEARN_MS);
  };

  const currentGains = () => rawRef.current.map((v) => v * (amount / 100));
  const currentHpf = () => (autoHpf ? hpfAutoRef.current : hpfManual);

  const exportPreset = () => {
    const preset = {
      app: "Spectral Balancer",
      targetSlopeDbPerOct: slope,
      amountPercent: amount,
      highpassHz: currentHpf(),
      bands: BANDS.map((f, i) => ({
        frequencyHz: f,
        type: "peaking",
        q: BAND_Q,
        gainDb: Number(currentGains()[i].toFixed(2)),
      })),
    };
    downloadBlob(new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" }), "spectral-balancer-eq.json");
  };

  const exportWav = async () => {
    const buf = userAudioBufferRef.current;
    if (!buf || exporting) return;
    setExporting(true);
    try {
      const out = await renderProcessed(buf, currentHpf(), currentGains());
      const base = (uploadedFileName ?? "audio").replace(/\.[^.]+$/, "");
      downloadBlob(encodeWav24(out), `${base}_balanced.wav`);
    } catch (err) {
      console.error("Errore di rendering:", err);
    } finally {
      setExporting(false);
    }
  };

  // ------------------------------------------------------------------ UI
  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center p-4 bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      <div className="w-full max-w-4xl bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-6 flex flex-col gap-5">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between border-b border-zinc-800/80 pb-4 gap-4">
          <div className="flex items-center gap-3">
            <div className="w-3 h-8 bg-emerald-500 rounded-sm shadow-[0_0_12px_rgba(16,185,129,0.5)]" />
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white uppercase flex items-center gap-2">
                Spectral Balancer
                <span className="text-[10px] bg-zinc-800 text-emerald-400 px-2 py-0.5 rounded font-mono border border-emerald-500/30">
                  {slope.toFixed(1)} dB / OCT
                </span>
              </h1>
              <p className="text-xs text-zinc-400">Automatic Spectral Tilt & Low-End Correction</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsBypassed(!isBypassed)}
              title="Bypass (B)"
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                isBypassed
                  ? "bg-rose-500/20 text-rose-400 border border-rose-500/40"
                  : "bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700"
              }`}
            >
              {isBypassed ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
              {isBypassed ? "BYPASS ON" : "ACTIVE"}
            </button>
            <button
              onClick={() => void togglePlay()}
              title="Play / Stop (Spazio)"
              className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider flex items-center gap-2 shadow-lg transition-all ${
                isPlaying ? "bg-rose-600 hover:bg-rose-500 text-white" : "bg-emerald-600 hover:bg-emerald-500 text-white"
              }`}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {isPlaying ? "Stop Audio" : "Listen & Test"}
            </button>
          </div>
        </div>

        {/* Sorgente + modalità */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-zinc-950/60 p-3 rounded-lg border border-zinc-800/60 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-zinc-400 font-medium whitespace-nowrap">Input:</span>
            <div className="flex flex-wrap gap-1.5 w-full">
              {(
                [
                  { id: "muddy", label: "Muddy Mix" },
                  { id: "harsh", label: "Harsh Synth" },
                  { id: "noise", label: "Pink Noise" },
                  { id: "mic", label: "Mic" },
                ] as const
              ).map((src) => (
                <button
                  key={src.id}
                  onClick={() => setSourceType(src.id)}
                  title={src.id === "mic" ? "Usa le cuffie per evitare il feedback" : undefined}
                  className={`flex-1 py-1 px-2 rounded font-mono transition-colors text-center ${
                    sourceType === src.id
                      ? "bg-zinc-700 text-emerald-400 font-semibold border border-zinc-600"
                      : "bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {src.label}
                </button>
              ))}
              <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileUpload} className="hidden" />
              <button
                onClick={() => fileInputRef.current?.click()}
                title={uploadedFileName || "Carica file audio"}
                className={`flex-1 py-1 px-2 rounded font-mono transition-colors text-center flex items-center justify-center gap-1 ${
                  sourceType === "file"
                    ? "bg-zinc-700 text-emerald-400 font-semibold border border-zinc-600"
                    : "bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Music className="w-3 h-3" />
                <span className="truncate max-w-[70px]">{uploadedFileName ?? "File"}</span>
              </button>
            </div>
          </div>

          <div className="flex items-center justify-end gap-3">
            <div className="flex items-center gap-2">
              <span className="text-zinc-400">Mode:</span>
              <button
                onClick={() => setMode(mode === "continuous" ? "hold" : "continuous")}
                className={`px-2.5 py-1 rounded font-mono text-[11px] border transition-colors ${
                  mode === "continuous"
                    ? "bg-emerald-950/60 text-emerald-300 border-emerald-500/40"
                    : "bg-zinc-800 text-amber-300 border-amber-500/40"
                }`}
              >
                {mode === "continuous" ? "Continuous Auto" : "Hold Snapshot"}
              </button>
            </div>
            <button
              onClick={handleLearn}
              disabled={!isPlaying || isAnalyzing}
              title="Media la misura su 2 secondi e blocca la correzione"
              className={`px-3 py-1 rounded text-[11px] font-semibold flex items-center gap-1.5 transition-all ${
                isAnalyzing
                  ? "bg-amber-500 text-zinc-950 animate-pulse"
                  : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 disabled:opacity-40"
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${isAnalyzing ? "animate-spin" : ""}`} />
              {isAnalyzing ? "Analyzing..." : "Re-Learn"}
            </button>
          </div>
        </div>

        {/* Spettro */}
        <div className="relative w-full h-72 bg-zinc-950 rounded-lg border border-zinc-800/80 overflow-hidden shadow-inner">
          <canvas ref={canvasRef} className="w-full h-full block" />
          <div className="absolute top-2 left-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono pointer-events-none bg-zinc-900/80 px-2 py-1 rounded border border-zinc-800">
            <span className="text-emerald-400">- - {slope.toFixed(1)} dB/oct target</span>
            <span className="text-zinc-400">— input</span>
            <span className={isBypassed ? "text-rose-400" : "text-sky-400"}>— output</span>
            <span className="text-zinc-100">— EQ curve</span>
            <span className="text-amber-400">¦ HPF {hpfCutoff} Hz</span>
          </div>
          {!isPlaying && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/70 backdrop-blur-xs text-xs text-zinc-400 font-mono">
              Premi "Listen & Test" (o Spazio) per far passare il segnale nel balancer
            </div>
          )}
        </div>

        {/* Bande */}
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
          {BANDS.map((freq, idx) => {
            const corr = (bandCorrections[idx] ?? 0) * (amount / 100);
            const isBoost = corr > 0;
            return (
              <div
                key={freq}
                className="bg-zinc-950/70 border border-zinc-800/80 rounded-lg p-2 flex flex-col items-center justify-between text-center"
              >
                <span className="text-[11px] font-mono text-zinc-400">{bandLabel(freq)}</span>
                <div className="w-full h-12 my-2 bg-zinc-900 rounded flex flex-col justify-center items-center relative overflow-hidden">
                  <div className="absolute w-full h-[1px] bg-zinc-700 top-1/2" />
                  <div
                    className={`w-3 rounded transition-all duration-75 ${isBoost ? "bg-emerald-500" : "bg-rose-500"}`}
                    style={{
                      height: `${Math.min(24, Math.abs(corr) * 2.4)}px`,
                      transform: isBoost ? "translateY(-50%)" : "translateY(50%)",
                    }}
                  />
                </div>
                <span
                  className={`text-xs font-mono font-semibold ${
                    Math.abs(corr) < 0.2 ? "text-zinc-500" : isBoost ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {corr >= 0 ? `+${corr.toFixed(1)}` : corr.toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Controlli */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 bg-zinc-950/40 p-4 rounded-lg border border-zinc-800/60 text-xs">
          <div>
            <div className="flex justify-between mb-1.5">
              <span className="text-zinc-300 font-medium">Target slope</span>
              <span className="font-mono text-emerald-400 font-semibold">{slope.toFixed(1)} dB/oct</span>
            </div>
            <div className="flex gap-1.5 mb-2">
              {SLOPE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setSlope(p.value)}
                  className={`flex-1 py-1 rounded font-mono border transition-colors ${
                    slope === p.value
                      ? "bg-zinc-700 text-emerald-400 border-zinc-600"
                      : "bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:text-zinc-200"
                  }`}
                >
                  {p.label} {p.value}
                </button>
              ))}
            </div>
            <input
              type="range"
              min={-7.5}
              max={-1.5}
              step={0.1}
              value={slope}
              onChange={(e) => setSlope(Number(e.target.value))}
              className="w-full accent-emerald-500 cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <div className="flex justify-between mb-1.5">
                <span className="text-zinc-300 font-medium">Correction Amount</span>
                <span className="font-mono text-emerald-400 font-semibold">{amount}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                className="w-full accent-emerald-500 cursor-pointer"
              />
            </div>
            <div>
              <div className="flex justify-between mb-1.5">
                <span className="text-zinc-300 font-medium">Max correction per band</span>
                <span className="font-mono text-emerald-400 font-semibold">±{maxCorr} dB</span>
              </div>
              <input
                type="range"
                min={3}
                max={12}
                step={0.5}
                value={maxCorr}
                onChange={(e) => setMaxCorr(Number(e.target.value))}
                className="w-full accent-emerald-500 cursor-pointer"
              />
            </div>
          </div>

          <div>
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-zinc-300 font-medium">High-pass filter</span>
              <div className="flex items-center gap-2 font-mono">
                <span className="text-amber-400 font-semibold">{hpfCutoff} Hz</span>
                <button
                  onClick={() => setAutoHpf(!autoHpf)}
                  className={`px-2 py-0.5 rounded border text-[11px] ${
                    autoHpf
                      ? "bg-emerald-950/60 text-emerald-300 border-emerald-500/40"
                      : "bg-zinc-800 text-zinc-300 border-zinc-700"
                  }`}
                >
                  {autoHpf ? "Auto" : "Manual"}
                </button>
              </div>
            </div>
            <input
              type="range"
              min={20}
              max={120}
              value={hpfManual}
              disabled={autoHpf}
              onChange={(e) => setHpfManual(Number(e.target.value))}
              className="w-full accent-amber-500 cursor-pointer disabled:opacity-30"
            />
          </div>

          <div className="flex items-end justify-end gap-2">
            <button
              onClick={exportPreset}
              className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-200 font-semibold flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" /> EQ preset (.json)
            </button>
            <button
              onClick={() => void exportWav()}
              disabled={!uploadedFileName || exporting}
              title={uploadedFileName ? "Applica la correzione attuale al file caricato" : "Carica prima un file audio"}
              className="px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-semibold flex items-center gap-1.5 disabled:opacity-40 disabled:hover:bg-emerald-700"
            >
              <FileAudio className="w-3.5 h-3.5" /> {exporting ? "Rendering..." : "Render WAV 24-bit"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
