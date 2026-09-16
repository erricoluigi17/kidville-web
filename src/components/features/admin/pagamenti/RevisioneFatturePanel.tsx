'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Eye, FileSearch, RefreshCw, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { FatturaViewer } from '@/components/features/pagamenti/FatturaViewer'
import { Modal } from '@/components/ui/Modal'
import { useDateFormat } from '@/lib/i18n/date'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { registraEsitoFattura } from '@/lib/pagamenti/esito-fattura'
import type {
  ElencoRevisioneFattureWire,
  FatturaRevisioneWire,
  StatoRevisioneFattura,
} from '@/lib/pagamenti/revisione-fatture'
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch'
import { cx } from '@/lib/ui/cx'
import {
  BTN_PRIMARY_AA,
  BTN_SECONDARY,
  MODAL_CARD,
  MODAL_SHADOW,
  SELECT,
} from './ui'

interface Props {
  userId: string
  scuolaId: string
}

interface PropsCiclo extends Props {
  aperto: boolean
  onApri: () => void
  onChiudi: () => void
}

interface ElencoCaricato {
  scuolaId: string
  pagina: number
  data: ElencoRevisioneFattureWire
}

interface OperazioneClient {
  controller: AbortController
  ciclo: number
}

interface ConfermaAttivazione {
  scuolaId: string
  userId: string
  irrisolte: ElencoRevisioneFattureWire['irrisolte']
}

interface FatturaAperta {
  scuolaId: string
  userId: string
  fattura: FatturaRevisioneWire
}

type ModalitaScelta = Exclude<StatoRevisioneFattura, 'da_verificare'> | ''

const PER_PAGINA = 25

async function corpoJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function registraErroreClient(messaggio: string, errore: unknown, stato: number): void {
  logClient({
    livello: stato >= 500 || stato === 0 ? 'error' : 'warn',
    evento: 'fetch',
    messaggio,
    stato,
    campi: { error_code: nomeErrore(errore) },
  })
}

export function RevisioneFatturePanel(props: Props) {
  const [aperto, setAperto] = useState(false)

  return (
    <RevisioneFatturePanelCiclo
      key={`${props.userId}:${props.scuolaId}`}
      {...props}
      aperto={aperto}
      onApri={() => setAperto(true)}
      onChiudi={() => setAperto(false)}
    />
  )
}

function RevisioneFatturePanelCiclo({
  userId,
  scuolaId,
  aperto,
  onApri,
  onChiudi,
}: PropsCiclo) {
  const t = useTranslations('adminContabilita')
  const { dataOra } = useDateFormat()
  const [pagina, setPagina] = useState(1)
  const [ricarica, setRicarica] = useState(0)
  const [caricato, setCaricato] = useState<ElencoCaricato | null>(null)
  const [loading, setLoading] = useState(false)
  const [erroreCaricamento, setErroreCaricamento] = useState<string | null>(null)
  const [erroreOperazione, setErroreOperazione] = useState<string | null>(null)
  const [fatturaInSalvataggio, setFatturaInSalvataggio] = useState<string | null>(null)
  const [attivazioneInCorso, setAttivazioneInCorso] = useState(false)
  const [confermaAttivazione, setConfermaAttivazione] = useState<ConfermaAttivazione | null>(null)
  const [fatturaAperta, setFatturaAperta] = useState<FatturaAperta | null>(null)
  const cicloRef = useRef(0)
  const apertoRef = useRef(aperto)
  const montatoRef = useRef(true)
  const controllerRef = useRef(new Set<AbortController>())
  const testoErroreCaricamento = t('revisioneFattureErroreCaricamento')

  const data = caricato?.scuolaId === scuolaId && caricato.pagina === pagina
    ? caricato.data
    : null
  const confermaCorrente = confermaAttivazione?.scuolaId === scuolaId
    && confermaAttivazione.userId === userId
    ? confermaAttivazione
    : null
  const fatturaCorrente = fatturaAperta?.scuolaId === scuolaId
    && fatturaAperta.userId === userId
    ? fatturaAperta
    : null

  const annullaOperazioni = useCallback(() => {
    cicloRef.current += 1
    for (const controller of controllerRef.current) controller.abort()
    controllerRef.current.clear()
  }, [])

  const iniziaOperazione = useCallback((): OperazioneClient => {
    const controller = new AbortController()
    controllerRef.current.add(controller)
    return { controller, ciclo: cicloRef.current }
  }, [])

  const operazioneCorrente = useCallback((operazione: OperazioneClient): boolean => (
    montatoRef.current
      && apertoRef.current
      && !operazione.controller.signal.aborted
      && cicloRef.current === operazione.ciclo
  ), [])

  useEffect(() => {
    montatoRef.current = true
    apertoRef.current = aperto
    return () => {
      montatoRef.current = false
      apertoRef.current = false
      annullaOperazioni()
    }
  }, [annullaOperazioni, aperto])

  useEffect(() => {
    if (!aperto) return
    const operazione = iniziaOperazione()
    const controllers = controllerRef.current

    void (async () => {
      setLoading(true)
      setErroreCaricamento(null)
      setCaricato(null)
      try {
        const params = new URLSearchParams({
          scuola_id: scuolaId,
          pagina: String(pagina),
          per_pagina: String(PER_PAGINA),
        })
        const response = await fetch(`/api/pagamenti/fattura/revisione?${params}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'x-user-id': userId },
          signal: operazione.controller.signal,
        })
        const body = await corpoJson(response) as {
          success?: boolean
          data?: ElencoRevisioneFattureWire
        } | null
        if (!operazioneCorrente(operazione)) return
        if (!response.ok || body?.success !== true || !body.data) {
          setErroreCaricamento(testoErroreCaricamento)
          registraErroreClient(
            'fatture-revisione-caricamento-fallito',
            new Error('RispostaHttp'),
            response.status,
          )
          return
        }
        setCaricato({ scuolaId, pagina, data: body.data })
      } catch (errore) {
        if (!operazioneCorrente(operazione) || (errore as { name?: unknown })?.name === 'AbortError') return
        setErroreCaricamento(testoErroreCaricamento)
        registraErroreClient('fatture-revisione-caricamento-fallito', errore, 0)
      } finally {
        controllers.delete(operazione.controller)
        if (operazioneCorrente(operazione)) setLoading(false)
      }
    })()

    return () => {
      operazione.controller.abort()
      controllers.delete(operazione.controller)
    }
  }, [aperto, iniziaOperazione, operazioneCorrente, pagina, ricarica, scuolaId, testoErroreCaricamento, userId])

  const apri = () => {
    annullaOperazioni()
    apertoRef.current = true
    setPagina(1)
    setCaricato(null)
    setLoading(false)
    setErroreCaricamento(null)
    setErroreOperazione(null)
    setFatturaInSalvataggio(null)
    setAttivazioneInCorso(false)
    setConfermaAttivazione(null)
    setFatturaAperta(null)
    onApri()
  }

  const chiudi = () => {
    apertoRef.current = false
    annullaOperazioni()
    onChiudi()
    setCaricato(null)
    setLoading(false)
    setErroreCaricamento(null)
    setErroreOperazione(null)
    setFatturaInSalvataggio(null)
    setAttivazioneInCorso(false)
    setConfermaAttivazione(null)
    setFatturaAperta(null)
  }

  const aggiorna = useCallback(() => {
    setCaricato(null)
    setRicarica((valore) => valore + 1)
  }, [])

  const salva = useCallback(async (
    fattura: FatturaRevisioneWire,
    modalita: Exclude<StatoRevisioneFattura, 'da_verificare'>,
    parentRegistryId: string | null,
  ) => {
    const operazione = iniziaOperazione()
    setErroreOperazione(null)
    setFatturaInSalvataggio(fattura.id)
    try {
      const response = await fetch('/api/pagamenti/fattura/revisione/operazione', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        signal: operazione.controller.signal,
        body: JSON.stringify({
          azione: 'salva',
          scuola_id: scuolaId,
          fattura_id: fattura.id,
          modalita,
          parent_registry_id: modalita === 'quote_separate' ? parentRegistryId : null,
        }),
      })
      const body = await corpoJson(response)
      if (!operazioneCorrente(operazione)) return
      if (!response.ok) {
        setErroreOperazione(messaggioDaCorpo(body, t('revisioneFattureErroreSalvataggio')))
        registraErroreClient(
          'fatture-revisione-salvataggio-fallito',
          new Error('RispostaHttp'),
          response.status,
        )
        if (response.status === 409) aggiorna()
        return
      }
      aggiorna()
    } catch (errore) {
      if (!operazioneCorrente(operazione) || (errore as { name?: unknown })?.name === 'AbortError') return
      setErroreOperazione(t('revisioneFattureErroreSalvataggio'))
      registraErroreClient('fatture-revisione-salvataggio-fallito', errore, 0)
    } finally {
      controllerRef.current.delete(operazione.controller)
      if (operazioneCorrente(operazione)) setFatturaInSalvataggio(null)
    }
  }, [aggiorna, iniziaOperazione, operazioneCorrente, scuolaId, t, userId])

  const attiva = useCallback(async (conferma: ConfermaAttivazione) => {
    if (
      !data
      || data.da_verificare !== 0
      || data.attiva_il
      || conferma.scuolaId !== scuolaId
      || conferma.userId !== userId
    ) return
    const operazione = iniziaOperazione()
    const irrisoltePreviste = conferma.irrisolte.map((fattura) => fattura.id)
    setErroreOperazione(null)
    setAttivazioneInCorso(true)
    try {
      const response = await fetch('/api/pagamenti/fattura/revisione/operazione', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        signal: operazione.controller.signal,
        body: JSON.stringify({
          azione: 'attiva',
          scuola_id: scuolaId,
          irrisolte_previste: irrisoltePreviste,
        }),
      })
      const body = await corpoJson(response)
      if (!operazioneCorrente(operazione)) return
      if (!response.ok) {
        setErroreOperazione(messaggioDaCorpo(body, t('revisioneFattureErroreAttivazione')))
        registraErroreClient(
          'fatture-revisione-attivazione-fallita',
          new Error('RispostaHttp'),
          response.status,
        )
        setConfermaAttivazione(null)
        if (response.status === 409) aggiorna()
        return
      }
      setConfermaAttivazione(null)
      aggiorna()
    } catch (errore) {
      if (!operazioneCorrente(operazione) || (errore as { name?: unknown })?.name === 'AbortError') return
      setErroreOperazione(t('revisioneFattureErroreAttivazione'))
      registraErroreClient('fatture-revisione-attivazione-fallita', errore, 0)
    } finally {
      controllerRef.current.delete(operazione.controller)
      if (operazioneCorrente(operazione)) setAttivazioneInCorso(false)
    }
  }, [aggiorna, data, iniziaOperazione, operazioneCorrente, scuolaId, t, userId])

  if (!aperto) {
    return (
      <section className="rounded-card border border-kidville-line bg-kidville-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-fredoka text-lg font-bold text-kidville-ink">
              {t('revisioneFattureTitolo')}
            </h3>
            <p className="mt-1 font-maven text-sm text-kidville-sub">
              {t('revisioneFattureSottotitolo')}
            </p>
          </div>
          <button type="button" className={BTN_PRIMARY_AA} onClick={apri}>
            <FileSearch size={17} aria-hidden="true" />
            {t('revisioneFattureApri')}
          </button>
        </div>
      </section>
    )
  }

  const pagine = data ? Math.max(1, Math.ceil(data.totale / data.per_pagina)) : 1

  return (
    <section className="rounded-card border border-kidville-line bg-kidville-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-fredoka text-lg font-bold text-kidville-ink">
            {t('revisioneFattureTitolo')}
          </h3>
          <p className="mt-1 font-maven text-sm text-kidville-sub">
            {t('revisioneFattureSottotitolo')}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={aggiorna}
            disabled={loading}
            aria-label={t('revisioneFattureAggiorna')}
          >
            <RefreshCw size={16} aria-hidden="true" />
            {t('revisioneFattureAggiorna')}
          </button>
          <button type="button" className={BTN_SECONDARY} onClick={chiudi}>
            <X size={16} aria-hidden="true" />
            {t('revisioneFattureChiudi')}
          </button>
        </div>
      </div>

      {erroreOperazione && (
        <p role="alert" className="mt-4 rounded-input bg-kidville-error-soft p-3 font-maven text-sm text-kidville-error-strong">
          {erroreOperazione}
        </p>
      )}

      {loading && !data ? (
        <p className="py-8 text-center font-maven text-sm text-kidville-sub" aria-live="polite">
          {t('revisioneFattureCaricamento')}
        </p>
      ) : erroreCaricamento ? (
        <div role="alert" className="mt-4 rounded-input bg-kidville-error-soft p-4 text-kidville-error-strong">
          <p className="font-maven text-sm">{erroreCaricamento}</p>
          <button type="button" className={cx(BTN_SECONDARY, 'mt-3')} onClick={aggiorna}>
            {t('revisioneFattureRiprova')}
          </button>
        </div>
      ) : data ? (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Riepilogo etichetta={t('revisioneFattureDaVerificare')} valore={data.da_verificare} />
            <Riepilogo etichetta={t('revisioneFattureRevisionate')} valore={data.revisionate} />
            <Riepilogo etichetta={t('revisioneFattureTotale')} valore={data.totale} />
          </div>

          <div className="mt-5 rounded-card border border-kidville-line bg-kidville-cream/60 p-4">
            {data.attiva_il ? (
              <p className="font-maven text-sm font-semibold text-kidville-green">
                {t('revisioneFattureAttivaDal', { data: dataOra(data.attiva_il) })}
              </p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-maven text-sm font-semibold text-kidville-ink">
                    {t('revisioneFattureNonAttiva')}
                  </p>
                  {data.da_verificare > 0 && (
                    <p className="mt-1 font-maven text-sm text-kidville-error-strong">
                      {t('revisioneFattureCompletaPrima')}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className={BTN_PRIMARY_AA}
                  disabled={data.da_verificare > 0 || attivazioneInCorso}
                  onClick={() => setConfermaAttivazione({
                    scuolaId,
                    userId,
                    irrisolte: data.irrisolte.map((fattura) => ({ ...fattura })),
                  })}
                >
                  {t('revisioneFattureAttiva')}
                </button>
              </div>
            )}
          </div>

          <div className="mt-5 space-y-4">
            {data.fatture.length === 0 ? (
              <p className="py-6 text-center font-maven text-sm text-kidville-sub">
                {t('revisioneFattureNessuna')}
              </p>
            ) : data.fatture.map((fattura) => (
              <SchedaFattura
                key={`${fattura.id}:${fattura.stato}:${fattura.parent_registry_id ?? ''}:${fattura.verificata_il ?? ''}`}
                fattura={fattura}
                attiva={data.attiva_il !== null}
                inSalvataggio={fatturaInSalvataggio === fattura.id}
                onSalva={(modalita, parentRegistryId) => void salva(fattura, modalita, parentRegistryId)}
                onApri={() => setFatturaAperta({ scuolaId, userId, fattura })}
              />
            ))}
          </div>

          {pagine > 1 && (
            <nav className="mt-5 flex items-center justify-center gap-3" aria-label={t('revisioneFatturePaginazione')}>
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={pagina <= 1}
                onClick={() => setPagina((valore) => Math.max(1, valore - 1))}
              >
                {t('revisioneFatturePrecedente')}
              </button>
              <span className="font-maven text-sm text-kidville-sub">
                {t('revisioneFatturePagina', { pagina, pagine })}
              </span>
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={pagina >= pagine}
                onClick={() => setPagina((valore) => Math.min(pagine, valore + 1))}
              >
                {t('revisioneFattureSuccessiva')}
              </button>
            </nav>
          )}
        </>
      ) : null}

      <Modal
        open={confermaCorrente !== null}
        onClose={() => !attivazioneInCorso && setConfermaAttivazione(null)}
        title={t('revisioneFattureConfermaTitolo')}
        className={cx(MODAL_CARD, 'max-h-[85vh] overflow-y-auto')}
        style={{ boxShadow: MODAL_SHADOW }}
      >
        <h3 className="font-fredoka text-xl font-bold text-kidville-ink">
          {t('revisioneFattureConfermaTitolo')}
        </h3>
        <p className="mt-3 font-maven text-sm text-kidville-sub">
          {t('revisioneFattureConfermaTesto')}
        </p>
        <p className="mt-2 font-maven text-sm font-semibold text-kidville-error-strong">
          {t('revisioneFattureIrrisolteStaff')}
        </p>
        {confermaCorrente?.irrisolte.length ? (
          <ul className="mt-3 space-y-2" aria-label={t('revisioneFattureIrrisolteElenco')}>
            {confermaCorrente.irrisolte.map((fattura) => (
              <li key={fattura.id} className="rounded-input border border-kidville-line p-3 font-maven text-sm text-kidville-ink">
                {t('revisioneFattureNumero', { numero: fattura.numero, anno: fattura.anno })} · {fattura.intestatario}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 font-maven text-sm text-kidville-sub">
            {t('revisioneFattureNessunaIrrisolta')}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className={BTN_SECONDARY}
            disabled={attivazioneInCorso}
            onClick={() => setConfermaAttivazione(null)}
          >
            {t('revisioneFattureAnnulla')}
          </button>
          <button
            type="button"
            className={BTN_PRIMARY_AA}
            disabled={attivazioneInCorso}
            onClick={() => {
              if (confermaCorrente) void attiva(confermaCorrente)
            }}
          >
            {attivazioneInCorso
              ? t('revisioneFattureAttivazioneInCorso')
              : t('revisioneFattureConferma')}
          </button>
        </div>
      </Modal>

      <FatturaViewer
        open={fatturaCorrente !== null}
        onClose={() => setFatturaAperta(null)}
        url={fatturaCorrente
          ? `/api/pagamenti/fattura?pagamento_id=${encodeURIComponent(fatturaCorrente.fattura.pagamento_id)}&fattura_id=${encodeURIComponent(fatturaCorrente.fattura.id)}&userId=${encodeURIComponent(fatturaCorrente.userId)}`
          : ''}
        titolo={fatturaCorrente
          ? t('revisioneFattureNumero', { numero: fatturaCorrente.fattura.numero, anno: fatturaCorrente.fattura.anno })
          : undefined}
        onEsito={fatturaCorrente ? (esito) => {
          void registraEsitoFattura({
            pagamentoId: fatturaCorrente.fattura.pagamento_id,
            fatturaId: fatturaCorrente.fattura.id,
            esito,
          })
        } : undefined}
      />
    </section>
  )
}

function Riepilogo({ etichetta, valore }: { etichetta: string; valore: number }) {
  return (
    <div className="rounded-input border border-kidville-line p-3">
      <p className="font-maven text-xs font-semibold uppercase tracking-wide text-kidville-sub">{etichetta}</p>
      <p className="mt-1 font-fredoka text-2xl font-bold text-kidville-ink">{valore}</p>
    </div>
  )
}

function SchedaFattura({
  fattura,
  attiva,
  inSalvataggio,
  onSalva,
  onApri,
}: {
  fattura: FatturaRevisioneWire
  attiva: boolean
  inSalvataggio: boolean
  onSalva: (
    modalita: Exclude<StatoRevisioneFattura, 'da_verificare'>,
    parentRegistryId: string | null,
  ) => void
  onApri: () => void
}) {
  const t = useTranslations('adminContabilita')
  const { dataOra } = useDateFormat()
  const iniziale: ModalitaScelta = fattura.stato === 'da_verificare' ? '' : fattura.stato
  const [modalita, setModalita] = useState<ModalitaScelta>(iniziale)
  const [parentRegistryId, setParentRegistryId] = useState(
    fattura.stato === 'quote_separate' ? fattura.parent_registry_id ?? '' : '',
  )

  const anomalia = fattura.anomalia
    ? t(`revisioneFattureAnomalia_${fattura.anomalia}`)
    : null
  const salvataggioDisabilitato = fattura.definitiva
    || fattura.anomalia !== null
    || inSalvataggio
    || modalita === ''
    || (modalita === 'quote_separate' && parentRegistryId === '')

  return (
    <article
      data-testid={`revisione-fattura-${fattura.id}`}
      className="rounded-card border border-kidville-line bg-kidville-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-fredoka text-base font-bold text-kidville-ink">
            {t('revisioneFattureNumero', { numero: fattura.numero, anno: fattura.anno })}
          </p>
          <p className="mt-1 font-maven text-sm text-kidville-sub">{fattura.intestatario}</p>
          <p className="mt-1 font-maven text-xs text-kidville-sub">
            {t(`revisioneFattureStato_${fattura.stato}`)}
          </p>
        </div>
        <button
          type="button"
          className={BTN_SECONDARY}
          disabled={!fattura.ha_pdf || fattura.anomalia !== null}
          onClick={onApri}
        >
          <Eye size={16} aria-hidden="true" />
          {t('revisioneFattureApriPdf')}
        </button>
      </div>

      {anomalia && (
        <p className="mt-3 flex gap-2 rounded-input bg-kidville-error-soft p-3 font-maven text-sm text-kidville-error-strong">
          <AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
          {anomalia}
        </p>
      )}

      {fattura.definitiva ? (
        <div className="mt-4 rounded-input bg-kidville-cream/60 p-3">
          <p className="font-maven text-sm font-bold text-kidville-ink">
            {t('revisioneFattureDefinitiva')}
          </p>
          <p className="mt-1 font-maven text-sm text-kidville-sub">
            {t(`revisioneFattureStato_${fattura.stato}`)}
          </p>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="font-maven text-sm font-semibold text-kidville-ink">
            {t('revisioneFattureModalita')}
            <select
              className={cx(SELECT, 'mt-1')}
              value={modalita}
              aria-label={t('revisioneFattureModalita')}
              disabled={fattura.anomalia !== null || inSalvataggio}
              onChange={(evento) => {
                const nuova = evento.target.value as ModalitaScelta
                setModalita(nuova)
                if (nuova !== 'quote_separate') setParentRegistryId('')
              }}
            >
              <option value="">{t('revisioneFattureScegliModalita')}</option>
              <option value="ordinaria">{t('revisioneFattureStato_ordinaria')}</option>
              <option value="quote_separate">{t('revisioneFattureStato_quote_separate')}</option>
              <option value="irrisolta">{t('revisioneFattureStato_irrisolta')}</option>
            </select>
          </label>

          {modalita === 'quote_separate' && (
            <label className="font-maven text-sm font-semibold text-kidville-ink">
              {t('revisioneFattureGenitore')}
              <select
                className={cx(SELECT, 'mt-1')}
                value={parentRegistryId}
                aria-label={t('revisioneFattureGenitore')}
                disabled={fattura.anomalia !== null || inSalvataggio}
                onChange={(evento) => setParentRegistryId(evento.target.value)}
              >
                <option value="">{t('revisioneFattureScegliGenitore')}</option>
                {fattura.candidati.map((candidato) => (
                  <option key={candidato.id} value={candidato.id}>
                    {candidato.cognome} {candidato.nome}
                    {candidato.codice_fiscale ? ` · ${candidato.codice_fiscale}` : ''}
                    {candidato.account_collegato ? ` · ${t('revisioneFattureAccountCollegato')}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="flex items-end sm:col-span-2">
            <button
              type="button"
              className={BTN_PRIMARY_AA}
              disabled={salvataggioDisabilitato}
              onClick={() => {
                if (modalita) onSalva(modalita, parentRegistryId || null)
              }}
            >
              {inSalvataggio ? t('revisioneFattureSalvataggio') : t('revisioneFattureSalva')}
            </button>
          </div>
        </div>
      )}

      {attiva && !fattura.definitiva && fattura.stato === 'irrisolta' && (
        <p className="mt-3 rounded-input bg-kidville-warn-soft p-3 font-maven text-sm text-kidville-ink">
          {t('revisioneFattureFinalizzazioneAvviso')}
        </p>
      )}

      {(fattura.verificata_il || fattura.verificata_da) && (
        <p className="mt-3 font-maven text-xs text-kidville-sub">
          {t('revisioneFattureVerificata', {
            data: fattura.verificata_il ? dataOra(fattura.verificata_il) : '—',
            utente: fattura.verificata_da ?? '—',
          })}
        </p>
      )}
    </article>
  )
}
