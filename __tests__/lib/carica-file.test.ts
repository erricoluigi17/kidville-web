import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { caricaFile } from '@/lib/upload/carica-file'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'

/**
 * IL CARICAMENTO DI UN FILE, UNA VOLTA SOLA — e questi sono i comportamenti che
 * `FileField` non deve riscrivere se un giorno lo si smonta.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * PERCHÉ ESISTE QUESTO FILE, detto senza abbellirlo. Fino al 12/08/2026 questa logica
 * viveva dentro `FileField` (`FieldRenderer.tsx`), cioè dentro un componente, ed era
 * raggiungibile SOLO rendendo quel componente: per misurare il ramo del 413 bisognava
 * montare una `<label>`, un `<input>` e `useTranslations`. Estraendola in
 * `@/lib/upload/carica-file` questi rami diventano misurabili da soli — ed è tutto
 * quello che l'estrazione ha comprato.
 *
 * ⚠️ QUANTI CHIAMANTI HA — e perché questa testata ha smesso di dire un numero. Qui c'è
 * stato scritto prima che stavano per nascere «due controlli che l'avrebbero riscritta»,
 * poi — cancellando quella frase come falsa — che «`caricaFile` ha UN SOLO chiamante»,
 * indicando `grep -rn caricaFile src` come verifica «in trenta secondi». Eseguito, quel
 * comando ne restituisce DUE: `FieldRenderer.tsx` (`FileField`, le porte anonime) e
 * `StaffDetailPanel.tsx` (il tab «Documento» della scheda staff, la prima porta
 * autenticata). Anche i numeri di riga citati erano sbagliati.
 *
 * Il conteggio vive ora in un posto solo, la testata di `@/lib/upload/carica-file`, e la
 * lezione la si scrive qui perché è costata due giri: **un commento che afferma un
 * CONTEGGIO scade il giorno in cui qualcuno chiama la funzione** — tanto più se prescrive
 * il comando che lo smentisce. I rami qui sotto valgono perché sono stati pagati in
 * produzione, non per quanti li leggono: il fronte/retro del documento
 * (`DocumentoIdentitaFields.tsx`) restano due ISTANZE dello stesso `FileField`, non una
 * seconda copia di questa logica.
 *
 *  1. la taglia si controlla PRIMA di spedire. Sopra il tetto della piattaforma la
 *     richiesta non arriva mai alla nostra route (Vercel risponde 413 da solo), quindi
 *     nessun controllo lato server potrebbe scattare: 41 tentativi falliti in un giorno
 *     sul modulo pubblico, il 31/07/2026;
 *  2. `res.ok` si guarda PRIMA di `res.json()`. Il 413 della piattaforma ha
 *     `content-type: text/plain`: il parse LANCIA `SyntaxError`, e l'errore che l'utente
 *     leggeva era «Caricamento non riuscito. Riprova.» — l'invito a rifare l'unica cosa
 *     che non poteva funzionare;
 *  3. il `path` torna dal corpo della risposta, e un corpo senza `path` è un errore, non
 *     un successo silenzioso;
 *  4. l'errore NON perde lo stato HTTP: `403` e «rete assente» non sono la stessa cosa,
 *     e chi rende deve poterle distinguere;
 *  5. **c'è un tetto di tempo**, e senza di esso i quattro punti qui sopra non servono a
 *     niente: `fetch` non scade da sola, e `FileField` mette `uploading = true` con
 *     `setUploading(false)` nel solo `finally`. Una richiesta che resta appesa (rete
 *     morta, captive portal) lascia la rotellina che gira per sempre — nessun errore,
 *     nessun ritentativo, fino al ricaricamento della pagina;
 *  6. **l'osservabilità è un comportamento, non un contorno**: quanto finisce in
 *     `app_log`, con quale livello, e soprattutto che cosa NON ci finisce mai (il nome
 *     del file: «carta-identita-maria-rossi.jpg» è un dato personale di un minore o di
 *     una dipendente, e resta 30 giorni in tabella interrogabile in SQL).
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/**
 * `logClient` FINTA — `nomeErrore` VERA (`importOriginal`).
 *
 * Non è pigrizia: metà di ciò che si misura qui sotto è proprio l'INTERAZIONE fra le due
 * (`nomeErrore` restituisce SOLO `e.name`, mai il messaggio — vedi il test sull'identità
 * del ramo «senza path»). Una `nomeErrore` finta renderebbe quei test veri per
 * costruzione.
 */
const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

/** Un file della dimensione voluta senza allocarla davvero: in jsdom `size` è scrivibile. */
function fileDa(byte: number, nome = 'documento.pdf'): File {
  const f = new File(['x'], nome, { type: 'application/pdf' })
  Object.defineProperty(f, 'size', { value: byte })
  return f
}

/** La risposta VERA della piattaforma Vercel: 413, corpo di testo, nessun JSON. */
function risposta413(): Response {
  return new Response('Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n\nfra1::abc', {
    status: 413,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

let rete: ReturnType<typeof vi.fn>

beforeEach(() => {
  rete = vi.fn()
  vi.stubGlobal('fetch', rete)
  h.logClient.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('caricaFile — la taglia si controlla prima di spedire', () => {
  it('un file oltre il tetto della piattaforma non parte nemmeno', async () => {
    const esito = await caricaFile({
      endpoint: '/api/personale/upload',
      file: fileDa(LIMITE_UPLOAD_BYTE + 1),
    })

    expect(esito).toEqual({ esito: 'troppo-grande', limiteMb: LIMITE_UPLOAD_MB })
    // Spedirlo significherebbe consumare la rete mobile di chi carica per farlo morire
    // contro un 413 che non è nostro e che non risponde nemmeno in JSON.
    expect(rete).not.toHaveBeenCalled()
  })

  it('il limite del campo, se più stretto di quello della piattaforma, vince', async () => {
    const esito = await caricaFile({
      endpoint: '/api/personale/upload',
      file: fileDa(2 * 1024 * 1024),
      maxSizeMb: 1,
    })

    expect(esito).toEqual({ esito: 'troppo-grande', limiteMb: 1 })
    expect(rete).not.toHaveBeenCalled()
  })

  it('un file esattamente al limite parte: il confronto è `>`, non `>=`', async () => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'personale/x/fronte.pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const esito = await caricaFile({
      endpoint: '/api/personale/upload',
      file: fileDa(LIMITE_UPLOAD_BYTE),
    })

    expect(esito).toEqual({ esito: 'ok', path: 'personale/x/fronte.pdf' })
  })
})

describe('caricaFile — `res.ok` prima di `res.json()`', () => {
  it('il 413 della piattaforma (corpo NON JSON) non diventa un SyntaxError', async () => {
    // Il tetto lo decide la piattaforma e può cambiare sotto di noi: la seconda difesa
    // deve reggere anche quando il controllo a monte non ha scattato.
    rete.mockResolvedValue(risposta413())

    const esito = await caricaFile({
      endpoint: '/api/personale/upload',
      file: fileDa(1024),
      maxSizeMb: 4,
    })

    // «Troppo grande» e non «errore generico»: il 413 e il file oltre il tetto sono lo
    // stesso guasto per chi carica, e devono poter mostrare lo stesso messaggio senza
    // che il secondo chiamante debba ricordarsi di trattare il 413 a parte.
    expect(esito).toEqual({ esito: 'troppo-grande', limiteMb: 4 })
    expect(rete).toHaveBeenCalledTimes(1)
  })

  it('un 500 con corpo di testo non esplode: torna l’errore con il suo stato', async () => {
    rete.mockResolvedValue(
      new Response('<html>Internal Server Error</html>', {
        status: 500,
        headers: { 'content-type': 'text/html' },
      }),
    )

    const esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(1024) })

    // Nessun `messaggioServer`: il corpo non è JSON, e riversare in pagina
    // «FUNCTION_PAYLOAD_TOO_LARGE» o un `<html>` non è un messaggio per un essere umano.
    expect(esito).toEqual({ esito: 'errore', stato: 500 })
  })

  it('un errore del server con corpo JSON restituisce il messaggio del server', async () => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Tipo di file non ammesso (PDF o immagini)' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(1024) })

    expect(esito).toEqual({
      esito: 'errore',
      stato: 400,
      messaggioServer: 'Tipo di file non ammesso (PDF o immagini)',
    })
  })
})

describe('caricaFile — il path torna dal corpo della risposta', () => {
  it('il percorso felice restituisce il path', async () => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'personale/uuid/retro-carta.jpg' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) })

    expect(esito).toEqual({ esito: 'ok', path: 'personale/uuid/retro-carta.jpg' })
  })

  it('una 200 SENZA path è un errore, non un successo muto', async () => {
    // È il caso che una copia scritta a memoria dimentica sempre: `res.ok` è vero, il
    // caricamento «riesce», e il modulo resta con il campo vuoto e nessuna spiegazione.
    rete.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) })

    expect(esito).toEqual({ esito: 'errore', stato: 200 })
  })

  it('una 200 con `path` vuoto è un errore', async () => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) })

    expect(esito).toEqual({ esito: 'errore', stato: 200 })
  })

  it('una 200 con corpo NON JSON è un errore, e resta lo stato', async () => {
    rete.mockResolvedValue(
      new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
    )

    const esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) })

    expect(esito).toEqual({ esito: 'errore', stato: 200 })
  })
})

describe('caricaFile — l’errore non perde lo stato HTTP', () => {
  it('la rete che cade dà `stato: null`, non uno stato inventato', async () => {
    // `TypeError: Failed to fetch` è ciò che si vede sulla rete mobile di chi carica dal
    // piazzale della scuola. Non c'è nessuno stato HTTP: dirlo è il punto.
    rete.mockRejectedValue(new TypeError('Failed to fetch'))

    const esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) })

    expect(esito).toEqual({ esito: 'errore', stato: null })
  })

  it('non lancia MAI: chi rende non deve avvolgerla in un try/catch per non rompersi', async () => {
    rete.mockRejectedValue(new Error('qualunque cosa'))

    await expect(
      caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) }),
    ).resolves.toMatchObject({ esito: 'errore' })
  })
})

describe('caricaFile — il corpo della richiesta', () => {
  it('spedisce il file, i campi `extra` e `max_size_mb` all’endpoint indicato', async () => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'p' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const file = fileDa(1024, 'fronte.jpg')

    await caricaFile({
      endpoint: '/api/personale/documento/upload',
      file,
      maxSizeMb: 2,
      extra: { folder: 'documento-personale', lato: 'fronte' },
    })

    expect(rete).toHaveBeenCalledTimes(1)
    const [url, init] = rete.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/personale/documento/upload')
    expect(init.method).toBe('POST')
    const fd = init.body as FormData
    expect(fd.get('file')).toBe(file)
    expect(fd.get('folder')).toBe('documento-personale')
    expect(fd.get('lato')).toBe('fronte')
    expect(fd.get('max_size_mb')).toBe('2')
  })

  it('senza `maxSizeMb` non inventa un `max_size_mb`', async () => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'p' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await caricaFile({ endpoint: '/api/forms/upload', file: fileDa(1024), extra: { folder: 'm' } })

    const [, init] = rete.mock.calls[0] as [string, RequestInit]
    expect((init.body as FormData).get('max_size_mb')).toBeNull()
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * IL TETTO DI TEMPO — il quinto comportamento, e quello senza cui gli altri quattro
 * non arrivano mai a servire.
 *
 * `fetch` non ha nessun timeout di suo: è MISURATO in questo repo (vedi la testata di
 * `src/lib/logging/tetto.ts`), un bersaglio che accetta la connessione e tace tiene
 * appesa la chiamata 150 secondi senza eccezione. Qui il conto lo paga l'interfaccia:
 * `FileField` mette `uploading = true` e lo rimette a `false` SOLO nel `finally`, mentre
 * `handleFile` comincia con `if (uploading) return`. Una richiesta che non si risolve mai
 * lascia la rotellina che gira, il controllo inerte, nessun errore e nessun ritentativo —
 * cioè il contrario esatto del difetto che questo modulo esiste per riparare.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Le righe che il modulo ha spedito a `app_log`, nell'ordine in cui le ha scritte. */
function righeDiLog(): { livello: string; evento: string; messaggio: string }[] {
  return h.logClient.mock.calls.map((c) => c[0] as { livello: string; evento: string; messaggio: string })
}

describe('caricaFile — il tetto di tempo', () => {
  it('alla `fetch` arriva un `AbortSignal`, e il numero chiesto è ESATTAMENTE 30 secondi', async () => {
    // Il numero è scritto A MANO qui, e non importato dal modulo: importarlo renderebbe
    // questo test verde per costruzione: `TETTO_UPLOAD_MS = 300_000` passerebbe, e un
    // tetto di cinque minuti su un caricamento è funzionalmente nessun tetto. Cambiarlo
    // deve costare una riga rossa e una decisione (l'altra metà la tiene
    // `__tests__/lib/logging-tetto.test.ts`, che lo vieta oltre i 30 s).
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'p' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const originale = AbortSignal.timeout
    const chiesti: number[] = []
    AbortSignal.timeout = ((ms: number) => {
      chiesti.push(ms)
      return originale.call(AbortSignal, ms)
    }) as typeof AbortSignal.timeout

    try {
      await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) })
    } finally {
      AbortSignal.timeout = originale
    }

    expect(chiesti).toEqual([30_000])
    const [, init] = rete.mock.calls[0] as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    // Il metodo e il corpo NON si perdono per strada mettendo il segnale: sarebbe un
    // caricamento che diventa una GET senza che nessuno se ne accorga.
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
  })

  it('una richiesta che non si risolve MAI non resta appesa: scade, e l’esito torna', async () => {
    // Il ramo `new Promise(() => {})` è il bersaglio muto vero, ed è deliberato che sia
    // lì: se qualcuno togliesse il tetto, questo test non tornerebbe ROSSO — resterebbe
    // APPESO finché vitest non lo uccide. Un fallimento che si vede, invece di un'attesa
    // infinita che in produzione nessuno può vedere.
    const scadenza = new DOMException('scaduto', 'TimeoutError')
    const originale = AbortSignal.timeout
    AbortSignal.timeout = (() => AbortSignal.abort(scadenza)) as typeof AbortSignal.timeout
    rete.mockImplementation((_url: string, init: RequestInit) =>
      init?.signal?.aborted ? Promise.reject(init.signal.reason) : new Promise(() => {}),
    )

    let esito
    try {
      esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) })
    } finally {
      AbortSignal.timeout = originale
    }

    // `stato: null` e non `0`: non c'è stata NESSUNA risposta (punto 4 della testata).
    expect(esito).toEqual({ esito: 'errore', stato: null })
    const righe = righeDiLog()
    expect(righe).toHaveLength(1)
    expect(righe[0].livello).toBe('error')
    // UNA SCADENZA NON È UNA RETE GIÙ, e in tabella deve dirlo: «il bersaglio non
    // risponde» si ripara alzando il tetto o chiamando chi tiene la route, «il bersaglio
    // non si raggiunge» si ripara altrove. E il NUMERO ci va dentro: senza, non si
    // distingue «è morto» da «il tetto è troppo stretto», che sono riparazioni opposte.
    expect(righe[0].messaggio).toContain('scaduto')
    expect(righe[0].messaggio).toContain('30000')
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * COSA FINISCE IN `app_log` — e cosa non ci finisce MAI.
 *
 * Fino al 12/08/2026 di questo blocco non esisteva niente, ed era il buco più grosso del
 * file: cancellando l'INTERA `logClient` del `catch`, o abbassandola da `error` a `warn`,
 * o togliendo il `warn` del ramo troppo-grande, la suite restava 20/20 verde. Sono le tre
 * regole non negoziabili di AGENTS.md (un `catch` che non logga è un bug; un guasto
 * critico è `error`; il contatore che dice se il tetto è tarato bene), e nessuna era
 * agganciata a niente.
 *
 * E soprattutto: aggiungendo `${file.name}` al messaggio della riga «troppo pesante» la
 * suite restava verde. A valle non lo ferma nessuno — `redigiPathNelTesto` pretende uno
 * slash iniziale, `sanificaMessaggio` maschera email, codici fiscali e vincoli Postgres,
 * non i nomi di file — quindi «carta-identita-maria-rossi.jpg» arriverebbe intatto in
 * `app_log.messaggio` e ci resterebbe 30 giorni, interrogabile in SQL, su documenti
 * d'identità di minori e di dipendenti.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('caricaFile — cosa finisce in `app_log`', () => {
  it('oltre il tetto: UNA riga `warn` con la DIMENSIONE, e mai il NOME del file', async () => {
    const nome = 'carta-identita-maria-rossi.jpg'
    const taglia = LIMITE_UPLOAD_BYTE + 1

    await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(taglia, nome) })

    const righe = righeDiLog()
    expect(righe).toHaveLength(1)
    // `warn` e non `error`: è un contatore operativo, non un guasto. Serve a sapere se il
    // tetto è tarato bene o se la gente carica foto da 12 MB; a livello `error` sarebbe
    // rumore in cima alla tabella (e `controlloTassoErrore` dichiara `/api/health`
    // degradato a 5 impronte `error` distinte in 15 minuti).
    expect(righe[0].livello).toBe('warn')
    expect(righe[0].evento).toBe('fetch')
    // La dimensione SÌ: è un numero, ed è l'unica cosa che serve per la taratura.
    expect(righe[0].messaggio).toContain(String(taglia))
    expect(righe[0].messaggio).toContain(String(LIMITE_UPLOAD_BYTE))
    // Il nome NO. E non solo intero: né il cognome, né il nome, né l'estensione — un
    // «maria-rossi» dentro un messaggio è un dato personale anche senza il `.jpg`.
    expect(righe[0].messaggio, 'il nome del file è finito in app_log').not.toContain(nome)
    for (const pezzo of ['carta-identita', 'maria', 'rossi', '.jpg']) {
      expect(righe[0].messaggio.toLowerCase(), `«${pezzo}» è finito in app_log`).not.toContain(pezzo)
    }
  })

  it('la rete caduta lascia UNA riga `error`, col nome della classe d’errore', async () => {
    rete.mockRejectedValue(new TypeError('Failed to fetch https://app.kidville.it/m/tok-segreto'))

    await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) })

    const righe = righeDiLog()
    expect(righe).toHaveLength(1)
    // Un caricamento fallito è invisibile a chi non ha in mano il dispositivo: se questa
    // riga non parte, «nessun log» non distingue «tutto ok» da «non è mai partito niente».
    expect(righe[0].livello).toBe('error')
    expect(righe[0].evento).toBe('fetch')
    expect(righe[0].messaggio).toContain('TypeError')
  })

  it('una 200 senza `path` ha un’identità PROPRIA in tabella, non un `Error` generico', async () => {
    // `nomeErrore` (quella VERA, vedi il mock in testa) restituisce SOLO `e.name`: un
    // `throw new Error('risposta senza path')` finiva in tabella come
    // «…-upload-fallito: Error», indistinguibile da qualunque altro guasto, e la frase
    // sopravviveva solo dentro `stack` — campo opzionale e troncato. Cioè il guasto che
    // il modulo descrive come «esattamente ciò che nessuno si accorge di aver perso» era
    // il primo a non essere ritrovabile con una query.
    rete.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048) })

    const righe = righeDiLog()
    expect(righe).toHaveLength(1)
    expect(righe[0].livello).toBe('error')
    expect(righe[0].messaggio).toBe('modulo-allegato-senza-path')
  })

  it('i tre guasti hanno tre messaggi DIVERSI (il throttle ne scarterebbe due su tre)', async () => {
    // La chiave del throttle di `logClient` è `${evento}|${messaggio}|${stato ?? ''}` con
    // `DEDUP_MS = 60_000`: due guasti diversi che producono la stessa stringa non sono
    // «due righe uguali», sono UNA riga — la seconda viene scartata in silenzio per un
    // minuto. Con `nomeErrore` che restituisce `Error` per quasi tutto, un messaggio
    // costruito solo su di lui collassa i rami uno sull'altro.
    const messaggi: string[] = []

    await caricaFile({ endpoint: '/x', file: fileDa(LIMITE_UPLOAD_BYTE + 1) })
    messaggi.push(righeDiLog()[0].messaggio)

    h.logClient.mockClear()
    rete.mockRejectedValue(new Error('qualunque cosa'))
    await caricaFile({ endpoint: '/x', file: fileDa(2048) })
    messaggi.push(righeDiLog()[0].messaggio)

    h.logClient.mockClear()
    rete.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await caricaFile({ endpoint: '/x', file: fileDa(2048) })
    messaggi.push(righeDiLog()[0].messaggio)

    expect(new Set(messaggi).size, `due guasti condividono un messaggio: ${messaggi.join(' | ')}`).toBe(3)
  })

  it('il percorso felice non logga NIENTE (controllo positivo del silenzio)', async () => {
    // Senza questo, tutte le asserzioni qui sopra reggerebbero anche con un modulo che
    // logga a ogni caricamento: `app_log` diventerebbe un registro degli allegati.
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'personale/uuid/fronte.jpg' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(2048, 'mario-bianchi-ci.jpg') })

    expect(righeDiLog()).toEqual([])
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * LE TRE STRETTE DI `messaggioDelServer` — due delle quali non erano provate.
 *
 * I due test che esistevano usavano corpi che NON sono JSON parsabile (`<html>…`, il
 * testo del 413): lì il `try/catch` sottostante produce lo stesso risultato del
 * guardiano sul content-type, e togliere il guardiano non cambiava nemmeno un'asserzione.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('caricaFile — le tre strette sul messaggio del server', () => {
  it('un JSON valido DICHIARATO `text/plain` non arriva in pagina', async () => {
    // È la forma vera dell'errore di piattaforma: corpo perfettamente parsabile,
    // content-type di testo. Senza il guardiano, «FUNCTION_PAYLOAD_TOO_LARGE» —
    // una stringa che non significa niente per chi carica una carta d'identità —
    // finirebbe sotto il campo al posto di «Caricamento non riuscito».
    rete.mockResolvedValue(
      new Response(JSON.stringify({ error: 'FUNCTION_PAYLOAD_TOO_LARGE' }), {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    )

    const esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(1024) })

    expect(esito).toEqual({ esito: 'errore', stato: 500 })
  })

  it('un `error` sterminato si tronca a 200 caratteri', async () => {
    // Un dump del server (uno stack, una query PostgREST con dentro dei valori) riversato
    // intero in pagina è insieme un problema di resa e di privacy: quel testo lo scrivono
    // le nostre route, ma nessuno può garantire che resti corto per sempre.
    rete.mockResolvedValue(
      new Response(JSON.stringify({ error: 'x'.repeat(500) }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const esito = await caricaFile({ endpoint: '/api/personale/upload', file: fileDa(1024) })

    expect(esito).toMatchObject({ esito: 'errore', stato: 400 })
    expect((esito as { messaggioServer?: string }).messaggioServer).toHaveLength(200)
  })

  it('un `error` che non è una stringa non diventa un messaggio', async () => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ error: { codice: 42 } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(await caricaFile({ endpoint: '/x', file: fileDa(1024) })).toEqual({
      esito: 'errore',
      stato: 400,
    })
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * `extra` NON PUÒ SCAVALCARE IL TETTO DEL CAMPO.
 *
 * I campi di `extra` venivano accodati PRIMA di `max_size_mb`, e `FormData.get()`
 * restituisce il PRIMO valore: un chiamante con `extra: { max_size_mb: '99' }` faceva
 * leggere 99 alla route mentre il client aveva appena applicato il tetto vero. Controllo
 * client e controllo server divergevano senza che niente lo segnalasse — e in questo
 * modulo `extra` è proprio il parametro aperto, quello su cui si inciampa.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('caricaFile — le chiavi riservate del multipart', () => {
  beforeEach(() => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'p' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })

  it('un `extra.max_size_mb` non sovrascrive il tetto applicato dal client', async () => {
    await caricaFile({
      endpoint: '/api/personale/upload',
      file: fileDa(1024),
      maxSizeMb: 2,
      extra: { folder: 'documento-personale', max_size_mb: '99' },
    })

    const [, init] = rete.mock.calls[0] as [string, RequestInit]
    const fd = init.body as FormData
    expect(fd.get('max_size_mb')).toBe('2')
    // E nemmeno in coda: la route potrebbe leggere con `getAll()`, e due valori per lo
    // stesso campo sono un tetto che dipende da come il server lo legge.
    expect(fd.getAll('max_size_mb')).toEqual(['2'])
    // Il resto di `extra` passa: la guardia è sulle chiavi riservate, non su `extra`.
    expect(fd.get('folder')).toBe('documento-personale')
  })

  it('un `extra.file` non sostituisce il file', async () => {
    const file = fileDa(1024, 'fronte.jpg')

    await caricaFile({
      endpoint: '/api/personale/upload',
      file,
      extra: { file: 'non-sono-io.txt' },
    })

    const fd = (rete.mock.calls[0] as [string, RequestInit])[1].body as FormData
    expect(fd.get('file')).toBe(file)
    expect(fd.getAll('file')).toEqual([file])
  })

  it('il rifiuto lascia una riga: una divergenza silenziosa è il difetto, non il rifiuto', async () => {
    await caricaFile({
      endpoint: '/api/personale/upload',
      file: fileDa(1024),
      maxSizeMb: 2,
      extra: { max_size_mb: '99' },
    })

    const righe = righeDiLog()
    expect(righe).toHaveLength(1)
    expect(righe[0].livello).toBe('warn')
    // Si logga il NOME DELLA CHIAVE, che è una nostra costante — mai il suo valore, che
    // arriva dal chiamante e di cui questo modulo non sa niente.
    expect(righe[0].messaggio).toContain('max_size_mb')
    expect(righe[0].messaggio).not.toContain('99')
  })

  it('senza chiavi riservate non logga niente (controllo positivo)', async () => {
    await caricaFile({
      endpoint: '/api/personale/upload',
      file: fileDa(1024),
      maxSizeMb: 2,
      extra: { folder: 'documento-personale', lato: 'fronte' },
    })

    expect(righeDiLog()).toEqual([])
  })
})
