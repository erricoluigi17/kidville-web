'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CircleCheck, CircleX, Clock, LogOut, CircleHelp } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import type { StatoPresenza } from '@/lib/primaria/oreAssenza'

interface OggiPresenza {
  stato: StatoPresenza | null
  orario_entrata: string | null
  orario_uscita: string | null
}

interface Riepilogo {
  presenze: number
  assenze: number
  ritardi: number
  uscite: number
  ore?: { oreTotali: number }
}

interface PresenzeData {
  schoolType: string | null
  oggi: OggiPresenza
  riepilogo: Riepilogo
}

interface Props {
  studentId: string
  parentId: string
}

// Presentazione dello stato di oggi (icona + stili). `null` = appello non ancora
// registrato. Le etichette testuali (label/pillText) sono i18n: si risolvono a
// runtime da `presenzeStato_<stato>` / `presenzePill_<stato>`.
const STATI = {
  presente: {
    Icon: CircleCheck,
    badge: 'bg-kidville-green-soft text-kidville-green',
    pill: 'bg-kidville-success text-white',
  },
  assente: {
    Icon: CircleX,
    badge: 'bg-kidville-error-soft text-kidville-error',
    pill: 'bg-kidville-error text-white',
  },
  ritardo: {
    Icon: Clock,
    badge: 'bg-kidville-warn-soft text-kidville-warn',
    pill: 'bg-kidville-warn text-white',
  },
  uscita_anticipata: {
    Icon: LogOut,
    badge: 'bg-kidville-warn-soft text-kidville-warn',
    pill: 'bg-kidville-warn text-white',
  },
} as const

// Ora 'HH:MM:SS' → 'HH:MM' (tollerante a null / formati corti).
function hhmm(v: string | null): string {
  return v ? v.slice(0, 5) : ''
}

/**
 * Riquadro "Oggi a scuola" della home genitore (DR home cards): presenza reale
 * del figlio per la giornata + riepilogo degli ultimi 30 giorni.
 *
 * Sola lettura: GET /api/parent/presenze?studentId=&userId= →
 * { oggi: { stato, orario_entrata, orario_uscita }, riepilogo: { presenze… } }.
 * Se l'appello di oggi non è ancora stato registrato dal docente lo stato è
 * `null` e mostriamo un messaggio neutro (nessun allarme).
 */
export function PresenzeTodayCard({ studentId, parentId }: Props) {
  const t = useTranslations('home')
  const [data, setData] = useState<PresenzeData | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!studentId || !parentId) return
    let active = true
    fetch(`/api/parent/presenze?studentId=${studentId}&userId=${parentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d?.success) setData(d.data as PresenzeData)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [studentId, parentId])

  if (!loaded) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 flex-shrink-0 animate-pulse rounded-[11px] bg-kidville-line" />
          <div className="flex-1">
            <div className="h-4 w-1/2 animate-pulse rounded-full bg-kidville-line" />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded-full bg-kidville-line" />
          </div>
        </div>
      </Card>
    )
  }

  if (!data) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[11px] bg-kidville-green-soft text-kidville-green">
          <CircleHelp size={18} />
        </span>
        <p className="font-maven text-[13px] text-kidville-muted">{t('presenzeNonDisponibili')}</p>
      </Card>
    )
  }

  const { oggi, riepilogo } = data
  const stato = oggi.stato ? STATI[oggi.stato] : null
  // Etichette testuali dallo stato: titolo, pill e sottotitolo tradotti.
  const statoLabel = oggi.stato ? t(`presenzeStato_${oggi.stato}`) : t('presenzeInAttesa')
  const pillText = oggi.stato ? t(`presenzePill_${oggi.stato}`) : ''

  // Sottotitolo contestuale in base allo stato di oggi.
  let sub = t('presenzeAppelloNonRegistrato')
  if (oggi.stato === 'presente') sub = oggi.orario_entrata ? t('presenzeIngressoAlle', { ora: hhmm(oggi.orario_entrata) }) : t('presenzePresenteOggi')
  else if (oggi.stato === 'ritardo') sub = oggi.orario_entrata ? t('presenzeIngressoAlle', { ora: hhmm(oggi.orario_entrata) }) : t('presenzeEntratoRitardo')
  else if (oggi.stato === 'uscita_anticipata') sub = oggi.orario_uscita ? t('presenzeUscitaAlle', { ora: hhmm(oggi.orario_uscita) }) : t('presenzeUscitaAnticipata')
  else if (oggi.stato === 'assente') sub = t('presenzeAssentePerOggi')

  const oreMancate = riepilogo.ore ? Math.round(riepilogo.ore.oreTotali * 10) / 10 : null

  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <span
          className={
            'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[11px] ' +
            (stato ? stato.badge : 'bg-kidville-green-soft text-kidville-muted')
          }
        >
          {stato ? <stato.Icon size={18} /> : <CircleHelp size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <span className="font-barlow text-sm font-extrabold uppercase text-kidville-green">
            {statoLabel}
          </span>
          <p className="font-maven text-xs text-kidville-muted">{sub}</p>
        </div>
        {stato && (
          <span className={'rounded-pill px-3 py-1 font-barlow text-[11px] font-extrabold uppercase tracking-wide ' + stato.pill}>
            {pillText}
          </span>
        )}
      </div>

      {/* Riepilogo ultimi 30 giorni */}
      <div className="mt-3 flex items-center gap-2 border-t border-kidville-line pt-3">
        <Riquadro n={riepilogo.presenze} label={t('presenzeRiquadroPresenze')} tone="green" />
        <Riquadro n={riepilogo.assenze} label={t('presenzeRiquadroAssenze')} tone="red" />
        <Riquadro n={riepilogo.ritardi} label={t('presenzeRiquadroRitardi')} tone="amber" />
        {oreMancate !== null && oreMancate > 0 && (
          <Riquadro n={oreMancate} label={t('presenzeRiquadroOrePerse')} tone="amber" suffix="h" />
        )}
      </div>
      <p className="mt-2 font-maven text-[10.5px] text-kidville-muted">{t('presenzeUltimi30')}</p>
    </Card>
  )
}

function Riquadro({
  n,
  label,
  tone,
  suffix,
}: {
  n: number
  label: string
  tone: 'green' | 'red' | 'amber'
  suffix?: string
}) {
  const color =
    tone === 'green' ? 'text-kidville-green' : tone === 'red' ? 'text-kidville-error' : 'text-kidville-warn'
  return (
    <div className="flex flex-1 flex-col items-center rounded-[12px] bg-kidville-cream py-2">
      <span className={'font-barlow text-lg font-black leading-none ' + color}>
        {n}
        {suffix ?? ''}
      </span>
      <span className="mt-1 font-maven text-[10px] font-semibold uppercase tracking-wide text-kidville-muted">
        {label}
      </span>
    </div>
  )
}
