'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle, CalendarOff, Pencil, Plus, Trash2 } from 'lucide-react'
import { DateField } from '@/components/ui/DateField'
import { Modal } from '@/components/ui/Modal'
import { APP_TIMEZONE, intlDateTime } from '@/i18n/config'
import type { DisponibilitaRow, IndisponibilitaRow, MotivoIndisponibilita } from '@/lib/crm/tipi'
import { oraCivile } from '@/lib/format/confini-giorno'
import { addGiorni } from '@/lib/format/data'
import { conIniziale, useDateFormat } from '@/lib/i18n/date'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'

/**
 * CRM DELLA SEGRETERIA · LA DISPONIBILITÀ DI CHI FA LE VISITE.
 *
 * Tre cose, in quest'ordine:
 *  · la SETTIMANA TIPO: le fasce in cui una persona riceve (giorno, da quando a quando, quanto dura uno slot).
 *    Gli slot dell'agenda si calcolano da qui, ogni volta: toglierne una fascia non tocca le visite già fissate;
 *  · le ASSENZE di quella persona (ferie, malattia, altro): tolgono gli slot di quei giorni;
 *  · le CHIUSURE DELLA SEDE: tolgono gli slot di tutte.
 *
 * La segreteria vede e modifica la PROPRIA settimana; l'admin può scegliere un'altra persona. Lo dice il server
 * (`io` nella risposta), non il client: il ruolo non si indovina da qui. E il server rifiuta comunque (403) chi
 * tenta di toccare la settimana di una collega.
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
  fasce: DisponibilitaRow[]
  assenze: IndisponibilitaRow[]
  persone: Persona[]
  io: { id: string; ruolo: string }
}

type Esito = { chiave: string; ok: true; dati: Dati } | { chiave: string; ok: false }

const ROUTE = '/admin/crm'
const DURATE_SLOT_MIN = [15, 20, 30, 45, 60, 90]
const DURATA_SLOT_DEFAULT_MIN = 45
/** I giorni in cui si offrono visite: da lunedì (1) a sabato (6), come l'agenda. */
const GIORNI_OFFERTI = [1, 2, 3, 4, 5, 6]
/** Un lunedì qualunque (1 gennaio 2024), per ricavare il nome dei giorni nella lingua corrente. */
const UN_LUNEDI = '2024-01-01'

const mezzogiorno = (ymd: string) => new Date(`${ymd}T12:00:00Z`)
const hhmm = (ora: string) => ora.slice(0, 5)
const nomeDi = (p: { nome: string; cognome: string }) => `${p.nome} ${p.cognome}`.trim()

async function leggi<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'crm-disponibilita-lettura-respinta', route: ROUTE, stato: res.status })
      return null
    }
    return (await res.json()) as T
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `crm-disponibilita-lettura-fallita: ${nomeErrore(e)}`, route: ROUTE })
    return null
  }
}

async function caricaTutto(chiave: string, scuolaId: string): Promise<Esito> {
  const q = `?${new URLSearchParams({ scuolaId }).toString()}`
  const [disp, ass, per] = await Promise.all([
    leggi<{ data?: DisponibilitaRow[]; io?: { id: string; ruolo: string } }>(`/api/admin/crm/disponibilita${q}`),
    leggi<{ data?: IndisponibilitaRow[] }>(`/api/admin/crm/indisponibilita${q}`),
    leggi<{ data?: Persona[] }>(`/api/admin/crm/persone${q}`),
  ])
  if (!disp?.io || !ass || !per) return { chiave, ok: false }
  return { chiave, ok: true, dati: { fasce: disp.data ?? [], assenze: ass.data ?? [], persone: per.data ?? [], io: disp.io } }
}

/** Scrive (POST/PATCH/DELETE) e rende il testo da mostrare se il server ha rifiutato. `null` = riuscito. */
async function scrivi(metodo: 'POST' | 'PATCH' | 'DELETE', url: string, corpo: unknown, fallback: string, evento: string): Promise<string | null> {
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

type Dialogo =
  | { tipo: 'fascia'; fascia?: DisponibilitaRow }
  | { tipo: 'assenza' }
  | { tipo: 'chiusura' }
  | { tipo: 'elimina-fascia'; fascia: DisponibilitaRow }
  | { tipo: 'elimina-assenza'; assenza: IndisponibilitaRow }

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
  useEffect(() => {
    let attivo = true
    void caricaTutto(chiave, scuolaId).then((e) => {
      if (attivo) setEsito(e)
    })
    return () => {
      attivo = false
    }
  }, [chiave, scuolaId])

  const ricarica = () => setVersione((v) => v + 1)
  const chiudiERicarica = () => {
    setDialogo(null)
    ricarica()
  }

  const dati = esito?.ok ? esito.dati : null
  const nomeGiorno = (n: number) =>
    conIniziale(intlDateTime(fmt.locale, { weekday: 'long', timeZone: APP_TIMEZONE }).format(mezzogiorno(addGiorni(UN_LUNEDI, n - 1))))

  // La persona di cui si guarda la settimana: io, salvo che l'admin ne scelga un'altra.
  const puoScegliere = dati?.io.ruolo === 'admin'
  const persona = useMemo(() => {
    if (!dati) return ''
    if (puoScegliere && scelta && dati.persone.some((p) => p.id === scelta)) return scelta
    return dati.io.id
  }, [dati, puoScegliere, scelta])
  const miaSettimana = dati !== null && persona === dati.io.id

  const fasce = (dati?.fasce ?? []).filter((f) => f.utente_id === persona)
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
        <p>{t('dispErroreCaricamento')}</p>
        <button type="button" className={BTN_SECONDARIO} onClick={ricarica}>
          {t('riprova')}
        </button>
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
      </header>

      {/* ── La settimana tipo ── */}
      <section aria-labelledby={`${idPersona}-settimana`} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${idPersona}-settimana`} className="font-maven text-base font-bold text-kidville-ink">
            {miaSettimana ? t('dispSettimanaMia') : t('dispSettimanaAltri')}
          </h3>
          <button type="button" className={BTN_PRIMARIO} onClick={() => setDialogo({ tipo: 'fascia' })}>
            <Plus size={16} aria-hidden="true" />
            {t('dispAggiungiFascia')}
          </button>
        </div>
        <ul className="divide-y divide-kidville-line rounded-card border border-kidville-line bg-kidville-white">
          {[...GIORNI_OFFERTI, ...(fasce.some((f) => f.giorno_settimana === 7) ? [7] : [])].map((g) => {
            const delGiorno = fasce.filter((f) => f.giorno_settimana === g)
            return (
              <li key={g} className="flex flex-wrap items-start gap-3 px-3 py-3">
                <span className="w-28 shrink-0 font-maven text-sm font-bold text-kidville-ink">{nomeGiorno(g)}</span>
                {delGiorno.length === 0 ? (
                  <span className="font-maven text-sm text-kidville-sub">{t('dispNessunaFascia')}</span>
                ) : (
                  <ul className="flex min-w-0 flex-1 flex-col gap-2">
                    {delGiorno.map((f) => (
                      <li key={f.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-maven text-sm text-kidville-ink">
                          <span className="font-semibold tabular-nums">
                            {hhmm(f.ora_inizio)}–{hhmm(f.ora_fine)}
                          </span>
                          <span className="text-kidville-sub"> · {t('dispSlotDa', { min: f.durata_slot_min })}</span>
                          {f.valida_al && <span className="text-kidville-sub"> · {t('dispFinoAl', { data: fmt.dataBreve(mezzogiorno(f.valida_al)) })}</span>}
                        </span>
                        <span className="flex gap-1.5">
                          <button
                            type="button"
                            className={BTN_ICONA}
                            aria-label={t('dispModificaAria', { giorno: nomeGiorno(g), da: hhmm(f.ora_inizio), a: hhmm(f.ora_fine) })}
                            onClick={() => setDialogo({ tipo: 'fascia', fascia: f })}
                          >
                            <Pencil size={16} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className={BTN_ICONA}
                            aria-label={t('dispEliminaAria', { giorno: nomeGiorno(g), da: hhmm(f.ora_inizio), a: hhmm(f.ora_fine) })}
                            onClick={() => setDialogo({ tipo: 'elimina-fascia', fascia: f })}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      </section>

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

      {dialogo?.tipo === 'fascia' && (
        <DialogoFascia
          key={dialogo.fascia?.id ?? 'nuova'}
          scuolaId={scuolaId}
          utenteId={persona}
          fascia={dialogo.fascia}
          nomeGiorno={nomeGiorno}
          onFatto={chiudiERicarica}
          onChiudi={() => setDialogo(null)}
        />
      )}
      {(dialogo?.tipo === 'assenza' || dialogo?.tipo === 'chiusura') && (
        <DialogoAssenza
          key={dialogo.tipo}
          scuolaId={scuolaId}
          utenteId={dialogo.tipo === 'chiusura' ? null : persona}
          onFatto={chiudiERicarica}
          onChiudi={() => setDialogo(null)}
        />
      )}
      {dialogo?.tipo === 'elimina-fascia' && (
        <DialogoElimina
          key={dialogo.fascia.id}
          titolo={t('dispEliminaFasciaTitolo')}
          corpo={t('dispEliminaFasciaCorpo', { giorno: nomeGiorno(dialogo.fascia.giorno_settimana), da: hhmm(dialogo.fascia.ora_inizio), a: hhmm(dialogo.fascia.ora_fine) })}
          url={`/api/admin/crm/disponibilita/${dialogo.fascia.id}`}
          evento="disponibilita-elimina"
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

/** Aggiungere o modificare una fascia della settimana tipo. */
function DialogoFascia({
  scuolaId,
  utenteId,
  fascia,
  nomeGiorno,
  onFatto,
  onChiudi,
}: {
  scuolaId: string
  utenteId: string
  fascia?: DisponibilitaRow
  nomeGiorno: (n: number) => string
  onFatto: () => void
  onChiudi: () => void
}) {
  const t = useTranslations('crmAgenda')
  const idBase = useId()
  const [giorno, setGiorno] = useState(fascia?.giorno_settimana ?? 1)
  const [oraInizio, setOraInizio] = useState(fascia ? hhmm(fascia.ora_inizio) : '09:00')
  const [oraFine, setOraFine] = useState(fascia ? hhmm(fascia.ora_fine) : '13:00')
  const [durata, setDurata] = useState(fascia?.durata_slot_min ?? DURATA_SLOT_DEFAULT_MIN)
  const [validaAl, setValidaAl] = useState(fascia?.valida_al ?? '')
  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState('')

  const giorni = GIORNI_OFFERTI.includes(giorno) ? GIORNI_OFFERTI : [...GIORNI_OFFERTI, giorno]
  const durate = DURATE_SLOT_MIN.includes(durata) ? DURATE_SLOT_MIN : [...DURATE_SLOT_MIN, durata].sort((a, b) => a - b)

  const salva = async () => {
    if (!oraInizio || !oraFine || oraFine <= oraInizio) {
      setErrore(t('dispErroreOre'))
      return
    }
    setInCorso(true)
    setErrore('')
    const campi = { giornoSettimana: giorno, oraInizio, oraFine, durataSlotMin: durata, validaAl: validaAl || null }
    const testo = fascia
      ? await scrivi('PATCH', `/api/admin/crm/disponibilita/${fascia.id}`, campi, t('dispErroreSalva'), 'disponibilita-modifica')
      : await scrivi('POST', '/api/admin/crm/disponibilita', { scuolaId, utenteId, ...campi }, t('dispErroreSalva'), 'disponibilita-aggiunta')
    setInCorso(false)
    if (testo) {
      setErrore(testo)
      return
    }
    onFatto()
  }

  const titolo = fascia ? t('dispModificaFasciaTitolo') : t('dispNuovaFasciaTitolo')
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
          <div className="space-y-1">
            <label htmlFor={`${idBase}-giorno`} className="block font-maven text-xs font-semibold text-kidville-sub">
              {t('dispGiorno')}
            </label>
            <select id={`${idBase}-giorno`} value={giorno} onChange={(e) => setGiorno(Number(e.target.value))} style={{ fontSize: '16px' }} className={CAMPO}>
              {giorni.map((g) => (
                <option key={g} value={g}>
                  {nomeGiorno(g)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label htmlFor={`${idBase}-da`} className="block font-maven text-xs font-semibold text-kidville-sub">
                {t('dispDalle')}
              </label>
              <input id={`${idBase}-da`} type="time" value={oraInizio} onChange={(e) => setOraInizio(e.target.value)} style={{ fontSize: '16px' }} className={CAMPO} />
            </div>
            <div className="space-y-1">
              <label htmlFor={`${idBase}-a`} className="block font-maven text-xs font-semibold text-kidville-sub">
                {t('dispAlle')}
              </label>
              <input id={`${idBase}-a`} type="time" value={oraFine} onChange={(e) => setOraFine(e.target.value)} style={{ fontSize: '16px' }} className={CAMPO} />
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${idBase}-slot`} className="block font-maven text-xs font-semibold text-kidville-sub">
              {t('dispDurataSlot')}
            </label>
            <select id={`${idBase}-slot`} value={durata} onChange={(e) => setDurata(Number(e.target.value))} style={{ fontSize: '16px' }} className={CAMPO}>
              {durate.map((m) => (
                <option key={m} value={m}>
                  {t('durataMinuti', { min: m })}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${idBase}-fino`} className="block font-maven text-xs font-semibold text-kidville-sub">
              {t('dispValidaFinoAl')}
            </label>
            <DateField id={`${idBase}-fino`} value={validaAl} onChange={setValidaAl} className={CAMPO} />
            <p className="font-maven text-xs text-kidville-sub">{t('dispValidaFinoAlAiuto')}</p>
          </div>
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
