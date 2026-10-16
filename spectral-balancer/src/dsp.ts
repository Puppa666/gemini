// Logica di analisi spettrale (pura, senza Web Audio) ---------------------

/** Bande di correzione, a distanza di un'ottava. */
export const BANDS = [100, 200, 400, 800, 1600, 3200, 6400, 12800] as const;
export const BAND_Q = 1.2;
export const FFT_SIZE = 8192;

export const bandLabel = (f: number) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);

/** Livello relativo (dB rispetto a 1 kHz) di una curva con pendenza `slope` dB/ottava. */
export const targetRel = (f: number, slope: number) => slope * Math.log2(f / 1000);

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Media in potenza dei bin FFT (valori in dB) tra lo e hi Hz, restituita in dB. */
export function bandPowerDb(data: ArrayLike<number>, binHz: number, lo: number, hi: number): number {
  const n = data.length;
  const a = clamp(Math.floor(lo / binHz), 1, n - 1);
  const b = clamp(Math.ceil(hi / binHz), a, n - 1);
  let sum = 0;
  for (let i = a; i <= b; i++) sum += Math.pow(10, data[i] / 10); // -Infinity -> 0
  const p = sum / (b - a + 1);
  return p > 1e-12 ? 10 * Math.log10(p) : -120;
}

export interface Analysis {
  valid: boolean;
  refDb: number;
  corrections: number[];
  /** Eccesso di energia sub (20-60 Hz) rispetto alla curva target, in dB. */
  subExcess: number;
}

/**
 * Confronta lo spettro misurato (dB reali, da getFloatFrequencyData)
 * con la curva target e restituisce la correzione per ciascuna banda.
 */
export function analyze(data: ArrayLike<number>, binHz: number, slope: number, maxCorr: number): Analysis {
  const refDb = bandPowerDb(data, binHz, 1000 * 0.707, 1000 * 1.414);
  if (refDb < -90) {
    return { valid: false, refDb, corrections: BANDS.map(() => 0), subExcess: 0 };
  }

  const corrections = BANDS.map((f) => {
    const level = bandPowerDb(data, binHz, f * 0.707, f * 1.414);
    if (level < -100) return 0; // banda vuota: non amplificare il rumore di fondo
    const diff = targetRel(f, slope) - (level - refDb);
    return clamp(diff, -maxCorr, maxCorr);
  });

  const sub = bandPowerDb(data, binHz, 20, 60);
  const subExcess = sub < -100 ? 0 : sub - refDb - targetRel(40, slope);

  return { valid: true, refDb, corrections, subExcess };
}

/** Frequenza di taglio automatica dell'HPF in base all'eccesso sub. */
export function hpfFromExcess(excess: number): number {
  if (excess > 12) return 65;
  if (excess > 6) return 45;
  return 30;
}

/** N frequenze log-spaziate tra 20 Hz e 20 kHz. */
export const logSpaced = (n: number) =>
  Array.from({ length: n }, (_, i) => 20 * Math.pow(1000, i / (n - 1)));
