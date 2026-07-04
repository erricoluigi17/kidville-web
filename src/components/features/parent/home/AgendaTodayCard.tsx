'use client'

import { useEffect, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { Card } from '@/components/ui/Card'

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

const TIPO_LABEL: Record<string, string> = {
  evento: 'Evento',
  uscita: 'Uscita',
  scadenza: 'Scadenza',
  riunione: 'Riunione',
}

function giornoMese(ymd: string): { giorno: string; mese: string } {
  try {
    const d = new Date(`${ymd}T00:00:00`)
    return {
      giorno: d.toLocaleDateString('it-IT', { day: 'numeric' }),
      mese: d.toLocaleDateString('it-IT', { month: 'short' }).replace('.', ''),
    }
  } catch {
    return { giorno: '—', mese: '' }
  }
}

export function AgendaTodayCard({ studentId }: { studentId: string | null }) {
  const [eventi, setEventi] = useState<EventoAgenda[]>([])
  const [loading, setLoading] = useState(true)

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
            Nessun appuntamento in programma
          </p>
          <p className="mt-0.5 font-maven text-[12.5px] leading-snug text-kidville-muted">
            Qui vedrai uscite, eventi e scadenze della sezione.
          </p>
        </div>
      </Card>
    )
  }

  return (
    <Card className="divide-y divide-kidville-line px-4 py-1">
      {eventi.map((e) => {
        const { giorno, mese } = giornoMese(e.data)
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
                {TIPO_LABEL[e.tipo] ?? e.tipo}
                {e.orario_inizio ? ` · ore ${e.orario_inizio.slice(0, 5)}` : ''}
              </p>
            </div>
          </div>
        )
      })}
    </Card>
  )
}
