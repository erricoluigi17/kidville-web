'use client'

import { CalendarDays } from 'lucide-react'
import { Card } from '@/components/ui/Card'

/**
 * Sezione "Calendario · Prossimi appuntamenti" del design (DR AgendaCard).
 * Non esiste un backend agenda/calendario lato genitore: la sezione è resa come
 * placeholder ("in arrivo") finché non sarà disponibile una sorgente dati reale.
 * (Vedi LISTA 1 del piano: design senza backend.)
 */
export function AgendaTodayCard() {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[13px] bg-kidville-yellow-soft text-kidville-yellow-dark">
        <CalendarDays size={20} />
      </span>
      <div className="min-w-0">
        <p className="font-barlow text-sm font-extrabold uppercase text-kidville-green">Agenda in arrivo</p>
        <p className="mt-0.5 font-maven text-[12.5px] leading-snug text-kidville-muted">
          Qui vedrai uscite, eventi e scadenze della sezione.
        </p>
      </div>
    </Card>
  )
}
