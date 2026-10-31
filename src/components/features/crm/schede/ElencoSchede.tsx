'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { BarraFiltri, testiBarraFiltri } from '@/components/ui/BarraFiltri'
import { Btn } from '@/components/ui/Btn'
import { Modal } from '@/components/ui/Modal'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { ESITI_BAMBINO, type EsitoBambino } from '@/lib/crm/tipi'
import { useDateFormat } from '@/lib/i18n/date'
import { logClient } from '@/lib/logging/client'
import { decidiStatoElenco } from '@/lib/ui/filtri/motore'
import type { OpzioneFiltro } from '@/lib/ui/filtri/tipi'
import { useFiltri } from '@/lib/ui/filtri/use-filtri'
import { campiSchede, TONO_ESITO } from './filtri-schede'
import { ID_TITOLO_NUOVA_SCHEDA, NuovaScheda } from './NuovaScheda'
import { chiama, leggiJson, ROUTE_LOG } from './rete'
import { RIQUADRO, TESTO_SECONDARIO } from './stile'
import { etichetta } from './vocabolari'

/**
 * CRM della segreteria · L'ELENCO DELLE FAMIGLIE.
 *
 * Una riga per scheda, dalla più recente: la famiglia, i suoi bambini con l'esito, la prossima visita e
 * il prossimo richiamo. Un clic apre la scheda (`onApri`) nel pannello accanto; «Nuova famiglia» apre
 * il modulo di creazione in una finestra.
 *
 * ── Ogni filtro è del SERVER ─────────────────────────────────────────────────────────────────────
 * L'elenco arriva a pagine da 50 (`GET /api/admin/crm/schede`): un filtro sul browser filtrerebbe solo
 * le righe già scaricate e scriverebbe un totale falso. I campi stanno in `filtri-schede.ts` e il lock
 * `filtri-server-non-mentono` verifica che la route li conosca tutti.
 *
 * ── Tre numeri, e non vanno confusi ──────────────────────────────────────────────────────────────
 *   · `righe`      le famiglie scaricate finora (le pagine lette);
 *   · `totale`     quante ne passano i filtri attivi, sul server (fa decidere «Mostra altre famiglie»);
 *   · `totaleSede` quante ne ha la sede SENZA filtri. Serve a distinguere «non c'è ancora nessuna
 *                  famiglia» da «nessun risultato con questi filtri»: dire la seconda cosa su una sede
 *                  vuota accusa i filtri di una colpa che non hanno (vedi `StatoElenco`).
 *   Senza filtri `totaleSede` è lo stesso `totale`. Con i filtri attivi serve una seconda lettura: una
 *   richiesta per una pagina oltre l'ultima, che la route risolve con un solo conteggio e nessuna riga.
 *
 * ── Le persone si leggono PRIMA di montare l'elenco ───────────────────────────────────────────────
 * `useFiltri` legge l'indirizzo una volta e scarta i valori che non sono fra le opzioni di una tendina:
 * se la tendina «Visite di» fosse ancora vuota, un `?persona=…` salvato in un segnalibro verrebbe
 * buttato via. Con le persone già in mano il filtro sopravvive. Se la lettura fallisce l'elenco parte
 * lo stesso, senza quella tendina (che si nasconde da sola quando non ha voci).
 *
 * ── Il caricamento non è una funzione di un effetto ───────────────────────────────────────────────
 * Le letture sono funzioni di modulo che ritornano una Promise; l'effetto si limita a `.then(setX)`. Se
 * una risposta arriva dopo che il filtro è cambiato (o la sede) viene scartata: «sto caricando» è la
 * differenza fra la chiave della risposta e quella attuale, non un booleano da tenere allineato.
 */

interface BambinoRiga {
  id: string
  nome: string | null
  esito: EsitoBambino
  domanda_id: string | null
}
interface Riga {
  id: string
  genitore_nome: string | null
  origine: string
  creata_il: string
  bambini: BambinoRiga[]
  prossima_visita: string | null
  prossima_azione: string | null
}

/** Una pagina dell'elenco. `null` = la lettura è fallita (il guasto è già nel log del browser). */
interface PaginaLetta {
  righe: Riga[]
  totale: number
}

interface Risultato {
  /** La `chiaveServer` per cui è stata chiesta la prima pagina: dice se la risposta è ancora attuale. */
  chiave: string
  ok: boolean
  righe: Riga[]
  totale: number
  totaleSede: number
  pagina: number
}

const eRiga = (v: unknown): v is Riga => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.id === 'string' && Array.isArray(r.bambini)
}

async function leggiPagina(scuolaId: string, filtri: string, pagina: number): Promise<PaginaLetta | null> {
  const parametri = new URLSearchParams(filtri)
  parametri.set('scuolaId', scuolaId)
  if (pagina > 1) parametri.set('pagina', String(pagina))
  const res = await chiama('schede-elenco', `/api/admin/crm/schede?${parametri.toString()}`)
  if (res === null || !res.ok) return null
  const json = (await leggiJson(res, 'schede-elenco')) as { data?: unknown; totale?: unknown } | null
  if (json === null || !Array.isArray(json.data) || typeof json.totale !== 'number') return null
  return { righe: json.data.filter(eRiga), totale: json.totale }
}

/** Una pagina oltre l'ultima: la route risponde con il solo conteggio. */
const OLTRE_L_ULTIMA = 100000

async function leggiPrimaPagina(scuolaId: string, chiave: string): Promise<Risultato> {
  // Con i filtri attivi, quante ce ne sono in sede senza? Le due letture partono insieme.
  const [pagina, intera] = await Promise.all([
    leggiPagina(scuolaId, chiave, 1),
    chiave === '' ? Promise.resolve(null) : leggiPagina(scuolaId, '', OLTRE_L_ULTIMA),
  ])
  if (pagina === null) return { chiave, ok: false, righe: [], totale: 0, totaleSede: 0, pagina: 1 }
  // Se la seconda lettura fallisce si resta sul numero che c'è: nel caso peggiore «nessun risultato con
  // questi filtri» invece di «non c'è ancora nessuna famiglia» (e mai il contrario).
  const totaleSede = chiave === '' ? pagina.totale : intera !== null ? intera.totale : Math.max(pagina.totale, 1)
  return { chiave, ok: true, righe: pagina.righe, totale: pagina.totale, totaleSede, pagina: 1 }
}

/** Le persone della sede a cui si assegna una visita, già in forma di voci di tendina. */
async function leggiPersone(scuolaId: string): Promise<OpzioneFiltro[]> {
  const res = await chiama('persone-elenco', `/api/admin/crm/persone?scuolaId=${encodeURIComponent(scuolaId)}`)
  if (res === null) return []
  if (!res.ok) {
    logClient({ livello: 'warn', evento: 'react', messaggio: 'crm-persone-elenco: lettura non riuscita', route: ROUTE_LOG, stato: res.status })
    return []
  }
  const json = (await leggiJson(res, 'persone-elenco')) as { data?: unknown } | null
  if (json === null || !Array.isArray(json.data)) return []
  const voci: OpzioneFiltro[] = []
  for (const p of json.data as Record<string, unknown>[]) {
    if (typeof p?.id !== 'string') continue
    const nome = `${typeof p.nome === 'string' ? p.nome : ''} ${typeof p.cognome === 'string' ? p.cognome : ''}`.trim()
    if (nome !== '') voci.push({ valore: p.id, etichetta: nome })
  }
  return voci
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

export function ElencoSchede({ scuolaId, onApri }: { scuolaId: string; onApri: (schedaId: string) => void }) {
  const ts = useTranslations('shared')
  const [persone, setPersone] = useState<{ scuolaId: string; voci: OpzioneFiltro[] } | null>(null)

  useEffect(() => {
    let attivo = true
    void leggiPersone(scuolaId).then((voci) => {
      if (attivo) setPersone({ scuolaId, voci })
    })
    return () => {
      attivo = false
    }
  }, [scuolaId])

  if (persone === null || persone.scuolaId !== scuolaId) {
    return (
      <p role="status" className={`py-12 text-center ${TESTO_SECONDARIO}`}>
        {ts('caricamentoInCorso')}
      </p>
    )
  }
  // `key`: cambiando sede si riparte da zero (filtri, pagine lette, finestra aperta).
  return <ElencoCaricato key={scuolaId} scuolaId={scuolaId} persone={persone.voci} onApri={onApri} />
}

function ElencoCaricato({ scuolaId, persone, onApri }: { scuolaId: string; persone: OpzioneFiltro[]; onApri: (schedaId: string) => void }) {
  const t = useTranslations('crmSchede')
  const tc = useTranslations('crmShell')
  const ts = useTranslations('shared')
  const date = useDateFormat()

  const campi = campiSchede<Riga>(t, tc, persone, (iso) => date.dataBreve(iso))
  const filtri = useFiltri<Riga>(campi)
  const chiaveServer = filtri.chiaveServer

  const [risultato, setRisultato] = useState<Risultato | null>(null)
  const [ricarica, setRicarica] = useState(0)
  const [altre, setAltre] = useState<'ferme' | 'in-corso' | 'errore'>('ferme')
  const [nuova, setNuova] = useState(false)

  useEffect(() => {
    let attivo = true
    void leggiPrimaPagina(scuolaId, chiaveServer).then((r) => {
      if (!attivo) return
      setRisultato(r)
      setAltre('ferme')
    })
    return () => {
      attivo = false
    }
  }, [scuolaId, chiaveServer, ricarica])

  // La risposta che si vede è di UNA chiave: se non è quella attuale, si sta ancora caricando.
  const caricamento = risultato === null || risultato.chiave !== chiaveServer
  const errore = risultato !== null && risultato.chiave === chiaveServer && !risultato.ok
  const righe = risultato?.righe ?? []
  const totale = risultato?.totale ?? 0
  const totaleSede = risultato?.totaleSede ?? 0
  const altreDaMostrare = risultato !== null && risultato.ok && righe.length < totale

  const statoElenco = decidiStatoElenco({ caricamento, errore, totale: totaleSede, mostrati: righe.length })

  const riprova = () => {
    setRisultato(null)
    setRicarica((n) => n + 1)
  }

  const mostraAltre = async () => {
    if (risultato === null || !risultato.ok || altre === 'in-corso') return
    const { chiave, pagina } = risultato
    setAltre('in-corso')
    const prossima = await leggiPagina(scuolaId, chiave, pagina + 1)
    if (prossima === null) {
      setAltre('errore')
      return
    }
    setRisultato((r) => {
      // Nel frattempo i filtri sono cambiati, o la pagina è già stata aggiunta: questa risposta è vecchia.
      if (r === null || r.chiave !== chiave || r.pagina !== pagina) return r
      const gia = new Set(r.righe.map((x) => x.id))
      return { ...r, righe: [...r.righe, ...prossima.righe.filter((x) => !gia.has(x.id))], totale: prossima.totale, pagina: pagina + 1 }
    })
    setAltre('ferme')
  }

  const creata = (schedaId: string) => {
    setNuova(false)
    setRicarica((n) => n + 1)
    onApri(schedaId)
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">{t('elencoTitolo')}</h2>
        <Btn size="sm" onClick={() => setNuova(true)}>
          <Plus size={14} aria-hidden="true" />
          {t('elencoNuovaFamiglia')}
        </Btn>
      </div>

      {/* La barra non si disegna su una sede che non ha mai avuto una scheda: filtrare il nulla non serve. */}
      {totaleSede > 0 && (
        <BarraFiltri campi={campi} stato={filtri} testi={testiBarraFiltri(ts)} totale={totaleSede} mostrati={totale} variante="compatta" className="mb-5" />
      )}

      {statoElenco !== 'pronto' ? (
        <StatoElenco
          stato={statoElenco}
          testi={{ ...testiStatoElenco(ts), vuotoTitolo: t('elencoVuotoTitolo'), vuotoCorpo: t('elencoVuotoCorpo') }}
          attivi={filtri.attivi}
          onPulisci={filtri.pulisci}
          onRiprova={riprova}
        />
      ) : (
        // Le righe restano a schermo (attenuate) mentre un filtro cambia: sparire a ogni tasto è il difetto peggiore.
        <div className={filtri.inAttesa || caricamento ? 'opacity-60' : undefined} aria-busy={filtri.inAttesa || caricamento || undefined}>
          <ul aria-label={t('elencoTitolo')} className="space-y-3">
            {righe.map((riga) => (
              <li key={riga.id}>
                <RigaFamiglia riga={riga} onApri={onApri} />
              </li>
            ))}
          </ul>

          {altreDaMostrare && (
            <div className="mt-4 flex flex-col items-center gap-2">
              {altre === 'errore' && (
                <p role="alert" className={TESTO_SECONDARIO}>
                  {t('elencoErroreAltre')}
                </p>
              )}
              <Btn variant="ghost" onClick={() => void mostraAltre()} disabled={altre === 'in-corso' || filtri.inAttesa}>
                {altre === 'in-corso' ? t('elencoCaricamentoAltre') : t('elencoMostraAltre')}
              </Btn>
            </div>
          )}
        </div>
      )}

      <Modal open={nuova} onClose={() => setNuova(false)} title={t('nuovaTitolo')} labelledBy={ID_TITOLO_NUOVA_SCHEDA}>
        <div className="max-h-[85dvh] w-full max-w-xl overflow-y-auto rounded-card bg-kidville-white p-5 shadow-xl">
          <NuovaScheda scuolaId={scuolaId} onCreata={creata} onAnnulla={() => setNuova(false)} />
        </div>
      </Modal>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════

function RigaFamiglia({ riga, onApri }: { riga: Riga; onApri: (schedaId: string) => void }) {
  const t = useTranslations('crmSchede')
  const tc = useTranslations('crmShell')
  const date = useDateFormat()

  return (
    <button type="button" onClick={() => onApri(riga.id)} className={`${RIQUADRO} block w-full text-left transition-colors hover:border-kidville-green`}>
      <span className="block font-barlow text-base font-extrabold uppercase text-kidville-ink">{riga.genitore_nome ?? t('rigaSenzaNome')}</span>

      <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {riga.bambini.map((b) => (
          <span key={b.id} className="inline-flex items-center gap-2">
            <span className="font-maven text-sm text-kidville-ink">{b.nome ?? t('rigaBambinoSenzaNome')}</span>
            <Badge tone={TONO_ESITO[b.esito] ?? 'neutral'}>
              {(ESITI_BAMBINO as readonly string[]).includes(b.esito) ? etichetta(tc, 'esiti', b.esito) : b.esito}
            </Badge>
          </span>
        ))}
      </span>

      <span className="mt-2 flex flex-col gap-0.5 sm:flex-row sm:gap-4">
        <span className={TESTO_SECONDARIO}>
          {riga.prossima_visita !== null ? t('rigaProssimaVisita', { quando: date.dataOra(riga.prossima_visita) }) : t('rigaNessunaVisita')}
        </span>
        <span className={TESTO_SECONDARIO}>
          {riga.prossima_azione !== null ? t('rigaProssimoRichiamo', { quando: date.dataOra(riga.prossima_azione) }) : t('rigaNessunRichiamo')}
        </span>
      </span>
    </button>
  )
}
