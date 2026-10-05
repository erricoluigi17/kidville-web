'use client'

import { useId, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/** Un blocco della scheda: titolo visibile che dà anche il nome alla regione. */
export function RiquadroScheda({ titolo, icona: Icona, children }: { titolo: string; icona: LucideIcon; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="rounded-card border border-kidville-line bg-kidville-white p-4 sm:p-5">
      <h2 id={id} className="flex items-center gap-2 font-barlow text-base font-extrabold uppercase tracking-[0.02em] text-kidville-green">
        <Icona size={18} aria-hidden="true" />
        {titolo}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  )
}
