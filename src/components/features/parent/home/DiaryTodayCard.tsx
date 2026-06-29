'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { BookOpen, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/Card'

interface Entry {
  id: string
  tipo_evento: string
  timestamp_evento: string
  note?: string | null
}

interface Props {
  studentId: string
  href: string
}

const fmtTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const titleCase = (s: string) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : 'Aggiornamento'

/**
 * "Oggi a scuola" del design (DR DiaryToday). Mostra gli ultimi aggiornamenti del
 * diario di oggi. Dato esistente: GET /api/diary/entries?alunno_id=&from=&to=
 * (sola lettura). Si nasconde se non ci sono eventi oggi.
 */
export function DiaryTodayCard({ studentId, href }: Props) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!studentId) return
    let active = true
    const today = new Date().toISOString().split('T')[0]
    fetch(`/api/diary/entries?alunno_id=${studentId}&from=${today}&to=${today}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && Array.isArray(d)) setEntries(d)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [studentId])

  if (!loaded || entries.length === 0) return null

  const items = entries.slice(0, 3)
  const updated = fmtTime(entries[0].timestamp_evento)

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-kidville-line px-4 py-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[13px] bg-kidville-green text-kidville-yellow">
          <BookOpen size={21} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-barlow text-[17px] font-black uppercase leading-none text-kidville-green">
            Oggi a scuola
          </p>
          {updated && <p className="mt-0.5 font-maven text-[11.5px] text-kidville-muted">Aggiornato · {updated}</p>}
        </div>
      </div>

      <div className="px-4 py-2">
        {items.map((ev, i) => (
          <div key={ev.id} className="flex gap-3 py-2">
            <div className="flex flex-col items-center">
              <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-kidville-cream text-kidville-green">
                <BookOpen size={16} strokeWidth={1.8} />
              </div>
              {i < items.length - 1 && <div className="mt-1 w-0.5 flex-1 bg-kidville-line" />}
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline gap-2">
                <span className="font-barlow text-[13.5px] font-extrabold uppercase tracking-wide text-kidville-green">
                  {titleCase(ev.tipo_evento)}
                </span>
                <span className="font-maven text-[11px] text-kidville-muted">{fmtTime(ev.timestamp_evento)}</span>
              </div>
              {ev.note && (
                <p className="mt-0.5 font-maven text-[12.8px] leading-snug text-[#55615c]">{ev.note}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      <Link
        href={href}
        className="flex items-center justify-center gap-1.5 border-t border-kidville-line py-3 font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green"
      >
        Apri il diario completo
        <ChevronRight size={16} strokeWidth={2.2} />
      </Link>
    </Card>
  )
}
