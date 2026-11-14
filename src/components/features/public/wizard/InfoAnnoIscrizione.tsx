'use client'

import { useLocale, useTranslations } from 'next-intl'
import { CalendarDays } from 'lucide-react'
import type { InfoAnno } from '@/components/features/public/wizard/use-info-anno'

const FASCE_NOMI: Record<string, string> = {
  nido_1: 'fasciaNido1',
  nido_2: 'fasciaNido2',
  primavera: 'fasciaPrimavera',
  infanzia: 'fasciaInfanzia',
  primaria: 'fasciaPrimaria',
  spazio_bambini: 'fasciaSpazioBambini',
}

/**
 * «Per quale anno stai iscrivendo il bambino», con la quota di nuova iscrizione e i documenti da consegnare.
 * Si mostra dal primo passo dopo la sede e rimostra nel riepilogo. Senza quota nel listino la quota non compare
 * (nessun importo inventato); senza documenti non c'è l'elenco; senza anno noto non c'è il pannello.
 */
export function InfoAnnoIscrizione({ anno, info }: { anno: string; info: InfoAnno | null }) {
  const ta = useTranslations('annoPubblico')
  const tf = useTranslations('annoListino')
  const locale = useLocale()
  const euro = (n: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(n)
  const quote = info?.quote ?? []
  const moduli = info?.moduli ?? []
  const uniforme = quote.length > 0 && quote.every((q) => q.importo === quote[0].importo)

  return (
    <section aria-label={ta('infoAnnoAria')} className="mb-5 rounded-xl border border-kidville-neutral bg-kidville-white px-4 py-3 text-sm text-kidville-ink">
      <p className="flex items-center gap-2 font-semibold text-kidville-green">
        <CalendarDays className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        {ta('infoAnnoTitolo', { anno })}
      </p>
      {quote.length > 0 &&
        (uniforme ? (
          <p className="mt-2">{ta('infoAnnoQuota', { importo: euro(quote[0].importo) })}</p>
        ) : (
          <div className="mt-2">
            <p>{ta('infoAnnoQuotaPerFascia')}</p>
            <ul className="mt-1 list-disc pl-5">
              {quote.map((q) => (
                <li key={q.fascia ?? 'tutte'}>
                  {q.fascia && FASCE_NOMI[q.fascia] ? tf(FASCE_NOMI[q.fascia] as 'fasciaInfanzia') : tf('fasciaTutte')}: {euro(q.importo)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      {moduli.length > 0 && (
        <div className="mt-2">
          <p>{ta('infoAnnoDocumenti')}</p>
          <ul className="mt-1 list-disc pl-5">
            {moduli.map((m) => (
              <li key={m.codice}>{m.titolo}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
