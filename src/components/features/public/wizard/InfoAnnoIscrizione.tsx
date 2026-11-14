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
  // «La quota» senza altro vale per tutti SOLO se è la riga con `fascia: null` ed è l'unica. Una quota di una fascia (o di più
  // fasce, anche con lo stesso importo) non è la quota di ogni bambino: si elencano le fasce presenti, ognuna col suo importo.
  const perTutti = quote.length === 1 && quote[0].fascia === null
  const nomeFascia = (f: string | null): string =>
    f === null ? tf('fasciaTutte') : FASCE_NOMI[f] ? tf(FASCE_NOMI[f] as 'fasciaInfanzia') : f // fascia sconosciuta: il codice, mai «Tutte»

  return (
    <section aria-label={ta('infoAnnoAria')} className="mb-5 rounded-xl border border-kidville-neutral bg-kidville-white px-4 py-3 text-sm text-kidville-ink">
      <p className="flex items-center gap-2 font-semibold text-kidville-green">
        <CalendarDays className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        {ta('infoAnnoTitolo', { anno })}
      </p>
      {quote.length > 0 &&
        (perTutti ? (
          <p className="mt-2">{ta('infoAnnoQuota', { importo: euro(quote[0].importo) })}</p>
        ) : (
          <ul className="mt-2 list-disc pl-5">
            {quote.map((q) => (
              <li key={q.fascia ?? 'tutte'}>{ta('infoAnnoQuotaFascia', { fascia: nomeFascia(q.fascia), importo: euro(q.importo) })}</li>
            ))}
          </ul>
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
