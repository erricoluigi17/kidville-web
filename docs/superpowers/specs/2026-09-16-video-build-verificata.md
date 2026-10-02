# Build video verificata — 16 settembre 2026

## Provenienza e integrità

FFmpeg n9.0.1-30-g9258bacca5, Linux x86_64 GPL, pacchetto BtbN:

`https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-15-13-18/ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0.tar.xz`

SHA-256 pubblicato e verificato sia sul download locale sia dentro Vercel Sandbox:

`adb2d107287cdace0c5d00dd986cd3674c1e86776501640bff3b5cf7d2cf2e71`

I binari sono `bin/ffmpeg` e `bin/ffprobe` dentro l'archivio. Il collegamento alla build è fissato alla release datata, non al tag mobile `latest`. FFmpeg indica BtbN fra i distributori di build Linux dalla propria pagina download.

> **Dal 2026-10-02 questo indirizzo è solo la provenienza.** La release è stata cancellata da BtbN il 29/09/2026 (404) e nessun codice la scarica più: la build vive nel nostro Storage, vedi la sezione «Dal 2026-10-02: la build vive nel nostro Storage» in fondo a questo file.

## Ambiente misurato

Sandbox temporaneo `kidville-video-benchmark-20260916`, regione `dub1`, architettura `x86_64`, 2 vCPU e 4 GB RAM. Immagine Vercel `vercel/sandbox/universal`, persistenza disattivata. Download, verifica, estrazione e inventario di versione/decoder/encoder/demuxer/filtri: 11,901 secondi. Questo è il tempo di preparazione, **non** una misura della conversione né un preventivo dei costi.

Inventario acquisito direttamente dalla build in Sandbox. I test con file rappresentativi e il benchmark di conversione restano da completare prima dell'attivazione.

## Dal 2026-10-02: la build vive nel nostro Storage

### Perché

Il 29/09/2026 BtbN ha cancellato la release datata (conserva le build giornaliere 14 giorni): l'indirizzo qui sopra risponde 404, e da quel giorno la conversione dei video in produzione si è fermata — 17 job su 17 falliti con `BUILD_DOWNLOAD_FAILED`. Il runner scaricava la build da Internet a **ogni** MicroVM nuova, dopo aver installato `xz` dai mirror di Amazon: due download esterni a runtime, entrambi fuori dal nostro controllo, e uno è scattato.

Da oggi **nessun codice scarica più niente da Internet per avere FFmpeg**: il runner di produzione e la CI prendono due file compressi dal nostro bucket privato. L'archivio BtbN resta nel bucket e nelle costanti di `src/lib/media/video/build.ts` come **provenienza**, non come fonte.

### Dove sta, e con quali impronte

Bucket privato **`video_build`** di Supabase Storage (nessuna policy su `storage.objects`: lo legge solo la chiave di servizio, chiunque altro passa da un URL firmato; non contiene nessun dato personale, solo due binari pubblici GPL e l'archivio da cui vengono). Cartella `ffmpeg-n9.0.1-30-g9258bacca5/`:

| Oggetto | Percorso nel bucket | Byte | SHA-256 |
|---|---|---|---|
| `ffmpeg.gz` | `ffmpeg-n9.0.1-30-g9258bacca5/ffmpeg.gz` | 67.302.445 | `f019aabcb3940d3ddf61554cc96086eb95f98a1978877196b9e6320b52a2a790` |
| `ffprobe.gz` | `ffmpeg-n9.0.1-30-g9258bacca5/ffprobe.gz` | 67.191.515 | `a3cb017c28ce55d622e3328fc4003acf7daa1b05ca63ca7b826f97807f3333a9` |
| archivio BtbN originale (provenienza) | `ffmpeg-n9.0.1-30-g9258bacca5/ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0.tar.xz` | 150.157.000 | `adb2d107287cdace0c5d00dd986cd3674c1e86776501640bff3b5cf7d2cf2e71` |

I due binari, una volta decompressi (`gzip -dc`):

| Binario | SHA-256 |
|---|---|
| `ffmpeg` | `341447cfff51ff528cf530eb111542306cffc1f1f6a51726e6327b655d6860be` |
| `ffprobe` | `09c3b0595ea6dd648e0cf1b462d97303792b31cb81c0359b65d072c0d7254063` |

Versione: `ffmpeg version n9.0.1-30-g9258bacca5-20260915`. Inventario (`mancanzeDellaBuild`): **vuoto** — 8 filtri, 7 decoder e 5 encoder richiesti, tutti presenti; la build ne espone 562, 554 e 227.

Le cinque impronte stanno in tre posti — `src/lib/media/video/build.ts` (tutte e cinque), questo file (tutte e cinque) e `.github/workflows/ci.yml` (le quattro che la CI verifica, perché l'archivio non lo scarica più nessuno) — e il lock `__tests__/architecture/fixture-video-reali.test.ts` fallisce se divergono.

⚠️ **I `.gz` canonici sono quelli prodotti in CI.** Sono stati ottenuti con `gzip -9 -n` su Linux, e rigenerarli su macOS cambierebbe lo SHA: un `gzip` diverso da quello di CI può produrre byte diversi dallo stesso binario. I `.gz` non si rigenerano a mano: si carica nel bucket ciò che è stato verificato. Le impronte dei **binari**, invece, sono quelle che contano davvero e non dipendono dal `gzip`.

### Come è stata ricavata

L'unica copia dell'archivio già collaudato era rimasta nella cache di GitHub Actions di `main` (chiave `ffmpeg-btbn-…`), che GitHub elimina dopo 7 giorni senza accessi. Il 02/10/2026 un workflow usa e getta l'ha ripristinata dalla stessa chiave e dallo stesso path (nessun download da Internet), ne ha verificato lo SHA-256, ha estratto `bin/ffmpeg` e `bin/ffprobe`, li ha impacchettati con `gzip -9 -n` e ha consegnato tutto in un artefatto da un giorno; poi il workflow è stato tolto dal repository e l'artefatto cancellato. I file sono stati **verificati in locale con strumenti diversi da quelli del workflow** — le cinque impronte della tabella sono quelle misurate lì.

### Chi li usa, e come li verifica

- **Il runner** (`src/lib/media/video/runner/preparazione.ts`): a ogni MicroVM nuova firma due URL di sola lettura (15 minuti) sul bucket e li passa **solo** nell'ambiente del comando di preparazione (`KV_URL_FFMPEG`, `KV_URL_FFPROBE`). Lo script scarica i due `.gz`, ne verifica le impronte, li decomprime, verifica le impronte dei binari e solo allora li rende eseguibili: un binario che non ha superato entrambe le verifiche non è mai eseguibile. Non contiene nessun indirizzo, né `dnf`, `sudo`, `xz`, `tar`.
- **La CI** (`.github/workflows/ci.yml`): cache `~/.cache/kidville-ffmpeg-bin` con chiave `ffmpeg-bin-<sha ffmpeg>-<sha ffprobe>`; a cache vuota, due URL firmati a 365 giorni nei segreti `CI_FFMPEG_GZ_URL` e `CI_FFPROBE_GZ_URL`. Le quattro impronte si verificano comunque, anche con la cache calda. La data di scadenza degli URL e il comando per rinnovarli stanno nel commento del workflow.
- **Costo**: ogni MicroVM nuova scarica ≈134 MB (i due `.gz`) dallo Storage.

La misura dei ~12 secondi di preparazione dell'«Ambiente misurato» riguarda il percorso vecchio (download da GitHub, estrazione `tar -xJ`): quella del percorso nuovo (due `.gz` dallo Storage, `gzip -dc`) si prende nel Sandbox vero prima del merge.

### Come si carica e come si firma (`scripts/ffmpeg-nel-bucket.mjs`)

Lo script legge da **stdin** il JSON delle chiavi del progetto e sceglie la chiave di servizio; non stampa mai né chiavi né URL.

```sh
# carica i tre file (ffmpeg.gz, ffprobe.gz, archivio-btbn.tar.xz) e li rilegge dal bucket
supabase projects api-keys --project-ref uimulkjyekgemjakmepp -o json \
  | node scripts/ffmpeg-nel-bucket.mjs --carica --cartella <cartella>

# un URL firmato a 365 giorni per la CI: esce SOLO se stdout non è un terminale
supabase projects api-keys --project-ref uimulkjyekgemjakmepp -o json \
  | node scripts/ffmpeg-nel-bucket.mjs --firma-ci ffmpeg | gh secret set CI_FFMPEG_GZ_URL
```

`--carica` **rifiuta** di caricare se gli SHA locali non sono quelli di `build.ts`, carica con `upsert: false` (un oggetto già presente non si sovrascrive) e poi rilegge ogni oggetto con un URL firmato, ricalcolandone l'impronta da capo a fondo.

### Per cambiare build

1. Scegliere una release BtbN **datata** (mai `latest`), scaricare l'archivio e verificarne lo SHA-256 pubblicato.
2. Su **Linux**, estrarre `bin/ffmpeg` e `bin/ffprobe`, calcolarne lo SHA-256, produrre i `.gz` con `gzip -9 -n -c` e calcolarne lo SHA-256. Non su macOS (vedi l'avviso sopra).
3. Verificare l'inventario: `mancanzeDellaBuild` vuoto, `zscale` presente.
4. In un solo commit: le costanti di `src/lib/media/video/build.ts` (anche `CARTELLA_BUILD_NEL_BUCKET`, così la build nuova non sovrascrive la vecchia), le quattro impronte e la chiave di cache di `.github/workflows/ci.yml`, le cinque impronte e la tabella di questo file. Il lock `fixture-video-reali` dice se un posto è rimasto indietro.
5. Caricare i file nel bucket **prima** del merge: il codice nuovo li cerca subito. Poi rinnovare i due segreti della CI e la data di scadenza nel commento del workflow.
6. Provarla in un Sandbox vero (MicroVM `node22`, script generato da `scriptPreparazioneBuild()`): uscita 0 e `mancanzeDellaBuild = []`.
