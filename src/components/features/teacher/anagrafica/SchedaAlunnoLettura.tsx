'use client'

import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, GraduationCap, HeartPulse, House, IdCard, ShieldCheck, TriangleAlert, UserCheck, Users } from 'lucide-react'
import { PageHeaderCard } from '@/components/ui/PageHeaderCard'
import { Badge } from '@/components/ui/Badge'
import { allergeneEmoji, useAllergeneLabel } from '@/lib/mensa/allergeni'
import { isoToIt } from '@/lib/format/data'
import { logClient } from '@/lib/logging/client'
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
  | { tipo: 'negata' | 'nonTrovata' | 'errore' | 'offline' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROTTA = '/teacher/alunni/[id]'

export function SchedaAlunnoLettura({ alunnoId }: { alunnoId: string }) {
  const t = useTranslations('teacherServizi')
  const router = useRouter()
  const etichettaAllergene = useAllergeneLabel()
  const idValido = UUID.test(alunnoId)
  const [esito, setEsito] = useState<Esito>({ tipo: 'caricamento' })

  const carica = useCallback(async () => {
    // Il fallimento della rete è un VALORE, non un `catch` che scrive lo stato:
    // `react-hooks/set-state-in-effect` vuole ogni `setState` dopo un `await`.
    // ⚠️ E vuole anche il `try/finally` attorno (misurato il 2026-10-04): senza, la
    // regola è rossa perfino con un solo `setEsito` dopo l'`await`. È la forma che
    // l'analisi riconosce, la stessa di `parent/profilo` (`controllaBio`).
    try {
      const res = await fetch(`/api/teacher/alunni/${encodeURIComponent(alunnoId)}`, { cache: 'no-store' }).catch(() => null)
      if (!res) {
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false
        setEsito({ tipo: offline ? 'offline' : 'errore' })
        if (!offline) logClient({ livello: 'error', evento: 'fetch', messaggio: 'scheda anagrafica non raggiunta', route: ROTTA })
        return
      }
      // 403 e 404 sono risposte di merito: il server le ha già registrate.
      if (res.status === 403) return setEsito({ tipo: 'negata' })
      if (res.status === 404) return setEsito({ tipo: 'nonTrovata' })
      const corpo = res.ok ? ((await res.json().catch(() => null)) as SchedaAlunnoDocente | null) : null
      if (!corpo || typeof corpo.id !== 'string') {
        setEsito({ tipo: 'errore' })
        logClient({ livello: 'warn', evento: 'fetch', messaggio: 'scheda anagrafica non letta', route: ROTTA, stato: res.status })
        return
      }
      setEsito({ tipo: 'pronta', scheda: corpo })
    } finally {
      // nessuna azione: il blocco esiste solo perché la regola riconosca il confine async
    }
  }, [alunnoId])

  useEffect(() => {
    if (idValido) void carica()
  }, [carica, idValido])

  const riprova = () => {
    setEsito({ tipo: 'caricamento' })
    void carica()
  }

  // In avanti verso l'elenco, ma con i filtri che c'erano (il tasto indietro del
  // telefono li ritrova da solo; questo pulsante no, senza l'appunto).
  const tornaAllElenco = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    router.push(`/teacher/alunni${leggiRitornoElenco()}`)
  }

  const indietro = (
    <Link
      href="/teacher/alunni"
      onClick={tornaAllElenco}
      className="inline-flex min-h-[44px] items-center gap-1.5 font-maven text-sm font-semibold text-kidville-green hover:underline"
    >
      <ArrowLeft size={16} aria-hidden="true" />
      {t('anagraficaIndietro')}
    </Link>
  )

  const stato: Esito = idValido ? esito : { tipo: 'nonTrovata' }

  if (stato.tipo !== 'pronta') {
    const messaggio =
      stato.tipo === 'negata'
        ? t('anagraficaErroreNegato')
        : stato.tipo === 'nonTrovata'
          ? t('anagraficaErroreNonTrovata')
          : stato.tipo === 'offline'
            ? t('anagraficaErroreOffline')
            : stato.tipo === 'errore'
              ? t('anagraficaErroreLettura')
              : null
    return (
      <div className="space-y-4">
        {indietro}
        <PageHeaderCard eyebrow={t('anagraficaTitolo')} icon={IdCard} title={t('anagraficaSchedaTitolo')} compatta />
        {stato.tipo === 'caricamento' ? (
          <div role="status" className="flex items-center justify-center gap-3 py-12">
            <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" />
            <p className="font-maven text-sm text-kidville-sub">{t('anagraficaCaricamento')}</p>
          </div>
        ) : (
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
          </div>
        )}
      </div>
    )
  }

  const s = stato.scheda
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
  const chipAllergie = (
    <ul className="flex flex-wrap gap-1.5">
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
    <div data-testid="scheda-alunno" className="space-y-4">
      {indietro}
      <PageHeaderCard
        eyebrow={t('anagraficaTitolo')}
        icon={IdCard}
        title={`${s.cognome} ${s.nome}`}
        subtitle={s.sezione?.nome}
        badge={<Badge tone="neutral">{t('anagraficaSolaLettura')}</Badge>}
        compatta
      />

      {s.salute.haAllergie && (
        <div role="note" aria-label={t('anagraficaAvvisoAllergie')} className="rounded-card border-2 border-kidville-error bg-kidville-error-soft p-4">
          <p className="mb-2 flex items-center gap-2 font-barlow text-sm font-extrabold uppercase text-kidville-ink">
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

      <RiquadroScheda titolo={t('anagraficaRiquadroDelegati')} icona={UserCheck}>
        {s.delegati.length === 0 ? (
          <p className="py-2 font-maven text-sm italic text-kidville-sub">{t('anagraficaNessunDelegato')}</p>
        ) : (
          <dl className="divide-y divide-kidville-line">
            {s.delegati.map((d, i) => (
              <CampoLettura
                key={`${i}-${d.cognome}-${d.nome}`}
                etichetta={`${d.cognome} ${d.nome}`}
                valore={d.parentela}
                nonIndicato={nonIndicato}
              />
            ))}
          </dl>
        )}
      </RiquadroScheda>

      <p className="pb-2 text-center font-maven text-xs text-kidville-sub">{t('anagraficaCorrezione')}</p>
    </div>
  )
}
