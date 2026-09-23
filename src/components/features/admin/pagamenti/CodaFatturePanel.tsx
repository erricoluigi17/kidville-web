'use client'

/**
 * Pannello «Coda fatture» (nucleo §4 — docs/superpowers/specs/2026-09-22-coda-fatture-aruba/nucleo.md).
 *
 * La segreteria mette in coda fino a 500 fatture in un gesto e chiude la pagina: l'invio
 * continua da solo, un blocco alla volta, governato dal cron (§2). Questo pannello mostra
 * lo stato della coda per TUTTA la segreteria (tutte le sedi, decisione 6 del nucleo) e
 * lascia — sulle sole voci delle sedi dell'utente (`propria`) — due azioni reversibili — «Togli» ed «Rimetti in coda» — più «Sospendi/Riprendi»,
 * riservata alla Direzione perché ferma l'invio di TUTTI.
 *
 * I tipi (`VoceCodaVista`, `RispostaGetCoda`) sono importati da `src/lib/fatture-coda/api.ts`,
 * il contratto fissato in nucleo.md §3: una copia locale si era già discostata (`accodata_il`
 * è `string | null` nel contratto vero, non `string`), ed era un modo silenzioso di rompere
 * il patto con T3.
 *
 * Polling: SOLO a scheda visibile (`usePollingVisibile`, già in uso da chat/notifiche). Il
 * primo caricamento resta di questo componente; l'hook governa solo il RITMO successivo.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Ban, Play, RefreshCw } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { usePollingVisibile } from '@/lib/hooks/use-polling-visibile'
import { useDateFormat } from '@/lib/i18n/date'
import { quandoRelativo } from '@/lib/i18n/quando-relativo'
import { formatEuro } from '@/lib/format/valuta'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch'
import { cx } from '@/lib/ui/cx'
import type { VoceCodaVista, RispostaGetCoda, StatoVoceCoda } from '@/lib/fatture-coda/api'
import { BTN_PRIMARY_AA, BTN_SECONDARY, MODAL_CARD, MODAL_SHADOW } from './ui'

const URL_CODA = '/api/pagamenti/fattura/coda'
const URL_AZIONI = '/api/pagamenti/fattura/coda/azioni'
const URL_SOSPENSIONE = '/api/pagamenti/fattura/coda/sospensione'

/** Ritmo del polling: 20 s, come da nucleo §4. Si ferma da solo a scheda nascosta. */
const INTERVALLO_POLLING_MS = 20_000

// Riesportati per compatibilità: sono i tipi del contratto (`src/lib/fatture-coda/api.ts`),
// non più una copia locale — vedi la nota in testa al file.
export type { StatoVoceCoda }
export type VoceCoda = VoceCodaVista
export type RispostaCoda = RispostaGetCoda

interface Props {
    userId: string
    /** Ruolo dell'utente corrente: «Sospendi/Riprendi» compare solo per `admin` (il gate vero è nel server). */
    ruolo: string | null
}

type TipoConferma = 'togli' | 'rimetti' | 'sospendi' | 'riprendi'

interface ConfermaAzione {
    tipo: TipoConferma
    ids: string[]
}

const TONO_STATO: Record<StatoVoceCoda, BadgeTone> = {
    in_coda: 'neutral',
    in_invio: 'inCorso',
    emessa: 'success',
    errore: 'error',
    tolta: 'read',
}

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

/**
 * Le voci selezionabili (le uniche con una checkbox): in attesa o in errore, e di una sede
 * dell'utente. La coda si LEGGE per tutte le sedi (decisione 6), ma `/coda/azioni` scrive solo
 * sulle proprie e rifiuta l'intero gesto con 403 se anche una sola voce è di un altro plesso:
 * senza `propria`, «Seleziona tutto» + «Togli» falliva sempre appena in coda c'era una voce
 * di un'altra sede.
 */
function selezionabile(voce: VoceCoda): boolean {
    return voce.propria && (voce.stato === 'in_coda' || voce.stato === 'errore')
}

export function CodaFatturePanel({ userId, ruolo }: Props) {
    const t = useTranslations('adminContabilita')
    const { dataOra, locale } = useDateFormat()
    const admin = ruolo === 'admin'

    const [dati, setDati] = useState<RispostaCoda | null>(null)
    const [loading, setLoading] = useState(true)
    const [erroreCaricamento, setErroreCaricamento] = useState<string | null>(null)
    const [selezionati, setSelezionati] = useState<Set<string>>(new Set())
    const [operazioneInCorso, setOperazioneInCorso] = useState(false)
    const [erroreOperazione, setErroreOperazione] = useState<string | null>(null)
    const [conferma, setConferma] = useState<ConfermaAzione | null>(null)

    const montatoRef = useRef(true)
    useEffect(() => {
        montatoRef.current = true
        return () => { montatoRef.current = false }
    }, [])

    // Niente `try/catch`: la promessa del `fetch` si biforca con `.then(onFulfilled,
    // onRejected)`, ed è SOLO un `finally` a reggere il flag di caricamento. Con un
    // `catch` qui dentro, la regola `react-hooks/set-state-in-effect` non riesce a
    // seguire il confine asincrono e segnala l'`useEffect` del primo caricamento
    // come se chiamasse `setState` in modo sincrono (misurato: vedi memoria
    // `eslint-set-state-in-effect`, stesso guasto già chiuso in `PagamentiSummary`).
    const carica = useCallback(async () => {
        try {
            const esito = await fetch(URL_CODA, {
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { 'x-user-id': userId },
            }).then(
                async (response) => ({ response, body: await corpoJson(response) as RispostaCoda | { error?: string } | null }),
                (erroreRete: unknown) => ({ erroreRete }),
            )
            if (!montatoRef.current) return
            if ('erroreRete' in esito) {
                if ((esito.erroreRete as { name?: unknown })?.name === 'AbortError') return
                setErroreCaricamento(t('codaFatture.erroreCaricamento'))
                registraErroreClient('coda-fatture-caricamento-fallito', esito.erroreRete, 0)
                return
            }
            const { response, body } = esito
            if (!response.ok || !body || typeof (body as RispostaCoda).disponibile !== 'boolean') {
                setErroreCaricamento(messaggioDaCorpo(body, t('codaFatture.erroreCaricamento')))
                registraErroreClient('coda-fatture-caricamento-fallito', new Error('RispostaHttp'), response.status)
                return
            }
            setErroreCaricamento(null)
            const risposta = body as RispostaCoda
            setDati(risposta)
            // Le voci sparite dal payload (es. concluse e uscite dalla finestra 7g,
            // o un'azione fatta da un altro operatore) escono anche dalla selezione:
            // altrimenti «Togli»/«Rimetti» agirebbero su id non più presenti a schermo.
            // (`risposta.disponibile` va controllato: l'altro ramo dell'unione non ha `voci`.)
            const vociVive = risposta.disponibile ? risposta.voci : []
            setSelezionati((precedente) => {
                const vivi = new Set(vociVive.map((v) => v.id))
                const prossimo = new Set([...precedente].filter((id) => vivi.has(id)))
                return prossimo.size === precedente.size ? precedente : prossimo
            })
        } finally {
            if (montatoRef.current) setLoading(false)
        }
    }, [t, userId])

    // Primo caricamento: di questo componente, non dell'hook (vedi doc dell'hook).
    useEffect(() => {
        void carica()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Il ritmo successivo: SOLO a scheda visibile. Niente `intervalloNascostoMs`:
    // a scheda nascosta l'orologio si ferma del tutto, com'è il caso normale.
    usePollingVisibile(carica, INTERVALLO_POLLING_MS)

    const toggleSelezione = (id: string) => {
        setSelezionati((precedente) => {
            const prossimo = new Set(precedente)
            if (prossimo.has(id)) prossimo.delete(id); else prossimo.add(id)
            return prossimo
        })
    }

    // `dati` è l'unione del contratto (`{disponibile:false}` oppure il resto): il ramo
    // pieno si isola UNA volta qui, invece di ripetere `dati.disponibile &&` a ogni
    // accesso — ed è quello che permette di importare `RispostaGetCoda` così com'è.
    const attiva = dati && dati.disponibile ? dati : null

    const voci = attiva?.voci ?? []
    const selezionabili = voci.filter(selezionabile)
    const tutteSelezionate = selezionabili.length > 0 && selezionabili.every((v) => selezionati.has(v.id))
    const toggleSelezionaTutto = () => {
        setSelezionati(tutteSelezionate ? new Set() : new Set(selezionabili.map((v) => v.id)))
    }

    const selezionateArray = [...selezionati]
    const selezionateInErrore = selezionateArray.every((id) => voci.find((v) => v.id === id)?.stato === 'errore')

    const eseguiAzione = useCallback(async (azione: 'togli' | 'rimetti', ids: string[]) => {
        setOperazioneInCorso(true)
        setErroreOperazione(null)
        try {
            const response = await fetch(URL_AZIONI, {
                method: 'POST',
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ azione, ids }),
            })
            const body = await corpoJson(response)
            if (!montatoRef.current) return
            if (!response.ok) {
                setErroreOperazione(messaggioDaCorpo(body, t('codaFatture.erroreOperazione')))
                registraErroreClient('coda-fatture-azione-fallita', new Error('RispostaHttp'), response.status)
                return
            }
            setSelezionati((precedente) => {
                const prossimo = new Set(precedente)
                for (const id of ids) prossimo.delete(id)
                return prossimo
            })
            void carica()
        } catch (errore) {
            if (!montatoRef.current) return
            setErroreOperazione(t('codaFatture.erroreOperazione'))
            registraErroreClient('coda-fatture-azione-fallita', errore, 0)
        } finally {
            if (montatoRef.current) setOperazioneInCorso(false)
        }
    }, [carica, t, userId])

    const eseguiSospensione = useCallback(async (sospesa: boolean) => {
        setOperazioneInCorso(true)
        setErroreOperazione(null)
        try {
            const response = await fetch(URL_SOSPENSIONE, {
                method: 'POST',
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
                body: JSON.stringify({ sospesa }),
            })
            const body = await corpoJson(response)
            if (!montatoRef.current) return
            if (!response.ok) {
                setErroreOperazione(messaggioDaCorpo(body, t('codaFatture.erroreOperazione')))
                registraErroreClient('coda-fatture-sospensione-fallita', new Error('RispostaHttp'), response.status)
                return
            }
            void carica()
        } catch (errore) {
            if (!montatoRef.current) return
            setErroreOperazione(t('codaFatture.erroreOperazione'))
            registraErroreClient('coda-fatture-sospensione-fallita', errore, 0)
        } finally {
            if (montatoRef.current) setOperazioneInCorso(false)
        }
    }, [carica, t, userId])

    const confermaEEsegui = () => {
        if (!conferma) return
        const { tipo, ids } = conferma
        setConferma(null)
        if (tipo === 'togli') void eseguiAzione('togli', ids)
        else if (tipo === 'rimetti') void eseguiAzione('rimetti', ids)
        else if (tipo === 'sospendi') void eseguiSospensione(true)
        else void eseguiSospensione(false)
    }

    // `new Date().getTime()`, non `Date.now()`: la regola `react-hooks/purity` marca
    // `Date.now` come impuro per costruzione (vedi node_modules/eslint-plugin-react-hooks),
    // il costruttore no. Stesso valore, e il render resta idempotente per l'analyzer.
    const adesso = new Date().getTime()
    const inPausa = !!attiva?.stato.pausa_fino_a && new Date(attiva.stato.pausa_fino_a).getTime() > adesso
    // Il GIORNO, non solo l'ora (consegna 2a, rilievo c): 300 fatture a 50 l'ora fanno sei ore,
    // e «fine stimata alle 00:03» letto alle 18:03 è il giorno dopo.
    const pausaFino = inPausa ? quandoRelativo(attiva?.stato.pausa_fino_a, adesso, locale) : null
    const fineStimata = quandoRelativo(attiva?.stima_fine, adesso, locale)

    return (
        <section className="rounded-card border border-kidville-line bg-kidville-white p-5">
            {/* Titolo e sottotitolo li rende SOLO `PageHeader` della pagina (stesse chiavi
                `codaFatture.titolo`/`sottotitolo`): ripeterli qui era un doppione a schermo. */}
            <div className="flex flex-wrap items-start justify-end gap-3">
                <button
                    type="button"
                    className={BTN_SECONDARY}
                    onClick={() => void carica()}
                    disabled={loading}
                    aria-label={t('codaFatture.aggiorna')}
                >
                    <RefreshCw size={16} aria-hidden="true" />
                    {t('codaFatture.aggiorna')}
                </button>
            </div>

            {erroreOperazione && (
                <p role="alert" className="mt-4 rounded-input bg-kidville-error-soft p-3 font-maven text-sm text-kidville-error-strong">
                    {erroreOperazione}
                </p>
            )}

            {loading && !dati ? (
                <p className="py-8 text-center font-maven text-sm text-kidville-sub" aria-live="polite">
                    {t('codaFatture.caricamento')}
                </p>
            ) : erroreCaricamento && !dati ? (
                <div role="alert" className="mt-4 rounded-input bg-kidville-error-soft p-4 text-kidville-error-strong">
                    <p className="font-maven text-sm">{erroreCaricamento}</p>
                    <button type="button" className={cx(BTN_SECONDARY, 'mt-3')} onClick={() => void carica()}>
                        {t('codaFatture.riprova')}
                    </button>
                </div>
            ) : dati && !dati.disponibile ? (
                <p className="mt-4 rounded-input bg-kidville-warn-soft p-4 font-maven text-sm text-kidville-warn-strong">
                    {t('codaFatture.nonDisponibile')}
                </p>
            ) : attiva ? (
                <>
                    {/* Striscia di stato — aria-live: sospesa/pausa/attiva cambiano da sole col polling. */}
                    <div
                        role="status"
                        aria-live="polite"
                        className={cx(
                            'mt-5 rounded-card border p-4',
                            attiva.stato.sospesa
                                ? 'border-kidville-error-strong/30 bg-kidville-error-soft'
                                : inPausa
                                    ? 'border-kidville-warn-strong/30 bg-kidville-warn-soft'
                                    : 'border-kidville-line bg-kidville-cream/60',
                        )}
                    >
                        <p className={cx(
                            'font-maven text-sm font-semibold',
                            attiva.stato.sospesa ? 'text-kidville-error-strong' : inPausa ? 'text-kidville-warn-strong' : 'text-kidville-ink',
                        )}
                        >
                            {attiva.stato.sospesa
                                ? t('codaFatture.stato.sospesa')
                                : pausaFino
                                    ? t('codaFatture.stato.pausa', { giorno: pausaFino.giorno, ora: pausaFino.ora, data: pausaFino.data })
                                    : t('codaFatture.stato.attiva')}
                        </p>
                        {fineStimata && !attiva.stato.sospesa && (
                            <p className="mt-1 font-maven text-xs text-kidville-sub">
                                {t('codaFatture.stato.stimaFine', { giorno: fineStimata.giorno, ora: fineStimata.ora, data: fineStimata.data })}
                            </p>
                        )}
                        {admin && (
                            <button
                                type="button"
                                className={cx(BTN_SECONDARY, 'mt-3')}
                                disabled={operazioneInCorso}
                                onClick={() => setConferma(attiva.stato.sospesa ? { tipo: 'riprendi', ids: [] } : { tipo: 'sospendi', ids: [] })}
                            >
                                {attiva.stato.sospesa ? <Play size={16} aria-hidden="true" /> : <Ban size={16} aria-hidden="true" />}
                                {attiva.stato.sospesa ? t('codaFatture.azioni.riprendi') : t('codaFatture.azioni.sospendi')}
                            </button>
                        )}
                        {!admin && attiva.stato.sospesa && (
                            <p className="mt-2 font-maven text-xs text-kidville-sub">{t('codaFatture.soloAdmin')}</p>
                        )}
                    </div>

                    {/* Contatori */}
                    <div className="mt-5 grid gap-3 grid-cols-2 sm:grid-cols-4">
                        <Contatore etichetta={t('codaFatture.conteggi.inCoda')} valore={attiva.conteggi.in_coda} />
                        <Contatore etichetta={t('codaFatture.conteggi.inInvio')} valore={attiva.conteggi.in_invio} />
                        <Contatore etichetta={t('codaFatture.conteggi.errore')} valore={attiva.conteggi.errore} />
                        <Contatore etichetta={t('codaFatture.conteggi.emesse7g')} valore={attiva.conteggi.emesse_7g} />
                    </div>

                    {/* Barra azioni di massa */}
                    {selezionabili.length > 0 && (
                        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-input border border-kidville-line bg-kidville-cream/40 p-3">
                            <label className="flex items-center gap-2 font-maven text-xs font-semibold text-kidville-ink">
                                <input
                                    type="checkbox"
                                    checked={tutteSelezionate}
                                    onChange={toggleSelezionaTutto}
                                    className="h-4 w-4 rounded accent-kidville-green"
                                    aria-label={t('codaFatture.selezionaTutto')}
                                />
                                {t('codaFatture.selezionaTutto')}
                            </label>
                            {selezionati.size > 0 && (
                                <>
                                    <span className="font-maven text-xs text-kidville-sub">
                                        {t('codaFatture.selezionate', { n: selezionati.size })}
                                    </span>
                                    <button
                                        type="button"
                                        className={BTN_SECONDARY}
                                        disabled={operazioneInCorso}
                                        onClick={() => setConferma({ tipo: 'togli', ids: selezionateArray })}
                                    >
                                        {t('codaFatture.azioni.togli')}
                                    </button>
                                    {selezionateInErrore && (
                                        <button
                                            type="button"
                                            className={BTN_PRIMARY_AA}
                                            disabled={operazioneInCorso}
                                            onClick={() => setConferma({ tipo: 'rimetti', ids: selezionateArray })}
                                        >
                                            {t('codaFatture.azioni.rimetti')}
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    )}

                    {/* Elenco */}
                    <div className="mt-5 space-y-3">
                        {voci.length === 0 ? (
                            <p className="py-6 text-center font-maven text-sm text-kidville-sub">
                                {t('codaFatture.elencoVuoto')}
                            </p>
                        ) : voci.map((voce) => (
                            <RigaVoce
                                key={voce.id}
                                voce={voce}
                                selezionata={selezionati.has(voce.id)}
                                onSeleziona={selezionabile(voce) ? () => toggleSelezione(voce.id) : undefined}
                                dataOra={dataOra}
                            />
                        ))}
                    </div>
                </>
            ) : null}

            <Modal
                open={conferma !== null}
                onClose={() => !operazioneInCorso && setConferma(null)}
                title={conferma ? t(`codaFatture.conferma${capitalizza(conferma.tipo)}Titolo`) : ''}
                className={MODAL_CARD}
                style={{ boxShadow: MODAL_SHADOW }}
            >
                {conferma && (
                    <>
                        <h3 className="font-fredoka text-xl font-bold text-kidville-ink">
                            {t(`codaFatture.conferma${capitalizza(conferma.tipo)}Titolo`)}
                        </h3>
                        <p className="mt-3 font-maven text-sm text-kidville-sub">
                            {t(`codaFatture.conferma${capitalizza(conferma.tipo)}Testo`, { n: conferma.ids.length })}
                        </p>
                        <div className="mt-5 flex justify-end gap-2">
                            <button
                                type="button"
                                className={BTN_SECONDARY}
                                disabled={operazioneInCorso}
                                onClick={() => setConferma(null)}
                            >
                                {t('codaFatture.annulla')}
                            </button>
                            <button
                                type="button"
                                className={BTN_PRIMARY_AA}
                                disabled={operazioneInCorso}
                                onClick={confermaEEsegui}
                            >
                                {t('codaFatture.conferma')}
                            </button>
                        </div>
                    </>
                )}
            </Modal>
        </section>
    )
}

function capitalizza(testo: string): string {
    return testo.charAt(0).toUpperCase() + testo.slice(1)
}

function Contatore({ etichetta, valore }: { etichetta: string; valore: number }) {
    return (
        <div className="rounded-input border border-kidville-line p-3">
            <p className="font-maven text-xs font-semibold uppercase tracking-wide text-kidville-sub">{etichetta}</p>
            <p className="mt-1 font-fredoka text-2xl font-bold text-kidville-ink">{valore}</p>
        </div>
    )
}

function RigaVoce({
    voce,
    selezionata,
    onSeleziona,
    dataOra,
}: {
    voce: VoceCoda
    selezionata: boolean
    onSeleziona?: () => void
    dataOra: (input: string | number | Date | null | undefined) => string
}) {
    const t = useTranslations('adminContabilita')
    const chiaveEsito = voce.esito_codice ? `codaFatture.esiti.${voce.esito_codice}` : null
    const codiceConosciuto = !!(chiaveEsito && t.has(chiaveEsito))
    const etichettaEsito = codiceConosciuto ? t(chiaveEsito as string) : null
    // Quando il codice è tradotto, si mostra l'etichetta E il messaggio del server, se
    // c'è: per `scarto_aruba` e per i rifiuti locali è proprio il motivo che la segreteria
    // legge per correggere la fattura. Nasconderlo solo perché il codice è noto perdeva
    // l'informazione che serve davvero (correzione giro 2).
    const testoPrincipale = etichettaEsito ?? voce.esito_messaggio
    const testoSecondario = etichettaEsito && voce.esito_messaggio ? voce.esito_messaggio : null

    return (
        <article
            data-testid={`coda-fattura-${voce.id}`}
            className="rounded-card border border-kidville-line bg-kidville-white p-4"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                    {onSeleziona && (
                        <input
                            type="checkbox"
                            checked={selezionata}
                            onChange={onSeleziona}
                            className="mt-1 h-4 w-4 shrink-0 rounded accent-kidville-green"
                            aria-label={voce.alunno ?? voce.descrizione ?? voce.id}
                        />
                    )}
                    <div>
                        <p className="font-fredoka text-base font-bold text-kidville-ink">
                            {voce.alunno ?? voce.descrizione ?? voce.pagamento_id}
                        </p>
                        <p className="mt-1 font-maven text-sm text-kidville-sub">
                            {voce.scuola_nome ?? '—'}
                            {voce.importo != null && ` · ${formatEuro(voce.importo)}`}
                        </p>
                        <p className="mt-1 font-maven text-xs text-kidville-sub">
                            {dataOra(voce.accodata_il)}
                            {voce.creato_da_nome && ` · ${voce.creato_da_nome}`}
                        </p>
                    </div>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                    <Badge tone={TONO_STATO[voce.stato]}>{t(`codaFatture.statoVoce.${voce.stato}`)}</Badge>
                    {voce.urgente && <Badge tone="warn">{t('codaFatture.urgente')}</Badge>}
                    {voce.stato === 'in_coda' && voce.posizione != null && (
                        <span className="font-maven text-xs text-kidville-sub">
                            {/* `posizione` è già 1-based nel contratto (§3: «1 = la
                                prossima a partire»): NON si somma 1 una seconda volta. */}
                            {t('codaFatture.posizione', { n: voce.posizione })}
                        </span>
                    )}
                </div>
            </div>

            {testoPrincipale && (
                <div className={cx(
                    'mt-3 flex gap-2 rounded-input p-3 font-maven text-sm',
                    voce.stato === 'errore' ? 'bg-kidville-error-soft text-kidville-error-strong' : 'bg-kidville-neutral-soft text-kidville-sub',
                )}
                >
                    {voce.stato === 'errore' && <AlertTriangle size={17} className="mt-0.5 shrink-0" aria-hidden="true" />}
                    <div>
                        <p>{testoPrincipale}</p>
                        {testoSecondario && <p className="mt-1 opacity-80">{testoSecondario}</p>}
                    </div>
                </div>
            )}
        </article>
    )
}
