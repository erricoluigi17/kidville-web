/**
 * LA BUILD DI FFMPEG CHE CONVERTE I VIDEO — numeri e stringhe, senza nessun import.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE QUESTO FILE, e perché non basta scrivere «ffmpeg» da qualche parte.
 *
 * La conversione gira dentro un Vercel Sandbox, su UNA build precisa di FFmpeg.
 * Se il collaudo in CI usa una build DIVERSA da quella del Sandbox, un test verde non
 * dice niente sul comportamento in produzione: dice che *una* certa FFmpeg fa *una*
 * certa cosa. Non è un'ipotesi — è la misura del 2026-09-17, e sta scritta qui perché
 * è il motivo per cui questo file esiste:
 *
 *   · `/opt/homebrew/bin/ffmpeg` 8.1.2, la build che un Mac ha addosso dopo
 *     `brew install ffmpeg`, NON ha il filtro `zscale`: Homebrew non compila libzimg.
 *   · `zscale` è il primo filtro di `hdrToSdrFilters()` (`./encode.ts`). Senza,
 *     OGNI video HDR fallisce con «No such filter», e i casi di collaudo sull'HDR non
 *     stanno misurando la nostra conversione: stanno misurando il pacchettizzatore.
 *
 * Perciò la build è **pinnata alla release datata**, non al tag mobile `latest`, e si
 * verifica con lo SHA-256 prima di essere eseguita.
 *
 * ─── DAL 2026-10-02 NON SI SCARICA PIÙ DA INTERNET ──────────────────────────────
 *
 * Fino al 29/09/2026 il runner prendeva l'archivio dalla release BtbN a OGNI MicroVM
 * nuova (dopo aver installato `xz` dai mirror di Amazon). Quel giorno BtbN ha
 * cancellato la release datata — conserva le build giornaliere 14 giorni — e da
 * allora ogni conversione è fallita con `BUILD_DOWNLOAD_FAILED`: 17 job su 17. Due
 * download esterni a runtime erano due punti di rottura fuori dal nostro controllo, e
 * uno è scattato.
 *
 * La catena adesso è questa, e ogni anello ha la sua impronta:
 *
 *     archivio BtbN (`adb2…`)  →  i due binari estratti  →  due `.gz` nel nostro bucket privato
 *
 *   · l'ARCHIVIO è la provenienza. Sta nel bucket accanto ai binari e nelle costanti
 *     qui sotto, ma nessun codice lo scarica più: né il runner, né la CI.
 *   · i BINARI sono `ffmpeg` e `ffprobe`, estratti da `<radice>/bin/` dell'archivio.
 *   · i `.gz` (`gzip -9 -n`) sono ciò che si scarica davvero, dal bucket `video_build`
 *     con URL firmati di sola lettura. Il runner verifica DUE impronte per ciascun
 *     binario: quella del `.gz` prima di decomprimerlo, quella del binario dopo.
 *
 * Le cinque impronte — archivio, due `.gz`, due binari — stanno in tre posti: qui, in
 * `.github/workflows/ci.yml` (le quattro che la CI verifica) e nella spec. Il lock
 * `__tests__/architecture/fixture-video-reali.test.ts` fallisce se divergono.
 *
 * ─── DAL 2026-10-02 (PR 2) I BINARI STANNO ANCHE NELLO SNAPSHOT DEL SANDBOX ─────────
 *
 * La catena sopra resta com'è, e resta il ripiego: la provvista dal bucket a ogni MicroVM
 * nuova (`runner/preparazione.ts`). Ma pagare ~134 MB di download a ogni conversione è un
 * costo che si può fare UNA volta: `scripts/video-sandbox-ambiente.mjs` costruisce uno
 * snapshot (immagine `node:24`, con `curl`) che i due binari li ha GIÀ, in
 * `CARTELLA_BINARI_NELLO_SNAPSHOT`, e il runner lo usa se `VIDEO_SANDBOX_SNAPSHOT_ID` lo
 * nomina (`runner/ambiente.ts`).
 *
 * ⚠️ Lo snapshot NON introduce nessuna impronta nuova e nessuna fiducia nuova: a ogni
 * avvio il runner rifà `sha256sum` dei due BINARI con le due costanti `FFMPEG_SHA256` e
 * `FFPROBE_SHA256` qui sotto, le stesse della provvista. Se non tornano, o i file
 * mancano, si ripiega nella stessa MicroVM scaricando dal bucket — e si grida.
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Provenienza e misura: `docs/superpowers/specs/2026-09-16-video-build-verificata.md`
 * (sezione «Dal 2026-10-02: la build vive nel nostro Storage»).
 */

/* ────────────────────────────────────────────────────────────────────────────
 * LA PROVENIENZA — nessun codice scarica più da qui
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * FFmpeg n9.0.1-30-g9258bacca5, Linux x86_64 GPL, pacchetto BtbN del 2026-09-15.
 *
 * PROVENIENZA, non una fonte: dal 2026-10-02 nessuno scarica da questo indirizzo. È
 * qui per dire da dove sono venuti i binari, e perché il lock sui provider esterni
 * lo conosce come host «non chiamato».
 */
export const ARCHIVIO_FFMPEG_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-15-13-18/ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0.tar.xz'

/**
 * SHA-256 pubblicato da BtbN, verificato sul download locale e dentro il Sandbox, e
 * rimisurato il 2026-10-02 sull'archivio recuperato dalla cache della CI (150.157.000
 * byte). È l'impronta del primo anello della catena: da qui sono stati estratti i
 * due binari.
 */
export const ARCHIVIO_FFMPEG_SHA256 =
  'adb2d107287cdace0c5d00dd986cd3674c1e86776501640bff3b5cf7d2cf2e71'

/** La cartella radice dentro il tarball: i binari stanno sotto `<radice>/bin/`. */
export const RADICE_ARCHIVIO_FFMPEG = 'ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0'

/** Dove stanno i due binari dentro l'archivio originale: il percorso con cui sono stati estratti. */
export const FFMPEG_NELL_ARCHIVIO = `${RADICE_ARCHIVIO_FFMPEG}/bin/ffmpeg`
export const FFPROBE_NELL_ARCHIVIO = `${RADICE_ARCHIVIO_FFMPEG}/bin/ffprobe`

/* ────────────────────────────────────────────────────────────────────────────
 * LA BUILD NEL NOSTRO STORAGE — ciò che il runner e la CI scaricano davvero
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Il bucket privato che custodisce la build. Nessuna policy su `storage.objects`: lo
 * legge solo la chiave di servizio, e chiunque altro passa da un URL firmato. Non c'è
 * nessun dato personale: due binari pubblici (GPL) e l'archivio da cui vengono.
 */
export const BUCKET_BUILD_VIDEO = 'video_build'

/** La cartella dentro il bucket: porta il nome della versione, così una build nuova non ne sovrascrive una vecchia. */
export const CARTELLA_BUILD_NEL_BUCKET = 'ffmpeg-n9.0.1-30-g9258bacca5'

export const PERCORSO_FFMPEG_GZ = `${CARTELLA_BUILD_NEL_BUCKET}/ffmpeg.gz`
export const PERCORSO_FFPROBE_GZ = `${CARTELLA_BUILD_NEL_BUCKET}/ffprobe.gz`
/** L'archivio originale, conservato nel bucket come provenienza: il runner non lo legge. */
export const PERCORSO_ARCHIVIO_ORIGINALE = `${CARTELLA_BUILD_NEL_BUCKET}/ffmpeg-n9.0.1-30-g9258bacca5-linux64-gpl-9.0.tar.xz`

/**
 * Le impronte dei due `.gz`, prodotti in CI con `gzip -9 -n`. Si verificano PRIMA di
 * decomprimere: un file che arriva da una rete è codice che sta per girare con i
 * nostri file dentro.
 *
 * ⚠️ Sono i `.gz` prodotti in CI quelli canonici. Rigenerarli su macOS cambierebbe lo
 * SHA: un `gzip` diverso da quello di CI può produrre byte diversi dallo stesso
 * binario. Perciò i `.gz` non si rigenerano a mano — si carica nel bucket ciò che è
 * stato verificato, e a restare invariate sono le impronte dei BINARI.
 */
export const FFMPEG_GZ_SHA256 = 'f019aabcb3940d3ddf61554cc96086eb95f98a1978877196b9e6320b52a2a790'
export const FFPROBE_GZ_SHA256 = 'a3cb017c28ce55d622e3328fc4003acf7daa1b05ca63ca7b826f97807f3333a9'

/**
 * Le impronte dei due binari decompressi. Si verificano DOPO `gzip -dc`: provano che
 * ciò che è uscito dal `.gz` è il binario che è stato collaudato, e solo allora il
 * file diventa eseguibile.
 */
export const FFMPEG_SHA256 = '341447cfff51ff528cf530eb111542306cffc1f1f6a51726e6327b655d6860be'
export const FFPROBE_SHA256 = '09c3b0595ea6dd648e0cf1b462d97303792b31cb81c0359b65d072c0d7254063'

/**
 * Dove stanno `ffmpeg` e `ffprobe` dentro lo SNAPSHOT del Sandbox (PR 2, spec §10.1).
 *
 * Sotto `/opt` e non sotto `/tmp`, dove stanno quando li porta la provvista dal bucket
 * (`CARTELLA_BUILD`, in `runner/preparazione.ts`): `/tmp` è il posto che un riavvio può
 * svuotare, `/opt` è quello fatto per il software installato. La cartella la crea e la
 * affida all'utente del Sandbox `scripts/video-sandbox-ambiente.mjs`, con `sudo`, una volta
 * sola alla costruzione dello snapshot: a runtime nessun comando ha bisogno di privilegi.
 */
export const CARTELLA_BINARI_NELLO_SNAPSHOT = '/opt/kv-ffmpeg'

/**
 * I FILTRI CHE IL FILTERGRAPH DI PRODUZIONE NOMINA, uno per uno.
 *
 * Non è un elenco di buone intenzioni: è ciò che `buildVideoEncodeArgs` scrive nella
 * riga di comando. Una build che ne perde uno non fallisce all'installazione — fallisce
 * al primo video che imbocca quel ramo, cioè in produzione e su un file di un genitore.
 * Chi risolve un binario (il collaudo oggi, il runner domani) verifica questa lista e si
 * rifiuta di partire se manca qualcosa, invece di scoprirlo per via di uno stderr.
 *
 * NON SI TIENE ALLINEATO A MANO. Il lock `__tests__/architecture/fixture-video-reali.test.ts`
 * ricava i nomi dal filtergraph vero, su tutti i suoi rami, e cade se qui ne manca uno:
 * è così che il 2026-09-17, aggiungendo `sidedata`, è venuto fuori che l'elenco aveva già
 * perso `setsar` — nominato dal ramo Galleria da sempre, e mai dichiarato.
 */
export const FILTRI_RICHIESTI = [
  'zscale', // HDR→SDR e conversione SDR completa: senza libzimg non esiste
  'tonemap', // compressione della gamma dinamica, `tonemap=hable`
  'scale', // Full HD senza upscale, con `reset_sar`
  'overlay', // watermark della Galleria
  'setsar', // pixel quadrati sul watermark prima dell'overlay
  'fps', // riduzione a 60 fps sopra soglia
  'format', // `gbrpf32le` in mezzo alla catena, `yuv420p` alla fine
  'sidedata', // cancella i SEI di mastering display e content light level
] as const

/** I decoder degli originali che `./limiti.ts` promette di saper leggere. */
export const DECODER_RICHIESTI = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'prores', 'dnxhd'] as const

/** Gli encoder dell'uscita, più quelli che servono a fabbricare le fixture di collaudo. */
export const ENCODER_RICHIESTI = ['libx264', 'aac', 'libx265', 'prores_ks', 'dnxhd'] as const
