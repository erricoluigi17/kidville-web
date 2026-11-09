'use client'

import { useTranslations } from 'next-intl'
import type { Calendario } from '@/lib/anno-scolastico'
import { useCalendarioDi } from '@/lib/context/calendario-context'
import { annoDellaScheda, annoIngressoDaAnno, etichettaAnno } from '@/lib/crm/quota-anno'
import { ANNI_INGRESSO, type AnnoIngresso } from '@/lib/crm/tipi'
import { etichetta } from './vocabolari'

/**
 * CRM della segreteria · L'ANNO DELLA SCHEDA, il campo a tendina (compito 4.5.9).
 *
 * Dalla PR 4.5 una scheda dichiara il suo anno con `anno_id`: l'elenco è quello degli anni che la SEDE ha nel suo calendario e che
 * non sono chiusi («2026/27», «2027/28»…), più «non indicato». Non è più l'etichetta relativa («in corso» / «prossimo»), che cambia
 * significato col passare dei giorni.
 *
 * Il valore del campo è una stringa: un uuid (`anni_scolastici.id`) oppure, quando il calendario della sede non c'è (database non
 * migrato, calendario non ancora arrivato), una delle tre etichette di sempre. `corpoAnno` lo traduce nel pezzo di corpo da mandare
 * alla route: `annoId` per un uuid, `annoIngresso` per l'etichetta.
 */

const eEtichetta = (v: string): v is AnnoIngresso => (ANNI_INGRESSO as readonly string[]).includes(v)

/** Il pezzo di corpo che dichiara l'anno scelto: `annoIngresso` per un'etichetta, `annoId` per un uuid. */
export function corpoAnno(valore: string): { annoIngresso: AnnoIngresso } | { annoId: string } {
  return eEtichetta(valore) ? { annoIngresso: valore } : { annoId: valore }
}

/**
 * Il valore con cui il campo parte per un bambino che c'è già: il suo `anno_id` se la sede lo conosce, altrimenti l'etichetta
 * (o «non indicato» per un valore che non si capisce).
 */
export function valoreAnnoIniziale(
  b: { anno_id?: string | null; anno_ingresso: string },
  calendario: Calendario | null,
): string {
  if (b.anno_id && annoDellaScheda(b.anno_id, calendario) !== null) {
    return calendario?.find((r) => r.annoId.toLowerCase() === b.anno_id!.toLowerCase())?.annoId ?? b.anno_id
  }
  return eEtichetta(b.anno_ingresso) ? b.anno_ingresso : 'non_indicato'
}

/**
 * Il valore che il campo mostra DAVVERO (e quindi che si manda): con il calendario della sede, un'etichetta relativa («prossimo»,
 * «in corso») diventa l'anno che oggi significa, e un valore che l'elenco non contiene ricade su «non indicato». Senza calendario
 * non cambia niente.
 */
export function valoreNelCalendario(valore: string, calendario: Calendario | null): string {
  const anni = (calendario ?? []).filter((r) => r.stato !== 'chiuso' || r.annoId.toLowerCase() === valore.toLowerCase())
  if (anni.length === 0) return valore
  if (valore === 'non_indicato') return valore
  const trovato = anni.find((r) => r.annoId.toLowerCase() === valore.toLowerCase())
  if (trovato) return trovato.annoId
  if (eEtichetta(valore)) {
    const riga = anni.find((r) => r.stato !== 'chiuso' && annoIngressoDaAnno(r, calendario ?? []) === valore)
    if (riga) return riga.annoId
  }
  return 'non_indicato'
}

export function SelettoreAnnoScheda({
  id,
  scuolaId,
  valore,
  onChange,
  disabled,
  className,
}: {
  id: string
  scuolaId: string
  valore: string
  onChange: (valore: string) => void
  disabled?: boolean
  className?: string
}) {
  const tc = useTranslations('crmShell')
  const calendario = useCalendarioDi(scuolaId)

  // Senza calendario della sede il campo resta com'era: le tre etichette relative.
  const anni = (calendario ?? []).filter((r) => r.stato !== 'chiuso' || r.annoId.toLowerCase() === valore.toLowerCase())
  const opzioni: Array<{ valore: string; testo: string }> =
    anni.length === 0
      ? ANNI_INGRESSO.map((a) => ({ valore: a, testo: etichetta(tc, 'anniIngresso', a) }))
      : [
          { valore: 'non_indicato', testo: etichetta(tc, 'anniIngresso', 'non_indicato') },
          ...[...anni]
            .sort((a, b) => a.annoInizio - b.annoInizio)
            .map((r) => ({ valore: r.annoId, testo: etichettaAnno(r.annoInizio) })),
        ]

  const mostrato = valoreNelCalendario(valore, calendario)

  return (
    <select id={id} value={mostrato} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={className}>
      {opzioni.map((o) => (
        <option key={o.valore} value={o.valore}>
          {o.testo}
        </option>
      ))}
    </select>
  )
}
