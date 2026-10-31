'use client'

import { useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Btn } from '@/components/ui/Btn'
import { Modal } from '@/components/ui/Modal'
import type { BambinoDettaglioRow } from '@/lib/crm/tipi'
import { useDateFormat } from '@/lib/i18n/date'
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch'
import { chiama, leggiJson, scrittura } from './rete'
import { CAMPO, MESSAGGIO_ERRORE, TESTO_SECONDARIO } from './stile'

/**
 * CRM della segreteria · IL COLLEGAMENTO DEL BAMBINO ALL'ALUNNO IN ANAGRAFICA, A MANO (spec 2026-10-31, §5.4).
 *
 * È ciò che fa passare la quota d'iscrizione in contabilità quando il bambino non arriva da una domanda
 * importata: un fratello o un rinnovo già in anagrafica, oppure la domanda importata che l'abbinamento
 * automatico non ha saputo risolvere. Un solo bottone alla volta, scelto da `bambino.alunno_id`:
 *
 *  · senza alunno → «Collega all'alunno»: una finestra con la ricerca fra gli alunni ISCRITTI DELLA STESSA SEDE
 *    (`GET /api/admin/crm/alunni`, almeno due caratteri); si sceglie e parte `PUT …/alunno { alunnoId }`.
 *    Se la quota era in attesa, la route la passa in contabilità nella stessa chiamata;
 *  · con un alunno → «Scollega l'alunno», con la conferma di `AssociaDomanda` (il gesto lascia una riga nello
 *    storico). Solo finché la quota NON è in contabilità: da lì il collegamento tiene insieme la voce e l'alunno,
 *    e la route risponde 409. Il bottone non c'è, e il perché si legge.
 *
 * Dopo ogni gesto riuscito chiama `onCambiata()`: la scheda si rilegge.
 *
 * ── 🔴 DATI DI MINORI ───────────────────────────────────────────────────────────────────────────────
 * Le righe portano il minimo per riconoscere un bambino (nome, cognome, nascita): lo decide la route. Nei log
 * del browser passano solo il nome dell'operazione e lo stato HTTP (lo fa `chiama`: né l'indirizzo, che porta
 * il testo cercato, né il corpo). Il testo di un rifiuto è sempre quello del CATALOGO, mai la prosa del server.
 *
 * ── Il doppio clic ──────────────────────────────────────────────────────────────────────────────────
 * Un `ref` chiude la porta nello stesso istante del clic, prima che lo `state` faccia in tempo a spegnere il
 * bottone: due `PUT` non partono. Una risposta lenta di una ricerca VECCHIA non copre quella nuova (contatore).
 */

interface RigaAlunno {
  id: string
  nome: string | null
  cognome: string | null
  dataNascita: string | null
}

const testoOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

function rigaValida(r: unknown): RigaAlunno | null {
  if (typeof r !== 'object' || r === null) return null
  const o = r as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  return { id: o.id, nome: testoOrNull(o.nome), cognome: testoOrNull(o.cognome), dataNascita: testoOrNull(o.data_nascita) }
}

const urlAlunno = (schedaId: string, bambinoId: string) =>
  `/api/admin/crm/schede/${encodeURIComponent(schedaId)}/bambini/${encodeURIComponent(bambinoId)}/alunno`

export function CollegaAlunno({
  schedaId,
  bambino,
  scuolaId,
  onCambiata,
}: {
  schedaId: string
  bambino: BambinoDettaglioRow
  scuolaId: string
  onCambiata: () => void
}) {
  const t = useTranslations('crmSchede')
  const idTitolo = useId()
  const [aperta, setAperta] = useState(false)
  const [conferma, setConferma] = useState(false)
  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)
  const inVolo = useRef(false)

  const scollega = async () => {
    if (inVolo.current) return
    inVolo.current = true
    setInCorso(true)
    setErrore(null)
    const res = await chiama('alunno-scollega', urlAlunno(schedaId, bambino.id), { method: 'DELETE' })
    let rilettura = false
    if (res === null) setErrore(t('alunnoScollegaErrore'))
    else if (!res.ok) setErrore(soloCatalogoDaCorpo(await leggiJson(res, 'alunno-scollega'), t('alunnoScollegaErrore')))
    else rilettura = true
    inVolo.current = false
    setInCorso(false)
    if (rilettura) {
      setConferma(false)
      onCambiata()
    }
  }

  if (bambino.alunno_id !== null) {
    // Con la quota in contabilità il collegamento tiene insieme la voce e l'alunno: non si toglie.
    const bloccato = bambino.quota_stato === 'in_contabilita'
    return (
      <div className="space-y-2">
        <p className="font-maven text-sm text-kidville-ink">{t('alunnoCollegato')}</p>
        {bloccato ? (
          <p className={TESTO_SECONDARIO}>{t('alunnoQuotaInContabilita')}</p>
        ) : conferma ? (
          <div className="flex flex-col gap-2 rounded-card border border-kidville-line bg-kidville-white p-3">
            <p className="font-maven text-sm font-bold text-kidville-ink">{t('alunnoScollegaDomanda')}</p>
            <p className="font-maven text-xs text-kidville-sub">{t('alunnoScollegaDettaglio')}</p>
            <div className="flex flex-wrap gap-2">
              <Btn variant="danger" size="sm" disabled={inCorso} onClick={() => void scollega()}>
                {t('alunnoScollegaConferma')}
              </Btn>
              <Btn variant="ghost" size="sm" disabled={inCorso} onClick={() => setConferma(false)}>
                {t('annulla')}
              </Btn>
            </div>
          </div>
        ) : (
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => {
              setErrore(null)
              setConferma(true)
            }}
          >
            {t('alunnoScollega')}
          </Btn>
        )}
        {errore !== null && (
          <p role="alert" className={MESSAGGIO_ERRORE}>
            {errore}
          </p>
        )}
      </div>
    )
  }

  return (
    <>
      <Btn variant="secondary" size="sm" onClick={() => setAperta(true)}>
        {t('alunnoCollega')}
      </Btn>
      {aperta && (
        <Modal open onClose={() => setAperta(false)} title={t('alunnoRicercaTitolo')} labelledBy={idTitolo} className="w-full max-w-lg">
          <div className="max-h-[85vh] overflow-y-auto rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
            <h2 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
              {t('alunnoRicercaTitolo')}
            </h2>
            <div className="mt-4">
              <RicercaAlunno
                schedaId={schedaId}
                scuolaId={scuolaId}
                bambino={bambino}
                onCollegato={() => {
                  setAperta(false)
                  onCambiata()
                }}
              />
            </div>
            <div className="mt-5 flex justify-end">
              <Btn variant="ghost" onClick={() => setAperta(false)}>
                {t('alunnoRicercaChiudi')}
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LA RICERCA (il contenuto della finestra: si monta all'apertura e si smonta alla chiusura)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Quanti caratteri servono perché la route accetti una ricerca (`querySchema` di `admin/crm/alunni`). */
const MINIMO_CARATTERI = 2

function RicercaAlunno({
  schedaId,
  scuolaId,
  bambino,
  onCollegato,
}: {
  schedaId: string
  scuolaId: string
  bambino: BambinoDettaglioRow
  onCollegato: () => void
}) {
  const t = useTranslations('crmSchede')
  const { dataBreve } = useDateFormat()
  const idCerca = useId()
  const [testo, setTesto] = useState('')
  const [caricamento, setCaricamento] = useState(false)
  const [righe, setRighe] = useState<RigaAlunno[] | null>(null)
  const [erroreRicerca, setErroreRicerca] = useState<string | null>(null)
  const [scelto, setScelto] = useState<string | null>(null)
  const [errore, setErrore] = useState<string | null>(null)
  const inVolo = useRef(false)
  const richiesta = useRef(0)

  const pulito = testo.trim()
  const cercabile = pulito.length >= MINIMO_CARATTERI

  const cerca = async () => {
    if (!cercabile) return
    const mia = ++richiesta.current
    setCaricamento(true)
    setErroreRicerca(null)
    setErrore(null)
    const parametri = new URLSearchParams({ scuolaId, q: pulito })
    const res = await chiama('alunni-cerca', `/api/admin/crm/alunni?${parametri}`)
    let trovate: RigaAlunno[] | null = null
    let messaggio: string | null = null
    if (res === null) {
      messaggio = t('alunnoRicercaErrore')
    } else if (!res.ok) {
      messaggio = soloCatalogoDaCorpo(await leggiJson(res, 'alunni-cerca'), t('alunnoRicercaErrore'))
    } else {
      const dati = ((await leggiJson(res, 'alunni-cerca')) as { data?: unknown } | null)?.data
      if (Array.isArray(dati)) trovate = dati.map(rigaValida).filter((r): r is RigaAlunno => r !== null)
      else messaggio = t('alunnoRicercaErrore')
    }
    // Una risposta lenta di una ricerca vecchia non copre quella nuova.
    if (mia !== richiesta.current) return
    setCaricamento(false)
    setRighe(trovate)
    setErroreRicerca(messaggio)
  }

  const collega = async (riga: RigaAlunno) => {
    if (inVolo.current) return
    inVolo.current = true
    setScelto(riga.id)
    setErrore(null)
    const res = await chiama('alunno-collega', urlAlunno(schedaId, bambino.id), scrittura('PUT', { alunnoId: riga.id }))
    let fatto = false
    if (res === null) setErrore(t('alunnoErrore'))
    else if (!res.ok) setErrore(soloCatalogoDaCorpo(await leggiJson(res, 'alunno-collega'), t('alunnoErrore')))
    else fatto = true
    inVolo.current = false
    setScelto(null)
    if (fatto) onCollegato()
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="font-maven text-sm text-kidville-sub">{t('alunnoRicercaPerBambino', { nome: bambino.nome ?? t('bambinoSenzaNome') })}</p>

      <form
        role="search"
        noValidate
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void cerca()
        }}
      >
        <label htmlFor={idCerca} className="sr-only">
          {t('alunnoRicercaEtichetta')}
        </label>
        <input
          id={idCerca}
          type="search"
          autoComplete="off"
          maxLength={100}
          value={testo}
          onChange={(e) => setTesto(e.target.value)}
          className={`${CAMPO} min-w-0 flex-1`}
        />
        <Btn type="submit" variant="ghost" disabled={!cercabile || caricamento}>
          {t('alunnoRicercaCerca')}
        </Btn>
      </form>

      {errore !== null && (
        <p role="alert" className={MESSAGGIO_ERRORE}>
          {errore}
        </p>
      )}

      {caricamento ? (
        <p role="status" className="font-maven text-sm text-kidville-sub">
          {t('alunnoRicercaCaricamento')}
        </p>
      ) : erroreRicerca !== null ? (
        <p role="alert" className={MESSAGGIO_ERRORE}>
          {erroreRicerca}
        </p>
      ) : righe === null ? null : righe.length === 0 ? (
        <p className="font-maven text-sm text-kidville-sub">{t('alunnoRicercaVuoto')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {righe.map((r) => {
            const nome = [r.nome, r.cognome].filter(Boolean).join(' ') || t('alunnoRicercaSenzaNome')
            const nascita = r.dataNascita !== null ? dataBreve(r.dataNascita) : ''
            return (
              <li key={r.id} className="flex items-start justify-between gap-3 rounded-card border border-kidville-line bg-kidville-white p-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="font-maven text-sm font-bold text-kidville-ink [overflow-wrap:anywhere]">{nome}</p>
                  {nascita !== '' && <p className="font-maven text-xs text-kidville-sub">{t('alunnoRicercaNascita', { data: nascita })}</p>}
                </div>
                <Btn size="sm" disabled={scelto !== null} aria-label={t('alunnoRicercaScegliPer', { nome })} onClick={() => void collega(r)}>
                  {scelto === r.id ? t('alunnoRicercaCollegamento') : t('alunnoRicercaScegli')}
                </Btn>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
