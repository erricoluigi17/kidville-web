'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, Search, UserPlus } from 'lucide-react'
import { DateTimeField } from '@/components/ui/DateTimeField'
import { Modal } from '@/components/ui/Modal'
import { dataCivile } from '@/i18n/config'
import type { AppuntamentoRow } from '@/lib/crm/tipi'
import { FORMA_DATA_ORA_LOCALE, istanteCivile, istanteDaLocale } from '@/lib/format/confini-giorno'
import { addGiorni } from '@/lib/format/data'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import { NuovaScheda } from '../schede/NuovaScheda'

/**
 * CRM DELLA SEGRETERIA · FISSARE (O SPOSTARE) UNA VISITA.
 *
 * Un dialogo solo, una schermata sola: famiglia, giorno, ora, durata e persona stanno insieme, così una
 * segretaria che ha cliccato su uno slot vede subito l'ora e la persona che aveva scelto e può cambiarle.
 *
 *  · senza `schedaId` né `appuntamento` la famiglia si CERCA (o si crea: «Nuova famiglia»);
 *  · con `schedaId` la famiglia è già quella; con `appuntamento` è uno SPOSTAMENTO (PATCH `sposta`).
 *
 * ── LA PERSONA, QUANDO LO SLOT È DELLA SEDE ─────────────────────────────────────────
 * Uno slot della sede non ha una persona: ce n'è una o più di libere (`personeProposte`, gli uuid, nell'ordine
 * della sede). Il selettore elenca SOLO quelle. Con una sola è già scelta; con più di una non se ne
 * preseleziona nessuna e la scelta è obbligatoria: il pulsante resta spento finché non si sceglie, e il testo
 * d'aiuto lo dice. Senza `personeProposte` (o vuoto) il dialogo si comporta come sempre.
 *
 * ── UN 409 SLOT_OCCUPATO NON CHIUDE IL DIALOGO ──────────────────────────────────────
 * L'orario può essere stato preso un attimo prima da una collega (il database lo impedisce: EXCLUDE). Il
 * messaggio sta nel dialogo, in un `role="alert"`, e i campi restano come sono: si cambia l'ora e si riprova.
 * Chiudere il dialogo qui farebbe perdere la famiglia già scelta.
 *
 * ── GLI ORARI SONO DI ROMA ──────────────────────────────────────────────────────────
 * `DateTimeField` parla ISO fuori e orologio a muro di Roma dentro; la proposta di default («domani alle
 * 10:00») si calcola sul giorno civile di Roma, non sul fuso del dispositivo.
 */

interface Persona {
  id: string
  nome: string
  cognome: string
}

interface SchedaTrovata {
  id: string
  genitore_nome: string | null
  bambini: { id: string; nome: string }[]
}

const ROUTE = '/admin/crm'
const DURATE_MIN = [15, 30, 45, 60, 90, 120]
const DURATA_DEFAULT_MIN = 45
const ORA_DI_SERIE = '10:00'
const LUNGHEZZA_MIN_RICERCA = 2

type EsitoPersone = { chiave: string; persone: Persona[]; errore: boolean }

async function caricaPersone(scuolaId: string): Promise<EsitoPersone> {
  const chiave = scuolaId
  try {
    const res = await fetch(`/api/admin/crm/persone?${new URLSearchParams({ scuolaId }).toString()}`)
    if (!res.ok) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-persone-lettura-respinta', route: ROUTE, stato: res.status })
      return { chiave, persone: [], errore: true }
    }
    const corpo = (await res.json()) as { data?: Persona[] }
    return { chiave, persone: corpo.data ?? [], errore: false }
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-persone-lettura-fallita: ${nomeErrore(e)}`, route: ROUTE })
    return { chiave, persone: [], errore: true }
  }
}

/** L'istante di partenza del campo: la visita da spostare, la proposta dello slot, altrimenti «domani alle 10». */
function inizioIniziale(appuntamento: AppuntamentoRow | undefined, inizioProposto: string | undefined): string {
  if (appuntamento) return appuntamento.inizio
  if (inizioProposto) {
    // La proposta può arrivare come istante ISO (uno slot) o come orologio a muro `YYYY-MM-DDTHH:MM`.
    if (FORMA_DATA_ORA_LOCALE.test(inizioProposto)) return istanteDaLocale(inizioProposto) ?? ''
    return inizioProposto
  }
  return istanteCivile(addGiorni(dataCivile(new Date()), 1), ORA_DI_SERIE) ?? ''
}

/** Il nome della famiglia di una visita letta dall'agenda (la GET lo allega alla riga). */
function famigliaDi(appuntamento: AppuntamentoRow | undefined): string | null {
  const scheda = (appuntamento as (AppuntamentoRow & { scheda?: { genitore_nome?: string | null } }) | undefined)?.scheda
  return scheda?.genitore_nome?.trim() || null
}

const nomeDi = (p: Persona) => `${p.nome} ${p.cognome}`.trim()

const CAMPO =
  'min-h-[44px] w-full rounded-xl border border-kidville-line bg-kidville-white px-3 font-maven text-kidville-ink'
const BTN_PRIMARIO =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-kidville-green px-4 font-maven text-sm font-bold text-white transition-colors disabled:bg-kidville-neutral'
const BTN_SECONDARIO =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-kidville-line px-4 font-maven text-sm font-bold text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green disabled:opacity-50'

export function FissaVisita({
  scuolaId,
  schedaId,
  appuntamento,
  inizioProposto,
  assegnataProposta,
  personeProposte,
  onFatto,
  onAnnulla,
}: {
  scuolaId: string
  schedaId?: string
  appuntamento?: AppuntamentoRow
  inizioProposto?: string
  assegnataProposta?: string
  /** Solo per gli slot della sede: le persone libere in quell'orario. Il selettore elenca solo loro. */
  personeProposte?: string[]
  onFatto: () => void
  onAnnulla: () => void
}) {
  const t = useTranslations('crmAgenda')
  const idBase = useId()
  const idTitolo = `${idBase}-titolo`
  const idQuando = `${idBase}-quando`
  const idData = `${idBase}-data`
  const idOra = `${idBase}-ora`
  const idDurata = `${idBase}-durata`
  const idPersona = `${idBase}-persona`
  const idPersonaAiuto = `${idBase}-persona-aiuto`
  const idCerca = `${idBase}-cerca`

  const sposta = appuntamento !== undefined
  const schedaFissa = appuntamento?.scheda_id ?? schedaId
  const [scheda, setScheda] = useState<{ id: string; nome: string | null } | null>(
    schedaFissa ? { id: schedaFissa, nome: famigliaDi(appuntamento) } : null,
  )
  const [nuova, setNuova] = useState(false)

  const [inizio, setInizio] = useState(() => inizioIniziale(appuntamento, inizioProposto))
  const [durata, setDurata] = useState(appuntamento?.durata_min ?? DURATA_DEFAULT_MIN)
  const [persona, setPersona] = useState(appuntamento?.assegnata_a ?? assegnataProposta ?? '')

  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState('')

  // Le persone della sede: «caricamento» si deduce dalla chiave, nessun setState sincrono nell'effetto.
  const [esitoPersone, setEsitoPersone] = useState<EsitoPersone | null>(null)
  useEffect(() => {
    let attivo = true
    void caricaPersone(scuolaId).then((e) => {
      if (attivo) setEsitoPersone(e)
    })
    return () => {
      attivo = false
    }
  }, [scuolaId])
  const persone = esitoPersone?.chiave === scuolaId ? esitoPersone.persone : []
  const personeInErrore = esitoPersone?.chiave === scuolaId && esitoPersone.errore

  // Fra le persone proposte (slot della sede) si elencano solo quelle; altrimenti tutte le persone della sede.
  const proposte = personeProposte ?? []
  const elencoPersone = proposte.length > 0 ? persone.filter((p) => proposte.includes(p.id)) : persone

  // Con una persona sola non c'è da scegliere: si propone lei.
  const personaScelta = persona || (elencoPersone.length === 1 ? elencoPersone[0].id : '')
  const personaFuoriElenco = personaScelta !== '' && persone.length > 0 && !persone.some((p) => p.id === personaScelta)
  // Più persone libere nello stesso slot: chi riceve la famiglia lo decide chi fissa, non il dialogo.
  const sceltaObbligatoria = proposte.length > 1 && personaScelta === ''

  // ── La ricerca della famiglia ──────────────────────────────────────────────────────
  const [domanda, setDomanda] = useState('')
  const [ricerca, setRicerca] = useState<{ stato: 'ferma' | 'in-corso' | 'fatta' | 'errore'; trovate: SchedaTrovata[] }>({
    stato: 'ferma',
    trovate: [],
  })
  const [ricercaCorta, setRicercaCorta] = useState(false)

  const cerca = async () => {
    const q = domanda.trim()
    if (q.length < LUNGHEZZA_MIN_RICERCA) {
      setRicercaCorta(true)
      return
    }
    setRicercaCorta(false)
    setRicerca({ stato: 'in-corso', trovate: [] })
    try {
      const res = await fetch(`/api/admin/crm/schede?${new URLSearchParams({ scuolaId, q }).toString()}`)
      if (!res.ok) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-ricerca-schede-respinta', route: ROUTE, stato: res.status })
        setRicerca({ stato: 'errore', trovate: [] })
        return
      }
      const corpo = (await res.json()) as { data?: SchedaTrovata[] }
      setRicerca({ stato: 'fatta', trovate: corpo.data ?? [] })
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-ricerca-schede-fallita: ${nomeErrore(err)}`, route: ROUTE })
      setRicerca({ stato: 'errore', trovate: [] })
    }
  }

  // ── L'invio ────────────────────────────────────────────────────────────────────────
  const invia = async () => {
    if (!scheda || !inizio || !personaScelta) {
      setErrore(t('datiIncompleti'))
      return
    }
    setInCorso(true)
    setErrore('')
    try {
      const res = sposta
        ? await fetch(`/api/admin/crm/appuntamenti/${appuntamento.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ azione: 'sposta', inizio, durataMin: durata, assegnataA: personaScelta }),
          })
        : await fetch('/api/admin/crm/appuntamenti', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schedaId: scheda.id, inizio, durataMin: durata, assegnataA: personaScelta }),
          })
      if (!res.ok) {
        // Un 409 SLOT_OCCUPATO arriva qui col suo testo del catalogo; il dialogo resta aperto coi campi come sono.
        const e = await erroreDaRisposta(res, sposta ? t('erroreSposta') : t('erroreFissa'))
        setErrore(e.testo)
        logClient({ livello: 'error', evento: 'fetch', messaggio: sposta ? 'crm-visita-sposta-respinta' : 'crm-visita-fissa-respinta', route: ROUTE, stato: res.status })
        return
      }
      onFatto()
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-visita-invio-fallito: ${nomeErrore(err)}`, route: ROUTE })
      setErrore(sposta ? t('erroreSposta') : t('erroreFissa'))
    } finally {
      setInCorso(false)
    }
  }

  const titolo = nuova ? t('nuovaFamigliaTitolo') : sposta ? t('spostaTitolo') : t('fissaTitolo')

  return (
    <Modal open onClose={onAnnulla} title={titolo} labelledBy={idTitolo} className="w-full max-w-lg">
      <div className="max-h-[90vh] overflow-y-auto rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {titolo}
        </h2>

        {nuova ? (
          <div className="mt-4">
            <NuovaScheda
              scuolaId={scuolaId}
              onCreata={(id) => {
                setScheda({ id, nome: null })
                setNuova(false)
              }}
              onAnnulla={() => setNuova(false)}
            />
          </div>
        ) : (
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault()
              void invia()
            }}
          >
            {/* La famiglia */}
            <fieldset className="space-y-2">
              <legend className="mb-1 font-maven text-xs font-semibold text-kidville-sub">{t('famiglia')}</legend>
              {scheda ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-kidville-line bg-kidville-white px-3 py-2">
                  <span className="font-maven text-sm font-semibold text-kidville-ink">{scheda.nome ?? t('famigliaScelta')}</span>
                  {!schedaFissa && (
                    <button type="button" className="font-maven text-sm font-bold text-kidville-green underline" onClick={() => setScheda(null)}>
                      {t('cambiaFamiglia')}
                    </button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={idCerca} className="sr-only">
                        {t('cercaEtichetta')}
                      </label>
                      <input
                        id={idCerca}
                        type="search"
                        value={domanda}
                        onChange={(e) => setDomanda(e.target.value)}
                        onKeyDown={(e) => {
                          // Invio nel campo di ricerca cerca; non fissa la visita.
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void cerca()
                          }
                        }}
                        placeholder={t('cercaSegnaposto')}
                        style={{ fontSize: '16px' }}
                        className={CAMPO}
                      />
                    </div>
                    <button type="button" className={BTN_SECONDARIO} onClick={() => void cerca()} disabled={ricerca.stato === 'in-corso'}>
                      <Search size={16} aria-hidden="true" />
                      {t('cerca')}
                    </button>
                  </div>
                  {ricercaCorta && (
                    <p role="alert" className="font-maven text-xs text-kidville-error-strong">
                      {t('cercaTroppoCorta')}
                    </p>
                  )}
                  {ricerca.stato === 'in-corso' && (
                    <p role="status" className="font-maven text-xs text-kidville-sub">
                      {t('cercaInCorso')}
                    </p>
                  )}
                  {ricerca.stato === 'errore' && (
                    <p role="alert" className="font-maven text-xs text-kidville-error-strong">
                      {t('cercaErrore')}
                    </p>
                  )}
                  {ricerca.stato === 'fatta' && ricerca.trovate.length === 0 && (
                    <p role="status" className="font-maven text-xs text-kidville-sub">
                      {t('nessunaFamiglia')}
                    </p>
                  )}
                  {ricerca.trovate.length > 0 && (
                    <ul className="max-h-48 space-y-1 overflow-y-auto">
                      {ricerca.trovate.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => setScheda({ id: s.id, nome: s.genitore_nome?.trim() || null })}
                            className="w-full rounded-xl border border-kidville-line px-3 py-2 text-left font-maven text-sm text-kidville-ink transition-colors hover:border-kidville-green"
                          >
                            <span className="block font-semibold">{s.genitore_nome?.trim() || t('famigliaSenzaNome')}</span>
                            {s.bambini.length > 0 && (
                              <span className="block text-xs text-kidville-sub">{s.bambini.map((b) => b.nome).join(', ')}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button type="button" className={BTN_SECONDARIO} onClick={() => setNuova(true)}>
                    <UserPlus size={16} aria-hidden="true" />
                    {t('nuovaFamiglia')}
                  </button>
                </div>
              )}
            </fieldset>

            {/* Quando */}
            <div className="space-y-1">
              <p id={idQuando} className="font-maven text-xs font-semibold text-kidville-sub">
                {t('quando')}
              </p>
              <DateTimeField
                value={inizio}
                onChange={setInizio}
                idData={idData}
                idOra={idOra}
                labelledBy={idQuando}
                etichettaData={t('giorno')}
                etichettaOra={t('ora')}
                className={CAMPO}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={idDurata} className="block font-maven text-xs font-semibold text-kidville-sub">
                  {t('durata')}
                </label>
                <select
                  id={idDurata}
                  value={durata}
                  onChange={(e) => setDurata(Number(e.target.value))}
                  style={{ fontSize: '16px' }}
                  className={CAMPO}
                >
                  {(DURATE_MIN.includes(durata) ? DURATE_MIN : [...DURATE_MIN, durata].sort((a, b) => a - b)).map((m) => (
                    <option key={m} value={m}>
                      {t('durataMinuti', { min: m })}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor={idPersona} className="block font-maven text-xs font-semibold text-kidville-sub">
                  {t('persona')}
                </label>
                <select
                  id={idPersona}
                  value={personaScelta}
                  onChange={(e) => setPersona(e.target.value)}
                  aria-describedby={sceltaObbligatoria ? idPersonaAiuto : undefined}
                  style={{ fontSize: '16px' }}
                  className={CAMPO}
                >
                  <option value="">{t('scegliPersona')}</option>
                  {personaFuoriElenco && <option value={personaScelta}>{t('personaSconosciuta')}</option>}
                  {elencoPersone.map((p) => (
                    <option key={p.id} value={p.id}>
                      {nomeDi(p)}
                    </option>
                  ))}
                </select>
                {sceltaObbligatoria && (
                  <p id={idPersonaAiuto} className="font-maven text-xs text-kidville-sub">
                    {t('scegliPersonaAiuto')}
                  </p>
                )}
              </div>
            </div>

            {personeInErrore && (
              <p role="alert" className="font-maven text-xs text-kidville-error-strong">
                {t('errorePersone')}
              </p>
            )}

            {errore && (
              <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{errore}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" onClick={onAnnulla} className={BTN_SECONDARIO}>
                {t('annulla')}
              </button>
              <button type="submit" disabled={inCorso || sceltaObbligatoria} className={BTN_PRIMARIO}>
                {inCorso ? t('invioInCorso') : sposta ? t('spostaConferma') : t('fissaConferma')}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  )
}
