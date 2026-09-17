# Build video verificata — 16 settembre 2026

## Provenienza e integrità

FFmpeg n9.0.1-30-g9258bacca5, Linux x86_64 GPL, pacchetto BtbN:

`https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-15-13-18/ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0.tar.xz`

SHA-256 pubblicato e verificato sia sul download locale sia dentro Vercel Sandbox:

`adb2d107287cdace0c5d00dd986cd3674c1e86776501640bff3b5cf7d2cf2e71`

I binari sono `bin/ffmpeg` e `bin/ffprobe` dentro l'archivio. Il collegamento alla build è fissato alla release datata, non al tag mobile `latest`. FFmpeg indica BtbN fra i distributori di build Linux dalla propria pagina download.

## Ambiente misurato

Sandbox temporaneo `kidville-video-benchmark-20260916`, regione `dub1`, architettura `x86_64`, 2 vCPU e 4 GB RAM. Immagine Vercel `vercel/sandbox/universal`, persistenza disattivata. Download, verifica, estrazione e inventario di versione/decoder/encoder/demuxer/filtri: 11,901 secondi. Questo è il tempo di preparazione, **non** una misura della conversione né un preventivo dei costi.

Inventario acquisito direttamente dalla build in Sandbox. I test con file rappresentativi e il benchmark di conversione restano da completare prima dell'attivazione.
