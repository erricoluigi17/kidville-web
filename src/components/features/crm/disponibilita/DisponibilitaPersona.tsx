'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, CalendarOff, Trash2 } from 'lucide-react'
import { DateField } from '@/components/ui/DateField'
import { Modal } from '@/components/ui/Modal'
import { dataCivile } from '@/i18n/config'
import type { IndisponibilitaRow, MotivoIndisponibilita } from '@/lib/crm/tipi'
import { oraCivile } from '@/lib/format/confini-giorno'
import { useDateFormat } from '@/lib/i18n/date'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import { SettimanaDisponibilita } from './SettimanaDisponibilita'

/**
 * CRM DELLA SEGRETERIA · LA DISPONIBILITÀ DI CHI FA LE VISITE.
 *
 * Tre cose, in quest'ordine:
 *  · la SETTIMANA: le fasce in cui la sede e ogni persona ricevono, settimana per settimana
 *    (`SettimanaDisponibilita`). Gli slot dell'agenda si calcolano da qui, ogni volta: cambiare una fascia non
 *    tocca le visite già fissate;
 *  · le ASSENZE di una persona (ferie, malattia, altro): tolgono gli slot di quei giorni;
 *  · le CHIUSURE DELLA SEDE: tolgono gli slot di tutte.
 *
 * La griglia della settimana mostra TUTTI e ognuno può modificare le fasce di chiunque: non dipende da chi
 * guarda. Le ASSENZE sono invece di una persona sola: la segreteria vede le PROPRIE, l'admin può scegliere
 * un'altra persona. Chi sta guardando lo dice il server (`io` nella risposta alla GET delle disponibilità),
 * non il client: il ruolo non si indovina da qui.
 *
 * ── GIORNI E ORARI SONO DI ROMA ────────────────────────────────────────────────────
 * Le assenze sono intervalli di istanti con l'estremo finale ESCLUSO: l'ultimo giorno di ferie va mostrato un
 * istante prima di quell'estremo, altrimenti «dal 3 al 5» apparirebbe «dal 3 al 6».
 */

interface Persona {
  id: string
  nome: string
  cognome: string
  ruolo: string
}

interface Dati {
  assenze: IndisponibilitaRow[]
  persone: Persona[]
  io: { id: string; ruolo: string }
}

/** `testo` è quello da mostrare (il catalogo per il codice del server, o la frase generica); `stato` nullo = la richiesta non è arrivata. */
type Esito = { chiave: string; ok: true; dati: Dati } | { chiave: string; ok: false; testo: string; stato: number | null }

type Lettura<T> = { ok: true; corpo: T } | { ok: false; testo: string; stato: number | null }

const ROUTE = '/admin/crm'

const nomeDi = (p: { nome: string; cognome: string }) => `${p.nome} ${p.cognome}`.trim()

async function leggi<T>(url: string, fallback: string): Promise<Lettura<T>> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-disponibilita-lettura-respinta', route: ROUTE, stato: res.status })
      // 503: le tabelle del CRM non ci sono (`CRM_NON_INSTALLATO`). La frase generica direbbe «riprova» a chi non
      // può farci niente: lì si dice com'è, col testo del catalogo. Ogni altro guasto resta «non riesco a leggere».
      if (res.status === 503) {
        const errore = await erroreDaRisposta(res, fallback)
        return { ok: false, testo: errore.testo, stato: res.status }
      }
      return { ok: false, testo: fallback, stato: res.status }
    }
    return { ok: true, corpo: (await res.json()) as T }
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-disponibilita-lettura-fallita: ${nomeErrore(e)}`, route: ROUTE })
    return { ok: false, testo: fallback, stato: null }
  }
}

async function caricaTutto(chiave: string, scuolaId: string, fallback: string): Promise<Esito> {
  const q = `?${new URLSearchParams({ scuolaId }).toString()}`
  // Da questa lettura il pannello prende SOLO `io` (chi sta guardando): le fasce le legge e le mostra
  // `SettimanaDisponibilita`, con la sua richiesta. La settimana è quella di oggi, a Roma.
  const qSettimana = `?${new URLSearchParams({ scuolaId, settimana: dataCivile(new Date()) }).toString()}`
  const [disp, ass, per] = await Promise.all([
    leggi<{ io?: { id: string; ruolo: string } }>(`/api/admin/crm/disponibilita${qSettimana}`, fallback),
    leggi<{ data?: IndisponibilitaRow[] }>(`/api/admin/crm/indisponibilita${q}`, fallback),
    leggi<{ data?: Persona[] }>(`/api/admin/crm/persone${q}`, fallback),
  ])
  // La prima lettura andata male dà il testo: se le tabelle del CRM non ci sono, lo dice (503).
  for (const lettura of [disp, ass, per]) {
    if (!lettura.ok) return { chiave, ok: false, testo: lettura.testo, stato: lettura.stato }
  }
  if (!disp.ok || !ass.ok || !per.ok) return { chiave, ok: false, testo: fallback, stato: null }
  // Senza `io` non si sa chi guarda: non si indovina.
  if (!disp.corpo.io) return { chiave, ok: false, testo: fallback, stato: null }
  return { chiave, ok: true, dati: { assenze: ass.corpo.data ?? [], persone: per.corpo.data ?? [], io: disp.corpo.io } }
}

/** Scrive (POST/DELETE) e rende il testo da mostrare se il server ha rifiutato. `null` = riuscito. */
async function scrivi(metodo: 'POST' | 'DELETE', url: string, corpo: unknown, fallback: string, evento: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: metodo,
      ...(corpo === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) }),
    })
    if (!res.ok) {
      const e = await erroreDaRisposta(res, fallback)
      logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-${evento}-respinto`, route: ROUTE, stato: res.status })
      return e.testo
    }
    return null
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-${evento}-fallito: ${nomeErrore(e)}`, route: ROUTE })
    return fallback
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

type Dialogo = { tipo: 'assenza' } | { tipo: 'chiusura' } | { tipo: 'elimina-assenza'; assenza: IndisponibilitaRow }

export function DisponibilitaPersona({ scuolaId }: { scuolaId: string }) {
  const t = useTranslations('crmAgenda')
  const tShell = useTranslations('crmShell')
  const fmt = useDateFormat()
  const idPersona = useId()

  const [versione, setVersione] = useState(0)
  const [esito, setEsito] = useState<Esito | null>(null)
  const [scelta, setScelta] = useState('')
  const [dialogo, setDialogo] = useState<Dialogo | null>(null)

  const chiave = `${scuolaId}|${versione}`
  const fallbackErrore = t('dispErroreCaricamento')
  useEffect(() => {
    let attivo = true
    void caricaTutto(chiave, scuolaId, fallbackErrore).then((e) => {
      if (attivo) setEsito(e)
    })
    return () => {
      attivo = false
    }
  }, [chiave, scuolaId, fallbackErrore])

  const ricarica = () => setVersione((v) => v + 1)
  const chiudiERicarica = () => {
    setDialogo(null)
    ricarica()
  }

  const dati = esito?.ok ? esito.dati : null

  // La persona di cui si guardano le assenze: io, salvo che l'admin ne scelga un'altra.
  const puoScegliere = dati?.io.ruolo === 'admin'
  const persona = useMemo(() => {
    if (!dati) return ''
    if (puoScegliere && scelta && dati.persone.some((p) => p.id === scelta)) return scelta
    return dati.io.id
  }, [dati, puoScegliere, scelta])

  const assenze = (dati?.assenze ?? []).filter((a) => a.utente_id === persona)
  const chiusure = (dati?.assenze ?? []).filter((a) => a.utente_id === null)

  /** «3 novembre» o «3 – 5 novembre»: l'estremo finale è ESCLUSO, si mostra l'ultimo giorno compreso. */
  const intervallo = (a: IndisponibilitaRow) => {
    const ultimo = new Date(Date.parse(a.al) - 1)
    const intero = oraCivile(a.dal) === '00:00' && oraCivile(a.al) === '00:00'
    if (intero) {
      const da = fmt.dataBreve(a.dal)
      const fino = fmt.dataBreve(ultimo)
      return da === fino ? da : t('intervalloGiorni', { dal: da, al: fino })
    }
    return t('intervalloGiorni', { dal: fmt.dataOra(a.dal), al: fmt.dataOra(a.al) })
  }

  if (esito === null) {
    return (
      <p role="status" className="rounded-card border border-kidville-line bg-kidville-white p-10 text-center font-maven text-kidville-sub">
        {t('caricamento')}
      </p>
    )
  }
  if (!esito.ok || !dati) {
    return (
      <div role="alert" className="space-y-3 rounded-card border border-kidville-error/30 bg-kidville-error-soft p-5 font-maven text-sm text-kidville-error-strong">
        <p>{esito.ok ? fallbackErrore : esito.testo}</p>
        {/* Se le tabelle del CRM non ci sono, riprovare non cambia niente. */}
        {(esito.ok || esito.stato !== 503) && (
          <button type="button" className={BTN_SECONDARIO} onClick={ricarica}>
            {t('riprova')}
          </button>
        )}
      </div>
    )
  }

  return (
    <section aria-labelledby={`${idPersona}-titolo`} className="space-y-6">
      <header className="space-y-3">
        <h2 id={`${idPersona}-titolo`} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('dispTitolo')}
        </h2>
        <p className="font-maven text-sm text-kidville-sub">{t('dispIntro')}</p>
      </header>

      {/* ── La settimana: la sede e ogni persona, fasce per fasce ── */}
      <SettimanaDisponibilita scuolaId={scuolaId} />

      {/* ── Le assenze ── */}
      <section aria-labelledby={`${idPersona}-assenze`} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${idPersona}-assenze`} className="font-maven text-base font-bold text-kidville-ink">
            {t('dispAssenze')}
          </h3>
          <button type="button" className={BTN_SECONDARIO} onClick={() => setDialogo({ tipo: 'assenza' })}>
            <CalendarOff size={16} aria-hidden="true" />
            {t('dispAggiungiAssenza')}
          </button>
        </div>
        {puoScegliere && (
          <div className="max-w-xs space-y-1">
            <label htmlFor={idPersona} className="block font-maven text-xs font-semibold text-kidville-sub">
              {t('dispPersona')}
            </label>
            <select id={idPersona} value={persona} onChange={(e) => setScelta(e.target.value)} style={{ fontSize: '16px' }} className={CAMPO}>
              {dati.persone.map((p) => (
                <option key={p.id} value={p.id}>
                  {nomeDi(p)}
                </option>
              ))}
            </select>
          </div>
        )}
        <ElencoAssenze
          righe={assenze}
          vuoto={t('dispNessunaAssenza')}
          etichetta={(a) => tShell(`motiviIndisponibilita.${a.motivo}`)}
          intervallo={intervallo}
          onElimina={(a) => setDialogo({ tipo: 'elimina-assenza', assenza: a })}
          eliminaAria={(a) => t('dispEliminaAssenzaAria', { motivo: tShell(`motiviIndisponibilita.${a.motivo}`), periodo: intervallo(a) })}
        />
      </section>

      {/* ── Le chiusure della sede ── */}
      <section aria-labelledby={`${idPersona}-chiusure`} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${idPersona}-chiusure`} className="font-maven text-base font-bold text-kidville-ink">
            {t('dispChiusure')}
          </h3>
          <button type="button" className={BTN_SECONDARIO} onClick={() => setDialogo({ tipo: 'chiusura' })}>
            <CalendarOff size={16} aria-hidden="true" />
            {t('dispAggiungiChiusura')}
          </button>
        </div>
        <p className="font-maven text-xs text-kidville-sub">{t('dispChiusureAiuto')}</p>
        <ElencoAssenze
          righe={chiusure}
          vuoto={t('dispNessunaChiusura')}
          etichetta={(a) => tShell(`motiviIndisponibilita.${a.motivo}`)}
          intervallo={intervallo}
          onElimina={(a) => setDialogo({ tipo: 'elimina-assenza', assenza: a })}
          eliminaAria={(a) => t('dispEliminaAssenzaAria', { motivo: tShell(`motiviIndisponibilita.${a.motivo}`), periodo: intervallo(a) })}
        />
      </section>

      {(dialogo?.tipo === 'assenza' || dialogo?.tipo === 'chiusura') && (
        <DialogoAssenza
          key={dialogo.tipo}
          scuolaId={scuolaId}
          utenteId={dialogo.tipo === 'chiusura' ? null : persona}
          onFatto={chiudiERicarica}
          onChiudi={() => setDialogo(null)}
        />
      )}
      {dialogo?.tipo === 'elimina-assenza' && (
        <DialogoElimina
          key={dialogo.assenza.id}
          titolo={dialogo.assenza.utente_id === null ? t('dispEliminaChiusuraTitolo') : t('dispEliminaAssenzaTitolo')}
          corpo={t('dispEliminaAssenzaCorpo', { motivo: tShell(`motiviIndisponibilita.${dialogo.assenza.motivo}`), periodo: intervallo(dialogo.assenza) })}
          url={`/api/admin/crm/indisponibilita/${dialogo.assenza.id}`}
          evento="indisponibilita-elimina"
          onFatto={chiudiERicarica}
          onChiudi={() => setDialogo(null)}
        />
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────────────

function ElencoAssenze({
  righe,
  vuoto,
  etichetta,
  intervallo,
  onElimina,
  eliminaAria,
}: {
  righe: IndisponibilitaRow[]
  vuoto: string
  etichetta: (a: IndisponibilitaRow) => string
  intervallo: (a: IndisponibilitaRow) => string
  onElimina: (a: IndisponibilitaRow) => void
  eliminaAria: (a: IndisponibilitaRow) => string
}) {
  if (righe.length === 0) {
    return <p className="rounded-card border border-kidville-line bg-kidville-white p-4 font-maven text-sm text-kidville-sub">{vuoto}</p>
  }
  return (
    <ul className="divide-y divide-kidville-line rounded-card border border-kidville-line bg-kidville-white">
      {righe.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
          <span className="font-maven text-sm text-kidville-ink">
            <span className="font-semibold">{etichetta(a)}</span>
            <span className="text-kidville-sub"> · {intervallo(a)}</span>
          </span>
          <button type="button" className={BTN_ICONA} aria-label={eliminaAria(a)} onClick={() => onElimina(a)}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  )
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

// ─────────────────────────────────────────────────────────────────────────────────────

/** Un'assenza (ferie, malattia, altro) di una persona, oppure la chiusura dell'intera sede (`utenteId: null`). */
function DialogoAssenza({
  scuolaId,
  utenteId,
  onFatto,
  onChiudi,
}: {
  scuolaId: string
  utenteId: string | null
  onFatto: () => void
  onChiudi: () => void
}) {
  const t = useTranslations('crmAgenda')
  const tShell = useTranslations('crmShell')
  const idBase = useId()
  const chiusura = utenteId === null
  const [motivo, setMotivo] = useState<MotivoIndisponibilita>(chiusura ? 'chiusura' : 'ferie')
  const [dal, setDal] = useState('')
  const [al, setAl] = useState('')
  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState('')

  const salva = async () => {
    if (!dal || !al) {
      setErrore(t('dispErroreDate'))
      return
    }
    if (al < dal) {
      setErrore(t('dispErroreOrdineDate'))
      return
    }
    setInCorso(true)
    setErrore('')
    // Giorni interi `YYYY-MM-DD`: il «al» è compreso, ci pensa il server (giorni di Roma).
    const testo = await scrivi('POST', '/api/admin/crm/indisponibilita', { scuolaId, utenteId, motivo, dal, al }, t('dispErroreSalva'), 'indisponibilita-aggiunta')
    setInCorso(false)
    if (testo) {
      setErrore(testo)
      return
    }
    onFatto()
  }

  const titolo = chiusura ? t('dispNuovaChiusuraTitolo') : t('dispNuovaAssenzaTitolo')
  return (
    <Modal open onClose={onChiudi} title={titolo} labelledBy={`${idBase}-titolo`} className="w-full max-w-md">
      <div className="max-h-[90vh] overflow-y-auto rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={`${idBase}-titolo`} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {titolo}
        </h2>
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void salva()
          }}
        >
          {!chiusura && (
            <div className="space-y-1">
              <label htmlFor={`${idBase}-motivo`} className="block font-maven text-xs font-semibold text-kidville-sub">
                {t('dispMotivo')}
              </label>
              <select
                id={`${idBase}-motivo`}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value as MotivoIndisponibilita)}
                style={{ fontSize: '16px' }}
                className={CAMPO}
              >
                {(['ferie', 'malattia', 'altro'] as const).map((m) => (
                  <option key={m} value={m}>
                    {tShell(`motiviIndisponibilita.${m}`)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor={`${idBase}-dal`} className="block font-maven text-xs font-semibold text-kidville-sub">
                {t('dispDal')}
              </label>
              <DateField id={`${idBase}-dal`} value={dal} onChange={setDal} className={CAMPO} />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${idBase}-al`} className="block font-maven text-xs font-semibold text-kidville-sub">
                {t('dispAl')}
              </label>
              <DateField id={`${idBase}-al`} value={al} onChange={setAl} className={CAMPO} />
            </div>
          </div>
          <p className="font-maven text-xs text-kidville-sub">{t('dispAlCompreso')}</p>
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

// ─────────────────────────────────────────────────────────────────────────────────────

/** La conferma prima di togliere una fascia, un'assenza o una chiusura. */
function DialogoElimina({
  titolo,
  corpo,
  url,
  evento,
  onFatto,
  onChiudi,
}: {
  titolo: string
  corpo: string
  url: string
  evento: string
  onFatto: () => void
  onChiudi: () => void
}) {
  const t = useTranslations('crmAgenda')
  const idTitolo = useId()
  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState('')

  const elimina = async () => {
    setInCorso(true)
    setErrore('')
    const testo = await scrivi('DELETE', url, undefined, t('dispErroreElimina'), evento)
    setInCorso(false)
    if (testo) {
      setErrore(testo)
      return
    }
    onFatto()
  }

  return (
    <Modal open onClose={onChiudi} title={titolo} labelledBy={idTitolo} className="w-full max-w-md">
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
        <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {titolo}
        </h2>
        <div className="mt-4 space-y-4">
          <p className="font-maven text-sm leading-relaxed text-kidville-ink">{corpo}</p>
          <Errore testo={errore} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={onChiudi} className={BTN_SECONDARIO}>
              {t('indietro')}
            </button>
            <button type="button" onClick={() => void elimina()} disabled={inCorso} className={BTN_PRIMARIO}>
              {inCorso ? t('invioInCorso') : t('dispElimina')}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
