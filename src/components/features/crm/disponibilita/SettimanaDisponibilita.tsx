'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { APP_TIMEZONE, dataCivile, intlDateTime } from '@/i18n/config'
import { lunediDi, type FasceDelProprietario } from '@/lib/crm/settimane'
import { addGiorni } from '@/lib/format/data'
import { conIniziale, useDateFormat } from '@/lib/i18n/date'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'

/**
 * CRM DELLA SEGRETERIA · LE DISPONIBILITÀ, SETTIMANA PER SETTIMANA.
 *
 * Una griglia: una riga per la SEDE e una per ogni persona della sede, sette giorni (lunedì–domenica), in ogni
 * casella le fasce in cui si ricevono le famiglie («9:00–12:00»). Accanto al nome si legge da dove vengono le
 * fasce di quella settimana:
 *
 *  · `registrata` — «modificata questa settimana»;
 *  · `ereditata`  — «uguale alla settimana del 5 ottobre»: nessuno l'ha toccata, vale l'ultima impostata prima;
 *  · `nessuna`    — «non ancora impostata».
 *
 * ── MODIFICARE UNA SETTIMANA È UNA SCRITTURA SOLA ───────────────────────────────────
 * «Modifica» apre un dialogo con le fasce di QUEL proprietario per QUELLA settimana, già pronte da cambiare
 * (anche quando erano ereditate). «Salva» manda TUTTE le righe con una `PUT`, e il server le sostituisce in
 * blocco (`crm_salva_settimana`): la copia di ciò che si ereditava e la modifica non possono restare a metà.
 * Vale da quella settimana in poi, finché qualcuno non la cambia di nuovo: il dialogo lo dice.
 * Ogni persona della sede modifica le fasce della sede e quelle delle colleghe (nessuna restrizione).
 *
 * ── LE SETTIMANE PASSATE SI LEGGONO E BASTA ─────────────────────────────────────────
 * Se il server dice che la settimana non è modificabile, niente bottoni «Modifica» e un avviso. Il server
 * risponde comunque 409 `SETTIMANA_PASSATA` a chi ci provasse: il rifiuto resta nel dialogo.
 *
 * ── «STO CARICANDO» NON È UNO STATO: SI DEDUCE ──────────────────────────────────────
 * Il risultato porta la chiave della richiesta a cui risponde (sede, settimana, versione). Se la chiave a
 * schermo non è più quella dell'ultimo risultato, si sta caricando: nessun `setState` sincrono nell'effetto, e
 * una risposta arrivata in ritardo per un'altra settimana non scavalca quella giusta.
 *
 * ── GIORNI E ORARI SONO DI ROMA ────────────────────────────────────────────────────
 * Il lunedì è un GIORNO CIVILE (`YYYY-MM-DD`, `lunediDi`); le ore sono `HH:MM` di Roma, come le dà il server.
 * Mai `getDay()`/`getHours()` locali.
 */

interface Persona {
  id: string
  nome: string
  cognome: string
}

interface DatiSettimana {
  /** il lunedì della settimana a cui rispondono i dati */
  settimana: string
  modificabile: boolean
  proprietari: FasceDelProprietario[]
  persone: Persona[]
}

type Esito = { chiave: string; ok: true; dati: DatiSettimana } | { chiave: string; ok: false; testo: string; stato: number | null }

const ROUTE = '/admin/crm'
const URL_DISPONIBILITA = '/api/admin/crm/disponibilita'

/** Quanto può durare uno slot a scelta (minuti). Una durata già salvata fuori elenco si tiene (vedi `durateCon`). */
const DURATE_SLOT_MIN = [15, 20, 30, 45, 60, 90]
const DURATA_SLOT_DEFAULT_MIN = 45
/** Una riga nuova parte da lunedì, 9:00–13:00. */
const GIORNO_DEFAULT = 1
const ORA_INIZIO_DEFAULT = '09:00'
const ORA_FINE_DEFAULT = '13:00'
/** I giorni che si offrono in una riga nuova: da lunedì (1) a sabato (6), come l'agenda. La domenica resta se c'è già. */
const GIORNI_OFFERTI = [1, 2, 3, 4, 5, 6]
/** Il tetto che il server accetta per proprietario e per settimana. */
const FASCE_MAX = 50

const mezzogiorno = (ymd: string) => new Date(`${ymd}T12:00:00Z`)
const nomeDi = (p: Persona) => `${p.nome} ${p.cognome}`.trim()
/** `09:00` → `9:00`: le fasce si leggono come «9:00–12:00». */
const senzaZero = (ora: string) => ora.replace(/^0(?=\d:)/, '')
const durateCon = (durata: number) => (DURATE_SLOT_MIN.includes(durata) ? DURATE_SLOT_MIN : [...DURATE_SLOT_MIN, durata].sort((a, b) => a - b))

async function caricaSettimana(chiave: string, scuolaId: string, lunedi: string, fallback: string): Promise<Esito> {
  try {
    const query = new URLSearchParams({ scuolaId, settimana: lunedi })
    const res = await fetch(`${URL_DISPONIBILITA}?${query.toString()}`)
    if (!res.ok) {
      // Il testo è quello del catalogo per il codice del server (`CRM_NON_INSTALLATO` → «Il CRM non è ancora disponibile…»).
      const errore = await erroreDaRisposta(res, fallback)
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-settimana-lettura-respinta', route: ROUTE, stato: res.status })
      return { chiave, ok: false, testo: errore.testo, stato: res.status }
    }
    const corpo = (await res.json()) as { data?: Partial<DatiSettimana> | null }
    const d = corpo.data
    if (!d || !Array.isArray(d.proprietari)) {
      // Una risposta che non si sa leggere non è «nessuno è disponibile»: si dice che non si è riusciti.
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-settimana-risposta-illeggibile', route: ROUTE, stato: res.status })
      return { chiave, ok: false, testo: fallback, stato: null }
    }
    return {
      chiave,
      ok: true,
      dati: { settimana: d.settimana ?? lunedi, modificabile: d.modificabile === true, proprietari: d.proprietari, persone: d.persone ?? [] },
    }
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-settimana-lettura-fallita: ${nomeErrore(e)}`, route: ROUTE })
    return { chiave, ok: false, testo: fallback, stato: null }
  }
}

const CAMPO =
  'min-h-[44px] w-full rounded-xl border border-kidville-line bg-kidville-white px-3 font-maven text-kidville-ink'
const BTN_PRIMARIO =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-kidville-green px-4 font-maven text-sm font-bold text-white transition-colors disabled:bg-kidville-neutral'
const BTN_SECONDARIO =
  'inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-kidville-line px-4 font-maven text-sm font-bold text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green disabled:opacity-50'
const BTN_ICONA =
  'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-kidville-line text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green'

interface InModifica {
  proprietario: FasceDelProprietario
  nome: string
  settimana: string
}

export function SettimanaDisponibilita({ scuolaId }: { scuolaId: string }) {
  const t = useTranslations('crmAgenda')
  const fmt = useDateFormat()
  const idTitolo = useId()

  const oggi = dataCivile(new Date())
  const [lunedi, setLunedi] = useState(() => lunediDi(oggi))
  const [versione, setVersione] = useState(0)
  const [esito, setEsito] = useState<Esito | null>(null)
  const [inModifica, setInModifica] = useState<InModifica | null>(null)

  const chiave = `${scuolaId}|${lunedi}|${versione}`
  const fallbackErrore = t('dispErroreCaricamento')

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
  const dati = esito?.ok ? esito.dati : null

  // La tabella mostra la settimana a cui rispondono i dati; mentre ne arriva un'altra resta quella, attenuata.
  const settimanaTabella = dati?.settimana ?? lunedi
  const giorni = useMemo(() => [0, 1, 2, 3, 4, 5, 6].map((n) => addGiorni(settimanaTabella, n)), [settimanaTabella])

  const nomeGiorno = (ymd: string) =>
    conIniziale(intlDateTime(fmt.locale, { weekday: 'long', timeZone: APP_TIMEZONE }).format(mezzogiorno(ymd)))
  const periodo = (da: string) =>
    t('settimanaDal', { dal: fmt.giornoMese(mezzogiorno(da)), al: fmt.dataLunga(mezzogiorno(addGiorni(da, 6))) })

  const nomeProprietario = (p: FasceDelProprietario) => {
    if (p.utenteId === null) return t('sede')
    const persona = dati?.persone.find((x) => x.id === p.utenteId)
    return persona ? nomeDi(persona) : t('personaSconosciuta')
  }

  /** «uguale alla settimana del 5 ottobre»: l'anno si scrive solo se non è quello della settimana mostrata. */
  const origine = (p: FasceDelProprietario) => {
    if (p.origine === 'registrata') return t('dispOrigineRegistrata')
    if (p.origine === 'ereditata' && p.daSettimana) {
      const stessoAnno = p.daSettimana.slice(0, 4) === settimanaTabella.slice(0, 4)
      const data = stessoAnno ? fmt.giornoMese(mezzogiorno(p.daSettimana)) : fmt.dataLunga(mezzogiorno(p.daSettimana))
      return t('dispOrigineEreditata', { data })
    }
    return t('dispOrigineNessuna')
  }

  return (
    <section aria-labelledby={`${idTitolo}-titolo`} className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id={`${idTitolo}-titolo`} className="font-maven text-base font-bold text-kidville-ink">
            {t('dispSettimaneTitolo')}
          </h3>
          <p className="font-maven text-sm text-kidville-sub" aria-live="polite">
            {periodo(lunedi)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN_ICONA} aria-label={t('settimanaPrecedente')} onClick={() => setLunedi(addGiorni(lunedi, -7))}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" className={BTN_SECONDARIO} onClick={() => setLunedi(lunediDi(oggi))}>
            {t('questaSettimana')}
          </button>
          <button type="button" className={BTN_ICONA} aria-label={t('settimanaSuccessiva')} onClick={() => setLunedi(addGiorni(lunedi, 7))}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      {dati && !dati.modificabile && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-2xl border border-kidville-warn/40 bg-kidville-warn-soft px-3 py-2 font-maven text-sm text-kidville-ink"
        >
          <AlertTriangle size={16} className="shrink-0 text-kidville-warn-strong" aria-hidden="true" />
          {t('dispSettimanaPassata')}
        </p>
      )}

      {esito === null || (inCaricamento && !esito.ok) ? (
        <p role="status" className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center font-maven text-kidville-sub">
          {t('dispCaricamento')}
        </p>
      ) : !esito.ok ? (
        <div role="alert" className="space-y-3 rounded-card border border-kidville-error/30 bg-kidville-error-soft p-5 font-maven text-sm text-kidville-error-strong">
          <p>{esito.testo}</p>
          {/* Se le tabelle del CRM non ci sono, riprovare non cambia niente. */}
          {esito.stato !== 503 && (
            <button type="button" className={BTN_SECONDARIO} onClick={ricarica}>
              {t('riprova')}
            </button>
          )}
        </div>
      ) : (
        <div
          aria-busy={inCaricamento}
          className={`overflow-x-auto rounded-card border border-kidville-line bg-kidville-white ${inCaricamento ? 'pointer-events-none opacity-60' : ''}`}
        >
          <table className="w-full min-w-[56rem] border-collapse text-left">
            <caption className="sr-only">{periodo(settimanaTabella)}</caption>
            <thead>
              <tr className="border-b border-kidville-line">
                <th scope="col" className="w-44 px-3 py-2 font-maven text-xs font-bold uppercase text-kidville-sub">
                  {t('dispPersona')}
                </th>
                {giorni.map((g) => (
                  <th key={g} scope="col" className="min-w-[7rem] px-2 py-2 font-maven text-sm">
                    <div className="font-bold text-kidville-green">{nomeGiorno(g)}</div>
                    <div className="text-xs font-normal text-kidville-sub">{fmt.giornoMese(mezzogiorno(g))}</div>
                  </th>
                ))}
                {esito.dati.modificabile && (
                  <th scope="col" className="w-28 px-2 py-2">
                    <span className="sr-only">{t('dispColonnaAzioni')}</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {esito.dati.proprietari.map((p) => {
                const nome = nomeProprietario(p)
                return (
                  <tr key={p.utenteId ?? 'sede'} className="border-b border-kidville-line last:border-b-0">
                    <th scope="row" className="px-3 py-3 text-left align-top font-maven text-sm">
                      <div className="font-bold text-kidville-ink">{nome}</div>
                      <div className="text-xs font-normal text-kidville-sub">{origine(p)}</div>
                    </th>
                    {giorni.map((g, i) => {
                      const fasce = p.fasce.filter((f) => f.giornoSettimana === i + 1)
                      return (
                        <td key={g} className="px-2 py-3 align-top font-maven text-sm">
                          {fasce.length === 0 ? (
                            <span className="text-kidville-sub" aria-hidden="true">
                              —
                            </span>
                          ) : (
                            <ul className="space-y-1.5">
                              {fasce.map((f) => (
                                <li key={`${f.oraInizio}-${f.oraFine}`}>
                                  <span className="block font-semibold tabular-nums text-kidville-ink">
                                    {senzaZero(f.oraInizio)}–{senzaZero(f.oraFine)}
                                  </span>
                                  <span className="block text-xs text-kidville-sub">{t('dispSlotDa', { min: f.durataSlotMin })}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      )
                    })}
                    {esito.dati.modificabile && (
                      <td className="px-2 py-3 text-right align-top">
                        <button
                          type="button"
                          className={BTN_SECONDARIO}
                          aria-label={t('dispModificaSettimanaAria', { nome })}
                          // Mentre arriva un'altra settimana la tabella è quella vecchia: non si apre un dialogo su di lei.
                          disabled={inCaricamento}
                          onClick={() => setInModifica({ proprietario: p, nome, settimana: esito.dati.settimana })}
                        >
                          <Pencil size={16} aria-hidden="true" />
                          {t('dispModifica')}
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {inModifica && (
        <DialogoSettimana
          key={`${inModifica.settimana}|${inModifica.proprietario.utenteId ?? 'sede'}`}
          scuolaId={scuolaId}
          settimana={inModifica.settimana}
          proprietario={inModifica.proprietario}
          nome={inModifica.nome}
          sottotitolo={periodo(inModifica.settimana)}
          nomeGiorno={(n) => nomeGiorno(addGiorni(inModifica.settimana, n - 1))}
          onFatto={() => {
            setInModifica(null)
            ricarica()
          }}
          onChiudi={() => setInModifica(null)}
        />
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────

interface Riga {
  /** identità della riga nel dialogo (non è un id del server): le righe si aggiungono e si tolgono */
  chiave: number
  giorno: number
  oraInizio: string
  oraFine: string
  durata: number
}

function Errore({ testo }: { testo: string }) {
  if (!testo) return null
  return (
    <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{testo}</span>
    </div>
  )
}

/**
 * Le fasce di un proprietario per una settimana: si aggiungono e si tolgono righe (giorno, dalle, alle, durata
 * di uno slot) e «Salva» le manda TUTTE. Se la settimana non è mai stata impostata si parte senza righe.
 *
 * Un rifiuto del server (409 `SETTIMANA_PASSATA`, 422 `FASCE_SOVRAPPOSTE`, 422 `PERSONA_NON_DELLA_SEDE`…) NON
 * chiude il dialogo: il testo sta qui, in un `role="alert"`, e le righe restano come sono da correggere.
 */
function DialogoSettimana({
  scuolaId,
  settimana,
  proprietario,
  nome,
  sottotitolo,
  nomeGiorno,
  onFatto,
  onChiudi,
}: {
  scuolaId: string
  settimana: string
  proprietario: FasceDelProprietario
  nome: string
  sottotitolo: string
  nomeGiorno: (n: number) => string
  onFatto: () => void
  onChiudi: () => void
}) {
  const t = useTranslations('crmAgenda')
  const idBase = useId()
  const [righe, setRighe] = useState<Riga[]>(() =>
    proprietario.fasce.map((f, i) => ({
      chiave: i,
      giorno: f.giornoSettimana,
      oraInizio: f.oraInizio,
      oraFine: f.oraFine,
      durata: f.durataSlotMin,
    })),
  )
  const prossimaChiave = useRef(proprietario.fasce.length)
  const inVolo = useRef(false)
  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState('')

  const aggiungi = () => {
    const chiave = prossimaChiave.current++
    setRighe((r) => [
      ...r,
      { chiave, giorno: GIORNO_DEFAULT, oraInizio: ORA_INIZIO_DEFAULT, oraFine: ORA_FINE_DEFAULT, durata: DURATA_SLOT_DEFAULT_MIN },
    ])
  }
  const cambia = (chiave: number, campi: Partial<Riga>) =>
    setRighe((r) => r.map((x) => (x.chiave === chiave ? { ...x, ...campi } : x)))
  const togli = (chiave: number) => setRighe((r) => r.filter((x) => x.chiave !== chiave))

  const salva = async () => {
    // Un secondo invio (clic doppio, Invio nel campo) mentre il primo è in volo non manda niente.
    if (inVolo.current) return
    if (righe.some((r) => !r.oraInizio || !r.oraFine || r.oraFine <= r.oraInizio)) {
      setErrore(t('dispErroreOre'))
      return
    }
    inVolo.current = true
    setInCorso(true)
    setErrore('')
    try {
      const res = await fetch(URL_DISPONIBILITA, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scuolaId,
          settimana,
          utenteId: proprietario.utenteId,
          fasce: righe.map((r) => ({ giornoSettimana: r.giorno, oraInizio: r.oraInizio, oraFine: r.oraFine, durataSlotMin: r.durata })),
        }),
      })
      if (!res.ok) {
        const e = await erroreDaRisposta(res, t('dispErroreSalva'))
        logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-settimana-salva-respinta', route: ROUTE, stato: res.status })
        setErrore(e.testo)
        return
      }
      onFatto()
    } catch (e) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-settimana-salva-fallita: ${nomeErrore(e)}`, route: ROUTE })
      setErrore(t('dispErroreSalva'))
    } finally {
      inVolo.current = false
      setInCorso(false)
    }
  }

  const titolo = t('dispFasceTitolo', { nome })
  return (
    <Modal open onClose={onChiudi} title={titolo} labelledBy={`${idBase}-titolo`} className="w-full max-w-2xl">
      <div className="max-h-[90vh] overflow-y-auto rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={`${idBase}-titolo`} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {titolo}
        </h2>
        <p className="mt-0.5 font-maven text-xs text-kidville-sub">{sottotitolo}</p>
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void salva()
          }}
        >
          {righe.length === 0 ? (
            <p className="rounded-xl border border-dashed border-kidville-line p-4 font-maven text-sm text-kidville-sub">{t('dispNessunaFascia')}</p>
          ) : (
            <ul className="space-y-3">
              {righe.map((r) => {
                const id = `${idBase}-${r.chiave}`
                const giorni = GIORNI_OFFERTI.includes(r.giorno) ? GIORNI_OFFERTI : [...GIORNI_OFFERTI, r.giorno]
                return (
                  <li
                    key={r.chiave}
                    className="grid grid-cols-2 items-end gap-3 rounded-2xl border border-kidville-line p-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_auto]"
                  >
                    <div className="col-span-2 space-y-1 sm:col-span-1">
                      <label htmlFor={`${id}-giorno`} className="block font-maven text-xs font-semibold text-kidville-sub">
                        {t('dispGiorno')}
                      </label>
                      <select
                        id={`${id}-giorno`}
                        value={r.giorno}
                        onChange={(e) => cambia(r.chiave, { giorno: Number(e.target.value) })}
                        style={{ fontSize: '16px' }}
                        className={CAMPO}
                      >
                        {giorni.map((g) => (
                          <option key={g} value={g}>
                            {nomeGiorno(g)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor={`${id}-da`} className="block font-maven text-xs font-semibold text-kidville-sub">
                        {t('dispDalle')}
                      </label>
                      <input
                        id={`${id}-da`}
                        type="time"
                        value={r.oraInizio}
                        onChange={(e) => cambia(r.chiave, { oraInizio: e.target.value })}
                        style={{ fontSize: '16px' }}
                        className={CAMPO}
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor={`${id}-a`} className="block font-maven text-xs font-semibold text-kidville-sub">
                        {t('dispAlle')}
                      </label>
                      <input
                        id={`${id}-a`}
                        type="time"
                        value={r.oraFine}
                        onChange={(e) => cambia(r.chiave, { oraFine: e.target.value })}
                        style={{ fontSize: '16px' }}
                        className={CAMPO}
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor={`${id}-slot`} className="block font-maven text-xs font-semibold text-kidville-sub">
                        {t('dispDurataSlot')}
                      </label>
                      <select
                        id={`${id}-slot`}
                        value={r.durata}
                        onChange={(e) => cambia(r.chiave, { durata: Number(e.target.value) })}
                        style={{ fontSize: '16px' }}
                        className={CAMPO}
                      >
                        {durateCon(r.durata).map((m) => (
                          <option key={m} value={m}>
                            {t('durataMinuti', { min: m })}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      className={BTN_ICONA}
                      aria-label={t('dispEliminaAria', { giorno: nomeGiorno(r.giorno), da: r.oraInizio, a: r.oraFine })}
                      onClick={() => togli(r.chiave)}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <button type="button" className={BTN_SECONDARIO} onClick={aggiungi} disabled={righe.length >= FASCE_MAX}>
            <Plus size={16} aria-hidden="true" />
            {t('dispAggiungiFascia')}
          </button>

          <p className="font-maven text-xs text-kidville-sub">{t('dispVale')}</p>
          <Errore testo={errore} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={onChiudi} className={BTN_SECONDARIO}>
              {t('annulla')}
            </button>
            <button type="submit" disabled={inCorso} className={BTN_PRIMARIO}>
              {inCorso ? t('invioInCorso') : t('dispSalva')}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  )
}
