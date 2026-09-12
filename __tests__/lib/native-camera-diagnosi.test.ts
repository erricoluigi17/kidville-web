import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * IL PERCHÉ DI UN `fotocamera-errore`, e la garanzia che il perché non sia il
 * messaggio del plugin.
 *
 * ─── COSA C'ERA DA COLLAUDARE ───────────────────────────────────────────────
 *
 * In `app_log`: 124 righe e 412 occorrenze di `fotocamera-errore` fra il 01/09 e
 * l'11/09, 32 utenti, `contesto` **vuoto** su tutte e 124. Nel dettaglio: **118
 * righe / 390 occorrenze su iOS** e **sei righe / 22 occorrenze** marcate `web` del
 * 01-02/09, prima che `piattaforma()` smettesse di indovinare. Sapevamo che la
 * fotocamera non si apriva centinaia di volte e non sapevamo perché.
 *
 * La diagnosi ha due vincoli che tirano in direzioni opposte, e questo file
 * verifica che tengano ENTRAMBI:
 *
 *  1. dire il perché — uno slug che nomini il difetto noto;
 *  2. non far uscire dal dispositivo una sola parola del messaggio del plugin,
 *     che porta percorsi e nomi di file (e il nome di un file di foto, qui, è
 *     spessissimo il nome di un bambino).
 *
 * ─── IL TEST CHE CONTA DAVVERO È IL PENULTIMO ───────────────────────────────
 *
 * «I campi escono leggibili da `redact`» non è un dettaglio di forma: la lista
 * bianca del server è PER CHIAVE, e i nomi che verrebbero spontanei (`causa`,
 * `codice`, `tipo_errore`) non ci sono. Scritti così, questi campi sarebbero
 * arrivati in tabella come `[redatto:str/7]`: lo stesso silenzio di prima, con
 * più righe e la convinzione di averlo chiuso. Perciò il test fa passare i campi
 * dal `redact()` vero e pretende che tornino IDENTICI.
 */

vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn(() => true) }))

const logClient = vi.hoisted(() => vi.fn())
// Mock PARZIALE: si sostituisce il sink e si tiene `nomeErrore` vero — è la
// politica «del messaggio non si prende niente, si prende il `.name`», e
// reimplementarla qui vorrebbe dire collaudare la copia.
vi.mock('@/lib/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logging/client')>()),
  logClient,
}))

const getPhoto = vi.hoisted(() => vi.fn())
vi.mock('@capacitor/camera', () => ({
  Camera: { getPhoto },
  CameraResultType: { DataUrl: 'dataUrl' },
  CameraSource: { Prompt: 'PROMPT' },
}))

import { redact } from '@/lib/logging/redact'

type Modulo = typeof import('@/lib/native/camera')

/**
 * Il modulo, RICARICATO. `successoLoggato` è stato di modulo (una volta per
 * sessione): senza `resetModules` il secondo test di questo file girerebbe su una
 * sessione in cui il successo è già stato scritto, e il test del «una volta sola»
 * passerebbe per il motivo sbagliato.
 */
async function caricaCamera(): Promise<Modulo> {
  vi.resetModules()
  return import('@/lib/native/camera')
}

const DATA_URL = 'data:image/jpeg;base64,AAAA'

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ blob: async () => new Blob(['xxxxx'], { type: 'image/jpeg' }) }),
  )
}

/** I `campi` dell'ultimo evento accodato. */
function campiUltimo(): Record<string, unknown> {
  const ultimo = logClient.mock.calls.at(-1)?.[0] as { campi?: Record<string, unknown> } | undefined
  return ultimo?.campi ?? {}
}

beforeEach(() => {
  logClient.mockClear()
  getPhoto.mockReset()
  stubFetch()
})

/* ── 1. IL MESSAGGIO DEL PLUGIN NON LASCIA IL DISPOSITIVO ─────────────────── */

describe('il messaggio del plugin non esce', () => {
  /**
   * La forma vera di un errore iOS: un percorso del rullino e un nome di file.
   * Non contiene nessuna parola inglese dei pattern noti, quindi finisce nel ramo
   * peggiore — `'ignoto'` — che è proprio quello in cui la tentazione di
   * «almeno passare il messaggio» sarebbe massima.
   *
   * ⚠️ IL SEGNAPOSTO È `nome-cognome` E NON UN NOME PLAUSIBILE, e la ragione non è
   * il pudore: questo repository è PUBBLICO. Al giro precedente qui c'era un nome e
   * cognome verosimili per l'area delle tre sedi; verificato in produzione non
   * corrispondevano a nessuno, ma i due pezzi separatamente sì (dodici volte il nome,
   * sedici il cognome), cioè la combinazione era a **una iscrizione di distanza**
   * dall'essere un bambino vero — e a quel punto questa riga si leggerebbe come un
   * nome di file trafugato. La memoria del progetto registra già un caso in cui un
   * nome d'esempio in un commento corrispondeva a un bambino vero. Un segnaposto
   * dimostra quanto un nome: quello che il test deve provare è che NIENTE del
   * messaggio esce.
   */
  const VELENOSO = 'Non è stato possibile leggere /var/mobile/Media/DCIM/100APPLE/IMG_0042-nome-cognome.HEIC'

  it('nessun frammento del messaggio compare in un campo, e lo slug è `ignoto`', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error(VELENOSO))

    await expect(scegliFotoNativa()).resolves.toEqual([])

    const serializzato = JSON.stringify(logClient.mock.calls)
    for (const frammento of ['nome-cognome', 'IMG_0042', 'DCIM', '100APPLE', 'var/mobile', 'HEIC', 'possibile']) {
      expect(serializzato).not.toContain(frammento)
    }
    expect(campiUltimo().error_code).toBe('ignoto')
    // …e il `.name`, che è struttura e non contenuto, invece c'è.
    expect(campiUltimo().tipo).toBe('Error')
  })

  it('il valore di OGNI campo stringa è un enumerato: mai spazi, mai prosa', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error(VELENOSO))
    await scegliFotoNativa({ etichette: { intestazione: 'a', scatta: 'b', libreria: 'c', annulla: 'd' } })

    const campi = campiUltimo()
    expect(Object.keys(campi).length).toBeGreaterThan(0)
    for (const [k, v] of Object.entries(campi)) {
      if (typeof v !== 'string') continue
      // La stessa forma che `redact` pretende (`FORMA_ENUMERATO`): niente spazi,
      // niente a capo, non più di 64 caratteri. La prosa non la rispetta mai.
      expect(v, k).toMatch(/^[A-Za-z0-9/][A-Za-z0-9._:/+[\]-]{0,63}$/)
    }
  })
})

/* ── 2. UN ERRORE NOTO PRODUCE IL SUO SLUG ────────────────────────────────── */

describe('codiceFotocamera: la lista bianca', () => {
  /**
   * La prima riga è IL DIFETTO MISURATO IN PRODUZIONE, e il motivo per cui
   * `fotocamera-permesso-negato` ha zero righe da sempre: l'Info.plist dell'app
   * iOS non dichiara `NSPhotoLibraryAddUsageDescription`, che
   * `CameraPropertyListKeys.allCases` pretende, e `getPhoto` rigetta in testa —
   * prima di ogni foglio e di ogni permesso. Android non ha un Info.plist: ecco
   * perché su Android quelle righe sono zero.
   */
  const NOTI: [string, string][] = [
    ['You are missing NSPhotoLibraryAddUsageDescription in your Info.plist file. Camera will not function without it. Learn more: https://developer.apple.com/x', 'plist_photo_library_add'],
    ['You are missing NSPhotoLibraryUsageDescription in your Info.plist file. Camera will not function without it.', 'plist_photo_library'],
    ['You are missing NSCameraUsageDescription in your Info.plist file. Camera will not function without it.', 'plist_camera'],
    ['You are missing NSFotocameraQualcosa in your Info.plist file.', 'plist_incompleto'],
    ['User denied access to camera', 'permission_denied_camera'],
    ['User denied access to photos', 'permission_denied_photos'],
    ['User cancelled photos app', 'user_cancelled'],
    ['Camera not available while running in Simulator', 'simulator_no_camera'],
    ["Device doesn't have a camera available", 'no_camera_available'],
    ['Unable to resolve camera activity', 'no_camera_available'],
    ['Unable to resolve photo activity', 'no_gallery_available'],
    ['Unable to convert image to jpeg', 'unable_to_convert_to_jpeg'],
    ['Error processing image', 'unable_to_process_image'],
    ['Unable to process bitmap', 'unable_to_process_image'],
    ['Unable to edit image', 'unable_to_edit_image'],
    ['Error loading image', 'image_not_found'],
    ['No such image found', 'image_not_found'],
    ['Unable to get portable path to file', 'file_not_writable'],
    ['Unable to create photo on disk', 'file_not_writable'],
    ['Unable to save the image in the gallery', 'save_to_gallery_failed'],
    ['Out of memory', 'memory'],
    ['SecurityException', 'security_exception'],
    ['Invalid resultType option', 'invalid_argument'],
    ['Camera does not have web implementation. Not implemented on web.', 'plugin_not_implemented'],
    ['Failed to fetch dynamically imported module: https://app.example/_next/chunk.js', 'module_load_failed'],
  ]

  it.each(NOTI)('«%s» → %s', async (messaggio, atteso) => {
    const { codiceFotocamera } = await caricaCamera()
    expect(codiceFotocamera(new Error(messaggio))).toBe(atteso)
  })

  /**
   * L'ORDINE, e il pericolo VERO — misurato, non immaginato.
   *
   * Al primo giro questo test asseriva `not.toBe('no_camera_available')`, ed era
   * una tautologia: il messaggio del plist non corrisponde a
   * `/have a camera available|no camera available|resolve camera activity/i` in
   * nessun caso, e spostando quel pattern in TESTA alla lista tutti e 40 i test
   * restavano verdi. Il pattern che davvero ruberebbe questo messaggio è la rete
   * generica `/info\.plist/i`, che corrisponde a «in your Info.plist file» — cioè a
   * tutti e tre i messaggi delle chiavi mancanti: sopra di loro appiattirebbe le
   * tre risposte che NOMINANO la chiave da aggiungere su un `plist_incompleto` che
   * non la nomina. Spostata in testa, questa asserzione diventa rossa.
   */
  it('l’ORDINE conta: la rete generica `/info.plist/i` non ruba le tre chiavi che nominano la riparazione', async () => {
    const { codiceFotocamera } = await caricaCamera()
    for (const [messaggio, atteso] of NOTI.slice(0, 3)) {
      expect(codiceFotocamera(new Error(messaggio)), messaggio.slice(0, 40)).not.toBe('plist_incompleto')
      expect(codiceFotocamera(new Error(messaggio))).toBe(atteso)
    }
  })

  it('il CODICE del plugin batte la prosa, che su un iPhone italiano è italiana', async () => {
    const { codiceFotocamera } = await caricaCamera()
    // `CameraPlugin.swift` riga 65 rigetta con `error.localizedDescription`:
    // nessun pattern inglese corrisponderà mai. Il codice non si traduce.
    const err = Object.assign(new Error('Operazione non consentita per questo elemento'), {
      code: 'OS-PLUG-CAMR-0007',
    })
    expect(codiceFotocamera(err)).toBe('no_camera_available')
  })

  it('un codice FUORI MAPPA non passa per forma: resta `ignoto`', async () => {
    const { codiceFotocamera } = await caricaCamera()
    // Se il codice passasse «perché ha la forma giusta», questo diventerebbe
    // `os_plug_camr_9999`: un canale nuovo aperto dal lato del plugin.
    const err = Object.assign(new Error('boh'), { code: 'OS-PLUG-CAMR-9999' })
    expect(codiceFotocamera(err)).toBe('ignoto')
  })
})

/* ── 2bis. LA MAPPA DEI CODICI, SORVEGLIATA COME I PATTERN ────────────────── */

describe('CODICI_PLUGIN: la mappa dei codici', () => {
  /**
   * COSA DEVE FARE UNO SLUG: nominare la RIPARAZIONE. È l'unico suo lavoro, e due
   * codici lo sbagliavano nominandone una opposta.
   *
   *  - `0027` è `FileNotFound` («the selected file does not exist») e finiva su
   *    `file_not_writable` («non si riesce a scrivere»): chi legge la riga in SQL
   *    andava a cercare permessi o disco pieno per un file che non c'è.
   *  - `0018` è `ChooseMediaFailed` (la scelta dalla galleria è fallita) e finiva su
   *    `unable_to_process_image`, cioè una fase DOPO: si guardava il
   *    ridimensionamento invece della galleria.
   *
   * I quattro annullamenti e i due permessi ci sono perché il loro slug non è
   * un'etichetta: decide se la riga esiste e sotto quale messaggio.
   */
  const PER_CODICE: [string, string][] = [
    ['OS-PLUG-CAMR-0003', 'permission_denied_camera'],
    ['OS-PLUG-CAMR-0005', 'permission_denied_photos'],
    ['OS-PLUG-CAMR-0006', 'user_cancelled'],
    ['OS-PLUG-CAMR-0007', 'no_camera_available'],
    ['OS-PLUG-CAMR-0013', 'user_cancelled'],
    ['OS-PLUG-CAMR-0017', 'user_cancelled'],
    ['OS-PLUG-CAMR-0018', 'choose_media_failed'],
    ['OS-PLUG-CAMR-0020', 'user_cancelled'],
    ['OS-PLUG-CAMR-0027', 'file_not_found'],
  ]

  it.each(PER_CODICE)('%s → %s', async (codice, atteso) => {
    const { codiceFotocamera } = await caricaCamera()
    // Messaggio deliberatamente INUTILE: risponde il codice o non risponde niente.
    expect(codiceFotocamera(Object.assign(new Error('prosa che non dice nulla'), { code: codice }))).toBe(atteso)
  })

  /**
   * ⚠️ IL LOCK CHE FA INVECCHIARE LA MAPPA INSIEME AL PLUGIN.
   *
   * I codici non li decidiamo noi: li dichiara `CameraErrorCode` in
   * `@capacitor/camera`. Una mappa scritta a mano su 24 codici resta giusta finché
   * nessuno aggiorna il plugin, e il giorno dell'aggiornamento il codice nuovo
   * cadrebbe in `'ignoto'` **in silenzio** — cioè esattamente il silenzio che
   * questo lavoro esiste per chiudere, riaperto da una `npm update`.
   *
   * Si legge l'enum del plugin installato e si pretende che ogni suo codice trovi
   * una risposta. Non verifica CHE cosa risponde (quello è la tabella qui sopra):
   * verifica che nessuno sia rimasto fuori.
   */
  it('ogni codice dell’enum del plugin installato trova una risposta', async () => {
    const { codiceFotocamera } = await caricaCamera()
    const fs = await import('node:fs')
    const path = await import('node:path')
    const definizioni = fs.readFileSync(
      path.join(process.cwd(), 'node_modules/@capacitor/camera/dist/esm/definitions.d.ts'),
      'utf8',
    )
    const dalPlugin = [...new Set(definizioni.match(/OS-PLUG-CAMR-\d{4}/g) ?? [])]
    // Se questo numero crolla, è cambiato il file del plugin, non la nostra mappa.
    expect(dalPlugin.length, 'codici trovati in definitions.d.ts').toBeGreaterThanOrEqual(24)

    const senzaRisposta = dalPlugin.filter(
      (c) => codiceFotocamera(Object.assign(new Error('x'), { code: c })) === 'ignoto',
    )
    expect(
      senzaRisposta,
      `Codici del plugin non mappati in CODICI_PLUGIN: ${senzaRisposta.join(', ')}.\n`
      + 'Aggiungili (con lo slug che nomina la RIPARAZIONE, non il sintomo), dopo aver\n'
      + 'aggiunto lo slug a CODICI_FOTOCAMERA se non c\'è già.',
    ).toEqual([])
  })
})

/* ── 2ter. LA CAUSA RADICE, E IL LOCK CHE LA TIENE RIPARATA ───────────────── */

describe('Info.plist: le chiavi che il plugin PRETENDE per aprire la fotocamera', () => {
  /**
   * ⚠️ QUESTO È IL LOCK DELLA RIPARAZIONE, non della diagnosi.
   *
   * Tutto il resto di questo file prova che un `fotocamera-errore` dica PERCHÉ.
   * Questo prova che quel perché non torni: `NSPhotoLibraryAddUsageDescription`
   * mancava da `ios/App/App/Info.plist` ed è costata **124 righe / 412 occorrenze /
   * 32 utenti in undici giorni** (01→11/09/2026), fra 42 e 71 occorrenze al giorno,
   * 390 delle 412 su iOS e **zero su Android**, che non ha un Info.plist.
   *
   * ⚠️ L'ELENCO NON È SCRITTO A MANO, e non può esserlo: le chiavi le dichiara
   * `CameraPropertyListKeys` nel plugin, e `checkUsageDescriptions()` rigetta alla
   * PRIMA mancante. Una `npm update` che ne aggiungesse una quarta rifarebbe il
   * guasto identico e in **silenzio** — l'unico segnale sarebbero di nuovo quaranta
   * righe al giorno in `app_log`. Qui invece diventa rosso, e dice quale chiave.
   *
   * ⚠️ E NON È LA CHIAVE INUTILE CHE SEMBRA, che è la trappola vera: l'app non
   * salva niente nel rullino (`saveToGallery: false`, deliberato — la foto di un
   * certificato medico non deve finire nel backup iCloud del docente), e la
   * tentazione di togliere una dichiarazione che «non usiamo» è esattamente quella
   * che riaprirebbe le 412 occorrenze. `checkUsageDescriptions()` scorre `allCases`
   * senza guardare le opzioni della chiamata: la chiave serve per PARTIRE, non per
   * salvare.
   */
  it('ogni chiave di `CameraPropertyListKeys.allCases` è dichiarata, con una stringa di scopo', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')

    const sorgente = fs.readFileSync(
      path.join(process.cwd(), 'node_modules/@capacitor/camera/ios/Sources/CameraPlugin/CameraTypes.swift'),
      'utf8',
    )
    // Solo i `case` dell'enum: si taglia al primo membro calcolato (`var link`),
    // altrimenti si pescherebbero anche le chiavi citate nei link di documentazione.
    const casi = (sorgente.split('enum CameraPropertyListKeys')[1] ?? '').split(/\n\s*var\s/)[0]
    const chiavi = [...new Set((casi.match(/"(NS\w+)"/g) ?? []).map((c) => c.slice(1, -1)))]
    // Se questo crolla è cambiato il SORGENTE del plugin, non il nostro plist.
    expect(chiavi.length, `chiavi lette da CameraTypes.swift: ${chiavi.join(', ')}`).toBeGreaterThanOrEqual(3)

    const plist = fs.readFileSync(path.join(process.cwd(), 'ios/App/App/Info.plist'), 'utf8')
    const mancanti = chiavi.filter((k) => !plist.includes(`<key>${k}</key>`))
    expect(
      mancanti,
      `Chiavi pretese da @capacitor/camera e NON dichiarate in ios/App/App/Info.plist: ${mancanti.join(', ')}.\n`
      + 'Il plugin rigetta `getPhoto` alla PRIMA mancante, come prima istruzione e prima di\n'
      + 'qualunque foglio o richiesta di permesso: la fotocamera non si apre AFFATTO, su ogni\n'
      + 'iPhone, e in `app_log` resta solo un `fotocamera-errore`. Aggiungerle nel plist con\n'
      + 'una stringa di scopo in italiano, poi `npx cap sync ios` e un build nativo.',
    ).toEqual([])

    // Una stringa di scopo VUOTA passa il controllo del plugin (che guarda solo
    // `dict[key] != nil`) e fa RIFIUTARE la build da App Review: il guasto si
    // sposterebbe di un piano, dalla fotocamera alla pubblicazione.
    for (const k of chiavi) {
      const scopo = ((plist.split(`<key>${k}</key>`)[1] ?? '').split('</string>')[0] ?? '')
        .replace(/[\s\S]*<string>/, '')
      expect(scopo.trim().length, `stringa di scopo di ${k}`).toBeGreaterThan(20)
    }
  })
})

/* ── 3. QUALUNQUE ALTRA COSA È `ignoto`, E L'INSIEME È CHIUSO ─────────────── */

describe('l’insieme dei codici è chiuso', () => {
  const OSTILI: unknown[] = [
    new Error('Mario Rossi, allergia alle arachidi, sezione Primavera A'),
    new Error(''),
    new Error('undefined'),
    'una stringa e non un Error',
    null,
    undefined,
    42,
    { message: 'un oggetto che finge di essere un errore' },
    Object.assign(new Error('x'), { code: 42 }),
    Object.assign(new Error('y'), { code: 'plist_camera' }),
    new TypeError('Load failed'),
  ]

  it('nessun input, per quanto ostile, produce qualcosa che non sia in `CODICI_FOTOCAMERA`', async () => {
    const { codiceFotocamera, CODICI_FOTOCAMERA } = await caricaCamera()
    for (const err of OSTILI) {
      const codice = codiceFotocamera(err)
      expect(CODICI_FOTOCAMERA as readonly string[], String(err)).toContain(codice)
    }
  })

  it('un errore sconosciuto è `ignoto`, non un pezzo di sé stesso', async () => {
    const { codiceFotocamera } = await caricaCamera()
    expect(codiceFotocamera(new Error('Mario Rossi, allergia alle arachidi'))).toBe('ignoto')
    // `code` che assomiglia a uno slug: non è nella mappa, quindi non apre niente.
    expect(codiceFotocamera(Object.assign(new Error('y'), { code: 'plist_camera' }))).toBe('ignoto')
  })
})

/* ── 3bis. LA LINGUA DEL TELEFONO NON DECIDE SE UNA RIGA ESISTE ───────────── */

describe('un annullamento su un telefono NON inglese non è un errore', () => {
  /**
   * IL DIFETTO, E PERCHÉ È IL BERSAGLIO DICHIARATO DI QUESTO LAVORO.
   *
   * `CameraPlugin.swift:65` rigetta con
   * `reject(error.localizedDescription, "OS-PLUG-CAMR-…")`: su un iPhone italiano il
   * messaggio è prosa ITALIANA e il codice è l'unica metà della diagnosi che
   * sopravvive alla lingua. Finché `classifica(err)` — che legge il messaggio —
   * veniva consultata PRIMA di `codiceFotocamera`, un utente che chiudeva il foglio
   * scriveva una riga `fotocamera-errore` a livello `error` **avendo in mano**
   * `error_code: 'user_cancelled'`: il campo accanto diceva la verità e il livello
   * diceva il contrario. Quattro codici dell'enum sono annullamenti (0006, 0013,
   * 0017, 0020) e questo si attiva proprio quando si ripara l'Info.plist, perché da
   * quel momento i rigetti arrivano da `sendError` col testo localizzato.
   *
   * Il rumore a livello `error` è una lezione già pagata da questo progetto: chi
   * apre la tabella filtrando per `error` non deve trovarci chi ha cambiato idea.
   */
  const PROSA_ITALIANA = 'L’operazione non è stata completata perché è stata interrotta dall’utente'

  it.each([
    ['OS-PLUG-CAMR-0006', 'lo scatto'],
    ['OS-PLUG-CAMR-0013', 'la modifica'],
    ['OS-PLUG-CAMR-0017', 'il video'],
    ['OS-PLUG-CAMR-0020', 'la scelta dalla galleria'],
  ])('%s (%s annullato) in italiano: NESSUNA riga di log', async (codice) => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(Object.assign(new Error(PROSA_ITALIANA), { code: codice }))
    const onErrore = vi.fn()
    await expect(scegliFotoNativa({ onErrore })).resolves.toEqual([])
    expect(logClient, 'un annullamento non lascia righe').not.toHaveBeenCalled()
    expect(onErrore, 'né avvisa il chiamante di un guasto').not.toHaveBeenCalled()
  })

  /**
   * IL GEMELLO, e vale quanto l'altro: `fotocamera-permesso-negato` ha **zero**
   * righe da sempre. Quando l'Info.plist sarà riparato e i permessi verranno
   * chiesti davvero, i rifiuti arriveranno da telefoni italiani — e con la sola
   * euristica sul testo sarebbero finiti sotto `fotocamera-errore`, lasciando quel
   * messaggio a zero per un secondo motivo dopo il primo.
   */
  it.each([
    ['OS-PLUG-CAMR-0003', 'permission_denied_camera'],
    ['OS-PLUG-CAMR-0005', 'permission_denied_photos'],
  ])('%s in italiano finisce sotto `fotocamera-permesso-negato`', async (codice, slug) => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(
      Object.assign(new Error('Non hai autorizzato l’accesso'), { code: codice }),
    )
    const onErrore = vi.fn()
    await scegliFotoNativa({ onErrore })
    expect(logClient).toHaveBeenCalledTimes(1)
    expect((logClient.mock.calls[0][0] as { messaggio?: string }).messaggio).toBe('fotocamera-permesso-negato')
    expect(campiUltimo()).toMatchObject({ esito: 'permesso_negato', error_code: slug })
    expect(onErrore).toHaveBeenCalledWith('permesso_negato')
  })

  /**
   * ⚠️ E NON PUÒ ESSERE UNA TENDA: uno slug NOTO che non sia annullamento né
   * permesso resta un guasto, anche se la prosa localizzata contiene per caso una
   * parola che l'euristica leggerebbe come «annullato». Prima, `classifica` decideva
   * e un `no_camera_available` con la parola «cancelado» dentro veniva INGHIOTTITO:
   * un guasto hardware vero, senza una riga.
   */
  it('uno slug noto che NON è annullamento resta un errore, anche con «cancel» nel testo', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(
      Object.assign(new Error('Operación cancelada: no hay cámara'), { code: 'OS-PLUG-CAMR-0007' }),
    )
    await scegliFotoNativa()
    expect(logClient).toHaveBeenCalledTimes(1)
    expect(campiUltimo()).toMatchObject({ esito: 'errore', error_code: 'no_camera_available' })
  })

  /**
   * IL RIPIEGO RESTA LARGO. Senza codice e senza pattern noto lo slug è `'ignoto'`,
   * e lì decide `classifica` — che su «annullato» è volutamente più larga: un falso
   * positivo costa un log in meno, un falso negativo costa una riga per ogni volta
   * che un utente cambia idea.
   */
  it('senza codice, l’euristica sul testo continua a tacere sugli annullamenti inglesi', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error('The operation was cancelled by the user'))
    await expect(scegliFotoNativa()).resolves.toEqual([])
    expect(logClient).not.toHaveBeenCalled()
  })
})

/* ── 4. LA FASE, cioè «il foglio nativo è mai comparso?» ──────────────────── */

describe('operazione: dove si è fermata', () => {
  it('`scatto` quando è il plugin a rigettare', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error('Out of memory'))
    await scegliFotoNativa()
    expect(campiUltimo()).toMatchObject({ operazione: 'scatto', error_code: 'memory', plugin_presente: true })
    expect(typeof campiUltimo().ms).toBe('number')
  })

  it('`conversione` quando il plugin ha consegnato e siamo NOI a rompere', async () => {
    // Il guasto dopo lo scatto ha una riparazione che non c'entra col plugin: se
    // le due fasi non si distinguono, si va a cercare nel posto sbagliato.
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockResolvedValue({ dataUrl: DATA_URL, format: 'jpeg' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')))
    await expect(scegliFotoNativa()).resolves.toEqual([])
    expect(campiUltimo()).toMatchObject({ operazione: 'conversione', tipo: 'TypeError' })
  })
})

/* ── 5. IL SUCCESSO, UNA VOLTA PER SESSIONE ───────────────────────────────── */

describe('fotocamera-scatto-riuscito', () => {
  it('si logga, con formato e byte, e UNA volta sola per sessione', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockResolvedValue({ dataUrl: DATA_URL, format: 'jpeg' })

    await expect(scegliFotoNativa()).resolves.toHaveLength(1)
    await expect(scegliFotoNativa()).resolves.toHaveLength(1)
    await expect(scegliFotoNativa()).resolves.toHaveLength(1)

    const successi = logClient.mock.calls.filter(
      (c) => (c[0] as { messaggio?: string }).messaggio === 'fotocamera-scatto-riuscito',
    )
    expect(successi).toHaveLength(1)
    expect((successi[0][0] as { livello?: string }).livello).toBe('warn')
    expect((successi[0][0] as { campi?: Record<string, unknown> }).campi).toMatchObject({
      esito: 'ok',
      canale: 'prompt',
      formato: 'jpeg',
      byte: 5,
      multiplo: false,
    })
  })

  it('un formato che il plugin inventa non esce: `ignoto`', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockResolvedValue({ dataUrl: DATA_URL, format: 'IMG_0042 di nome-cognome' })
    await scegliFotoNativa()
    expect(campiUltimo().formato).toBe('ignoto')
  })

  it('senza scatto riuscito non c’è nessuna riga di successo', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error('User cancelled photos app'))
    await scegliFotoNativa()
    expect(logClient).not.toHaveBeenCalled()
  })
})

/* ── 6. I CAMPI ESCONO LEGGIBILI DAL `redact` VERO ────────────────────────── */

describe('i campi sopravvivono alla lista bianca del server', () => {
  /**
   * ⚠️ È IL TEST CHE DISTINGUE «diagnosi» da «righe in più». `redact` è a lista
   * bianca PER CHIAVE: sotto `causa`, `codice` o `tipo_errore` questi stessi
   * valori arriverebbero in `app_log` come `[redatto:str/N]`. Qui si pretende che
   * il `redact` vero — lo stesso che gira in `/api/logs` — li restituisca
   * IDENTICI.
   */
  it('l’errore: ogni campo torna da `redact()` uguale a com’è partito', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error('You are missing NSPhotoLibraryAddUsageDescription in your Info.plist file.'))
    await scegliFotoNativa({ multiplo: true })

    const campi = campiUltimo()
    expect(campi.error_code).toBe('plist_photo_library_add')
    expect(redact(campi)).toEqual(campi)
  })

  it('il successo: idem', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockResolvedValue({ dataUrl: DATA_URL, format: 'jpeg' })
    await scegliFotoNativa()

    const campi = campiUltimo()
    expect(campi.esito).toBe('ok')
    expect(redact(campi)).toEqual(campi)
  })

  it('e sono meno di dodici: oltre il tetto `logClient` li butta', async () => {
    const { scegliFotoNativa } = await caricaCamera()
    getPhoto.mockRejectedValue(new Error('Out of memory'))
    await scegliFotoNativa()
    expect(Object.keys(campiUltimo()).length).toBeLessThanOrEqual(12)
  })
})
