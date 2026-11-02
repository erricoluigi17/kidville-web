'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronRight, Vote } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { formatData } from '@/lib/i18n/date'
import type { SchedaGenitore } from '@/lib/votazioni/tipi'
import { leggiSchede } from '@/components/features/votazioni/genitore/chiamate'

interface Props {
  parentId: string
  /** Il link già con l'identità (`wi('/parent/votazioni')` dalla home). */
  href: string
}

/** La scadenza più vicina: è quella che dice «entro quando» a chi ha più schede con date diverse. */
function scadenzaPiuVicina(schede: readonly SchedaGenitore[]): string | null {
  let migliore: { ms: number; iso: string } | null = null
  for (const s of schede) {
    const ms = Date.parse(s.scadenza)
    if (Number.isNaN(ms)) continue
    if (migliore === null || ms < migliore.ms) migliore = { ms, iso: s.scadenza }
  }
  return migliore?.iso ?? null
}

/**
 * La card «Votazioni aperte» della home genitore. Fa la sua fetch (`GET /api/parent/votazioni`) e
 * **non rende NIENTE** se `disponibile` è falso, se le schede sono 0 o se c'è un errore: una home che
 * mostra a ogni famiglia, ogni giorno, un riquadro vuoto insegna a non guardarlo. Compare solo quando
 * c'è qualcosa da votare.
 *
 * ── PERCHÉ IL RIQUADRO È DENTRO LA CARD ─────────────────────────────────────────
 * Le altre sezioni della home hanno il loro `<div className="px-4 pt-5">` nella pagina, e quando sono
 * vuote lasciano un guscio vuoto. Qui il guscio sta DENTRO il componente: la griglia a due colonne da
 * 1024 px non deve riservare una cella a un riquadro che non c'è.
 *
 * ── L'ERRORE NON SI MOSTRA SULLA HOME ───────────────────────────────────────────
 * Un guasto qui non deve sporcare la schermata più vista dell'app. `leggiSchede` lo ha già registrato
 * (livello `warn`, con il codice); la pagina `/parent/votazioni` ha la sua schermata d'errore con «Riprova».
 */
export function VotazioniCard({ parentId, href }: Props) {
  const t = useTranslations('votazioniGenitore')
  const locale = useLocale()
  const [schede, setSchede] = useState<SchedaGenitore[]>([])

  useEffect(() => {
    let vivo = true
    // Il `fallback` non si legge: l'errore non si mostra, quindi nessuna frase da tradurre.
    void leggiSchede(parentId, '').then((esito) => {
      if (vivo && esito.tipo === 'ok') setSchede(esito.schede)
    })
    return () => {
      vivo = false
    }
  }, [parentId])

  if (schede.length === 0) return null

  const scadenza = scadenzaPiuVicina(schede)

  return (
    <div className="px-4 pt-5">
      <Link href={href} className="block active:scale-[.99]">
        <Card className="p-[14px]">
          <div className="flex items-center gap-3">
            <div className="flex h-[38px] w-[38px] flex-shrink-0 items-center justify-center rounded-xl bg-kidville-yellow text-kidville-green">
              <Vote size={19} strokeWidth={1.8} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-barlow text-base font-extrabold uppercase leading-tight text-kidville-green">
                {t('cardTitolo')}
              </h2>
              <p className="mt-1 font-maven text-[12.5px] leading-snug text-kidville-sub">
                {t('cardDettaglio', {
                  count: schede.length,
                  data: scadenza ? formatData(scadenza, locale, 'dataOra') : '',
                })}
              </p>
            </div>
            <ChevronRight size={18} aria-hidden="true" className="flex-shrink-0 text-kidville-green" />
          </div>
        </Card>
      </Link>
    </div>
  )
}
