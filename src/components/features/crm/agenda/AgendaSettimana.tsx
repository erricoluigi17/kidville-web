'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, CalendarPlus, Check, ChevronLeft, ChevronRight, MoveRight, UserX, X } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { APP_TIMEZONE, dataCivile, intlDateTime } from '@/i18n/config'
import type { AppuntamentoRow } from '@/lib/crm/tipi'
import type { SlotLibero } from '@/lib/crm/slot'
import { addGiorni } from '@/lib/format/data'
import { conIniziale, useDateFormat } from '@/lib/i18n/date'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import { FissaVisita } from './FissaVisita'

/**
 * CRM DELLA SEGRETERIA · L'AGENDA DELLA SETTIMANA.
 *
 * Da lunedì a sabato, una colonna per persona: in ogni casella le visite già fissate (con la famiglia, lo stato
 * e i comandi rapidi) e gli slot ancora liberi, cliccabili per fissarne una. Le frecce portano alla settimana
 * prima e dopo; di domenica si guarda già la settimana che viene, perché la domenica non è un giorno di agenda.
 *
 * ── LA COLONNA «SEDE» ────────────────────────────────────────────────────────────────
 * Gli slot della SEDE (`utenteId` nullo) non sono di nessuna persona: chi li riceve lo sceglie chi fissa, fra le
 * persone libere in quell'orario (`personeLibere`). Stanno in una colonna «Sede», PRIMA delle persone, che compare
 * solo se in quella settimana c'è almeno uno slot della sede. Il clic apre «Fissa una visita» con quell'ora e
 * con SOLE quelle persone da scegliere.
 *
 * ── UNA SETTIMANA È UN'INTERROGAZIONE SOLA ─────────────────────────────────────────
 * `GET /api/admin/crm/appuntamenti` restituisce visite, slot e persone nello stesso colpo: le tre cose si
 * leggono dallo stesso istante, e uno slot non può risultare libero accanto a una visita che lo occupa. La sede
 * si dichiara (`scuolaId` arriva dalla cornice), mai si indovina.
 *
 * ── «STO CARICANDO» NON È UNO STATO: SI DEDUCE ─────────────────────────────────────
 * Il risultato porta la chiave della richiesta a cui risponde (sede, settimana, versione). Se la chiave
 * a schermo non è più quella dell'ultimo risultato, si sta caricando: nessun `setState` sincrono nell'effetto,
 * e una risposta arrivata in ritardo per un'altra settimana non scavalca quella giusta.
 *
 * ── GIORNI E ORARI SONO DI ROMA ────────────────────────────────────────────────────
 * Il giorno di una visita è il giorno CIVILE (`dataCivile`), l'ora è quella dell'orologio a muro (`ora`): mai
 * `getDay()`/`getHours()` locali, che nel browser di chi è in viaggio direbbero un'altra cosa.
 */

interface Persona {
  id: string
  nome: string
  cognome: string
}

type VisitaAgenda = AppuntamentoRow & {
  scheda: { id: string; genitore_nome: string | null }
  fuori_disponibilita: boolean
  da_chiudere: boolean
}

interface DatiSettimana {
  appuntamenti: VisitaAgenda[]
  slot: SlotLibero[]
  persone: Persona[]
}

type Esito = { chiave: string; ok: true; dati: DatiSettimana } | { chiave: string; ok: false; testo: string }

const ROUTE = '/admin/crm'

/** L'identità della colonna degli slot della sede: non è un uuid, quindi non si scambia con nessuna persona. */
const COLONNA_SEDE = 'sede'

/** Il lunedì da mostrare per `oggi` (giorno civile): la domenica guarda già avanti. */
function lunediDa(oggi: string): string {
  const giornoSettimana = new Date(`${oggi}T12:00:00Z`).getUTCDay() // 0 = domenica; a mezzogiorno UTC non dipende dal fuso
  return addGiorni(oggi, giornoSettimana === 0 ? 1 : 1 - giornoSettimana)
}

/** Mezzogiorno UTC di un giorno civile: l'istante che nessun fuso sposta al giorno prima o dopo. */
const mezzogiorno = (ymd: string) => new Date(`${ymd}T12:00:00Z`)

async function caricaSettimana(chiave: string, scuolaId: string, lunedi: string, fallback: string): Promise<Esito> {
  try {
    const query = new URLSearchParams({ scuolaId, dal: lunedi, al: addGiorni(lunedi, 5) })
    const res = await fetch(`/api/admin/crm/appuntamenti?${query.toString()}`)
    if (!res.ok) {
      const errore = await erroreDaRisposta(res, fallback)
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-agenda-lettura-respinta', route: ROUTE, stato: res.status })
      return { chiave, ok: false, testo: errore.testo }
    }
    const dati = (await res.json()) as Partial<DatiSettimana>
    return {
      chiave,
      ok: true,
      dati: { appuntamenti: dati.appuntamenti ?? [], slot: dati.slot ?? [], persone: dati.persone ?? [] },
    }
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-agenda-lettura-fallita: ${nomeErrore(e)}`, route: ROUTE })
    return { chiave, ok: false, testo: fallback }
  }
}

const nomeDi = (p: Persona) => `${p.nome} ${p.cognome}`.trim()

type Voce = { tipo: 'visita'; inizio: string; visita: VisitaAgenda } | { tipo: 'slot'; inizio: string; slot: SlotLibero }

const BTN_PRIMARIO =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-kidville-green px-4 font-maven text-sm font-bold text-white transition-colors disabled:bg-kidville-neutral'
const BTN_SECONDARIO =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-kidville-line px-4 font-maven text-sm font-bold text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green disabled:opacity-50'
const BTN_ICONA =
  'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-kidville-line text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green'

type TipoAzione = 'svolto' | 'non_presentato' | 'annulla'

export function AgendaSettimana({ scuolaId, onApriScheda }: { scuolaId: string; onApriScheda: (schedaId: string) => void }) {
  const t = useTranslations('crmAgenda')
  const tShell = useTranslations('crmShell')
  const fmt = useDateFormat()

  const oggi = dataCivile(new Date())
  const [lunedi, setLunedi] = useState(() => lunediDa(oggi))
  const [versione, setVersione] = useState(0)
  const [esito, setEsito] = useState<Esito | null>(null)
  const [fissa, setFissa] = useState<{ appuntamento?: AppuntamentoRow; inizio?: string; assegnataA?: string; personeProposte?: string[] } | null>(null)
  const [azione, setAzione] = useState<{ tipo: TipoAzione; visita: VisitaAgenda } | null>(null)

  const chiave = `${scuolaId}|${lunedi}|${versione}`
  const fallbackErrore = t('erroreCaricamento')

  useEffect(() => {
    let attivo = true
    void caricaSettimana(chiave, scuolaId, lunedi, fallbackErrore).then((e) => {
      if (attivo) setEsito(e)
    })
    return () => {
      attivo = false
    }
  }, [chiave, scuolaId, lunedi, fallbackErrore])

  const ricarica = () => setVersione((v) => v + 1)
  const inCaricamento = esito === null || esito.chiave !== chiave

  const giorni = useMemo(() => [0, 1, 2, 3, 4, 5].map((n) => addGiorni(lunedi, n)), [lunedi])

  // Le colonne: le persone della sede, più chi ha visite in settimana pur non essendo (più) della sede.
  const dati = esito?.ok ? esito.dati : null
  const colonne = useMemo(() => {
    if (!dati) return []
    const note = new Map(dati.persone.map((p) => [p.id, p]))
    const extra = [...new Set(dati.appuntamenti.map((a) => a.assegnata_a))].filter((id) => !note.has(id))
    const conSlotSede = dati.slot.some((s) => s.utenteId === null)
    return [
      ...(conSlotSede ? [{ id: COLONNA_SEDE, nome: t('sede') }] : []),
      ...dati.persone.map((p) => ({ id: p.id, nome: nomeDi(p) })),
      ...extra.map((id) => ({ id, nome: t('personaSconosciuta') })),
    ]
  }, [dati, t])

  // Visite e slot raggruppati per giorno civile e per persona, in ordine d'orario.
  const voci = useMemo(() => {
    const mappa = new Map<string, Voce[]>()
    const metti = (giorno: string, utenteId: string, voce: Voce) => {
      const k = `${giorno}|${utenteId}`
      mappa.set(k, [...(mappa.get(k) ?? []), voce])
    }
    for (const v of dati?.appuntamenti ?? []) {
      metti(dataCivile(new Date(v.inizio)), v.assegnata_a, { tipo: 'visita', inizio: v.inizio, visita: v })
    }
    for (const s of dati?.slot ?? []) {
      // Gli slot della SEDE (`utenteId` nullo) stanno nella colonna «Sede».
      metti(dataCivile(new Date(s.inizio)), s.utenteId ?? COLONNA_SEDE, { tipo: 'slot', inizio: s.inizio, slot: s })
    }
    for (const [k, lista] of mappa) mappa.set(k, [...lista].sort((a, b) => (a.inizio < b.inizio ? -1 : a.inizio > b.inizio ? 1 : 0)))
    return mappa
  }, [dati])

  const daChiudere = (dati?.appuntamenti ?? []).filter((v) => v.da_chiudere).length
  const nomeGiorno = (ymd: string) =>
    conIniziale(intlDateTime(fmt.locale, { weekday: 'long', timeZone: APP_TIMEZONE }).format(mezzogiorno(ymd)))

  return (
    <section aria-labelledby="crm-agenda-titolo" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="crm-agenda-titolo" className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
            {t('titolo')}
          </h2>
          <p className="font-maven text-sm text-kidville-sub" aria-live="polite">
            {t('settimanaDal', { dal: fmt.giornoMese(mezzogiorno(lunedi)), al: fmt.dataLunga(mezzogiorno(giorni[5])) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_ICONA} aria-label={t('settimanaPrecedente')} onClick={() => setLunedi(addGiorni(lunedi, -7))}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" className={BTN_SECONDARIO} onClick={() => setLunedi(lunediDa(oggi))}>
            {t('questaSettimana')}
          </button>
          <button type="button" className={BTN_ICONA} aria-label={t('settimanaSuccessiva')} onClick={() => setLunedi(addGiorni(lunedi, 7))}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <button type="button" className={BTN_PRIMARIO} onClick={() => setFissa({})}>
            <CalendarPlus size={16} aria-hidden="true" />
            {t('fissaVisita')}
          </button>
        </div>
      </header>

      {daChiudere > 0 && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-2xl border border-kidville-warn/40 bg-kidville-warn-soft px-3 py-2 font-maven text-sm text-kidville-ink"
        >
          <AlertTriangle size={16} className="shrink-0 text-kidville-warn-strong" aria-hidden="true" />
          {t('daChiudereConteggio', { count: daChiudere })}
        </p>
      )}

      {esito === null || (inCaricamento && !esito.ok) ? (
        <p role="status" className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center font-maven text-kidville-sub">
          {t('caricamento')}
        </p>
      ) : !esito.ok ? (
        <div role="alert" className="space-y-3 rounded-card border border-kidville-error/30 bg-kidville-error-soft p-5 font-maven text-sm text-kidville-error-strong">
          <p>{esito.testo}</p>
          <button type="button" className={BTN_SECONDARIO} onClick={ricarica}>
            {t('riprova')}
          </button>
        </div>
      ) : colonne.length === 0 ? (
        <p className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center font-maven text-kidville-sub">{t('nessunaPersona')}</p>
      ) : (
        <div
          aria-busy={inCaricamento}
          className={`overflow-x-auto rounded-card border border-kidville-line bg-kidville-white ${inCaricamento ? 'pointer-events-none opacity-60' : ''}`}
        >
          <table className="w-full min-w-[40rem] border-collapse text-left">
            <caption className="sr-only">{t('settimanaDal', { dal: fmt.giornoMese(mezzogiorno(lunedi)), al: fmt.dataLunga(mezzogiorno(giorni[5])) })}</caption>
            <thead>
              <tr className="border-b border-kidville-line">
                <th scope="col" className="w-28 px-3 py-2 font-maven text-xs font-bold uppercase text-kidville-sub">
                  {t('colonnaGiorno')}
                </th>
                {colonne.map((c) => (
                  <th key={c.id} scope="col" className="min-w-[10rem] px-3 py-2 font-maven text-sm font-bold text-kidville-green">
                    {c.nome}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {giorni.map((g) => (
                <tr key={g} className={`border-b border-kidville-line last:border-b-0 ${g === oggi ? 'bg-kidville-green-soft/40' : ''}`}>
                  <th scope="row" aria-current={g === oggi ? 'date' : undefined} className="px-3 py-3 align-top font-maven text-sm">
                    <span className="block font-bold text-kidville-ink">{nomeGiorno(g)}</span>
                    <span className="block text-xs text-kidville-sub">{fmt.giornoMese(mezzogiorno(g))}</span>
                  </th>
                  {colonne.map((c) => {
                    const lista = voci.get(`${g}|${c.id}`) ?? []
                    return (
                      <td key={c.id} className="px-2 py-2 align-top">
                        {lista.length === 0 ? (
                          <span className="font-maven text-sm text-kidville-sub" aria-hidden="true">
                            —
                          </span>
                        ) : (
                          <ul className="flex flex-wrap items-start gap-2">
                            {lista.map((voce) =>
                              voce.tipo === 'slot' ? (
                                <li key={`s-${voce.slot.inizio}`}>
                                  <button
                                    type="button"
                                    className="min-h-[36px] rounded-pill border border-dashed border-kidville-green px-3 font-maven text-sm font-bold tabular-nums text-kidville-green transition-colors hover:bg-kidville-green-soft"
                                    aria-label={
                                      voce.slot.utenteId === null
                                        ? t('slotSedeAria', { giorno: `${nomeGiorno(g)} ${fmt.giornoMese(mezzogiorno(g))}`, ora: fmt.ora(voce.slot.inizio) })
                                        : t('slotAria', { giorno: `${nomeGiorno(g)} ${fmt.giornoMese(mezzogiorno(g))}`, ora: fmt.ora(voce.slot.inizio), persona: c.nome })
                                    }
                                    onClick={() =>
                                      setFissa(
                                        voce.slot.utenteId === null
                                          ? { inizio: voce.slot.inizio, personeProposte: voce.slot.personeLibere }
                                          : { inizio: voce.slot.inizio, assegnataA: voce.slot.utenteId },
                                      )
                                    }
                                  >
                                    {fmt.ora(voce.slot.inizio)}
                                  </button>
                                </li>
                              ) : (
                                <li key={`v-${voce.visita.id}`} className="w-full">
                                  <CartaVisita
                                    visita={voce.visita}
                                    ora={fmt.ora(voce.visita.inizio)}
                                    stato={tShell(`statiAppuntamento.${voce.visita.stato}`)}
                                    onApri={() => onApriScheda(voce.visita.scheda_id)}
                                    onSposta={() => setFissa({ appuntamento: voce.visita })}
                                    onAzione={(tipo) => setAzione({ tipo, visita: voce.visita })}
                                  />
                                </li>
                              ),
                            )}
                          </ul>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {fissa && (
        <FissaVisita
          scuolaId={scuolaId}
          appuntamento={fissa.appuntamento}
          inizioProposto={fissa.inizio}
          assegnataProposta={fissa.assegnataA}
          personeProposte={fissa.personeProposte}
          onFatto={() => {
            setFissa(null)
            ricarica()
          }}
          onAnnulla={() => setFissa(null)}
        />
      )}

      {azione && dati && (
        <ConfermaAzione
          key={`${azione.tipo}-${azione.visita.id}`}
          tipo={azione.tipo}
          visita={azione.visita}
          ora={fmt.ora(azione.visita.inizio)}
          persone={dati.persone}
          onFatto={() => {
            setAzione(null)
            ricarica()
          }}
          onAggiorna={ricarica}
          onChiudi={() => setAzione(null)}
        />
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────

function CartaVisita({
  visita,
  ora,
  stato,
  onApri,
  onSposta,
  onAzione,
}: {
  visita: VisitaAgenda
  ora: string
  stato: string
  onApri: () => void
  onSposta: () => void
  onAzione: (tipo: TipoAzione) => void
}) {
  const t = useTranslations('crmAgenda')
  const famiglia = visita.scheda.genitore_nome?.trim() || t('famigliaSenzaNome')
  const aperta = visita.stato === 'in_programma'
  const aria = (azione: string) => t('azioneAria', { azione, famiglia, ora })

  return (
    <div className="space-y-1.5 rounded-xl border border-kidville-line bg-kidville-white p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-maven text-sm font-bold tabular-nums text-kidville-ink">{ora}</span>
        <span className="rounded-pill bg-kidville-green-soft px-2 py-0.5 font-maven text-xs font-bold text-kidville-green">{stato}</span>
      </div>
      <button
        type="button"
        onClick={onApri}
        aria-label={t('apriScheda', { famiglia })}
        className="block w-full text-left font-maven text-sm font-semibold text-kidville-ink underline-offset-2 hover:text-kidville-green hover:underline"
      >
        {famiglia}
      </button>
      {visita.fuori_disponibilita && (
        <p className="font-maven text-xs font-semibold text-kidville-warn-strong" title={t('fuoriDisponibilitaAiuto')}>
          {t('badgeFuoriDisponibilita')}
        </p>
      )}
      {visita.da_chiudere && <p className="font-maven text-xs font-semibold text-kidville-error-strong">{t('badgeDaChiudere')}</p>}
      {aperta && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={BTN_ICONA} aria-label={aria(t('azioneSvolto'))} title={t('azioneSvolto')} onClick={() => onAzione('svolto')}>
            <Check size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={BTN_ICONA}
            aria-label={aria(t('azioneNonPresentato'))}
            title={t('azioneNonPresentato')}
            onClick={() => onAzione('non_presentato')}
          >
            <UserX size={16} aria-hidden="true" />
          </button>
          <button type="button" className={BTN_ICONA} aria-label={aria(t('azioneSposta'))} title={t('azioneSposta')} onClick={onSposta}>
            <MoveRight size={16} aria-hidden="true" />
          </button>
          <button type="button" className={BTN_ICONA} aria-label={aria(t('azioneAnnulla'))} title={t('azioneAnnulla')} onClick={() => onAzione('annulla')}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Il dialogo dei tre gesti che chiudono una visita.
 *
 *  · «svolto» CHIEDE CHI L'HA SVOLTA e propone l'assegnataria: chi segna non è per forza chi ha incontrato la
 *    famiglia, e il primo richiamo spetta a chi l'ha incontrata;
 *  · «non presentato» e «annulla» chiedono conferma: il primo fa nascere un richiamo, il secondo libera l'orario.
 *
 * Se la visita è già stata chiusa da una collega (`STATO_NON_AMMESSO`, `ELEMENTO_NON_TROVATO`) il server non ha
 * scritto niente: si dice com'è andata, si ricarica l'agenda sotto al dialogo e si lascia solo «Chiudi».
 */
function ConfermaAzione({
  tipo,
  visita,
  ora,
  persone,
  onFatto,
  onAggiorna,
  onChiudi,
}: {
  tipo: TipoAzione
  visita: VisitaAgenda
  ora: string
  persone: Persona[]
  onFatto: () => void
  onAggiorna: () => void
  onChiudi: () => void
}) {
  const t = useTranslations('crmAgenda')
  const idBase = useId()
  const idTitolo = `${idBase}-titolo`
  const idPersona = `${idBase}-persona`
  const famiglia = visita.scheda.genitore_nome?.trim() || t('famigliaSenzaNome')

  const [svoltoDa, setSvoltoDa] = useState(() => (persone.some((p) => p.id === visita.assegnata_a) ? visita.assegnata_a : ''))
  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState('')
  const [superata, setSuperata] = useState(false)

  const titolo = { svolto: t('svoltoTitolo'), non_presentato: t('nonPresentatoTitolo'), annulla: t('annullaTitolo') }[tipo]
  const corpo = { svolto: t('svoltoCorpo'), non_presentato: t('nonPresentatoCorpo'), annulla: t('annullaCorpo') }[tipo]
  const conferma = { svolto: t('svoltoConferma'), non_presentato: t('nonPresentatoConferma'), annulla: t('annullaConferma') }[tipo]

  const invia = async () => {
    setInCorso(true)
    setErrore('')
    try {
      const corpoRichiesta =
        tipo === 'svolto' ? { azione: 'svolto', svoltoDa } : tipo === 'non_presentato' ? { azione: 'non_presentato' } : { azione: 'annulla' }
      const res = await fetch(`/api/admin/crm/appuntamenti/${visita.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpoRichiesta),
      })
      if (!res.ok) {
        const e = await erroreDaRisposta(res, t('erroreAzione'))
        setErrore(e.testo)
        logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-agenda-${tipo}-respinto`, route: ROUTE, stato: res.status })
        if (e.codice === 'STATO_NON_AMMESSO' || e.codice === 'ELEMENTO_NON_TROVATO') {
          setSuperata(true)
          onAggiorna()
        }
        return
      }
      onFatto()
    } catch (e) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-agenda-${tipo}-fallito: ${nomeErrore(e)}`, route: ROUTE })
      setErrore(t('erroreAzione'))
    } finally {
      setInCorso(false)
    }
  }

  return (
    <Modal open onClose={onChiudi} title={titolo} labelledBy={idTitolo} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {titolo}
        </h2>
        <p className="mt-0.5 font-maven text-xs text-kidville-sub">
          {famiglia} · {ora}
        </p>

        <div className="mt-4 space-y-4">
          <p className="font-maven text-sm leading-relaxed text-kidville-ink">{corpo}</p>

          {tipo === 'svolto' && !superata && (
            <div className="space-y-1">
              <label htmlFor={idPersona} className="block font-maven text-xs font-semibold text-kidville-sub">
                {t('svoltoDa')}
              </label>
              <select
                id={idPersona}
                value={svoltoDa}
                onChange={(e) => setSvoltoDa(e.target.value)}
                disabled={inCorso}
                style={{ fontSize: '16px' }}
                className="min-h-[44px] w-full rounded-xl border border-kidville-line bg-kidville-white px-3 font-maven"
              >
                <option value="">{t('scegliPersona')}</option>
                {persone.map((p) => (
                  <option key={p.id} value={p.id}>
                    {nomeDi(p)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {errore && (
            <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{errore}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={onChiudi} className={BTN_SECONDARIO}>
              {superata ? t('chiudi') : t('indietro')}
            </button>
            {!superata && (
              <button type="button" onClick={invia} disabled={inCorso || (tipo === 'svolto' && svoltoDa === '')} className={BTN_PRIMARIO}>
                {inCorso ? t('invioInCorso') : conferma}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
