import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FileField } from '@/components/features/forms/FieldRenderer'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'
// I cataloghi VERI, non stringhe ribattute a mano: un test che ricopia il glossario
// diventa rosso per un apostrofo, e su questo repo è già successo.
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'
import itParentForms from '../../messages/it/parentForms.json'

/**
 * L'ALLEGATO CHE NON SI CARICA — un guasto vivo, contato in produzione.
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 * COSA SUCCEDEVA. `app_log`, 31 luglio 2026: **41 occorrenze in un giorno** di
 * `POST /api/iscrizione/upload → 413`, e altrettante di
 * `modulo-allegato-upload-fallito: SyntaxError`. Sono genitori che allegano il
 * certificato o la carta d'identità al modulo pubblico di preiscrizione e non ci
 * riescono — e un client che non sa nemmeno dire perché.
 *
 * DUE DIFETTI SOVRAPPOSTI, e il secondo nasconde il primo:
 *
 *  1. il 413 lo emette la PIATTAFORMA, non il nostro handler. Verificato dal vivo su
 *     `https://app.kidville.it/api/iscrizione/upload`: a 4 MB la richiesta arriva alla
 *     route (che risponde 400 sul campo mancante), a 5 MB torna
 *     `HTTP/2 413`, `x-vercel-error: FUNCTION_PAYLOAD_TOO_LARGE`,
 *     `content-type: text/plain`. Il nostro codice non viene mai eseguito — quindi il
 *     suo limite dichiarato di 8 MB era una promessa che nessuno poteva mantenere.
 *  2. il client faceva `await res.json()` PRIMA di guardare `res.ok`. Su un corpo
 *     `text/plain` quel parse LANCIA `SyntaxError`, e il genitore riceve «Caricamento
 *     non riuscito. Riprova.» — cioè l'invito a rifare esattamente la cosa che non può
 *     funzionare, all'infinito.
 * ─────────────────────────────────────────────────────────────────────────────────
 */

/**
 * `logClient` FINTA — `nomeErrore` VERA (`importOriginal`): il test sull'identità del
 * `catch` misura proprio la STRINGA che le due compongono insieme.
 */
const h = vi.hoisted(() => ({ logClient: vi.fn() }))
vi.mock('@/lib/logging/client', async (originale) => ({
  ...(await originale<typeof import('@/lib/logging/client')>()),
  logClient: h.logClient,
}))

/** Un file della dimensione voluta senza allocarla davvero: in jsdom `size` è scrivibile. */
function fileDa(byte: number, nome = 'certificato.pdf'): File {
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

function inputFile(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[type="file"]')
  if (el === null) throw new Error('input file non trovato')
  return el as HTMLInputElement
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

describe('FileField — il 413 della piattaforma', () => {
  it('un file oltre il limite NON parte nemmeno: si spiega al genitore invece di far fallire l’invio', async () => {
    const onChange = vi.fn()
    const { container } = render(
      <FileField modelId="m" value="" onChange={onChange} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), {
      target: { files: [fileDa(LIMITE_UPLOAD_BYTE + 1)] },
    })

    // Il messaggio dice qual è il problema — «troppo pesante» — non «riprova».
    await waitFor(() => expect(screen.getByText(/troppo pesante/i)).toBeInTheDocument())
    // E la richiesta non è mai partita: mandarla significherebbe farla morire sul 413,
    // consumare la rete mobile del genitore e non poter nemmeno leggere l'errore.
    expect(rete).not.toHaveBeenCalled()
  })

  it('un 413 che arriva comunque (corpo NON JSON) non diventa un SyntaxError: il messaggio resta utile', async () => {
    // Il limite lo decide la piattaforma e può cambiare sotto di noi: la seconda difesa
    // deve reggere anche quando il controllo a monte non ha scattato.
    rete.mockResolvedValue(risposta413())
    const onChange = vi.fn()
    const { container } = render(
      <FileField modelId="m" value="" onChange={onChange} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(1024)] } })

    await waitFor(() => expect(screen.getByText(/troppo pesante/i)).toBeInTheDocument())
    expect(rete).toHaveBeenCalledTimes(1)
  })

  it('un errore del server con corpo JSON continua a mostrare il messaggio del server', async () => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Tipo di file non ammesso (PDF o immagini)' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const { container } = render(
      <FileField modelId="m" value="" onChange={vi.fn()} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(1024)] } })

    await waitFor(() => expect(screen.getByText(/Tipo di file non ammesso/i)).toBeInTheDocument())
  })

  it('il percorso felice resta intatto: il path torna al form', async () => {
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'iscrizioni/m/uuid-certificato.pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const onChange = vi.fn()
    const { container } = render(
      <FileField modelId="m" value="" onChange={onChange} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(1024)] } })

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('iscrizioni/m/uuid-certificato.pdf'))
  })

  it('il limite del campo, se più stretto di quello della piattaforma, vince', async () => {
    const { container } = render(
      <FileField modelId="m" value="" onChange={vi.fn()} uploadEndpoint="/api/iscrizione/upload" maxSizeMb={1} />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(2 * 1024 * 1024)] } })

    await waitFor(() => expect(screen.getByText(/troppo pesante/i)).toBeInTheDocument())
    expect(rete).not.toHaveBeenCalled()
  })

  it('il limite della piattaforma è sotto il tetto vero misurato in produzione (5 MB → 413)', () => {
    // Non è un test tautologico: è il lock sul numero. Se un domani qualcuno lo alzasse a
    // 8 MB «per comodità», tornerebbero i 413 — e con essi 41 genitori al giorno.
    expect(LIMITE_UPLOAD_BYTE).toBeLessThan(4.5 * 1024 * 1024)
    expect(LIMITE_UPLOAD_MB).toBe(LIMITE_UPLOAD_BYTE / (1024 * 1024))
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * IL `catch` DEL COMPONENTE HA UN'IDENTITÀ SUA — e senza, in `app_log` non esisteva.
 *
 * Dopo l'estrazione di `caricaFile` i `catch` sono diventati DUE, e per un po' hanno
 * emesso la stringa IDENTICA (`modulo-allegato-upload-fallito: ${nomeErrore(err)}`), lo
 * stesso `evento: 'fetch'`, entrambi senza `stato`. Non erano «due righe uguali»: la
 * chiave del throttle di `logClient` è `${evento}|${messaggio}|${stato ?? ''}` con
 * `DEDUP_MS = 60_000`, e siccome `nomeErrore` restituisce `Error` per quasi tutto, la
 * seconda veniva SCARTATA in silenzio per un minuto. Due guasti che si riparano in posti
 * diversi — la rete/la route da una parte, il form dall'altra — si contendevano un nome
 * solo: è il modello «403 senza corpo» contro cui argomenta l'intero `src/lib/logging/**`.
 * ════════════════════════════════════════════════════════════════════════════ */

describe('FileField — quando a rompersi è l’APPLICAZIONE dell’esito', () => {
  it('un `onChange` che esplode non si maschera da caricamento fallito', async () => {
    // Il caricamento RIESCE: 200, `path` valido, `caricaFile` non ha niente da ridire.
    // Quel che si rompe è il passo dopo — il form che riceve il path — ed è un bug
    // NOSTRO, in un altro punto del codice, che non si ripara guardando la rete.
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'iscrizione/uuid/certificato.pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const onChange = vi.fn()
    // Solo la PRIMA chiamata: il `catch` ne fa una seconda (`onChange('')`) per svuotare
    // il campo, e un errore anche lì uscirebbe da `processaFile` come promise rifiutata.
    onChange.mockImplementationOnce(() => {
      throw new Error('il resolver del form ha rifiutato il valore')
    })
    const { container } = render(
      <FileField modelId="m" value="" onChange={onChange} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(2048)] } })

    await waitFor(() => expect(h.logClient).toHaveBeenCalled())
    const messaggi = h.logClient.mock.calls.map((c) => (c[0] as { messaggio: string }).messaggio)
    expect(messaggi).toContain('modulo-allegato-esito-non-applicato: Error')
    // E NON il nome dell'altro guasto: se torna quello, la riga sparisce dietro al
    // throttle ogni volta che i due capitano nello stesso minuto — cioè proprio quando
    // stanno succedendo davvero.
    expect(messaggi.some((m) => m.startsWith('modulo-allegato-upload-fallito'))).toBe(false)
  })

  it('il controllo non resta bloccato dopo il guasto: `uploading` torna giù', async () => {
    // `handleFile` comincia con `if (uploading) return`, e `setUploading(false)` vive nel
    // solo `finally`. Se un ramo d'errore saltasse quel `finally`, il campo resterebbe
    // inerte per sempre — lo stesso stato terminale che il tetto di tempo esiste per
    // impedire sul versante della rete.
    rete.mockResolvedValue(
      new Response(JSON.stringify({ path: 'p' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const onChange = vi.fn()
    onChange.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const { container } = render(
      <FileField modelId="m" value="" onChange={onChange} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(2048)] } })
    await waitFor(() => expect(h.logClient).toHaveBeenCalled())

    // Un secondo tentativo deve poter partire: è la prova che la guardia si è riaperta.
    rete.mockClear()
    fireEvent.change(inputFile(container), { target: { files: [fileDa(4096)] } })
    await waitFor(() => expect(rete).toHaveBeenCalledTimes(1))
  })
})

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LA PORTA ANONIMA PARLA ANCHE INGLESE — e fino al 13/08/2026 no          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `FileField` sta sui due wizard PUBBLICI e sui moduli delle famiglie, cioè sulle
 * uniche schermate che si aprono senza sessione, e il catalogo inglese di
 * `parentForms` è completo. Il messaggio d'errore però usciva come
 * `esito.messaggioServer ?? t('caricamentoNonRiuscito')`: la prosa del server
 * riversata in pagina così com'è. Quella prosa nasce dove il locale non esiste ed è
 * ITALIANA PER COSTRUZIONE — è il fallimento F2 del collaudo del 31/07/2026, lasciato
 * aperto proprio sulla porta anonima mentre il chiamante gemello di `caricaFile` (il
 * tab «Documento» della scheda staff) traduceva già.
 *
 * ⚠️ NESSUN TEST LO COPRIVA. Il caso qui sopra («un errore del server con corpo JSON
 * continua a mostrare il messaggio del server») usa un corpo SENZA `codice`, quindi
 * era verde sia col difetto sia senza: è il ramo di ripiego, non la traduzione.
 *
 * La lingua si prende da `document.documentElement.lang` (`@/lib/ui/esito-fetch`), che
 * `RootLayout` scrive da `getLocale()`: qui la si stabilisce a mano, ed è l'unico modo
 * di misurare in jsdom la cosa che conta — che chi ha l'interfaccia in inglese non
 * legga italiano.
 */
describe('FileField — il codice del server si traduce, la prosa non si mostra e basta', () => {
  const linguaOriginale = document.documentElement.getAttribute('lang')
  afterEach(() => {
    if (linguaOriginale === null) document.documentElement.removeAttribute('lang')
    else document.documentElement.setAttribute('lang', linguaOriginale)
  })

  /** La risposta VERA di `verificaAllegatoPubblico`: prosa italiana + codice dichiarato. */
  function risposta415ConCodice(): Response {
    return new Response(
      JSON.stringify({
        error:
          'Questo tipo di file non si può allegare: sono ammessi PDF e immagini (JPG, PNG, WEBP, HEIC)',
        codice: 'ALLEGATO_PDF_O_IMMAGINE',
      }),
      { status: 415, headers: { 'content-type': 'application/json' } },
    )
  }

  it('interfaccia INGLESE: si legge la frase di catalogo inglese, non l’italiano del server', async () => {
    document.documentElement.setAttribute('lang', 'en')
    rete.mockResolvedValue(risposta415ConCodice())
    const { container } = render(
      <FileField modelId="m" value="" onChange={vi.fn()} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(1024)] } })

    await waitFor(() =>
      expect(screen.getByText(enShared.erroreAllegatoPdfOImmagine)).toBeInTheDocument(),
    )
    // …e l'italiano del server NON compare: è la metà che conta del rilievo. Senza
    // questa riga la prova resterebbe verde su un prodotto che mostra entrambe.
    expect(screen.queryByText(/non si può allegare/i)).toBeNull()
  })

  it('interfaccia ITALIANA: la frase è quella del catalogo, e resta italiana', async () => {
    document.documentElement.setAttribute('lang', 'it')
    rete.mockResolvedValue(risposta415ConCodice())
    const { container } = render(
      <FileField modelId="m" value="" onChange={vi.fn()} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(1024)] } })

    await waitFor(() =>
      expect(screen.getByText(itShared.erroreAllegatoPdfOImmagine)).toBeInTheDocument(),
    )
  })

  it('il 429 del tetto di frequenza si traduce anche lui', async () => {
    // `TROPPE_RICHIESTE` arriva da `rispostaTroppiCaricamenti`, cioè dalla stessa porta
    // anonima: un genitore che sbatte contro il tetto non deve leggere italiano se ha
    // scelto l'inglese.
    document.documentElement.setAttribute('lang', 'en')
    rete.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'Troppi caricamenti. Riprova tra qualche minuto.',
          codice: 'TROPPE_RICHIESTE',
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    )
    const { container } = render(
      <FileField modelId="m" value="" onChange={vi.fn()} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(1024)] } })

    await waitFor(() =>
      expect(screen.getByText(enShared.erroreTroppeRichieste)).toBeInTheDocument(),
    )
  })

  it('senza codice la prosa del server RESTA: toglierla sarebbe un difetto scambiato con un altro', async () => {
    // `/api/forms/upload` non manda ancora nessun codice, e la sua prosa dice cose che il
    // ripiego generico non sa («Tipo di file non ammesso»). La regola giusta è
    // `messaggioDaCorpo` — catalogo se c'è, altrimenti prosa, altrimenti ripiego — non
    // `soloCatalogoDaCorpo`, che qui sostituirebbe un messaggio utile con uno vuoto.
    // La strada per chiudere il residuo è DICHIARARE il codice, non nascondere la frase.
    document.documentElement.setAttribute('lang', 'it')
    rete.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Tipo di file non ammesso (PDF o immagini)' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const { container } = render(
      <FileField modelId="m" value="" onChange={vi.fn()} uploadEndpoint="/api/forms/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(1024)] } })

    await waitFor(() =>
      expect(screen.getByText(/Tipo di file non ammesso/i)).toBeInTheDocument(),
    )
  })

  it('né codice né prosa: si ripiega sulla frase TRADOTTA del componente, mai sul vuoto', async () => {
    // Un 500 senza corpo JSON leggibile. Il ripiego non è mai la stringa vuota, che a
    // schermo è indistinguibile dal silenzio — e passa da `useTranslations`, quindi è
    // già nella lingua giusta.
    document.documentElement.setAttribute('lang', 'it')
    rete.mockResolvedValue(new Response('', { status: 500 }))
    const { container } = render(
      <FileField modelId="m" value="" onChange={vi.fn()} uploadEndpoint="/api/iscrizione/upload" />,
    )

    fireEvent.change(inputFile(container), { target: { files: [fileDa(1024)] } })

    await waitFor(() =>
      expect(screen.getByText(itParentForms.caricamentoNonRiuscito)).toBeInTheDocument(),
    )
  })
})
