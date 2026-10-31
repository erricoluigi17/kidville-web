'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { CalendarCheck, ChartColumn, PhoneCall, Target, Timer } from 'lucide-react'
import { SectionTitle, StatCard, TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit'
import {
  PERSONA_AI,
  periodoDaSettembre,
  periodoMeseCorrente,
  periodoMeseScorso,
  type ConfrontoSede,
  type PersonaStatistiche,
  type RigaPersonaNominata,
  type RispostaStatistiche,
  type TotaleStatistiche,
} from '@/lib/crm/statistiche'
import { useRuoloCockpit } from '@/lib/context/admin-identity'
import { logClient } from '@/lib/logging/client'
import { erroreDaRisposta } from '@/lib/ui/esito-fetch'
import { cx } from '@/lib/ui/cx'
import { zUuid } from '@/lib/validation/common'

/**
 * CRM DELLA SEGRETERIA · LA SCHERMATA DELLE STATISTICHE.
 *
 * ── CHE COSA SI VEDE ───────────────────────────────────────────────────────────
 * Il periodo (il mese in corso, con le scorciatoie «mese scorso» e «da settembre» e due date a mano), quattro
 * numeri riassuntivi della sede e una tabella con UNA RIGA PER PERSONA. Le colonne seguono il §10 della
 * specifica e sono raggruppate per chi fa cosa, perché sono due statistiche diverse su due persone diverse:
 * la presentazione va a chi FISSA la visita, la chiusura a chi la SVOLGE. «Iscritti verificati» (con la
 * domanda collegata) e «iscritti a mano» (senza) stanno in due colonne separate: sommarli nasconderebbe
 * proprio la differenza che il titolare vuole vedere.
 *
 * ── IL TRATTINO NON È ZERO ─────────────────────────────────────────────────────
 * Un rapporto senza denominatore arriva dal server come `null` e qui diventa «—». «0%» direbbe che nessuno si è
 * presentato; «—» dice che non c'erano visite da misurare. Mai `NaN`, mai `Infinity` a schermo.
 *
 * ── CIÒ CHE NON HA UNA PERSONA SI DICHIARA ─────────────────────────────────────
 * `nonAttribuiti` è mostrato quando è maggiore di zero: un numero che sparisce in silenzio è il difetto che ha
 * reso inaffidabili le statistiche di prima.
 *
 * ── IL CONFRONTO FRA SEDI È DELL'ADMIN ─────────────────────────────────────────
 * Si chiede (`confronto=1`) solo se il ruolo è `admin`; il gate vero sta sul server, che a chiunque altro
 * risponde 403 `SOLO_ADMIN`. Mentre il ruolo non è ancora noto (`''`) si chiede senza confronto: si sbaglia verso
 * il NASCONDERE.
 *
 * Le props sono il contratto con la cornice (`CrmShell`): non si cambiano.
 */

const ROTTA = '/admin/crm/statistiche'
const ASSENTE = '—'
const GIORNO = /^\d{4}-\d{2}-\d{2}$/

type Esito =
  | { tipo: 'pronta'; dati: RispostaStatistiche }
  // `testo`: la frase del catalogo del server quando il suo codice è dichiarato, altrimenti `''` (si usa quella locale).
  | { tipo: 'errore'; testo: string }
  | { tipo: 'offline' }

/** Legge le statistiche e le traduce in un esito. Nessuno stato React qui dentro: è una funzione del modulo. */
async function leggiStatistiche(url: string): Promise<Esito> {
  // Il fallimento della rete è un VALORE (`null`), non un'eccezione da rincorrere.
  const res = await fetch(url, { cache: 'no-store' }).catch(() => null)
  if (!res) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    if (!offline) logClient({ livello: 'warn', evento: 'fetch', messaggio: 'statistiche CRM non raggiunte', route: ROTTA })
    return offline ? { tipo: 'offline' } : { tipo: 'errore', testo: '' }
  }
  if (!res.ok) {
    // I rifiuti di merito il server li ha già registrati; qui serve solo la frase, se il codice è dichiarato.
    const errore = await erroreDaRisposta(res, '')
    return { tipo: 'errore', testo: errore.testo }
  }
  const corpo = (await res.json().catch(() => null)) as { data?: RispostaStatistiche } | null
  if (!corpo?.data || !Array.isArray(corpo.data.righe)) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: 'statistiche CRM illeggibili', route: ROTTA, stato: res.status })
    return { tipo: 'errore', testo: '' }
  }
  return { tipo: 'pronta', dati: corpo.data }
}

const percentuale = (x: number | null): string =>
  x === null || !Number.isFinite(x) ? ASSENTE : `${Math.round(x * 100)}%`

const nomeCompleto = (p: PersonaStatistiche): string => `${p.cognome} ${p.nome}`.trim()

const THN = TH.replace('text-left', 'text-right')
const TDN = cx(TD, 'text-right tabular-nums')
const GRUPPO = cx(
  TH,
  'border-b border-kidville-line px-3 pb-1.5 text-center normal-case tracking-normal',
)

export function StatisticheCrm({ scuolaId }: { scuolaId: string }) {
  const t = useTranslations('crmStatistiche')
  const ruolo = useRuoloCockpit()
  const conConfronto = ruolo === 'admin'
  const regioneRef = useRef<HTMLDivElement>(null)

  // Le scorciatoie si calcolano UNA volta: `new Date()` nel corpo del componente cambierebbe a ogni resa.
  const [scorciatoie] = useState(() => {
    const adesso = new Date()
    return {
      corrente: periodoMeseCorrente(adesso),
      scorso: periodoMeseScorso(adesso),
      settembre: periodoDaSettembre(adesso),
    }
  })
  const [periodo, setPeriodo] = useState(scorciatoie.corrente)
  const { dal, al } = periodo

  // Lo stato porta con sé la chiave della richiesta a cui si riferisce: se il periodo cambia, i numeri
  // vecchi non restano a schermo (si torna a «caricamento» per derivazione).
  const [letto, setLetto] = useState<{ chiave: string; esito: Esito } | null>(null)
  const [tentativo, setTentativo] = useState(0)

  const sedeValida = zUuid.safeParse(scuolaId).success
  const intervalloCompleto = GIORNO.test(dal) && GIORNO.test(al)
  const intervalloInvertito = intervalloCompleto && dal > al
  const richiestaValida = sedeValida && intervalloCompleto && !intervalloInvertito
  const chiave = `${scuolaId}|${dal}|${al}|${conConfronto ? 1 : 0}|${tentativo}`

  useEffect(() => {
    if (!richiestaValida) return
    let vivo = true
    const parametri = new URLSearchParams({ scuolaId, dal, al })
    if (conConfronto) parametri.set('confronto', '1')
    // Il `setState` sta nel `.then`, mai nel corpo dell'effetto: è la forma che
    // `react-hooks/set-state-in-effect` accetta (come in `SchedaAlunnoLettura`).
    void leggiStatistiche(`/api/admin/crm/statistiche?${parametri.toString()}`).then((esito) => {
      if (vivo) setLetto({ chiave, esito })
    })
    return () => {
      vivo = false
    }
  }, [richiestaValida, scuolaId, dal, al, conConfronto, chiave])

  const riprova = () => {
    setLetto(null)
    setTentativo((n) => n + 1)
    // Il pulsante sta per sparire: il fuoco va sulla regione che annuncerà l'esito (WCAG 2.4.3).
    regioneRef.current?.focus()
  }

  const attivo =
    (['corrente', 'scorso', 'settembre'] as const).find(
      (k) => scorciatoie[k].dal === dal && scorciatoie[k].al === al,
    ) ?? null

  const scorciatoia = (k: 'corrente' | 'scorso' | 'settembre', etichetta: string) => (
    <button
      key={k}
      type="button"
      aria-pressed={attivo === k}
      onClick={() => setPeriodo(scorciatoie[k])}
      className={cx(
        'min-h-[44px] rounded-pill border px-4 py-2 font-barlow text-xs font-bold uppercase tracking-[0.04em] transition-colors',
        attivo === k
          ? 'border-kidville-green bg-kidville-green text-kidville-white'
          : 'border-kidville-line bg-kidville-white text-kidville-sub hover:bg-kidville-cream',
      )}
    >
      {etichetta}
    </button>
  )

  const campoData = (id: string, etichetta: string, valore: string, quando: (v: string) => void) => (
    <label htmlFor={id} className="flex flex-col gap-1 font-maven text-xs text-kidville-sub">
      {etichetta}
      <input
        id={id}
        type="date"
        value={valore}
        onChange={(e) => quando(e.target.value)}
        className="min-h-[44px] rounded-lg border border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink"
      />
    </label>
  )

  let corpo: ReactNode
  if (intervalloInvertito) {
    corpo = (
      <p role="alert" className="font-maven text-sm text-kidville-error-strong">
        {t('periodoNonValido')}
      </p>
    )
  } else if (!richiestaValida) {
    // Date a metà digitazione, o sede illeggibile: niente da chiedere, niente da mostrare.
    corpo = null
  } else if (letto?.chiave !== chiave) {
    corpo = (
      <p role="status" className="font-maven text-sm text-kidville-sub">
        {t('caricamento')}
      </p>
    )
  } else if (letto.esito.tipo === 'pronta') {
    corpo = <Risultato dati={letto.esito.dati} />
  } else {
    const esito = letto.esito
    corpo = (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-card border border-kidville-line bg-kidville-white p-4">
        <p className="font-maven text-sm text-kidville-error-strong">
          {esito.tipo === 'offline' ? t('erroreOffline') : esito.testo || t('erroreGenerico')}
        </p>
        <button
          type="button"
          onClick={riprova}
          className="min-h-[44px] rounded-pill border border-kidville-green px-4 py-2 font-barlow text-xs font-bold uppercase tracking-[0.04em] text-kidville-green hover:bg-kidville-cream"
        >
          {t('riprova')}
        </button>
      </div>
    )
  }

  return (
    <section className="space-y-5" aria-labelledby="crm-statistiche-titolo">
      <div id="crm-statistiche-titolo">
        <SectionTitle icon={ChartColumn} title={t('titolo')} sub={t('sottotitolo')} />
      </div>

      <fieldset className="m-0 flex flex-wrap items-end gap-3 border-0 p-0">
        <legend className="mb-2 font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
          {t('periodoLegenda')}
        </legend>
        {scorciatoia('corrente', t('periodoMeseCorrente'))}
        {scorciatoia('scorso', t('periodoMeseScorso'))}
        {scorciatoia('settembre', t('periodoDaSettembre'))}
        {campoData('crm-statistiche-dal', t('periodoDal'), dal, (v) => setPeriodo((p) => ({ ...p, dal: v })))}
        {campoData('crm-statistiche-al', t('periodoAl'), al, (v) => setPeriodo((p) => ({ ...p, al: v })))}
      </fieldset>

      <div ref={regioneRef} tabIndex={-1} aria-busy={richiestaValida && letto?.chiave !== chiave} className="outline-none">
        {corpo}
      </div>
    </section>
  )
}

/** I numeri della sede nel periodo: quattro riquadri, la tabella per persona, le note e il confronto. */
function Risultato({ dati }: { dati: RispostaStatistiche }) {
  const t = useTranslations('crmStatistiche')
  const { totale, ritardoMedianoGiorni, nonAttribuiti } = dati
  const sommaNonAttribuiti = nonAttribuiti.visite + nonAttribuiti.bambini

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={CalendarCheck}
          label={t('cardPresentazione')}
          value={percentuale(totale.tassoPresentazione)}
          sub={t('cardPresentazioneSub')}
        />
        <StatCard
          icon={Target}
          tone="info"
          label={t('cardChiusura')}
          value={percentuale(totale.closeRate)}
          sub={t('cardChiusuraSub')}
        />
        <StatCard
          icon={Timer}
          tone="warn"
          label={t('cardRitardo')}
          value={ritardoMedianoGiorni === null ? ASSENTE : t('cardRitardoValore', { n: ritardoMedianoGiorni })}
          sub={t('cardRitardoSub')}
        />
        <StatCard
          icon={PhoneCall}
          tone="success"
          label={t('cardFollowUp')}
          value={percentuale(totale.followUpInTempo)}
          sub={t('cardFollowUpSub')}
        />
      </div>

      <div className="rounded-card bg-kidville-white p-4">
        <h3 className="mb-3 font-barlow text-[15px] font-extrabold uppercase tracking-[0.02em] text-kidville-green">
          {t('tabellaTitolo')}
        </h3>
        {dati.righe.length === 0 ? (
          <p className="font-maven text-sm text-kidville-sub">{t('tabellaVuota')}</p>
        ) : (
          <TabellaPersone righe={dati.righe} totale={totale} />
        )}
      </div>

      {sommaNonAttribuiti > 0 && (
        <p role="note" className="rounded-card border border-kidville-line bg-kidville-cream p-3 font-maven text-sm text-kidville-ink">
          {t('nonAttribuiti', { visite: nonAttribuiti.visite, bambini: nonAttribuiti.bambini })}
        </p>
      )}

      <div className="space-y-1 font-maven text-xs text-kidville-sub">
        <p className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em]">{t('legendaTitolo')}</p>
        <p>{t('legendaPresentazione')}</p>
        <p>{t('legendaChiusura')}</p>
        <p>{t('legendaVerificati')}</p>
        <p>{t('legendaRichiami')}</p>
      </div>

      {dati.confronto && (
        <div className="rounded-card bg-kidville-white p-4">
          <SectionTitle icon={ChartColumn} title={t('confrontoTitolo')} sub={t('confrontoSottotitolo')} />
          {dati.confronto.length === 0 ? (
            <p className="font-maven text-sm text-kidville-sub">{t('confrontoVuoto')}</p>
          ) : (
            <TabellaConfronto sedi={dati.confronto} />
          )}
        </div>
      )}
    </div>
  )
}

/** Le celle numeriche di una riga, nell'ordine delle colonne: identiche per le persone, il totale e le sedi. */
function CelleNumeri({ r }: { r: TotaleStatistiche }) {
  return (
    <>
      <td className={TDN}>{r.fissati}</td>
      <td className={TDN}>{r.svolti}</td>
      <td className={TDN}>{r.nonPresentati}</td>
      <td className={TDN}>{percentuale(r.tassoPresentazione)}</td>
      <td className={TDN}>{r.bambiniVisitati}</td>
      <td className={TDN}>{r.iscrittiVerificati}</td>
      <td className={TDN}>{r.iscrittiAMano}</td>
      <td className={TDN}>{percentuale(r.closeRate)}</td>
      <td className={TDN}>{r.azioniDovute}</td>
      <td className={TDN}>{r.azioniInTempo}</td>
      <td className={TDN}>{percentuale(r.followUpInTempo)}</td>
    </>
  )
}

function TabellaPersone({ righe, totale }: { righe: RigaPersonaNominata[]; totale: TotaleStatistiche }) {
  const t = useTranslations('crmStatistiche')
  const etichetta = (r: RigaPersonaNominata): string =>
    r.persona === PERSONA_AI ? t('rigaAi') : nomeCompleto(r.persona) || t('rigaSenzaNome')
  const chiaveRiga = (r: RigaPersonaNominata): string => (r.persona === PERSONA_AI ? PERSONA_AI : r.persona.id)

  return (
    <div className={TABLE_WRAP}>
      <table className={TABLE}>
        <caption className="sr-only">{t('tabellaDescrizione')}</caption>
        <thead>
          <tr>
            <th rowSpan={2} scope="col" className={TH}>
              {t('colPersona')}
            </th>
            <th colSpan={4} scope="colgroup" className={GRUPPO}>
              {t('gruppoFissa')}
            </th>
            <th colSpan={4} scope="colgroup" className={GRUPPO}>
              {t('gruppoSvolge')}
            </th>
            <th colSpan={3} scope="colgroup" className={GRUPPO}>
              {t('gruppoRichiami')}
            </th>
          </tr>
          <tr>
            <th scope="col" className={THN}>{t('colConcluse')}</th>
            <th scope="col" className={THN}>{t('colSvolte')}</th>
            <th scope="col" className={THN}>{t('colNonPresentati')}</th>
            <th scope="col" className={THN}>{t('colPresentazione')}</th>
            <th scope="col" className={THN}>{t('colVisitati')}</th>
            <th scope="col" className={THN}>{t('colVerificati')}</th>
            <th scope="col" className={THN}>{t('colAMano')}</th>
            <th scope="col" className={THN}>{t('colChiusura')}</th>
            <th scope="col" className={THN}>{t('colScaduti')}</th>
            <th scope="col" className={THN}>{t('colInTempo')}</th>
            <th scope="col" className={THN}>{t('colInTempoPercentuale')}</th>
          </tr>
        </thead>
        <tbody>
          {righe.map((r) => (
            <tr key={chiaveRiga(r)} className={TROW}>
              <th scope="row" className={cx(TD, 'text-left font-maven text-sm font-bold text-kidville-ink')}>
                {etichetta(r)}
              </th>
              <CelleNumeri r={r} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-bold">
            <th scope="row" className={cx(TD, 'text-left font-barlow text-sm font-extrabold uppercase text-kidville-green')}>
              {t('rigaTotale')}
            </th>
            <CelleNumeri r={totale} />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function TabellaConfronto({ sedi }: { sedi: ConfrontoSede[] }) {
  const t = useTranslations('crmStatistiche')
  return (
    <div className={TABLE_WRAP}>
      <table className={TABLE}>
        <caption className="sr-only">{t('confrontoDescrizione')}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>{t('colSede')}</th>
            <th scope="col" className={THN}>{t('colConcluse')}</th>
            <th scope="col" className={THN}>{t('colPresentazione')}</th>
            <th scope="col" className={THN}>{t('colVisitati')}</th>
            <th scope="col" className={THN}>{t('colVerificati')}</th>
            <th scope="col" className={THN}>{t('colAMano')}</th>
            <th scope="col" className={THN}>{t('colChiusura')}</th>
            <th scope="col" className={THN}>{t('colRitardo')}</th>
            <th scope="col" className={THN}>{t('colInTempoPercentuale')}</th>
          </tr>
        </thead>
        <tbody>
          {sedi.map((s) => (
            <tr key={s.scuolaId} className={TROW}>
              <th scope="row" className={cx(TD, 'text-left font-maven text-sm font-bold text-kidville-ink')}>
                {s.nome}
              </th>
              <td className={TDN}>{s.totale.fissati}</td>
              <td className={TDN}>{percentuale(s.totale.tassoPresentazione)}</td>
              <td className={TDN}>{s.totale.bambiniVisitati}</td>
              <td className={TDN}>{s.totale.iscrittiVerificati}</td>
              <td className={TDN}>{s.totale.iscrittiAMano}</td>
              <td className={TDN}>{percentuale(s.totale.closeRate)}</td>
              <td className={TDN}>
                {s.ritardoMedianoGiorni === null ? ASSENTE : t('cardRitardoValore', { n: s.ritardoMedianoGiorni })}
              </td>
              <td className={TDN}>{percentuale(s.totale.followUpInTempo)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
