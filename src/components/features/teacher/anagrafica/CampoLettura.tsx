import type { ReactNode } from 'react'
import { cx } from '@/lib/ui/cx'

interface CampoLetturaProps {
  etichetta: string
  /** `null`, `undefined` o stringa vuota ⇒ si mostra `nonIndicato`, mai una riga che sparisce. */
  valore: ReactNode
  nonIndicato: string
  /** Testo su più righe (note mediche): conserva gli a capo. */
  aCapo?: boolean
}

/** Una riga «etichetta: valore» dentro un `<dl>`. Non c'è niente da modificare. */
export function CampoLettura({ etichetta, valore, nonIndicato, aCapo }: CampoLetturaProps) {
  const vuoto = valore === null || valore === undefined || valore === ''
  return (
    <div className="py-2.5 sm:grid sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-4">
      <dt className="font-barlow text-[11px] font-bold uppercase tracking-[0.05em] text-kidville-sub">{etichetta}</dt>
      <dd
        className={cx(
          'mt-0.5 font-maven text-sm sm:mt-0',
          vuoto ? 'italic text-kidville-sub' : 'text-kidville-ink',
          aCapo && 'whitespace-pre-line break-words',
        )}
      >
        {vuoto ? nonIndicato : valore}
      </dd>
    </div>
  )
}
