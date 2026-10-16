# Spectral Balancer

Correzione spettrale automatica in tempo reale (Web Audio API, React, Vite, Tailwind).
Misura lo spettro del segnale in ingresso, lo confronta con una curva target
(default **-4.5 dB/ottava**) e regola un EQ a 8 bande e un high-pass automatico.

## Funzioni

- Analisi in dB reali sul segnale **pre-EQ** (FFT 8192), nessun feedback tra misura e correzione
- Target slope regolabile (Pink -3 / Mix -4.5 / Dark -6 o slider libero)
- Modalità *Continuous* e *Hold*; **Re-Learn** media la misura su 2 s e blocca il risultato
- Amount, correzione massima per banda, HPF automatico o manuale
- Spettro input/output, curva target ancorata a 1 kHz e risposta reale dei filtri
- Sorgenti: Muddy Mix, Harsh Synth, Pink Noise, microfono, file audio
- Export: preset EQ `.json` e **render WAV 24-bit** del file caricato
- Scorciatoie: `Spazio` play/stop, `B` bypass

## Sviluppo

```bash
npm install
npm run dev
```

## Build

```bash
npm run build   # output in dist/
```

## Pubblicazione su GitHub Pages

1. Crea il repository e fai push sul branch `main`.
2. Su GitHub: **Settings → Pages → Source: GitHub Actions**.
3. Il workflow `.github/workflows/deploy.yml` compila e pubblica a ogni push.

Il sito sarà su `https://<utente>.github.io/<repo>/` (HTTPS, quindi il microfono funziona).
