'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronLeft, ChevronRight, Download, Minus, Plus, RotateCw, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { caricaMotorePdf, type MotorePdf } from '@/lib/pagamenti/pdf-renderer'

type DocumentoPdf = Awaited<ReturnType<MotorePdf>> & {
  destroy?: () => Promise<void>
}
type PaginaPdf = Awaited<ReturnType<DocumentoPdf['getPage']>>
type RenderPdf = ReturnType<PaginaPdf['render']>
type Stadio = 'fetch' | 'risposta' | 'contenuto' | 'motore' | 'documento' | 'render' | 'testo' | 'pulizia'

const TIMEOUT_MS = 25_000;
const PIXEL_MASSIMI = 16_000_000
const ZOOM_MIN = 0.75
const ZOOM_MAX = 2.5
const PASSO_ZOOM = 0.25

class ErroreFatturaViewer extends Error {
  constructor(
    readonly stadio: Stadio,
    readonly stato?: number,
    readonly codice = 'ErroreFatturaViewer',
  ) {
    super('fattura-viewer-fallito')
    this.name = 'ErroreFatturaViewer'
  }
}

export interface FatturaViewerProps {
  open: boolean
  onClose: () => void
  url: string
  titolo?: string
  onScarica?: () => void
  etichettaScarica?: string
  scaricamentoInCorso?: boolean
  avvisoScarico?: string | null
  onEsito?: (esito: 'visualizzata' | 'annullata') => void
}

function eAbort(errore: unknown): boolean {
  return (errore as { name?: unknown } | null)?.name === 'AbortError'
}

function registraErrore(errore: unknown, stadioFallback: Stadio): void {
  const noto = errore instanceof ErroreFatturaViewer ? errore : null
  logClient({
    livello: 'error',
    evento: 'js',
    messaggio: 'fattura-viewer-fallito',
    stato: noto?.stato,
    campi: {
      operazione: noto?.stadio ?? stadioFallback,
      error_code: noto?.codice ?? nomeErrore(errore),
    },
  })
}

function distruggiDocumento(documento: DocumentoPdf): void {
  const distruzione = documento.destroy?.() ?? documento.loadingTask.destroy()
  void distruzione.catch((errore: unknown) => {
    registraErrore(errore, 'pulizia')
  })
}

function annullaRender(render: RenderPdf | null): void {
  if (!render) return
  try {
    render.cancel()
  } catch (errore) {
    registraErrore(errore, 'pulizia')
  }
}

export function FatturaViewer({
  open,
  onClose,
  url,
  titolo,
  onScarica,
  etichettaScarica,
  scaricamentoInCorso = false,
  avvisoScarico,
  onEsito,
}: FatturaViewerProps) {
  const t = useTranslations('pagamenti')
  const titoloId = useId()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderRef = useRef<RenderPdf | null>(null)
  const visualizzataRef = useRef(false)
  const annullataRef = useRef(false)
  const onEsitoRef = useRef(onEsito)
  const [documento, setDocumento] = useState<{ url: string; pdf: DocumentoPdf } | null>(null)
  const [pagina, setPagina] = useState(1)
  const [totalePagine, setTotalePagine] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [paginaPronta, setPaginaPronta] = useState<number | null>(null)
  const [testoPagina, setTestoPagina] = useState('')
  const [errore, setErrore] = useState(false)
  const [tentativo, setTentativo] = useState(0)
  const chiaveRichiesta = open ? `${tentativo}\u0000${url}` : null
  const [chiaveApplicata, setChiaveApplicata] = useState<string | null>(chiaveRichiesta)

  if (chiaveRichiesta !== chiaveApplicata) {
    setChiaveApplicata(chiaveRichiesta)
    setDocumento(null)
    setPagina(1)
    setTotalePagine(0)
    setZoom(1)
    setPaginaPronta(null)
    setTestoPagina('')
    setErrore(false)
  }

  useEffect(() => {
    onEsitoRef.current = onEsito
  }, [onEsito])

  const chiudi = useCallback(() => {
    if (open && !visualizzataRef.current && !annullataRef.current) {
      annullataRef.current = true
      onEsitoRef.current?.('annullata')
    }
    onClose()
  }, [onClose, open])

  useEffect(() => {
    if (!open) return

    let dismesso = false
    let documentoCaricato: DocumentoPdf | null = null
    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      controller.abort()
    }, TIMEOUT_MS)

    visualizzataRef.current = false
    annullataRef.current = false

    async function carica() {
      try {
        let risposta: Response
        try {
          risposta = await fetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/pdf' },
            signal: controller.signal,
          })
        } catch (causa) {
          if (dismesso && eAbort(causa)) return
          throw new ErroreFatturaViewer('fetch', undefined, nomeErrore(causa))
        }

        const tipo = risposta.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (!risposta.ok || tipo !== 'application/pdf') {
          throw new ErroreFatturaViewer('risposta', risposta.status)
        }

        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(await risposta.arrayBuffer())
        } catch {
          throw new ErroreFatturaViewer('contenuto', risposta.status, 'ArrayBufferError')
        }

        let getDocumentProxy: MotorePdf
        try {
          getDocumentProxy = await caricaMotorePdf()
        } catch (causa) {
          throw new ErroreFatturaViewer('motore', undefined, nomeErrore(causa))
        }

        let pdf: DocumentoPdf
        try {
          const opzioni = { isEvalSupported: false } as NonNullable<Parameters<MotorePdf>[1]> & {
            isEvalSupported: false
          }
          pdf = await getDocumentProxy(bytes, opzioni)
        } catch (causa) {
          throw new ErroreFatturaViewer('documento', undefined, nomeErrore(causa))
        }

        if (dismesso) {
          distruggiDocumento(pdf)
          return
        }
        documentoCaricato = pdf
        setTotalePagine(pdf.numPages)
        setDocumento({ url, pdf })
      } catch (causa) {
        if (dismesso && eAbort(causa)) return
        if (!dismesso) {
          registraErrore(causa, 'documento')
          setErrore(true)
        }
      } finally {
        window.clearTimeout(timeout)
      }
    }

    void carica()

    return () => {
      dismesso = true
      window.clearTimeout(timeout)
      controller.abort()
      annullaRender(renderRef.current)
      renderRef.current = null
      if (documentoCaricato) distruggiDocumento(documentoCaricato)
    }
  }, [open, tentativo, url])

  const documentoCorrente = open && documento?.url === url ? documento.pdf : null

  useEffect(() => {
    if (!documentoCorrente || errore) return

    let dismesso = false
    annullaRender(renderRef.current)
    renderRef.current = null

    async function renderizza() {
      try {
        const paginaPdf = await documentoCorrente!.getPage(pagina)
        if (dismesso) return
        const viewport = paginaPdf.getViewport({ scale: zoom })
        const canvas = canvasRef.current
        const contesto = canvas?.getContext('2d')
        if (!canvas || !contesto) throw new ErroreFatturaViewer('render')

        const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2)
        const limiteArea = Math.sqrt(PIXEL_MASSIMI / Math.max(viewport.width * viewport.height, 1))
        const rapportoPixel = Math.min(dpr, limiteArea)
        canvas.width = Math.max(1, Math.floor(viewport.width * rapportoPixel))
        canvas.height = Math.max(1, Math.floor(viewport.height * rapportoPixel))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`

        const render = paginaPdf.render({
          canvas,
          canvasContext: contesto,
          viewport,
          transform: rapportoPixel === 1 ? undefined : [rapportoPixel, 0, 0, rapportoPixel, 0, 0],
        })
        renderRef.current = render

        // I due lavori partono insieme e, soprattutto, hanno entrambi un handler
        // nello stesso turno. PDF.js fa rigettare `render.promise` quando
        // `cancel()` viene chiamato: aspettare prima `getTextContent()` lasciava
        // quella rejection orfana se il testo falliva o restava pendente durante
        // la chiusura del viewer.
        const promessaRender = render.promise
        const promessaTesto = Promise.resolve()
          .then(() => paginaPdf.getTextContent())
          .catch((causa) => {
            throw new ErroreFatturaViewer('testo', undefined, nomeErrore(causa))
          })

        let contenutoTestuale
        try {
          const risultati = await Promise.all([promessaRender, promessaTesto])
          contenutoTestuale = risultati[1]
        } catch (causa) {
          // Se il testo fallisce mentre il viewer è vivo, libera il renderer. In
          // cleanup `dismesso` è già true e il render è già stato cancellato:
          // richiamarlo qui sarebbe un secondo cancel sulla stessa task.
          if (!dismesso && causa instanceof ErroreFatturaViewer && causa.stadio === 'testo') {
            annullaRender(render)
          }
          throw causa
        }
        if (dismesso) return

        const testo = contenutoTestuale.items
          .filter((elemento): elemento is (typeof contenutoTestuale.items)[number] & { str: string } =>
            'str' in elemento && typeof elemento.str === 'string',
          )
          .map((elemento) => elemento.str)
          .join(' ')
        setTestoPagina(testo)
        setPaginaPronta(pagina)
        if (pagina === 1 && !visualizzataRef.current) {
          visualizzataRef.current = true
          onEsitoRef.current?.('visualizzata')
        }
      } catch (causa) {
        const cancellato = eAbort(causa) || nomeErrore(causa) === 'RenderingCancelledException'
        if (!dismesso && !cancellato) {
          registraErrore(causa, causa instanceof ErroreFatturaViewer ? causa.stadio : 'render')
          setErrore(true)
        }
      } finally {
        if (!dismesso) renderRef.current = null
      }
    }

    void renderizza()
    return () => {
      dismesso = true
      annullaRender(renderRef.current)
      renderRef.current = null
    }
  }, [documentoCorrente, errore, pagina, zoom])

  const riprova = () => {
    setErrore(false)
    setDocumento(null)
    setPaginaPronta(null)
    setTestoPagina('')
    setTentativo((corrente) => corrente + 1)
  }

  const cambiaPagina = (nuovaPagina: number) => {
    setPaginaPronta(null)
    setTestoPagina('')
    setPagina(nuovaPagina)
  }

  const cambiaZoom = (nuovoZoom: number) => {
    setPaginaPronta(null)
    setTestoPagina('')
    setZoom(nuovoZoom)
  }

  const pronta = Boolean(documentoCorrente && paginaPronta === pagina && !errore)
  const caricamento = open && !errore && !pronta
  const titoloDialogo = titolo ?? t('fatturaViewerTitolo')

  return (
    <Modal
      open={open}
      onClose={chiudi}
      title={titoloDialogo}
      labelledBy={titoloId}
      safeArea
      // Safari 15.0–15.3 ignora `dvh`: la classe `vh` resta quindi il limite
      // effettivo sulla baseline iOS 15. Da Safari 15.4 il feature query applica
      // l'altezza dinamica, che segue le barre mobili senza cambiare il fallback.
      // Il limite sottrae gli stessi inset usati dal contenitore: intestazione e
      // controlli non possono quindi finire sotto notch o home indicator.
      className="flex max-h-[calc(100vh_-_max(1rem,env(safe-area-inset-top))_-_max(1rem,env(safe-area-inset-bottom)))] supports-[height:100dvh]:max-h-[calc(100dvh_-_max(1rem,env(safe-area-inset-top))_-_max(1rem,env(safe-area-inset-bottom)))] w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-kidville-white shadow-2xl"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-kidville-line px-4 py-3 sm:px-5">
        <h2 id={titoloId} className="min-w-0 flex-1 truncate font-barlow text-lg font-black text-kidville-ink">
          {titoloDialogo}
        </h2>
        {onScarica && (
          <button
            type="button"
            onClick={onScarica}
            disabled={scaricamentoInCorso}
            aria-busy={scaricamentoInCorso || undefined}
            aria-label={etichettaScarica ?? t('fatturaScarica')}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-kidville-line px-3 font-barlow text-sm font-bold text-kidville-ink disabled:cursor-wait disabled:opacity-60"
          >
            <Download size={17} aria-hidden="true" />
            <span aria-hidden="true" className="hidden sm:inline">{etichettaScarica ?? t('fatturaScarica')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={chiudi}
          aria-label={t('fatturaViewerChiudi')}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-kidville-line text-kidville-ink"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>

      {avvisoScarico && (
        <p role="alert" className="shrink-0 border-b border-kidville-line px-4 py-2 font-maven text-sm font-bold text-kidville-error-strong sm:px-5">
          {avvisoScarico}
        </p>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto bg-kidville-cream p-3 sm:p-5">
        {caricamento && (
          <div role="status" className="flex min-h-64 items-center justify-center font-barlow font-semibold text-kidville-sub">
            {documentoCorrente ? t('fatturaViewerPreparazione') : t('fatturaViewerCaricamento')}
          </div>
        )}
        {errore && (
          <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
            <p role="alert" className="font-barlow font-bold text-kidville-error-strong">
              {t('fatturaViewerErrore')}
            </p>
            <button
              type="button"
              onClick={riprova}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-kidville-green px-5 font-barlow text-sm font-black text-kidville-white"
            >
              <RotateCw size={16} aria-hidden="true" /> {t('fatturaViewerRiprova')}
            </button>
          </div>
        )}
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className={`mx-auto bg-white shadow-sm ${pronta ? 'block' : 'hidden'}`}
        />
        {pronta && (
          <section className="sr-only" aria-label={t('fatturaViewerTestoPagina', { pagina })}>
            {testoPagina}
          </section>
        )}
      </div>

      {documentoCorrente && !errore && (
        <footer className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-kidville-line px-3 py-3 sm:justify-between sm:px-5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t('fatturaViewerPrecedente')}
              disabled={!pronta || pagina <= 1}
              onClick={() => cambiaPagina(pagina - 1)}
              className="inline-flex size-11 items-center justify-center rounded-full border border-kidville-line text-kidville-ink disabled:opacity-40"
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <span aria-live="polite" className="min-w-28 text-center font-barlow text-sm font-bold text-kidville-ink">
              {t('fatturaViewerPagina', { corrente: pagina, totale: totalePagine })}
            </span>
            <button
              type="button"
              aria-label={t('fatturaViewerSuccessiva')}
              disabled={!pronta || pagina >= totalePagine}
              onClick={() => cambiaPagina(pagina + 1)}
              className="inline-flex size-11 items-center justify-center rounded-full border border-kidville-line text-kidville-ink disabled:opacity-40"
            >
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={t('fatturaViewerZoomMeno')}
              disabled={!pronta || zoom <= ZOOM_MIN}
              onClick={() => cambiaZoom(Math.max(ZOOM_MIN, zoom - PASSO_ZOOM))}
              className="inline-flex size-11 items-center justify-center rounded-full border border-kidville-line text-kidville-ink disabled:opacity-40"
            >
              <Minus size={18} aria-hidden="true" />
            </button>
            <span className="min-w-14 text-center font-barlow text-sm font-bold text-kidville-ink">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              aria-label={t('fatturaViewerZoomPiu')}
              disabled={!pronta || zoom >= ZOOM_MAX}
              onClick={() => cambiaZoom(Math.min(ZOOM_MAX, zoom + PASSO_ZOOM))}
              className="inline-flex size-11 items-center justify-center rounded-full border border-kidville-line text-kidville-ink disabled:opacity-40"
            >
              <Plus size={18} aria-hidden="true" />
            </button>
          </div>
        </footer>
      )}
    </Modal>
  )
}
