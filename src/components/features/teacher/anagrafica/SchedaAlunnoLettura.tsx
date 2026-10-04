'use client'

import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, GraduationCap, HeartPulse, House, IdCard, ShieldCheck, TriangleAlert, UserCheck, Users } from 'lucide-react'
import { PageHeaderCard } from '@/components/ui/PageHeaderCard'
import { Badge } from '@/components/ui/Badge'
import { allergeneEmoji, useAllergeneLabel } from '@/lib/mensa/allergeni'
import { isoToIt } from '@/lib/format/data'
import { logClient } from '@/lib/logging/client'
import { zUuid } from '@/lib/validation/common'
import { cx } from '@/lib/ui/cx'
import { leggiRitornoElenco } from '@/lib/anagrafiche/docente/ritorno-elenco'
import type { SchedaAlunnoDocente } from '@/lib/anagrafiche/docente/tipi'
import { CampoLettura } from './CampoLettura'
import { RiquadroScheda } from './RiquadroScheda'
import { SchedaGenitore } from './SchedaGenitore'

/**
 * LA SCHEDA ANAGRAFICA, IN SOLA LETTURA.
 *
 * Qui non c'è nessun campo modificabile e nessun salvataggio: la route esporta solo
 * `GET`, e un test verifica che nel DOM non compaia un `input`. I dati non si salvano
 * sul telefono (né service worker né Dexie): senza rete la scheda non si apre, e lo
 * dice.
 */

type Esito =
  | { tipo: 'caricamento' }
  | { tipo: 'pronta'; scheda: SchedaAlunnoDocente }
  | { tipo: 'negata' | 'nonTrovata' | 'sessione' | 'errore' | 'offline' }

const ROTTA = '/teacher/alunni/[id]'

/** Legge la scheda e la traduce in un esito. Nessuno stato React qui dentro: è una funzione del modulo. */
async function leggiScheda(alunnoId: string): Promise<Esito> {
  // Il fallimento della rete è un VALORE (`null`), non un'eccezione da rincorrere.
  const res = await fetch(`/api/teacher/alunni/${encodeURIComponent(alunnoId)}`, { cache: 'no-store' }).catch(() => null)
  if (!res) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false
    if (!offline) logClient({ livello: 'error', evento: 'fetch', messaggio: 'scheda anagrafica non raggiunta', route: ROTTA })
    return { tipo: offline ? 'offline' : 'errore' }
  }
  // 401, 403 e 404 sono risposte di merito: il server le ha già registrate.
  if (res.status === 401) return { tipo: 'sessione' }
  if (res.status === 403) return { tipo: 'negata' }
  if (res.status === 404) return { tipo: 'nonTrovata' }
  const corpo = res.ok ? ((await res.json().catch(() => null)) as SchedaAlunnoDocente | null) : null
  if (!corpo || typeof corpo.id !== 'string') {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: 'scheda anagrafica non letta', route: ROTTA, stato: res.status })
    return { tipo: 'errore' }
  }
  return { tipo: 'pronta', scheda: corpo }
}

export function SchedaAlunnoLettura({ alunnoId }: { alunnoId: string }) {
  const t = useTranslations('teacherServizi')
  const router = useRouter()
  // Lo stesso criterio della route (`zUuid`): un id che il server rifiuterebbe non parte.
  const idValido = zUuid.safeParse(alunnoId).success
  const annunciRef = useRef<HTMLDivElement>(null)

  // Lo stato porta con sé l'id a cui si riferisce: se `alunnoId` cambia, la scheda
  // vecchia non resta a schermo (si torna a «caricamento» per derivazione).
  const [letto, setLetto] = useState<{ id: string; esito: Esito } | null>(null)
  const [tentativo, setTentativo] = useState(0)

  useEffect(() => {
    if (!idValido) return
    let vivo = true
    // Il `setState` sta nel `.then`, mai nel corpo dell'effetto: è la forma che
    // `react-hooks/set-state-in-effect` accetta (come in `parent/primaria/valutazioni`).
    void leggiScheda(alunnoId).then((esito) => {
      if (vivo) setLetto({ id: alunnoId, esito })
    })
    return () => {
      vivo = false
    }
  }, [alunnoId, idValido, tentativo])

  const riprova = () => {
    setLetto(null)
    setTentativo((n) => n + 1)
    // Il pulsante sta per sparire: il fuoco va sulla regione che annuncerà l'esito,
    // non su `<body>` (WCAG 2.4.3).
    annunciRef.current?.focus()
  }

  // In avanti verso l'elenco, ma con i filtri che c'erano (il tasto indietro del
  // telefono li ritrova da solo; questo pulsante no, senza l'appunto). Un clic con un
  // modificatore o col tasto centrale resta al browser: apre l'elenco in un'altra scheda.
  const tornaAllElenco = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    router.push(`/teacher/alunni${leggiRitornoElenco()}`)
  }

  const stato: Esito = !idValido
    ? { tipo: 'nonTrovata' }
    : letto?.id === alunnoId
      ? letto.esito
      : { tipo: 'caricamento' }
  const scheda = stato.tipo === 'pronta' ? stato.scheda : null

  const messaggio =
    stato.tipo === 'negata'
      ? t('anagraficaErroreNegato')
      : stato.tipo === 'nonTrovata'
        ? t('anagraficaErroreNonTrovata')
        : stato.tipo === 'sessione'
          ? t('anagraficaErroreSessione')
          : stato.tipo === 'offline'
            ? t('anagraficaErroreOffline')
            : stato.tipo === 'errore'
              ? t('anagraficaErroreLettura')
              : null

  return (
    <div data-testid={scheda ? 'scheda-alunno' : undefined} className="space-y-4">
      {/* Fisso sotto l'AppBar, come il ritorno della `ClasseShell`: la freccia dell'AppBar
          qui non c'è, su iOS nativo non c'è il tasto fisico, e su una scheda lunga
          bisognerebbe risalire in cima per uscire. Lo sfondo è quello della pagina. */}
      <Link
        href="/teacher/alunni"
        onClick={tornaAllElenco}
        className="sticky top-[var(--kv-appbar-h,0px)] z-20 flex min-h-[44px] items-center gap-1.5 bg-kidville-cream font-maven text-sm font-semibold text-kidville-green hover:underline"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        {t('anagraficaIndietro')}
      </Link>

      {scheda ? (
        <PageHeaderCard
          eyebrow={t('anagraficaTitolo')}
          icon={IdCard}
          title={`${scheda.cognome} ${scheda.nome}`}
          subtitle={scheda.sezione?.nome}
          badge={<Badge tone="neutral">{t('anagraficaSolaLettura')}</Badge>}
          compatta
        />
      ) : (
        <PageHeaderCard eyebrow={t('anagraficaTitolo')} icon={IdCard} title={t('anagraficaSchedaTitolo')} compatta />
      )}

      {/* Sempre montata, così caricamento ed esiti vengono annunciati quando cambiano. */}
      {/* A scheda pronta `sr-only` e non `hidden`: dopo «Riprova» il fuoco sta qui, e un `display:none` lo farebbe cadere su `<body>`. */}
      {/* L'anello di fuoco lo disegna la regola globale `:focus-visible` di `globals.css`. */}
      <div ref={annunciRef} tabIndex={-1} aria-live="polite" className={cx('rounded-card', scheda && 'sr-only')}>
        {stato.tipo === 'caricamento' ? (
          <div className="flex items-center justify-center gap-3 py-12">
            <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
            <p className="font-maven text-sm text-kidville-sub">{t('anagraficaCaricamento')}</p>
          </div>
        ) : stato.tipo !== 'pronta' ? (
          <div data-testid="scheda-esito" data-esito={stato.tipo} className="flex flex-col items-center gap-3 py-12 text-center">
            <TriangleAlert size={34} aria-hidden="true" className="text-kidville-error-strong" />
            <p className="max-w-md font-maven text-sm text-kidville-ink">{messaggio}</p>
            {(stato.tipo === 'errore' || stato.tipo === 'offline') && (
              <button
                type="button"
                onClick={riprova}
                className="inline-flex min-h-[44px] items-center rounded-pill border border-kidville-line px-4 font-maven text-sm font-semibold text-kidville-ink/80 hover:border-kidville-green"
              >
                {t('anagraficaRiprova')}
              </button>
            )}
            {stato.tipo === 'sessione' && (
              // Navigazione piena e non `Link`: il login riparte da zero, senza lo stato della sessione scaduta.
              <a
                href="/auth/login"
                className="inline-flex min-h-[44px] items-center rounded-pill bg-kidville-green px-4 font-maven text-sm font-semibold text-white"
              >
                {t('anagraficaAccedi')}
              </a>
            )}
          </div>
        ) : null}
      </div>

      {scheda && <CorpoScheda s={scheda} />}
    </div>
  )
}

/** I riquadri della scheda pronta. */
function CorpoScheda({ s }: { s: SchedaAlunnoDocente }) {
  const t = useTranslations('teacherServizi')
  const etichettaAllergene = useAllergeneLabel()
  const idTitoloAllergie = useId()
  const nonIndicato = t('anagraficaNonIndicato')
  const siNo = (v: boolean | null) => (v === null ? null : v ? t('anagraficaSi') : t('anagraficaNo'))
  const data = (v: string | null) => (v ? isoToIt(v) : null)
  const conProvincia = (comune: string | null, provincia: string | null) =>
    comune && provincia ? `${comune} (${provincia})` : (comune ?? provincia)
  const luogo = [conProvincia(s.luogoNascita.comune, s.luogoNascita.provincia), s.luogoNascita.nazione].filter(Boolean).join(', ')
  const indirizzo = [s.residenza.indirizzo, s.residenza.civico].filter(Boolean).join(', ')
  const sesso = s.sesso === 'M' ? t('anagraficaSessoM') : s.sesso === 'F' ? t('anagraficaSessoF') : null
  const grado =
    s.sezione?.grado === 'nido'
      ? t('anagraficaGradoNido')
      : s.sezione?.grado === 'infanzia'
        ? t('anagraficaGradoInfanzia')
        : s.sezione?.grado === 'primaria'
          ? t('anagraficaGradoPrimaria')
          : null
  // `role="list"`: con `list-style: none` Safari toglie all'`ul` la semantica di elenco.
  const chipAllergie = (
    <ul role="list" className="flex flex-wrap gap-1.5">
      {s.salute.allergeni.map((k) => (
        <li key={k} className="inline-flex items-center gap-1 rounded-pill bg-kidville-error-soft px-2.5 py-1 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-ink">
          <span aria-hidden="true">{allergeneEmoji(k)}</span> {etichettaAllergene(k)}
        </li>
      ))}
      {s.salute.allergieAltro && (
        <li className="inline-flex items-center rounded-pill bg-kidville-cream-dark px-2.5 py-1 font-barlow text-xs font-extrabold uppercase tracking-wide text-kidville-ink">
          {s.salute.allergieAltro}
        </li>
      )}
    </ul>
  )

  return (
    <>
      {s.salute.haAllergie && (
        <div role="note" aria-labelledby={idTitoloAllergie} className="rounded-card border-2 border-kidville-error bg-kidville-error-soft p-4">
          <p id={idTitoloAllergie} className="mb-2 flex items-center gap-2 font-barlow text-sm font-extrabold uppercase text-kidville-ink">
            <TriangleAlert size={18} aria-hidden="true" className="text-kidville-error-strong" />
            {t('anagraficaAvvisoAllergie')}
          </p>
          {chipAllergie}
        </div>
      )}

      <RiquadroScheda titolo={t('anagraficaRiquadroDati')} icona={IdCard}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura etichetta={t('anagraficaCampoSesso')} valore={sesso} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoDataNascita')} valore={data(s.dataNascita)} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoLuogoNascita')} valore={luogo} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoCittadinanza')} valore={s.cittadinanza} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoCodiceFiscale')} valore={s.codiceFiscale} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroResidenza')} icona={House}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura etichetta={t('anagraficaCampoIndirizzo')} valore={indirizzo} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoCap')} valore={s.residenza.cap} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoComune')} valore={conProvincia(s.residenza.comune, s.residenza.provincia)} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroClasse')} icona={GraduationCap}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura etichetta={t('anagraficaCampoSezione')} valore={s.sezione?.nome} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoGrado')} valore={grado} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoDataIscrizione')} valore={data(s.dataIscrizione)} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroSalute')} icona={HeartPulse}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura
            etichetta={t('anagraficaCampoAllergie')}
            valore={s.salute.haAllergie ? chipAllergie : t('anagraficaNessunaAllergia')}
            nonIndicato={nonIndicato}
          />
          <CampoLettura etichetta={t('anagraficaCampoNoteMediche')} valore={s.salute.noteMediche} nonIndicato={nonIndicato} aCapo />
          <CampoLettura etichetta={t('anagraficaCampoBes')} valore={siNo(s.salute.besDsa)} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoPannolino')} valore={siNo(s.salute.usaPannolino)} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroConsensi')} icona={ShieldCheck}>
        <dl className="divide-y divide-kidville-line">
          <CampoLettura etichetta={t('anagraficaCampoConsensoPrivacy')} valore={siNo(s.consensi.privacy)} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoConsensoFotoSito')} valore={siNo(s.consensi.fotoSito)} nonIndicato={nonIndicato} />
          <CampoLettura etichetta={t('anagraficaCampoConsensoFotoSocial')} valore={siNo(s.consensi.fotoSocial)} nonIndicato={nonIndicato} />
        </dl>
      </RiquadroScheda>

      <RiquadroScheda titolo={t('anagraficaRiquadroFamiglia')} icona={Users}>
        {s.genitori.length === 0 ? (
          <p className="py-2 font-maven text-sm italic text-kidville-sub">{t('anagraficaNessunGenitore')}</p>
        ) : (
          <div className="space-y-3">
            {s.genitori.map((g, i) => (
              <SchedaGenitore key={`${i}-${g.cognome}-${g.nome}`} genitore={g} />
            ))}
          </div>
        )}
      </RiquadroScheda>

      {/* Al ritiro si controlla il NOME: è lui in evidenza, la parentela sotto in piccolo. */}
      <RiquadroScheda titolo={t('anagraficaRiquadroDelegati')} icona={UserCheck}>
        {s.delegati.length === 0 ? (
          <p className="py-2 font-maven text-sm italic text-kidville-sub">{t('anagraficaNessunDelegato')}</p>
        ) : (
          <ul role="list" className="divide-y divide-kidville-line">
            {s.delegati.map((d, i) => (
              <li key={`${i}-${d.cognome}-${d.nome}`} className="py-2.5">
                <p className="font-maven text-sm font-semibold text-kidville-ink">{`${d.cognome} ${d.nome}`}</p>
                {d.parentela && <p className="font-maven text-xs text-kidville-sub">{d.parentela}</p>}
              </li>
            ))}
          </ul>
        )}
      </RiquadroScheda>

      <p className="pb-2 text-center font-maven text-xs text-kidville-sub">{t('anagraficaCorrezione')}</p>
    </>
  )
}
