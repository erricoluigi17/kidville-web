'use client'

import { useEffect, useState } from 'react'
import { useTranslations, useLocale } from 'next-intl'
import { CalendarDays } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { formattaIstante } from '@/i18n/config'

/**
 * Sezione "Calendario · Prossimi appuntamenti" del design (DR AgendaCard).
 * M6.3: collegata a /api/agenda (eventi di plesso + sezione del figlio,
 * visibile_genitori) — prossimi 5 eventi. Stato vuoto = card del design con
 * "Nessun appuntamento in programma".
 */

interface EventoAgenda {
  id: string
  titolo: string
  descrizione?: string | null
  tipo: string
  data: string // YYYY-MM-DD
  orario_inizio?: string | null
  orario_fine?: string | null
}

// Mappa il codice `tipo` (dato) alla chiave i18n della sua etichetta. Codici
// sconosciuti degradano al valore grezzo (vedi tipoLabel nel componente).
const TIPO_CHIAVE: Record<string, string> = {
  evento: 'agendaTipoEvento',
  uscita: 'agendaTipoUscita',
  scadenza: 'agendaTipoScadenza',
  riunione: 'agendaTipoRiunione',
}

function giornoMese(ymd: string, locale: string): { giorno: string; mese: string } {
  // `agenda.data` è una colonna `date`: un GIORNO di calendario, non un
  // istante. L'istante si àncora a UTC e si formatta in UTC, così una data
  // senza ora non può slittare col fuso del dispositivo; il `locale` passa da
  // `intlDateTime`, che gli dà la sua REGIONE (`'en'` nudo sarebbe en-US).
  // Gemello di `TeacherAgendaCard.giornoMese`.
  const d = new Date(`${ymd}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return { giorno: '—', mese: '' }
  return {
    giorno: formattaIstante(d, locale, { day: 'numeric', timeZone: 'UTC' }),
    mese: formattaIstante(d, locale, { month: 'short', timeZone: 'UTC' }).replace('.', ''),
  }
}

export function AgendaTodayCard({ studentId }: { studentId: string | null }) {
  const t = useTranslations('home')
  const locale = useLocale()
  const [eventi, setEventi] = useState<EventoAgenda[]>([])
  const [loading, setLoading] = useState(true)
  // Etichetta del tipo evento: tradotta se nota, altrimenti codice grezzo (dato).
  const tipoLabel = (tipo: string) => (TIPO_CHIAVE[tipo] ? t(TIPO_CHIAVE[tipo]) : tipo)

  useEffect(() => {
    if (!studentId) return
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`/api/agenda?alunno_id=${studentId}`).catch(() => null)
        const j = res?.ok ? await res.json().catch(() => null) : null
        if (!cancelled && Array.isArray(j?.data)) setEventi(j.data.slice(0, 5))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [studentId])

  if (studentId && loading) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <span className="h-10 w-10 flex-shrink-0 animate-pulse rounded-[13px] bg-kidville-yellow-soft" />
        <div className="min-w-0 flex-1">
          <div className="h-3.5 w-2/5 animate-pulse rounded-full bg-kidville-line" />
          <div className="mt-2 h-3 w-3/5 animate-pulse rounded-full bg-kidville-line" />
        </div>
      </Card>
    )
  }

  if (eventi.length === 0) {
    return (
      <Card className="flex items-center gap-3 p-4">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[13px] bg-kidville-yellow-soft text-kidville-yellow-dark">
          <CalendarDays size={20} />
        </span>
        <div className="min-w-0">
          <p className="font-barlow text-sm font-extrabold uppercase text-kidville-green">
            {t('agendaVuotaTitolo')}
          </p>
          <p className="mt-0.5 font-maven text-[12.5px] leading-snug text-kidville-muted">
            {t('agendaVuotaSottotitolo')}
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card className="divide-y divide-kidville-line px-4 py-1">
      {eventi.map((e) => {
        const { giorno, mese } = giornoMese(e.data, locale)
        return (
          <div key={e.id} className="flex items-center gap-3 py-3">
            <span className="flex h-10 w-10 flex-shrink-0 flex-col items-center justify-center rounded-[13px] bg-kidville-yellow-soft text-kidville-yellow-dark">
              <span className="font-barlow text-[15px] font-black leading-none">{giorno}</span>
              <span className="font-barlow text-[9px] font-bold uppercase leading-none">{mese}</span>
            </span>
            <div className="min-w-0">
              <p className="truncate font-barlow text-sm font-extrabold uppercase text-kidville-green">
                {e.titolo}
              </p>
              <p className="mt-0.5 font-maven text-[12.5px] leading-snug text-kidville-muted">
                {tipoLabel(e.tipo)}
                {e.orario_inizio ? t('agendaOre', { ora: e.orario_inizio.slice(0, 5) }) : ''}
              </p>
            </div>
          </div>
        )
      })}
    </Card>
  )
}
