'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Download, FileText } from 'lucide-react'
import { FatturaViewer } from '@/components/features/pagamenti/FatturaViewer'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { registraEsitoFattura } from '@/lib/pagamenti/esito-fattura'
import {
  presentazioneSalvataggioFattura,
  salvaFattura,
  urlFattura,
  useFattureScaricabili,
  type AvvisoScarico,
  type FatturaScaricabile,
  type ScartoFattura,
} from '@/lib/pagamenti/scarico-fattura'

const PILL = 'inline-flex min-h-8 items-center gap-1 rounded-full bg-kidville-green/10 px-3 py-1 font-maven text-xs font-bold text-kidville-green transition-colors hover:bg-kidville-green/20 disabled:cursor-wait disabled:opacity-60'
const LINK_MENU = 'inline-flex min-h-8 items-center gap-1 font-maven text-xs font-bold text-kidville-green hover:underline disabled:cursor-wait disabled:opacity-60'

const CHIAVI_AVVISO: Record<AvvisoScarico, string> = {
  'in-corso': 'fatturaScaricoInCorso',
  'non-consegnato': 'fatturaScaricoNonConsegnato',
  'non-riuscito': 'fatturaScaricoNonRiuscito',
}

export interface FatturaDocumentiProps {
  pagamentoId: string
  userId: string
  aspetto: 'genitore' | 'segreteria'
  renderScarti?: (scarti: ScartoFattura[]) => ReactNode
}

interface DocumentoAperto {
  chiavePagamento: string
  documento: FatturaScaricabile
}

export function FatturaDocumenti({
  pagamentoId,
  userId,
  aspetto,
  renderScarti,
}: FatturaDocumentiProps) {
  const t = useTranslations('pagamenti')
  const { caricamento, scaricabili, scarti } = useFattureScaricabili(pagamentoId, userId)
  const chiavePagamento = `${pagamentoId}|${userId}`
  const [aperto, setAperto] = useState<DocumentoAperto | null>(null)
  const [menuAperto, setMenuAperto] = useState(false)
  const [salvataggioInCorso, setSalvataggioInCorso] = useState<string | null>(null)
  const [avviso, setAvviso] = useState<AvvisoScarico | null>(null)
  const [chiaveApplicata, setChiaveApplicata] = useState(chiavePagamento)
  const controllerRef = useRef<AbortController | null>(null)
  const presentazione = presentazioneSalvataggioFattura()
  const etichettaScarica = presentazione.modalita === 'browser-esterno'
    ? t('fatturaApriBrowserSalvare')
    : t('fatturaScarica')

  if (chiaveApplicata !== chiavePagamento) {
    setChiaveApplicata(chiavePagamento)
    setAperto(null)
    setMenuAperto(false)
    setSalvataggioInCorso(null)
    setAvviso(null)
  }

  useEffect(() => () => {
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [pagamentoId, userId])

  const annullaSalvataggio = () => {
    controllerRef.current?.abort()
    controllerRef.current = null
    setSalvataggioInCorso(null)
  }

  const apriDocumento = (documento: FatturaScaricabile) => {
    annullaSalvataggio()
    setAvviso(null)
    setMenuAperto(false)
    setAperto({ chiavePagamento, documento })
  }

  const salvaDocumento = async (documento: FatturaScaricabile) => {
    annullaSalvataggio()
    setAvviso(null)
    const controller = new AbortController()
    controllerRef.current = controller
    setSalvataggioInCorso(documento.id)
    try {
      const risultato = await salvaFattura({
        pagamentoId,
        fatturaId: documento.id,
        userId,
        numero: documento.numero,
        anno: documento.anno,
        titolo: t('fattura'),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      if (!risultato.ok && risultato.avviso) setAvviso(risultato.avviso)
    } catch (errore) {
      if (controller.signal.aborted) return
      logClient({
        livello: 'error',
        evento: 'js',
        messaggio: 'fattura-salvataggio-ui-fallito',
        campi: { error_code: nomeErrore(errore) },
      })
      setAvviso('non-riuscito')
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null
        setSalvataggioInCorso(null)
      }
    }
  }

  const documentoAperto = aperto?.chiavePagamento === chiavePagamento
    ? scaricabili.find((documento) => documento.id === aperto.documento.id) ?? null
    : null

  if (caricamento) return null

  const scartiResi = renderScarti?.(scarti) ?? null
  if (scaricabili.length === 0) return <>{scartiResi}</>

  const azioni = (documento: FatturaScaricabile, nelMenu = false) => {
    const classe = nelMenu ? LINK_MENU : PILL
    const occupato = salvataggioInCorso === documento.id
    return (
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <button type="button" onClick={() => apriDocumento(documento)} className={classe}>
          <FileText size={13} aria-hidden="true" /> {t('fatturaApri')}
        </button>
        <button
          type="button"
          onClick={() => { void salvaDocumento(documento) }}
          disabled={occupato}
          className={classe}
        >
          <Download size={13} aria-hidden="true" /> {etichettaScarica}
        </button>
      </div>
    )
  }

  const corpo = aspetto === 'segreteria' && scaricabili.length > 1
    ? (
      <div className="relative inline-block">
        <button type="button" onClick={() => setMenuAperto((corrente) => !corrente)} className={PILL}>
          <Download size={13} aria-hidden="true" /> {t('fatture')} ({scaricabili.length})
        </button>
        {menuAperto && (
          <div className="absolute right-0 z-20 mt-1 w-72 rounded-card border border-kidville-line bg-kidville-white p-1 shadow-lg">
            {scaricabili.map((documento) => (
              <div key={documento.id} className="rounded-input px-3 py-1.5">
                <p className="font-maven text-xs text-kidville-ink">
                  {t('fatturaConEtichetta', { etichetta: documento.quota_label || documento.intestatario })}
                </p>
                {azioni(documento, true)}
              </div>
            ))}
          </div>
        )}
      </div>
    )
    : (
      <div className={aspetto === 'genitore' ? 'flex flex-col items-end gap-1.5' : 'inline-flex flex-wrap items-center gap-1'}>
        {scaricabili.map((documento) => (
          <div key={documento.id} className="flex flex-wrap items-center justify-end gap-1.5">
            {aspetto === 'genitore' && (
              <span className="font-maven text-[11px] text-kidville-sub">
                {scaricabili.length === 1
                  ? t('fattura')
                  : t('fatturaConEtichetta', { etichetta: documento.quota_label || documento.intestatario })}
              </span>
            )}
            {azioni(documento)}
          </div>
        ))}
      </div>
    )

  return (
    <div className={aspetto === 'genitore' ? 'flex flex-col items-end gap-1' : 'inline-flex flex-col items-start gap-1'}>
      {corpo}
      {!documentoAperto && (
        <p role="alert" className={`font-maven text-[11px] text-kidville-error-strong ${avviso ? '' : 'sr-only'}`}>
          {avviso ? t(CHIAVI_AVVISO[avviso]) : ''}
        </p>
      )}
      {scartiResi}
      {documentoAperto && (
        <FatturaViewer
          key={`${chiavePagamento}|${documentoAperto.id}`}
          open
          onClose={() => setAperto(null)}
          url={urlFattura({ pagamentoId, fatturaId: documentoAperto.id, userId })}
          titolo={t('fattura')}
          onScarica={() => { void salvaDocumento(documentoAperto) }}
          etichettaScarica={etichettaScarica}
          scaricamentoInCorso={salvataggioInCorso === documentoAperto.id}
          avvisoScarico={avviso ? t(CHIAVI_AVVISO[avviso]) : null}
          onEsito={(esito) => {
            void registraEsitoFattura({
              pagamentoId,
              fatturaId: documentoAperto.id,
              esito,
            })
          }}
        />
      )}
    </div>
  )
}
