'use client'

import { isNativeApp } from '@/lib/push/native-register'
import { logClient, nomeErrore } from '@/lib/logging/client'

// Fotocamera NATIVA (Capacitor Camera) per gli upload immagine, con degradazione
// pulita sul web:
//  - Web/SSR → `scegliFotoNativa` ritorna [] e il chiamante ricade sull'<input
//    type=file> di sempre (nessuna differenza per l'utente web).
//  - Nativo  → `Camera.getPhoto({ source: 'PROMPT' })` chiede all'utente se
//    scattare una foto o sceglierne una dalla libreria, poi converte il dataUrl
//    in un `File` uguale a quello che darebbe `e.target.files[0]`.
// L'annullamento da parte dell'utente è UX ATTESA, non un errore: nessun log
// (stesso principio di `@/lib/native/share`). Un permesso negato invece NO —
// vedi `diagnosi`, che distingue i due leggendo prima il CODICE del plugin (che
// non si traduce) e solo poi il testo del messaggio (che su un telefono italiano
// è italiano).
//
// Questo modulo è una LIB, non un componente: non può usare `useTranslations`.
// Le etichette del foglio nativo arrivano come PARAMETRO dai chiamanti
// (`ScattaFotoButton` e l'hook `useImagePicker`, che il contesto i18n ce l'hanno).
// Se non arrivano non si passa alcun `promptLabel*` e restano i default del
// plugin: la lib resta pura e i chiamanti storici non si rompono.

/** Etichette del foglio di scelta nativo (`promptLabelCancel` è solo iOS). */
export interface EtichettePicker {
  intestazione: string
  scatta: string
  libreria: string
  annulla: string
}

export interface OpzioniScatto {
  /** Coerenza con `multiple` dell'input: la fotocamera resta comunque 1 scatto. */
  multiplo?: boolean
  etichette?: EtichettePicker
  /** Chiamato quando NON è un annullamento dell'utente ma un problema vero. */
  onErrore?: (codice: 'permesso_negato' | 'errore') => void
}

/**
 * Lato lungo massimo dello scatto, in pixel.
 *
 * Senza questo limite il plugin restituiva la foto a piena risoluzione: 4-6 MB
 * per un sensore da 12 MP, cioè oltre il limite di body della funzione
 * serverless — l'upload falliva e nel fascicolo lo spinner restava appeso per
 * sempre, senza messaggio. 1600 px su un A4 sono circa 190 dpi: un PEI, un
 * certificato o uno scontrino restano perfettamente leggibili e il JPEG sta su
 * 250-500 KB. Se un documento risultasse illeggibile, il passo successivo è
 * 2048 (≈1 MB), che è ancora sotto i limiti.
 */
const LATO_MAX = 1600

/** true se l'app gira nella shell nativa Capacitor (delega a isNativeApp). */
export function fotocameraNativaDisponibile(): boolean {
  return isNativeApp()
}

/* ════════════════════════════════════════════════════════════════════════════
 * IL PERCHÉ DI UN `fotocamera-errore` — la lista bianca, e perché è una lista
 * bianca e non il passaggio del messaggio.
 *
 * ─── IL FATTO, MISURATO IN `app_log` ────────────────────────────────────────
 *
 * `fotocamera-errore`: 124 righe, 412 occorrenze, 32 utenti, dal 01/09 all'11/09.
 * **118 righe / 390 occorrenze su iOS**, e **sei righe / 22 occorrenze** marcate
 * `web`, del 01-02/09, prima che `piattaforma()` smettesse di indovinare. ZERO su
 * Android — dove nello stesso periodo 204 utenti hanno scritto 18.071 occorrenze
 * di eventi client. E `contesto` è `{}` su tutte e 124: sapevamo CHE la fotocamera
 * non si apriva, centinaia di volte, e non sapevamo PERCHÉ. È la regola 3 di
 * AGENTS.md violata dal lato opposto: non uno status senza corpo, un evento senza
 * nulla.
 *
 * ⚠️ E NON SONO TUTTE SULLA GALLERIA, che è il dato che cambia la diagnosi:
 * `/teacher/gallery` 83 righe, `/teacher/chat` 33, `/parent/chat` 8. **14 dei 32
 * utenti iOS hanno fallito su ENTRAMBE** le aree, e OTTO solo in chat — dove la
 * fotocamera si apre da un bottone di 40 px, non dal riquadro di trascinamento
 * alto 8 rem di `MediaUploader`. Il guasto segue il DISPOSITIVO, non l'area di
 * tocco: l'area di tocco moltiplica i tentativi (fino a 22 occorrenze in un giorno
 * per un solo utente sulla galleria, contro 5 come massimo in chat), non li causa.
 *
 * Il corollario che vale quanto la misura: `fotocamera-permesso-negato` ha
 * **zero** righe da sempre, mentre `push-nativa-permesso-negato` ne ha 265 — in
 * tre varianti, perché quel messaggio porta lo stato in coda, per 747 occorrenze.
 * Nessuno nega il permesso alla fotocamera perché il permesso non viene mai
 * chiesto: il plugin rifiuta PRIMA.
 *
 * ─── E SI SA DOVE: `checkUsageDescriptions()`, LETTO NEL PLUGIN ──────────────
 *
 * `CameraPropertyListKeys` (`CameraTypes.swift`) è `CaseIterable` e ha TRE casi;
 * `getPhoto` (`CameraPlugin.swift`) chiama `checkUsageDescriptions()` come PRIMA
 * istruzione e rigetta se una sola manca. `ios/App/App/Info.plist` dichiara
 * `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`,
 * `NSMicrophoneUsageDescription` e `NSFaceIDUsageDescription` — e NON
 * `NSPhotoLibraryAddUsageDescription`, che in tutto `ios/` non compare (grep, non
 * dedotto). È il PRIMO caso dell'enum, quindi è il messaggio che esce sempre.
 * Android non ha un Info.plist: ecco perché su Android quelle righe sono zero.
 *
 * ⚠️ QUEL RIGETTO NON PORTA UN CODICE: `call.reject(missingUsageDescription)`
 * passa il solo messaggio. Per il caso che vale la maggior parte delle 412
 * occorrenze l'unico appiglio è dunque il TESTO — ed è un appiglio solido, perché
 * `missingMessage` è una stringa letterale INGLESE compilata nel plugin, non un
 * `localizedDescription`. È il motivo per cui qui sotto i meccanismi sono DUE e
 * non uno: il testo copre ciò che rigetta senza codice, il codice copre ciò che
 * rigetta in una lingua che non conosciamo.
 *
 * ─── PERCHÉ IL MESSAGGIO DEL PLUGIN NON PUÒ USCIRE DAL DISPOSITIVO ──────────
 *
 * `logClient` persiste in `app_log` per 30 giorni, interrogabile in SQL. Il
 * `.message` di un errore del plugin porta percorsi del filesystem e nomi di file
 * («/var/mobile/Media/DCIM/…/IMG_0042.HEIC»), e in questo repo il nome di un file
 * di foto è un dato personale: contiene spessissimo il nome del bambino. Su iOS
 * c'è di peggio — a riga 65 di `CameraPlugin.swift` il plugin rigetta con
 * `error.localizedDescription`, cioè un testo di sistema LOCALIZZATO: prosa, in
 * italiano, scritta da un componente che non controlliamo.
 *
 * ─── LA FORMA CHE RISPONDE ALLA DOMANDA SENZA APRIRE IL CANALE ──────────────
 *
 * Si confronta il testo con un elenco CHIUSO di pattern noti del plugin e si
 * restituisce uno SLUG preso da `CODICI_FOTOCAMERA`. Il tipo di ritorno è
 * l'unione di quelle costanti: **nessuna stringa che venga dal messaggio può
 * essere il valore di ritorno**, non per disciplina di chi scrive ma per
 * costruzione — quello che non è in elenco esce `'ignoto'`, che è una risposta
 * («è un caso che non conosciamo») e non un travaso.
 *
 * Chi aggiunge un pattern aggiunge PRIMA lo slug qui sotto: è il punto in cui la
 * garanzia si tiene o si perde.
 * ════════════════════════════════════════════════════════════════════════════ */
export const CODICI_FOTOCAMERA = [
  /* Info.plist incompleto: il plugin rifiuta in testa a `getPhoto`, prima di
     qualunque foglio e di qualunque permesso. Le tre chiavi sono tre slug
     distinti perché il nome della chiave mancante È la riparazione. */
  'plist_photo_library_add',
  'plist_photo_library',
  'plist_camera',
  'plist_incompleto',
  /* Permessi negati per davvero (questi sì, dopo che il foglio è comparso). */
  'permission_denied_camera',
  'permission_denied_photos',
  /* L'utente ha chiuso il foglio. Quattro codici del plugin dicono questo, e
     quando c'è un codice è LUI a decidere che non si logga: vedi il `catch`. */
  'user_cancelled',
  /* Hardware e attività di sistema che non si risolvono. */
  'no_camera_available',
  'no_gallery_available',
  'simulator_no_camera',
  /* La scelta dalla libreria è fallita PRIMA dell'elaborazione (0018): la
     riparazione guarda la galleria, non il ridimensionamento. Era mappato su
     `unable_to_process_image`, cioè una fase più in là. */
  'choose_media_failed',
  /* Il plugin ha avuto l'immagine e non è riuscito a consegnarla. */
  'unable_to_process_image',
  'unable_to_convert_to_jpeg',
  'unable_to_edit_image',
  'invalid_image_data',
  'image_not_found',
  /* Il file scelto NON C'È (0027 `FileNotFound`): diagnosi opposta a «non si
     riesce a scrivere», e chi legge la riga in SQL andrebbe a cercare permessi o
     disco pieno per un file che semplicemente non esiste. */
  'file_not_found',
  /* Il file c'è ma non si riesce a METTERLO dove serve: `0021 MediaPathError`
     («impossibile ottenere il percorso») e «unable to create photo on disk». È il
     confine che `file_not_found` ha aperto: il file assente contro il file che non
     si riesce a scrivere. Chi legge la riga in SQL guarda storage e permessi. */
  'file_not_writable',
  'save_to_gallery_failed',
  'memory',
  'security_exception',
  'invalid_argument',
  /* Codici del ramo video/riproduzione: `getPhoto` non li produce, e se uno
     comparisse sarebbe una notizia — meglio nominato che confuso con altro. */
  'video_record_failed',
  'video_not_found',
  'video_play_failed',
  'general_error',
  /* Non è il plugin: è il ponte o il nostro bundle. */
  'plugin_not_implemented',
  'module_load_failed',
  /* Il default. Non è un fallimento della lista: è la sua unica uscita onesta. */
  'ignoto',
] as const

export type CodiceFotocamera = (typeof CODICI_FOTOCAMERA)[number]

/**
 * I pattern noti, IN ORDINE: il primo che corrisponde vince.
 *
 * L'ordine non è estetico, e il pericolo vero è UNO SOLO, misurato spostando i
 * pattern uno per uno: `/info\.plist/i` — la rete per una quarta chiave che il
 * plugin richiedesse domani — corrisponde a «in your Info.plist file», cioè a
 * TUTTI e tre i messaggi delle chiavi mancanti. Sopra di loro ruberebbe le tre
 * risposte che nominano la riparazione e le appiattirebbe su `plist_incompleto`,
 * che non dice quale chiave aggiungere. Perciò le tre chiavi stanno per prime e la
 * rete generica subito dopo.
 *
 * ⚠️ Non è vero, invece, che il rischio venga da un pattern sull'assenza della
 * fotocamera: la frase «Camera will not function without it» del messaggio del
 * plist non corrisponde a `/have a camera available|no camera available|resolve
 * camera activity/i` in nessun caso — verificato spostando quel pattern in testa,
 * con tutti i test che restano verdi. Chi legge questa testata deve guardare
 * `/info\.plist/i`, non la fotocamera assente.
 *
 * I testi vengono dai sorgenti del plugin alla versione installata (8.2.2):
 * `node_modules/@capacitor/camera/ios/Sources/CameraPlugin/CameraPlugin.swift`
 * e `.../android/src/main/java/com/capacitorjs/plugins/camera/CameraPlugin.java`.
 * Non sono indovinati, e non sono un contratto: per questo esiste `'ignoto'`.
 */
const PATTERN_CODICE: readonly (readonly [RegExp, CodiceFotocamera])[] = [
  [/missing\s+nsphotolibraryaddusagedescription/i, 'plist_photo_library_add'],
  [/missing\s+nsphotolibraryusagedescription/i, 'plist_photo_library'],
  [/missing\s+nscamerausagedescription/i, 'plist_camera'],
  [/info\.plist/i, 'plist_incompleto'],
  [/denied access to camera|camera permission/i, 'permission_denied_camera'],
  [/denied access to photos|gallery permission|photo library permission/i, 'permission_denied_photos'],
  [/user cancelled photos app|no image picked/i, 'user_cancelled'],
  [/running in simulator/i, 'simulator_no_camera'],
  [/have a camera available|no camera available|resolve camera activity/i, 'no_camera_available'],
  [/resolve photo activity/i, 'no_gallery_available'],
  [/convert image to jpeg/i, 'unable_to_convert_to_jpeg'],
  [/processing image|process bitmap|process image/i, 'unable_to_process_image'],
  [/edit image/i, 'unable_to_edit_image'],
  [/invalid image data/i, 'invalid_image_data'],
  [/loading image|no such image found|image not found/i, 'image_not_found'],
  [/portable path|photo on disk|not found on disk/i, 'file_not_writable'],
  [/save the image in the gallery/i, 'save_to_gallery_failed'],
  [/out of memory/i, 'memory'],
  [/securityexception/i, 'security_exception'],
  [/invalid resulttype|invalid argument/i, 'invalid_argument'],
  [/not implemented/i, 'plugin_not_implemented'],
  // Il `dynamic import` di `@capacitor/camera` che non arriva: non è il plugin
  // che ha detto di no, è il chunk che non è stato scaricato (WebView offline,
  // build vecchia in cache). Sintomo identico per l'utente, riparazione opposta.
  [/dynamically imported module|loading chunk|importing a module script failed/i, 'module_load_failed'],
]

/**
 * I codici del plugin, e perché contano PIÙ dei pattern sul testo.
 *
 * Dalla v8 il plugin rigetta anche con un codice (`OS-PLUG-CAMR-0007`) accanto al
 * messaggio, e a riga 65 di `CameraPlugin.swift` quel messaggio è
 * `error.localizedDescription` — cioè, su un iPhone italiano, prosa italiana su
 * cui nessun pattern inglese corrisponderà mai. Il codice invece non si traduce:
 * è la metà della diagnosi che sopravvive alla lingua del dispositivo.
 *
 * È una MAPPA CHIUSA, non un passaggio per forma: un `OS-PLUG-CAMR-9999` non
 * diventa lo slug `os_plug_camr_9999`, cade in `'ignoto'` come tutto il resto.
 * Presa da `@capacitor/camera/dist/esm/definitions.d.ts` (enum `CameraErrorCode`).
 */
const CODICI_PLUGIN: Readonly<Record<string, CodiceFotocamera>> = {
  'OS-PLUG-CAMR-0003': 'permission_denied_camera',
  'OS-PLUG-CAMR-0005': 'permission_denied_photos',
  'OS-PLUG-CAMR-0006': 'user_cancelled',
  'OS-PLUG-CAMR-0007': 'no_camera_available',
  'OS-PLUG-CAMR-0008': 'invalid_image_data',
  'OS-PLUG-CAMR-0009': 'unable_to_edit_image',
  'OS-PLUG-CAMR-0010': 'unable_to_process_image',
  'OS-PLUG-CAMR-0011': 'image_not_found',
  'OS-PLUG-CAMR-0012': 'unable_to_process_image',
  'OS-PLUG-CAMR-0013': 'user_cancelled',
  'OS-PLUG-CAMR-0014': 'invalid_argument',
  'OS-PLUG-CAMR-0016': 'video_record_failed',
  'OS-PLUG-CAMR-0017': 'user_cancelled',
  'OS-PLUG-CAMR-0018': 'choose_media_failed',
  'OS-PLUG-CAMR-0019': 'unable_to_convert_to_jpeg',
  'OS-PLUG-CAMR-0020': 'user_cancelled',
  'OS-PLUG-CAMR-0021': 'file_not_writable',
  'OS-PLUG-CAMR-0023': 'video_play_failed',
  'OS-PLUG-CAMR-0024': 'unable_to_edit_image',
  'OS-PLUG-CAMR-0025': 'video_not_found',
  'OS-PLUG-CAMR-0026': 'general_error',
  'OS-PLUG-CAMR-0027': 'file_not_found',
  'OS-PLUG-CAMR-0028': 'image_not_found',
  'OS-PLUG-CAMR-0031': 'invalid_argument',
}

/**
 * Il testo dell'errore, letto UNA volta sola per tutto il modulo.
 *
 * Non esce da qui: lo consumano `classifica` e `codiceFotocamera`, che
 * restituiscono entrambe un enumerato.
 *
 * ⚠️ IL NOME È QUESTO PERCHÉ È QUELLO CHE IL LOCK CONOSCE. La lista `TESTO_ERRORE`
 * di `__tests__/architecture/messaggio-errore-nei-log.test.ts` (riga 80) riconosce
 * gli helper del testo d'errore PER NOME — `testoErrore`, `messaggioErrore`,
 * `msgErrore`, `errorMessage`, `descriviErrore` — e scatta se uno di essi compare
 * negli argomenti di una chiamata al logger. Al primo giro questa funzione si
 * chiamava `testoGrezzo` «per rendere più difficile sbagliarsi»: misurato, era
 * l'opposto. Con `testoGrezzo` un `campi: { stato: `x-${testoGrezzo(err)}` }`
 * passava il lock in SILENZIO; con `testoErrore` lo stesso travaso lo fa scattare
 * e stampa file e riga. Nel file la cui ragione d'essere è non far uscire il
 * messaggio del plugin, la guardia va tenuta ARMATA, non nascosta.
 */
function testoErrore(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '')
}

/**
 * Distingue l'annullamento dell'utente da un problema vero.
 *
 * È un'EURISTICA sui messaggi del plugin, non un contratto: il default sicuro è
 * `errore`, così un caso non previsto viene segnalato invece che inghiottito.
 * Serve perché prima un unico `catch {}` rendeva «ho cambiato idea» e «l'app non
 * ha il permesso» indistinguibili, e il sintomo per l'utente era identico —
 * «premo e non succede niente».
 *
 * ⚠️ RESTA PIÙ LARGA di `codiceFotocamera` di proposito, e le due non vanno
 * unificate nella direzione sbagliata: qui un falso positivo su «annullato»
 * costa un log in meno, un falso negativo costa una riga in `app_log` per ogni
 * volta che un utente cambia idea. Nel dubbio questa tace; quella nomina.
 *
 * ⚠️ MA NON È PIÙ L'ULTIMA PAROLA, e il perché è tutto nella lingua: legge il
 * MESSAGGIO, e su un iPhone italiano il messaggio è italiano
 * (`CameraPlugin.swift:65` rigetta con `error.localizedDescription`). Un
 * annullamento su un telefono non inglese non corrisponde a nessuno di questi
 * pattern e finiva in `app_log` a livello `error` come `fotocamera-errore`, col
 * campo accanto che diceva `user_cancelled`: il codice SAPEVA che era un
 * annullamento e lo registrava come guasto. Dal 2026-09-12 decide prima la lista
 * bianca (`CAUSA_DA_SLUG`) e questa funzione è il RIPIEGO per ciò che la lista
 * bianca non riconosce — cioè `'ignoto'`. Vedi il `catch` di `scegliFotoNativa`.
 */
function classifica(err: unknown): 'annullato' | 'permesso_negato' | 'errore' {
  const m = testoErrore(err)
  if (/cancel|canceled|cancelled|no image picked/i.test(m)) return 'annullato'
  if (/denied|permission|not authorized/i.test(m)) return 'permesso_negato'
  return 'errore'
}

/**
 * LO SLUG DEL DIFETTO NOTO — l'unica cosa che un errore del plugin può lasciare
 * sul dispositivo oltre al proprio `.name`.
 *
 * Prima il codice (non si traduce), poi i pattern sul testo, poi `'ignoto'`.
 * Non lancia: la chiama un `catch`.
 */
export function codiceFotocamera(err: unknown): CodiceFotocamera {
  const codice = (err as { code?: unknown } | null | undefined)?.code
  if (typeof codice === 'string') {
    const noto = CODICI_PLUGIN[codice]
    if (noto !== undefined) return noto
  }
  const m = testoErrore(err)
  for (const [rx, slug] of PATTERN_CODICE) {
    if (rx.test(m)) return slug
  }
  return 'ignoto'
}

/**
 * QUANDO LA LISTA BIANCA HA GIÀ RISPOSTO, DECIDE LEI — non il pattern sul testo.
 *
 * I tre slug che cambiano il DESTINO di una riga, non solo la sua etichetta: un
 * annullamento non si logga affatto, un permesso negato si logga sotto
 * `fotocamera-permesso-negato`. Sono gli stessi tre stati di `OpzioniScatto.onErrore`
 * più il silenzio.
 *
 * Perché questa mappa e non un `if` sul testo: quattro codici del plugin sono
 * annullamenti dell'utente (0006 `TakePhotoCancelled`, 0013 `EditPhotoCancelled`,
 * 0017 `RecordVideoCancelled`, 0020 `ChooseMediaCancelled`) e due sono permessi
 * negati (0003, 0005). Un codice non si traduce; la prosa che lo accompagna sì. Con
 * la sola euristica sul testo, su un telefono italiano quei sei casi diventavano
 * tutti `fotocamera-errore` a livello `error` — e la memoria di questo progetto ha
 * già pagato la lezione del rumore a livello `error`: chi apre la tabella filtrando
 * per `error` non deve trovarci gli utenti che hanno cambiato idea.
 *
 * ⚠️ Gli slug NON elencati qui valgono `'errore'` quando la lista bianca li ha
 * riconosciuti: se sappiamo che è `memory` o `no_camera_available`, non è un
 * annullamento, qualunque parola il sistema abbia messo nel messaggio. Solo
 * `'ignoto'` ricade su `classifica`, che è dov'è giusto che stia un'euristica.
 */
const CAUSA_DA_SLUG: Partial<Record<CodiceFotocamera, 'annullato' | 'permesso_negato'>> = {
  user_cancelled: 'annullato',
  permission_denied_camera: 'permesso_negato',
  permission_denied_photos: 'permesso_negato',
}

/**
 * La causa di un rigetto: la lista bianca se ha riconosciuto qualcosa, l'euristica
 * sul testo soltanto per ciò che resta `'ignoto'`.
 *
 * Restituisce anche lo slug perché il chiamante lo logga: calcolarlo due volte
 * significherebbe che le due decisioni possono divergere, ed è esattamente il
 * difetto che questa funzione chiude.
 */
function diagnosi(err: unknown): { causa: 'annullato' | 'permesso_negato' | 'errore'; slug: CodiceFotocamera } {
  const slug = codiceFotocamera(err)
  if (slug === 'ignoto') return { causa: classifica(err), slug }
  return { causa: CAUSA_DA_SLUG[slug] ?? 'errore', slug }
}

/**
 * Il formato dello scatto riuscito, da un elenco chiuso.
 *
 * `photo.format` lo scrive il plugin, quindi passa dalla stessa disciplina del
 * resto: quello che non è in elenco è `'ignoto'`. Sta sotto la chiave `formato`,
 * che `@/lib/logging/redact` ha in lista bianca.
 */
const FORMATI_NOTI = ['jpeg', 'jpg', 'png', 'gif', 'webp', 'heic', 'heif'] as const

function formatoFoto(v: unknown): string {
  return typeof v === 'string' && (FORMATI_NOTI as readonly string[]).includes(v.toLowerCase())
    ? v.toLowerCase()
    : 'ignoto'
}

/**
 * IL SUCCESSO SI LOGGA UNA VOLTA PER SESSIONE (regola 5 di AGENTS.md).
 *
 * Senza la riga del successo, «nessun log» non distingue «la fotocamera
 * funziona» da «non è mai partita»: è la stessa ambiguità che ha tenuto nascosto
 * per mesi il guasto delle email di credenziali. Una volta per sessione e non a
 * ogni scatto perché la domanda a cui questa riga risponde è «su questo
 * dispositivo la fotocamera si è mai aperta?», e la seconda occorrenza non
 * aggiunge niente: il throttle di `logClient` (60 s) e la deduplica di `app_log`
 * (per giorno) la butterebbero comunque, ma qui non parte nemmeno.
 *
 * Stato di MODULO, cioè per scheda: nella WebView nativa la scheda è la
 * sessione dell'app.
 */
let successoLoggato = false

/**
 * Apre la fotocamera/galleria native e restituisce i File scelti (0 o 1).
 * Non lancia mai: l'annullamento restituisce un array vuoto.
 */
export async function scegliFotoNativa(opts?: OpzioniScatto): Promise<File[]> {
  if (!fotocameraNativaDisponibile()) return []
  const etichette = opts?.etichette
  const multiplo = opts?.multiplo === true
  const avvio = Date.now()
  /**
   * DOVE si è fermata. Il valore che chiude la domanda «il foglio nativo è
   * comparso?»: `import` è il nostro bundle, `scatto` è il plugin, `conversione`
   * è codice NOSTRO che gira DOPO che l'utente ha scattato — e un guasto lì ha
   * una riparazione che non c'entra niente col plugin. Va sotto `operazione`,
   * che `redact` ha in lista bianca.
   */
  let fase: 'import' | 'scatto' | 'conversione' = 'import'
  let pluginPresente = false
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera')
    pluginPresente = typeof Camera?.getPhoto === 'function'
    fase = 'scatto'
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt,
      quality: 80,
      width: LATO_MAX,
      height: LATO_MAX,
      // Raddrizza il documento E ri-codifica l'immagine: la ricodifica lascia
      // indietro l'EXIF originale, GPS compreso. Su una foto scattata dentro una
      // scuola la posizione è un dato che non ha motivo di viaggiare.
      correctOrientation: true,
      // La foto di un certificato medico non deve finire nel rullino del
      // docente, e da lì nel backup automatico di Google Foto / iCloud.
      saveToGallery: false,
      allowEditing: false,
      ...(etichette
        ? {
            promptLabelHeader: etichette.intestazione,
            promptLabelPicture: etichette.scatta,
            promptLabelPhoto: etichette.libreria,
            promptLabelCancel: etichette.annulla,
          }
        : {}),
    })
    const dataUrl = photo?.dataUrl
    if (!dataUrl) return []
    fase = 'conversione'
    const blob = await (await fetch(dataUrl)).blob()
    const file = new File([blob], `foto-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' })
    if (!successoLoggato) {
      successoLoggato = true
      // `warn` è il livello più basso che `/api/logs` accetta: `info` lo
      // rifiuta, e la riga del successo esiste proprio per stare in tabella.
      // `canale` e non `sorgente`: la lista bianca di `redact` ha la prima e non
      // la seconda, e un campo che esce `[redatto:str/6]` non è un dato.
      logClient({
        livello: 'warn',
        evento: 'js',
        messaggio: 'fotocamera-scatto-riuscito',
        campi: {
          esito: 'ok',
          canale: 'prompt',
          formato: formatoFoto(photo?.format),
          byte: blob.size,
          ms: Date.now() - avvio,
          multiplo,
        },
      })
    }
    return [file]
  } catch (err) {
    // LA DIAGNOSI PRIMA DELLA DECISIONE, e l'ordine è il difetto che si chiude
    // qui: fino al 2026-09-12 `classifica(err)` decideva sul MESSAGGIO e veniva
    // consultata PRIMA di `codiceFotocamera`. Su un iPhone italiano un
    // annullamento scriveva così una riga `fotocamera-errore` a livello `error`
    // avendo in mano `error_code: 'user_cancelled'` — il campo accanto diceva la
    // verità e il livello diceva il contrario. Ora la lista bianca decide e
    // `classifica` resta il ripiego per `'ignoto'`.
    const { causa, slug } = diagnosi(err)
    if (causa === 'annullato') return [] // UX attesa: nessun log
    // IL PERCHÉ, e solo il perché. Nessun pezzo del messaggio del plugin: il
    // `.name` (`nomeErrore`, che è STRUTTURA), lo slug della lista bianca e dei
    // contatori. `logClient` persiste in `app_log` per 30 giorni, quindi ciò che
    // finisce qui è interrogabile in SQL — un errore del plugin stampato per
    // intero sarebbe un leak peggiore di quello nel logcat.
    //
    // I NOMI DELLE CHIAVI NON SONO LIBERI, e non sono quelli che verrebbero
    // spontanei: `@/lib/logging/redact` è una lista bianca PER CHIAVE, e
    // `causa`, `codice` e `tipo_errore` non ci sono — `codice` ne è escluso con
    // un commento esplicito, perché è anche il livello di una valutazione di
    // competenza. Scritti così sarebbero arrivati in tabella come
    // `[redatto:str/7]`: lo stesso silenzio di prima, con più righe. Quindi
    // `esito` (la causa), `error_code` (lo slug — è il campo che quel commento
    // indica), `tipo` (la classe d'errore), `operazione` (la fase). I numeri e i
    // booleani passano per TIPO, qualunque sia la chiave.
    logClient({
      livello: 'error',
      evento: 'js',
      messaggio: causa === 'permesso_negato' ? 'fotocamera-permesso-negato' : 'fotocamera-errore',
      campi: {
        esito: causa,
        error_code: slug,
        tipo: nomeErrore(err),
        operazione: fase,
        // Quanto è durato il tentativo. Da solo risponde a «il foglio nativo è
        // comparso?»: un rifiuto in testa a `getPhoto` torna in pochi
        // millisecondi, una scelta dalla libreria ne impiega migliaia.
        ms: Date.now() - avvio,
        plugin_presente: pluginPresente,
        con_etichette: etichette !== undefined,
        multiplo,
      },
    })
    opts?.onErrore?.(causa)
    return []
  }
}
