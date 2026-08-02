import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FileField } from '@/components/features/forms/FieldRenderer'
import { LIMITE_UPLOAD_BYTE, LIMITE_UPLOAD_MB } from '@/lib/upload/limite-piattaforma'

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
