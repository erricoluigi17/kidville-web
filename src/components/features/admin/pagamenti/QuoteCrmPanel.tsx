'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Handshake } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Btn } from '@/components/ui/Btn'
import { SectionTitle, TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit'
import { useSediAttive } from '@/lib/context/sede-context'
import { etichettaAnno } from '@/lib/crm/quota-anno'
import { QUOTA_METODI, QUOTA_MOTIVI_BLOCCO, type QuotaInAttesa } from '@/lib/crm/tipi'
import { formatEuro } from '@/lib/format/valuta'
import { useDateFormat } from '@/lib/i18n/date'
import { logClient, nomeErrore } from '@/lib/logging/client'
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch'

/**
 * Contabilità · la vista «Quote dal CRM» (spec 2026-10-31, §5.6).
 *
 * Le quote d'iscrizione che la segreteria ha segnato nel CRM e che NON sono ancora diventate la voce
 * «Iscrizione» dell'alunno: in attesa dell'alunno, senza importo (la vecchia spunta), bloccate con il loro
 * motivo. Una quota sparisce da qui nel momento in cui passa in contabilità: finché è qui, i soldi sono
 * entrati e la famiglia non ha ancora una voce pagata.
 *
 * ── Cosa fa ─────────────────────────────────────────────────────────────────────────────────────────
 *  · LEGGE `GET /api/admin/crm/quote` (con `?scuolaId` se la pagina ne ha scelta una; senza, la route usa
 *    le sedi attive dell'utente e ogni riga dice la sua sede);
 *  · «Riprova» (solo per i bambini già collegati a un alunno) chiama
 *    `POST /api/admin/crm/schede/[id]/bambini/[bambinoId]/quota/riprova` e rilegge la lista;
 *  · il bambino è un collegamento alla sua scheda (`/admin/crm?scheda=<id>`): è lì che si corregge l'importo
 *    o si collega l'alunno. Questo pannello non scrive altro.
 *
 * ── Le tre schermate che non sono la lista ──────────────────────────────────────────────────────────
 *  · 403 → «Riservato alla segreteria» (il CRM è di segreteria e Direzione; solo il 403 per la SEDE dice
 *    un'altra cosa, con la frase del catalogo);
 *  · 503 → «Il CRM non è disponibile su questo ambiente» (le tabelle `crm_*` non ci sono: è il caso del DB
 *    E2E della CI, o della finestra fra il deploy e la migrazione);
 *  · nessuna quota → «Nessuna quota in attesa».
 *
 * ── Il doppio clic ──────────────────────────────────────────────────────────────────────────────────
 * Una «Riprova» alla volta: un `ref` chiude la porta nello stesso istante del clic (lo `state` che spegne il
 * bottone arriva al render dopo), e il bottone resta spento finché la richiesta è in volo.
 *
 * ── 🔴 DATI DI MINORI ───────────────────────────────────────────────────────────────────────────────
 * Il nome del bambino sta a schermo (serve a riconoscere la riga) ma MAI nei log del browser: lì vanno solo
 * il nome dell'operazione e lo stato HTTP. Il testo di un rifiuto è sempre quello del CATALOGO, mai la prosa
 * del server. I testi dei motivi di blocco e dei metodi sono quelli della scheda del bambino
 * (`crmSchede.quotaBlocco_*`, `quotaMetodo_*`): una sola frase per la stessa cosa.
 */

const ROUTE_LOG = '/admin/pagamenti'

const urlElenco = (scuolaId: string | null) =>
  scuolaId ? `/api/admin/crm/quote?scuolaId=${encodeURIComponent(scuolaId)}` : '/api/admin/crm/quote'

const urlRiprova = (schedaId: string, bambinoId: string) =>
  `/api/admin/crm/schede/${encodeURIComponent(schedaId)}/bambini/${encodeURIComponent(bambinoId)}/quota/riprova`

const chiaveDi = (scuolaId: string | null) => scuolaId ?? 'tutte'

// ── La lettura dell'elenco ─────────────────────────────────────────────────────────────────────────

type Elenco =
  | { tipo: 'righe'; righe: QuotaInAttesa[] }
  /** `stato` 0 = la richiesta non è nemmeno arrivata (rete, timeout). */
  | { tipo: 'errore'; stato: number; codice: string | null }

/** Il corpo JSON di una risposta, o `null` se non lo è: chi legge non deve dipendere da un `try`. */
async function leggiJson(res: Response, operazione: string): Promise<unknown> {
  try {
    return await res.json()
  } catch (e) {
    logClient({ livello: 'error', evento: 'react', messaggio: `quote-crm-${operazione}-corpo-illeggibile: ${nomeErrore(e)}`, route: ROUTE_LOG, stato: res.status })
    return null
  }
}

const codiceDi = (corpo: unknown): string | null => {
  const c = (corpo as { codice?: unknown } | null)?.codice
  return typeof c === 'string' ? c : null
}

async function leggiElenco(scuolaId: string | null): Promise<Elenco> {
  let res: Response
  try {
    res = await fetch(urlElenco(scuolaId))
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `quote-crm-lettura-fallita: ${nomeErrore(e)}`, route: ROUTE_LOG, stato: 0 })
    return { tipo: 'errore', stato: 0, codice: null }
  }
  const corpo = await leggiJson(res, 'lettura')
  if (!res.ok) {
    if (res.status >= 500 && res.status !== 503) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'quote-crm-lettura-rifiutata', route: ROUTE_LOG, stato: res.status })
    }
    return { tipo: 'errore', stato: res.status, codice: codiceDi(corpo) }
  }
  const dati = (corpo as { data?: unknown } | null)?.data
  if (!Array.isArray(dati)) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: 'quote-crm-risposta-illeggibile', route: ROUTE_LOG, stato: res.status })
    return { tipo: 'errore', stato: res.status, codice: null }
  }
  return { tipo: 'righe', righe: dati as QuotaInAttesa[] }
}

// ── «Riprova» ──────────────────────────────────────────────────────────────────────────────────────

type EsitoRiprova =
  | { esito: 'passata' | 'bloccata' | 'non_pronta' | 'sede_diversa' | 'categoria_assente' }
  /** Il server ha risposto con un rifiuto (`stato` 0 = la richiesta non è arrivata). */
  | { esito: 'rifiuto'; stato: number; codice: string | null }
  /** 200 con un esito che non si riconosce: non passa per un successo. */
  | { esito: 'illeggibile' }

async function provaAPassare(r: QuotaInAttesa): Promise<EsitoRiprova> {
  let res: Response
  try {
    res = await fetch(urlRiprova(r.schedaId, r.bambinoId), { method: 'POST' })
  } catch (e) {
    logClient({ livello: 'error', evento: 'fetch', messaggio: `quote-crm-riprova-fallita: ${nomeErrore(e)}`, route: ROUTE_LOG, stato: 0 })
    return { esito: 'rifiuto', stato: 0, codice: null }
  }
  const corpo = await leggiJson(res, 'riprova')
  if (!res.ok) {
    if (res.status >= 500 && res.status !== 503) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'quote-crm-riprova-rifiutata', route: ROUTE_LOG, stato: res.status })
    }
    return { esito: 'rifiuto', stato: res.status, codice: codiceDi(corpo) }
  }
  const esito = ((corpo as { data?: { esito?: unknown } } | null)?.data?.esito ?? null) as unknown
  if (esito === 'ok' || esito === 'gia_in_contabilita') return { esito: 'passata' }
  if (esito === 'bloccata' || esito === 'non_pronta' || esito === 'sede_diversa' || esito === 'categoria_assente') {
    return { esito }
  }
  logClient({ livello: 'error', evento: 'fetch', messaggio: 'quote-crm-riprova-esito-illeggibile', route: ROUTE_LOG, stato: res.status })
  return { esito: 'illeggibile' }
}

// ── Il pannello ────────────────────────────────────────────────────────────────────────────────────

const eMetodo = (v: unknown): v is (typeof QUOTA_METODI)[number] => (QUOTA_METODI as readonly unknown[]).includes(v)
const eMotivo = (v: unknown): v is (typeof QUOTA_MOTIVI_BLOCCO)[number] => (QUOTA_MOTIVI_BLOCCO as readonly unknown[]).includes(v)

const AVVISO_BASE = 'rounded-input px-3 py-2 font-maven text-sm'
const AVVISO_OK = `${AVVISO_BASE} bg-kidville-green-soft text-kidville-green`
const AVVISO_ERRORE = `${AVVISO_BASE} bg-kidville-error-soft text-kidville-error-strong`
const COLLEGAMENTO = 'font-maven text-sm font-bold text-kidville-green underline-offset-2 hover:underline'
const SECONDARIO = 'font-maven text-xs text-kidville-sub'

export function QuoteCrmPanel({ scuolaId }: { userId: string; scuolaId: string | null }) {
  const t = useTranslations('adminContabilita')
  const tc = useTranslations('crmSchede')
  const date = useDateFormat()
  const { sedi } = useSediAttive()

  // Ciò che si è letto, con la sede per cui lo si è letto: se la pagina cambia sede, quello che c'è non vale più.
  const [lettura, setLettura] = useState<{ chiave: string; elenco: Elenco } | null>(null)
  const [giro, setGiro] = useState(0)
  const [occupato, setOccupato] = useState<string | null>(null)
  const [avviso, setAvviso] = useState<{ ok: boolean; testo: string } | null>(null)
  const inVolo = useRef(false)

  useEffect(() => {
    let attivo = true
    void leggiElenco(scuolaId).then((elenco) => {
      if (attivo) setLettura({ chiave: chiaveDi(scuolaId), elenco })
    })
    return () => {
      attivo = false
    }
  }, [scuolaId, giro])

  const elenco = lettura !== null && lettura.chiave === chiaveDi(scuolaId) ? lettura.elenco : null

  const riprova = async (r: QuotaInAttesa) => {
    if (inVolo.current) return
    inVolo.current = true
    setOccupato(r.bambinoId)
    setAvviso(null)

    const esito = await provaAPassare(r)

    inVolo.current = false
    setOccupato(null)
    let rilettura = true
    switch (esito.esito) {
      case 'passata':
        setAvviso({ ok: true, testo: t('quoteRiprovaOk') })
        break
      case 'bloccata':
        // Il motivo è nella riga che si rilegge: non serve ripeterlo.
        break
      case 'non_pronta':
        setAvviso({ ok: false, testo: tc('quotaRiprovaNonPronta') })
        break
      case 'sede_diversa':
        setAvviso({ ok: false, testo: t('quoteRiprovaSedeDiversa') })
        break
      case 'categoria_assente':
        setAvviso({ ok: false, testo: t('quoteRiprovaCategoriaAssente') })
        break
      case 'illeggibile':
        setAvviso({ ok: false, testo: tc('quotaErrore') })
        rilettura = false
        break
      case 'rifiuto':
        // 404: la scheda non c'è più, e la lista riletta lo dirà. Il resto non cambia nulla da rileggere.
        rilettura = esito.stato === 404
        setAvviso({
          ok: false,
          testo: esito.stato === 503 ? t('quoteNonInstallato') : soloCatalogoDaCorpo({ codice: esito.codice }, tc('quotaErrore')),
        })
        break
    }
    if (rilettura) setGiro((g) => g + 1)
  }

  const intestazione = <SectionTitle icon={Handshake} title={t('quoteTitolo')} sub={t('quoteSottotitolo')} />

  if (elenco === null) {
    return (
      <section className="min-w-0 space-y-4">
        {intestazione}
        <p role="status" className={SECONDARIO}>
          {t('quoteCaricamento')}
        </p>
      </section>
    )
  }

  if (elenco.tipo === 'errore') {
    const sede = elenco.stato === 403 && elenco.codice === 'SEDE_NON_ACCESSIBILE'
    const testo =
      elenco.stato === 403
        ? sede
          ? soloCatalogoDaCorpo({ codice: elenco.codice }, t('quoteRiservato'))
          : t('quoteRiservato')
        : elenco.stato === 503
          ? t('quoteNonInstallato')
          : t('quoteErrore')
    // Riservato e «non disponibile» non cambiano riprovando; un guasto sì.
    const riprovabile = elenco.stato !== 403 && elenco.stato !== 503
    return (
      <section className="min-w-0 space-y-4">
        {intestazione}
        <div role="alert" className="space-y-3">
          <p className={AVVISO_ERRORE}>{testo}</p>
          {riprovabile && (
            <Btn variant="secondary" size="sm" onClick={() => setGiro((g) => g + 1)}>
              {tc('riprova')}
            </Btn>
          )}
        </div>
      </section>
    )
  }

  const righe = elenco.righe
  const conSede = scuolaId === null

  return (
    <section className="min-w-0 space-y-4">
      {intestazione}

      {avviso !== null && (
        <p role={avviso.ok ? 'status' : 'alert'} className={avviso.ok ? AVVISO_OK : AVVISO_ERRORE}>
          {avviso.testo}
        </p>
      )}

      {righe.length === 0 ? (
        <p role="status" className="rounded-card border border-kidville-line bg-kidville-white p-8 text-center font-maven text-sm text-kidville-sub">
          {t('quoteVuoto')}
        </p>
      ) : (
        <div className={TABLE_WRAP}>
          <table className={TABLE} aria-label={t('quoteTitolo')}>
            <thead>
              <tr>
                <th className={TH}>{t('quoteThBambino')}</th>
                {conSede && <th className={TH}>{t('quoteThSede')}</th>}
                <th className={TH}>{t('quoteThAnno')}</th>
                <th className={TH}>{t('quoteThImporto')}</th>
                <th className={TH}>{t('quoteThMetodo')}</th>
                <th className={TH}>{t('quoteThGiorno')}</th>
                <th className={TH}>{t('quoteThAttesa')}</th>
                <th className={TH}>{t('quoteThStato')}</th>
                <th className={TH}>
                  <span className="sr-only">{t('quoteThAzione')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {righe.map((r) => {
                const nome = r.nome !== null && r.nome.trim() !== '' ? r.nome : tc('bambinoSenzaNome')
                const trattino = <span className="text-kidville-sub">—</span>
                const stato =
                  r.stato === 'bloccata'
                    ? { tono: 'warn' as const, testo: tc('quotaStatoBloccata') }
                    : r.stato === 'senza_importo'
                      ? { tono: 'neutral' as const, testo: tc('quotaStatoSenzaImporto') }
                      : { tono: 'info' as const, testo: r.alunnoCollegato ? tc('quotaStatoAttesaPassaggio') : tc('quotaStatoAttesaAlunno') }
                const inCorso = occupato === r.bambinoId
                return (
                  <tr key={r.bambinoId} className={TROW}>
                    <td className={TD}>
                      <Link href={`/admin/crm?scheda=${encodeURIComponent(r.schedaId)}`} className={COLLEGAMENTO}>
                        {nome}
                      </Link>
                    </td>
                    {conSede && (
                      <td className={`${TD} font-maven text-sm text-kidville-ink`}>
                        {sedi.find((s) => s.id === r.scuolaId)?.nome ?? t('fisc_sede_ignota')}
                      </td>
                    )}
                    <td className={`${TD} whitespace-nowrap font-maven text-sm text-kidville-ink`}>
                      {r.anno !== null ? etichettaAnno(r.anno) : trattino}
                    </td>
                    <td className={`${TD} whitespace-nowrap font-maven text-sm text-kidville-ink`}>
                      {r.importo !== null ? formatEuro(r.importo) : trattino}
                    </td>
                    <td className={`${TD} whitespace-nowrap font-maven text-sm text-kidville-ink`}>
                      {eMetodo(r.metodo) ? tc(`quotaMetodo_${r.metodo}`) : trattino}
                    </td>
                    <td className={`${TD} whitespace-nowrap font-maven text-sm text-kidville-ink`}>
                      {r.giorno !== null ? date.dataBreve(r.giorno) : trattino}
                    </td>
                    <td className={`${TD} whitespace-nowrap font-maven text-sm text-kidville-ink`}>
                      {r.giorniAttesa !== null ? t('quoteGiorniAttesa', { n: r.giorniAttesa }) : trattino}
                    </td>
                    <td className={`${TD} min-w-[14rem] space-y-1`}>
                      <Badge tone={stato.tono}>{stato.testo}</Badge>
                      {r.stato === 'bloccata' && eMotivo(r.motivo) && (
                        <p className="max-w-sm font-maven text-sm text-kidville-ink">{tc(`quotaBlocco_${r.motivo}`)}</p>
                      )}
                    </td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {r.alunnoCollegato && (
                        <Btn
                          variant="secondary"
                          size="sm"
                          disabled={occupato !== null}
                          aria-label={t('quoteRiprovaPer', { nome })}
                          onClick={() => void riprova(r)}
                        >
                          {inCorso ? t('quoteRiprovaInCorso') : tc('riprova')}
                        </Btn>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
