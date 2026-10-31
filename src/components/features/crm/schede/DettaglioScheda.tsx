'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Mail, MessageCircle, Phone, X } from 'lucide-react'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Btn } from '@/components/ui/Btn'
import { DateField } from '@/components/ui/DateField'
import { ETICHETTA_CAMPO_FILTRO } from '@/components/ui/BarraFiltri'
import { normalizzaEmail } from '@/lib/crm/contatti'
import {
  ANNI_INGRESSO,
  ESITI_BAMBINO,
  MOTIVI_PERDITA,
  ORIGINI,
  TIPI_EVENTO,
  type AppuntamentoRow,
  type BambinoRow,
  type EsitoBambino,
  type EventoRow,
  type SchedaRow,
  type StatoAppuntamento,
} from '@/lib/crm/tipi'
import { useDateFormat } from '@/lib/i18n/date'
import { messaggioErrore } from '@/lib/ui/esito-fetch'
import type { Traduttore } from '@/lib/ui/filtri/tipi'
import { FissaVisita } from '../agenda/FissaVisita'
import { AssociaDomanda } from '../collegamento/AssociaDomanda'
import { AvvisoDomandaDaAssociare } from '../collegamento/AvvisoDomandaDaAssociare'
import { BadgeCollegamento } from '../collegamento/BadgeCollegamento'
import { AzioniScheda } from '../follow-up/AzioniScheda'
import { linkTelefono, linkWhatsApp } from './contatti-link'
import { TONO_ESITO } from './filtri-schede'
import { ModuloFamiglia, contattoValido, famigliaDaScheda, type DatiFamiglia } from './ModuloFamiglia'
import { chiama, leggiJson, scrittura } from './rete'
import { AREA, CAMPO, COLLEGAMENTO_PASTIGLIA, MESSAGGIO_ERRORE, RIQUADRO, TESTO_SECONDARIO, TITOLO_SEZIONE } from './stile'
import { etichetta } from './vocabolari'

/**
 * CRM della segreteria · LA SCHEDA DI UNA FAMIGLIA.
 *
 * Si apre nel pannello fisso accanto all'elenco (`ColonnaDettaglio`): la famiglia in cima, poi i
 * bambini, le visite, i richiami, il campo per aggiungere una nota e — a chiudere la stessa colonna —
 * lo STORICO (spec §9: il pannello «si apre sullo storico, con sopra famiglia e bambini»). Lo storico
 * non è dietro un'altra linguetta né un clic: è già nella pagina quando la scheda compare.
 *
 * ── Un solo giro di lettura ───────────────────────────────────────────────────────────────────────
 * `GET /api/admin/crm/schede/[id]` porta tutto: scheda, bambini, visite, richiami aperti e storico. Ogni
 * gesto che cambia qualcosa (salvare un bambino, aggiungere una nota, fissare una visita…) rilegge la
 * scheda: lo storico che si vede è sempre quello che il database ha, mai quello che il browser crede.
 * Le risposte di una lettura vecchia sono scartate se nel frattempo si è passati a un'altra scheda.
 *
 * ── La sede viene dalla scheda ────────────────────────────────────────────────────────────────────
 * Le props non portano la sede (il contratto fra le sessioni è `{ schedaId, onChiudi }`): le schermate
 * delle altre sessioni che la chiedono la ricevono da `scheda.scuola_id`, cioè dalla sede che la route
 * ha verificato — non da una dichiarata dal browser.
 *
 * ── Pezzi di altre sessioni ───────────────────────────────────────────────────────────────────────
 * `BadgeCollegamento`, `AssociaDomanda`, `AvvisoDomandaDaAssociare` (collegamento con la domanda),
 * `AzioniScheda` (richiami) e `FissaVisita` (agenda) sono montati e basta, con le props fissate dal
 * contratto. Quando una di loro cambia qualcosa chiama `onCollegato` / `onAggiornata` / `onFatto`, e la
 * scheda si rilegge.
 *
 * ── Cosa NON c'è ─────────────────────────────────────────────────────────────────────────────────
 * Aggiungere un bambino a una scheda esistente: la route c'è (`POST …/bambini`), il pulsante no.
 */

interface Persona {
  id: string
  nome: string
  cognome: string
}
interface AppuntamentoDettaglio extends AppuntamentoRow {
  assegnata_a_persona: Persona | null
  svolto_da_persona: Persona | null
}
interface EventoDettaglio extends EventoRow {
  autore_persona: Persona | null
}
interface Dettaglio {
  scheda: SchedaRow
  bambini: BambinoRow[]
  appuntamenti: AppuntamentoDettaglio[]
  eventi: EventoDettaglio[]
  eventi_totale: number
}

type Lettura = { schedaId: string } & ({ stato: 'ok'; dati: Dettaglio } | { stato: 'errore' } | { stato: 'non-trovata' })

const nomeCompleto = (p: Persona | null) => (p === null ? null : `${p.nome} ${p.cognome}`.trim() || null)
const pulito = (v: string) => v.trim()
const nonVuoto = (v: string | null): v is string => typeof v === 'string' && v.trim() !== ''

function eDettaglio(v: unknown): v is Dettaglio {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Record<string, unknown>
  const scheda = d.scheda as Record<string, unknown> | null | undefined
  return (
    typeof scheda === 'object' &&
    scheda !== null &&
    typeof scheda.id === 'string' &&
    typeof scheda.scuola_id === 'string' &&
    Array.isArray(d.bambini) &&
    Array.isArray(d.appuntamenti) &&
    Array.isArray(d.eventi) &&
    typeof d.eventi_totale === 'number'
  )
}

async function leggiDettaglio(schedaId: string): Promise<Lettura> {
  const res = await chiama('scheda-dettaglio', `/api/admin/crm/schede/${encodeURIComponent(schedaId)}`)
  if (res === null) return { schedaId, stato: 'errore' }
  if (res.status === 404) return { schedaId, stato: 'non-trovata' }
  if (!res.ok) return { schedaId, stato: 'errore' }
  const json = await leggiJson(res, 'scheda-dettaglio')
  if (!eDettaglio(json)) return { schedaId, stato: 'errore' }
  return { schedaId, stato: 'ok', dati: json }
}

const urlScheda = (schedaId: string) => `/api/admin/crm/schede/${encodeURIComponent(schedaId)}`

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LA SCHERMATA
// ════════════════════════════════════════════════════════════════════════════════════════════════

export function DettaglioScheda({ schedaId, onChiudi }: { schedaId: string; onChiudi: () => void }) {
  const t = useTranslations('crmSchede')
  const [lettura, setLettura] = useState<Lettura | null>(null)
  const [ricarica, setRicarica] = useState(0)

  useEffect(() => {
    let attivo = true
    void leggiDettaglio(schedaId).then((r) => {
      if (attivo) setLettura(r)
    })
    return () => {
      attivo = false
    }
  }, [schedaId, ricarica])

  const rileggi = () => setRicarica((n) => n + 1)
  // Una lettura di un'altra scheda non è la mia: finché non arriva la mia, "carico".
  const corrente = lettura !== null && lettura.schedaId === schedaId ? lettura : null

  return (
    <div className="relative">
      {/* Sul computer la colonna non ha un proprio comando di chiusura; sul telefono ce l'ha il foglio. */}
      <button
        type="button"
        onClick={onChiudi}
        aria-label={t('dettaglioChiudi')}
        className="absolute right-3 top-3 z-10 hidden h-9 w-9 items-center justify-center rounded-pill text-kidville-sub transition-colors hover:bg-kidville-line/40 hover:text-kidville-ink lg:inline-flex"
      >
        <X size={18} aria-hidden="true" />
      </button>

      {corrente === null ? (
        <p role="status" className={`${RIQUADRO} text-center ${TESTO_SECONDARIO}`}>
          {t('dettaglioCaricamento')}
        </p>
      ) : corrente.stato === 'ok' ? (
        <Contenuto dati={corrente.dati} rileggi={rileggi} />
      ) : (
        <div className={`${RIQUADRO} space-y-3 text-center`}>
          <p role="alert" className="font-maven text-sm text-kidville-ink">
            {corrente.stato === 'non-trovata' ? t('dettaglioNonTrovata') : t('dettaglioErrore')}
          </p>
          {corrente.stato === 'errore' && (
            <Btn variant="ghost" size="sm" onClick={rileggi}>
              {t('riprova')}
            </Btn>
          )}
        </div>
      )}
    </div>
  )
}

function Contenuto({ dati, rileggi }: { dati: Dettaglio; rileggi: () => void }) {
  const { scheda, bambini, appuntamenti, eventi, eventi_totale: eventiTotale } = dati
  return (
    <div className="space-y-5">
      <Famiglia scheda={scheda} onSalvata={rileggi} />
      {typeof scheda.domanda_da_associare === 'string' && <AvvisoDomandaDaAssociare scheda={scheda} onAggiornata={rileggi} />}
      <SezioneBambini scheda={scheda} bambini={bambini} rileggi={rileggi} />
      <Visite scuolaId={scheda.scuola_id} schedaId={scheda.id} appuntamenti={appuntamenti} rileggi={rileggi} />
      <AzioniScheda scuolaId={scheda.scuola_id} schedaId={scheda.id} onAggiornata={rileggi} />
      <Registra schedaId={scheda.id} rileggi={rileggi} />
      <Storico eventi={eventi} totale={eventiTotale} bambini={bambini} />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LA FAMIGLIA
// ════════════════════════════════════════════════════════════════════════════════════════════════

function Famiglia({ scheda, onSalvata }: { scheda: SchedaRow; onSalvata: () => void }) {
  const t = useTranslations('crmSchede')
  const tc = useTranslations('crmShell')
  const date = useDateFormat()
  const [modifica, setModifica] = useState(false)

  const telefoni = [scheda.telefono1, scheda.telefono2].filter(nonVuoto)
  const email = [scheda.email1, scheda.email2].filter(nonVuoto)
  const domande = [
    [t('domandaRoutine'), scheda.routine],
    [t('domandaPaura'), scheda.paura],
    [t('domandaDesiderio'), scheda.desiderio],
  ] as const
  const via = scheda.creato_via === 'ai' ? t('viaAi') : t('viaSegreteria')

  return (
    <section aria-label={t('sezioneFamiglia')} className={RIQUADRO}>
      <h2 className="pr-10 font-barlow text-xl font-black uppercase leading-tight text-kidville-green">
        {scheda.genitore_nome ?? t('rigaSenzaNome')}
      </h2>
      <p className={TESTO_SECONDARIO}>
        {via} · {date.dataLunga(scheda.creata_il)}
      </p>

      {modifica ? (
        <ModificaFamiglia
          scheda={scheda}
          onSalvata={() => {
            setModifica(false)
            onSalvata()
          }}
          onAnnulla={() => setModifica(false)}
        />
      ) : (
        <>
          <ul className="mt-3 space-y-2">
            {telefoni.map((numero, i) => {
              const chiamata = linkTelefono(numero)
              const whatsapp = linkWhatsApp(numero)
              return (
                <li key={`tel-${i}`} className="flex flex-wrap items-center gap-2">
                  <Phone size={14} aria-hidden="true" className="shrink-0 text-kidville-sub" />
                  {chiamata !== null ? (
                    <a href={chiamata} className="font-maven text-sm font-semibold text-kidville-green hover:underline">
                      {numero}
                    </a>
                  ) : (
                    <span className="font-maven text-sm text-kidville-ink">{numero}</span>
                  )}
                  {whatsapp !== null && (
                    <a
                      href={whatsapp}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t('whatsappA', { numero })}
                      className={COLLEGAMENTO_PASTIGLIA}
                    >
                      <MessageCircle size={12} aria-hidden="true" />
                      {t('whatsappEtichetta')}
                    </a>
                  )}
                </li>
              )
            })}
            {email.map((indirizzo, i) => (
              <li key={`email-${i}`} className="flex flex-wrap items-center gap-2">
                <Mail size={14} aria-hidden="true" className="shrink-0 text-kidville-sub" />
                {normalizzaEmail(indirizzo) !== null ? (
                  <a href={`mailto:${indirizzo.trim()}`} className="break-all font-maven text-sm font-semibold text-kidville-green hover:underline">
                    {indirizzo}
                  </a>
                ) : (
                  <span className="break-all font-maven text-sm text-kidville-ink">{indirizzo}</span>
                )}
              </li>
            ))}
          </ul>

          <p className={`mt-3 ${TESTO_SECONDARIO}`}>
            {t('famigliaOrigine')}: {(ORIGINI as readonly string[]).includes(scheda.origine) ? etichetta(tc, 'origini', scheda.origine) : scheda.origine}
          </p>

          <dl className="mt-3 space-y-2">
            {domande.map(([domanda, risposta]) => (
              <div key={domanda}>
                <dt className={TESTO_SECONDARIO}>{domanda}</dt>
                <dd className={`font-maven text-sm ${nonVuoto(risposta) ? 'whitespace-pre-wrap text-kidville-ink' : 'text-kidville-sub'}`}>
                  {nonVuoto(risposta) ? risposta : t('domandaVuota')}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-4">
            <Btn variant="ghost" size="sm" onClick={() => setModifica(true)}>
              {t('famigliaModifica')}
            </Btn>
          </div>
        </>
      )}
    </section>
  )
}

/** I soli campi della famiglia che sono cambiati: un salvataggio che non cambia niente non parte. */
const CAMPI_TESTO = [
  ['genitoreNome', 'genitore_nome'],
  ['telefono1', 'telefono1'],
  ['telefono2', 'telefono2'],
  ['email1', 'email1'],
  ['email2', 'email2'],
  ['routine', 'routine'],
  ['paura', 'paura'],
  ['desiderio', 'desiderio'],
] as const

function variazioniFamiglia(scheda: SchedaRow, dati: DatiFamiglia): Record<string, string> {
  const corpo: Record<string, string> = {}
  for (const [campo, colonna] of CAMPI_TESTO) {
    const nuovo = pulito(dati[campo])
    if (nuovo !== (scheda[colonna] ?? '').trim()) corpo[campo] = nuovo
  }
  if (dati.origine !== scheda.origine) corpo.origine = dati.origine
  return corpo
}

function ModificaFamiglia({ scheda, onSalvata, onAnnulla }: { scheda: SchedaRow; onSalvata: () => void; onAnnulla: () => void }) {
  const t = useTranslations('crmSchede')
  const [dati, setDati] = useState<DatiFamiglia>(() => famigliaDaScheda(scheda))
  const [invio, setInvio] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)

  const variazioni = variazioniFamiglia(scheda, dati)
  const cambiata = Object.keys(variazioni).length > 0
  const valido = pulito(dati.genitoreNome) !== '' && contattoValido(dati)

  const salva = async () => {
    if (!cambiata || !valido || invio) return
    setInvio(true)
    setErrore(null)
    const res = await chiama('scheda-modifica', urlScheda(scheda.id), scrittura('PATCH', variazioni))
    if (res === null) {
      setErrore(t('formErrore'))
      setInvio(false)
      return
    }
    if (!res.ok) {
      setErrore(await messaggioErrore(res, t('formErrore')))
      setInvio(false)
      return
    }
    setInvio(false)
    onSalvata()
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void salva()
      }}
      className="mt-4 space-y-4"
    >
      <ModuloFamiglia dati={dati} onCambia={setDati} disabilitato={invio} />
      {!contattoValido(dati) && <p className={TESTO_SECONDARIO}>{t('formContattoServe')}</p>}
      {errore !== null && (
        <p role="alert" className={MESSAGGIO_ERRORE}>
          {errore}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Btn variant="ghost" onClick={onAnnulla} disabled={invio}>
          {t('annulla')}
        </Btn>
        <Btn type="submit" disabled={!cambiata || !valido || invio}>
          {invio ? t('salvataggio') : t('formSalva')}
        </Btn>
      </div>
    </form>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// I BAMBINI
// ════════════════════════════════════════════════════════════════════════════════════════════════

function SezioneBambini({ scheda, bambini, rileggi }: { scheda: SchedaRow; bambini: BambinoRow[]; rileggi: () => void }) {
  const t = useTranslations('crmSchede')
  const id = useId()
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3 id={id} className={TITOLO_SEZIONE}>
        {t('sezioneBambini')}
      </h3>
      {bambini.map((b) => (
        // La chiave porta `aggiornata_il`: dopo un salvataggio la riga cambia e la bozza riparte da ciò
        // che il database ha davvero, senza un effetto che la riallinei.
        <CardBambino key={`${b.id}:${b.aggiornata_il}`} scheda={scheda} bambino={b} rileggi={rileggi} />
      ))}
    </section>
  )
}

function CardBambino({ scheda, bambino: b, rileggi }: { scheda: SchedaRow; bambino: BambinoRow; rileggi: () => void }) {
  const t = useTranslations('crmSchede')
  const tc = useTranslations('crmShell')
  const date = useDateFormat()
  const id = useId()
  const [esito, setEsito] = useState<EsitoBambino>(b.esito)
  const [motivo, setMotivo] = useState<string>(b.motivo_perdita ?? '')
  const [nota, setNota] = useState<string>(b.motivo_nota ?? '')
  const [saldata, setSaldata] = useState<boolean>(b.quota_saldata)
  const [dataSaldo, setDataSaldo] = useState<string>(b.quota_saldata_il ?? '')
  const [invio, setInvio] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)

  // ── Che cosa è cambiato, e quindi che cosa parte ───────────────────────────────────────────────
  const motivoVecchio = b.motivo_perdita ?? ''
  const esitoCambiato = esito !== b.esito
  const motivoCambiato = motivo !== motivoVecchio
  const corpo: Record<string, unknown> = {}
  if (esitoCambiato) corpo.esito = esito
  if (esito === 'perso') {
    if (esitoCambiato || motivoCambiato) corpo.motivoPerdita = motivo
    if (pulito(nota) !== (b.motivo_nota ?? '').trim()) corpo.motivoNota = pulito(nota)
  }
  if (saldata !== b.quota_saldata) corpo.quotaSaldata = saldata
  if (saldata && dataSaldo !== '' && dataSaldo !== (b.quota_saldata_il ?? '')) corpo.quotaSaldataIl = dataSaldo

  const cambiato = Object.keys(corpo).length > 0
  // Il motivo si pretende quando «perso» è una scelta nuova o il motivo lo si sta toccando: un «perso»
  // vecchio, senza motivo, non impedisce di correggere la quota.
  const motivoMancante = esito === 'perso' && motivo === ''
  const valido = !(motivoMancante && (esitoCambiato || motivoCambiato))

  const salva = async () => {
    if (!cambiato || !valido || invio) return
    setInvio(true)
    setErrore(null)
    const res = await chiama('bambino-salva', `${urlScheda(scheda.id)}/bambini/${encodeURIComponent(b.id)}`, scrittura('PATCH', corpo))
    if (res === null) {
      setErrore(t('bambinoErrore'))
      setInvio(false)
      return
    }
    if (!res.ok) {
      setErrore(await messaggioErrore(res, t('bambinoErrore')))
      setInvio(false)
      return
    }
    setInvio(false)
    rileggi()
  }

  const nome = b.nome ?? t('bambinoSenzaNome')
  const meta = [
    b.data_nascita !== null ? t('bambinoNascita', { data: date.dataBreve(b.data_nascita) }) : null,
    t('bambinoAnno', { anno: (ANNI_INGRESSO as readonly string[]).includes(b.anno_ingresso) ? etichetta(tc, 'anniIngresso', b.anno_ingresso) : b.anno_ingresso }),
    b.esito_origine === 'automatico' ? t('esitoOrigineAutomatico') : b.esito_origine === 'manuale' ? t('esitoOrigineManuale') : null,
  ].filter((v): v is string => v !== null)

  return (
    <article aria-labelledby={`${id}-nome`} className={`${RIQUADRO} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={`${id}-nome`} className="font-barlow text-base font-extrabold uppercase text-kidville-ink">
          {nome}
        </h4>
        <Badge tone={TONO_ESITO[b.esito]}>{etichetta(tc, 'esiti', b.esito)}</Badge>
        <BadgeCollegamento bambino={b} />
      </div>
      <p className={TESTO_SECONDARIO}>{meta.join(' · ')}</p>

      <AssociaDomanda scuolaId={scheda.scuola_id} schedaId={scheda.id} bambino={b} onCollegato={rileggi} />

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void salva()
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-esito`} className={ETICHETTA_CAMPO_FILTRO}>
              {t('bambinoEsito')}
            </label>
            <select id={`${id}-esito`} value={esito} disabled={invio} onChange={(e) => setEsito(e.target.value as EsitoBambino)} className={CAMPO}>
              {ESITI_BAMBINO.map((v) => (
                <option key={v} value={v}>
                  {etichetta(tc, 'esiti', v)}
                </option>
              ))}
            </select>
          </div>
          {esito === 'perso' && (
            <div>
              <label htmlFor={`${id}-motivo`} className={ETICHETTA_CAMPO_FILTRO}>
                {t('bambinoMotivo')}
              </label>
              <select
                id={`${id}-motivo`}
                value={motivo}
                disabled={invio}
                aria-describedby={motivoMancante ? `${id}-serve` : undefined}
                onChange={(e) => setMotivo(e.target.value)}
                className={CAMPO}
              >
                <option value="">{t('bambinoMotivoScegli')}</option>
                {MOTIVI_PERDITA.map((m) => (
                  <option key={m} value={m}>
                    {etichetta(tc, 'motiviPerdita', m)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {esito === 'perso' && (
          <>
            {motivoMancante && (
              <p id={`${id}-serve`} className={TESTO_SECONDARIO}>
                {t('bambinoMotivoServe')}
              </p>
            )}
            <div>
              <label htmlFor={`${id}-nota`} className={ETICHETTA_CAMPO_FILTRO}>
                {t('bambinoMotivoNota')}
              </label>
              <textarea id={`${id}-nota`} rows={2} maxLength={500} value={nota} disabled={invio} onChange={(e) => setNota(e.target.value)} className={AREA} />
            </div>
          </>
        )}

        <div className="flex flex-wrap items-end gap-4">
          <label className="inline-flex min-h-11 items-center gap-2 font-maven text-sm text-kidville-ink">
            <input
              type="checkbox"
              checked={saldata}
              disabled={invio}
              onChange={(e) => setSaldata(e.target.checked)}
              className="h-5 w-5 rounded border-kidville-line accent-kidville-green"
            />
            {t('bambinoQuota')}
          </label>
          {saldata && (
            <div className="w-40">
              <label htmlFor={`${id}-data-saldo`} className={ETICHETTA_CAMPO_FILTRO}>
                {t('bambinoQuotaData')}
              </label>
              <DateField
                id={`${id}-data-saldo`}
                value={dataSaldo}
                onChange={setDataSaldo}
                disabled={invio}
                aria-describedby={`${id}-data-saldo-aiuto`}
                className={CAMPO}
              />
              <p id={`${id}-data-saldo-aiuto`} className={`mt-1 ${TESTO_SECONDARIO}`}>
                {t('bambinoQuotaOggi')}
              </p>
            </div>
          )}
        </div>

        {errore !== null && (
          <p role="alert" className={MESSAGGIO_ERRORE}>
            {errore}
          </p>
        )}
        <div className="flex justify-end">
          <Btn type="submit" size="sm" disabled={!cambiato || !valido || invio}>
            {invio ? t('salvataggio') : t('salva')}
          </Btn>
        </div>
      </form>
    </article>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LE VISITE
// ════════════════════════════════════════════════════════════════════════════════════════════════

const TONO_STATO_VISITA: Record<StatoAppuntamento, BadgeTone> = {
  in_programma: 'info',
  svolto: 'success',
  non_presentato: 'warn',
  annullato: 'neutral',
}

function Visite({
  scuolaId,
  schedaId,
  appuntamenti,
  rileggi,
}: {
  scuolaId: string
  schedaId: string
  appuntamenti: AppuntamentoDettaglio[]
  rileggi: () => void
}) {
  const t = useTranslations('crmSchede')
  const tc = useTranslations('crmShell')
  const date = useDateFormat()
  const id = useId()
  // Aperto = c'è il modulo di FissaVisita: nuovo (nessun appuntamento) o per spostarne uno.
  const [aperto, setAperto] = useState<{ appuntamento?: AppuntamentoRow } | null>(null)

  return (
    <section aria-labelledby={id} className={`${RIQUADRO} space-y-3`}>
      <div className="flex items-center justify-between gap-2">
        <h3 id={id} className={TITOLO_SEZIONE}>
          {t('sezioneVisite')}
        </h3>
        {aperto === null && (
          <Btn variant="ghost" size="sm" onClick={() => setAperto({})}>
            {t('visiteFissa')}
          </Btn>
        )}
      </div>

      {appuntamenti.length === 0 ? (
        <p className={TESTO_SECONDARIO}>{t('visiteNessuna')}</p>
      ) : (
        <ul className="space-y-2">
          {appuntamenti.map((a) => {
            const con = nomeCompleto(a.svolto_da_persona) ?? nomeCompleto(a.assegnata_a_persona)
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="font-maven text-sm font-semibold text-kidville-ink">{date.dataOra(a.inizio)}</span>
                <Badge tone={TONO_STATO_VISITA[a.stato] ?? 'neutral'}>{etichetta(tc, 'statiAppuntamento', a.stato)}</Badge>
                {con !== null && <span className={TESTO_SECONDARIO}>{t('visiteCon', { nome: con })}</span>}
                {a.stato === 'in_programma' && aperto === null && (
                  <Btn variant="ghost" size="sm" onClick={() => setAperto({ appuntamento: a })}>
                    {t('visiteSposta')}
                  </Btn>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {aperto !== null && (
        <FissaVisita
          scuolaId={scuolaId}
          schedaId={schedaId}
          appuntamento={aperto.appuntamento}
          onFatto={() => {
            setAperto(null)
            rileggi()
          }}
          onAnnulla={() => setAperto(null)}
        />
      )}
    </section>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// UNA NOTA O UNA TELEFONATA
// ════════════════════════════════════════════════════════════════════════════════════════════════

type TipoRegistrabile = 'nota' | 'telefonata'

function Registra({ schedaId, rileggi }: { schedaId: string; rileggi: () => void }) {
  const t = useTranslations('crmSchede')
  const id = useId()
  const [tipo, setTipo] = useState<TipoRegistrabile>('nota')
  const [testo, setTesto] = useState('')
  const [invio, setInvio] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)

  const pronto = pulito(testo) !== ''

  const aggiungi = async () => {
    if (!pronto || invio) return
    setInvio(true)
    setErrore(null)
    const res = await chiama('scheda-evento', `${urlScheda(schedaId)}/eventi`, scrittura('POST', { tipo, testo: pulito(testo) }))
    if (res === null) {
      setErrore(t('notaErrore'))
      setInvio(false)
      return
    }
    if (!res.ok) {
      setErrore(await messaggioErrore(res, t('notaErrore')))
      setInvio(false)
      return
    }
    // Il campo si svuota: la stessa nota non parte due volte.
    setTesto('')
    setInvio(false)
    rileggi()
  }

  return (
    <section aria-labelledby={`${id}-titolo`} className={RIQUADRO}>
      <h3 id={`${id}-titolo`} className={TITOLO_SEZIONE}>
        {t('sezioneNota')}
      </h3>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void aggiungi()
        }}
        className="mt-3 space-y-3"
      >
        <div>
          <label htmlFor={`${id}-tipo`} className={ETICHETTA_CAMPO_FILTRO}>
            {t('notaTipo')}
          </label>
          <select id={`${id}-tipo`} value={tipo} disabled={invio} onChange={(e) => setTipo(e.target.value as TipoRegistrabile)} className={CAMPO}>
            <option value="nota">{t('notaTipoNota')}</option>
            <option value="telefonata">{t('notaTipoTelefonata')}</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-testo`} className={ETICHETTA_CAMPO_FILTRO}>
            {t('notaTesto')}
          </label>
          <textarea
            id={`${id}-testo`}
            rows={3}
            maxLength={2000}
            value={testo}
            disabled={invio}
            placeholder={t('notaSegnaposto')}
            onChange={(e) => setTesto(e.target.value)}
            className={AREA}
          />
        </div>
        {errore !== null && (
          <p role="alert" className={MESSAGGIO_ERRORE}>
            {errore}
          </p>
        )}
        <div className="flex justify-end">
          <Btn type="submit" size="sm" disabled={!pronto || invio}>
            {invio ? t('salvataggio') : t('notaAggiungi')}
          </Btn>
        </div>
      </form>
    </section>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// LO STORICO
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Il nome di una colonna modificata, nella lingua della pagina. Una colonna sconosciuta non si dice. */
function nomeCampo(t: Traduttore, colonna: string): string | null {
  switch (colonna) {
    case 'genitore_nome':
      return t('campoGenitoreNome')
    case 'telefono1':
      return t('campoTelefono1')
    case 'telefono2':
      return t('campoTelefono2')
    case 'email1':
      return t('campoEmail1')
    case 'email2':
      return t('campoEmail2')
    case 'origine':
      return t('campoOrigine')
    case 'routine':
      return t('campoRoutine')
    case 'paura':
      return t('campoPaura')
    case 'desiderio':
      return t('campoDesiderio')
    case 'nome':
      return t('campoNome')
    case 'data_nascita':
      return t('campoDataNascita')
    case 'anno_ingresso':
      return t('campoAnnoIngresso')
    case 'motivo_perdita':
      return t('campoMotivoPerdita')
    case 'motivo_nota':
      return t('campoMotivoNota')
    default:
      return null
  }
}

/**
 * La riga di dettaglio di un evento, a partire dai suoi `dati`. Nello storico entrano nomi di CAMPI e
 * id (mai valori: sono recapiti e parole di famiglie), quindi qui si ricompone solo ciò che si può dire
 * senza rileggere un valore: il bambino (dal suo id), l'esito di prima e di dopo, i nomi dei campi.
 */
function dettaglioEvento(e: EventoDettaglio, nomiBambini: Map<string, string>, t: Traduttore, tc: Traduttore): string | null {
  const dati = e.dati ?? {}
  const nome = (typeof dati.bambino_id === 'string' ? nomiBambini.get(dati.bambino_id) : undefined) ?? t('eventoBambinoSconosciuto')
  const esito = (v: unknown) => (typeof v === 'string' && (ESITI_BAMBINO as readonly string[]).includes(v) ? etichetta(tc, 'esiti', v) : '—')

  if (e.tipo === 'esito_cambiato') return t('eventoEsito', { nome, da: esito(dati.da), a: esito(dati.a) })
  if (e.tipo === 'quota_segnata') return t(dati.saldata === true ? 'eventoQuotaSaldata' : 'eventoQuotaTolta', { nome })
  if (e.tipo === 'modificata' || e.tipo === 'bambino_modificato') {
    const campi = typeof dati.campi === 'string' ? dati.campi.split(',').map((c) => nomeCampo(t, c.trim())) : []
    const noti = campi.filter((c): c is string => c !== null)
    return noti.length > 0 ? t('eventoCampi', { campi: noti.join(', ') }) : null
  }
  return null
}

function Storico({ eventi, totale, bambini }: { eventi: EventoDettaglio[]; totale: number; bambini: BambinoRow[] }) {
  const t = useTranslations('crmSchede')
  const tc = useTranslations('crmShell')
  const date = useDateFormat()
  const id = useId()
  const nomiBambini = new Map(bambini.map((b) => [b.id, b.nome ?? t('bambinoSenzaNome')]))

  const autore = (e: EventoDettaglio): string =>
    nomeCompleto(e.autore_persona) ?? (e.autore_via === 'ai' ? t('autoreAi') : e.autore_via === 'sistema' ? t('autoreSistema') : t('autoreSegreteria'))

  return (
    <section aria-labelledby={id} className={RIQUADRO}>
      <h3 id={id} className={TITOLO_SEZIONE}>
        {t('sezioneStorico')}
      </h3>
      {eventi.length === 0 ? (
        <p className={`mt-3 ${TESTO_SECONDARIO}`}>{t('storicoVuoto')}</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {eventi.map((e) => {
            const dettaglio = dettaglioEvento(e, nomiBambini, t, tc)
            return (
              <li key={e.id} className="border-l-2 border-kidville-line pl-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-barlow text-[13px] font-extrabold uppercase text-kidville-ink">
                    {(TIPI_EVENTO as readonly string[]).includes(e.tipo) ? etichetta(tc, 'tipiEvento', e.tipo) : e.tipo}
                  </span>
                  <time dateTime={e.creato_il} className={TESTO_SECONDARIO}>
                    {date.dataOra(e.creato_il)}
                  </time>
                </div>
                {nonVuoto(e.testo) && <p className="mt-0.5 whitespace-pre-wrap font-maven text-sm text-kidville-ink">{e.testo}</p>}
                {dettaglio !== null && <p className="mt-0.5 font-maven text-sm text-kidville-ink">{dettaglio}</p>}
                <p className={TESTO_SECONDARIO}>{autore(e)}</p>
              </li>
            )
          })}
        </ol>
      )}
      {totale > eventi.length && <p className={`mt-3 ${TESTO_SECONDARIO}`}>{t('storicoParziale', { mostrati: eventi.length, totale })}</p>}
    </section>
  )
}
