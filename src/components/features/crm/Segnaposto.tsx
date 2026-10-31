'use client'

import { useTranslations } from 'next-intl'
import { Construction } from 'lucide-react'

/**
 * CRM DELLA SEGRETERIA · IL SEGNAPOSTO DI UNA SCHERMATA NON ANCORA COSTRUITA.
 *
 * Le sei sessioni che costruiscono il CRM lavorano in parallelo. La prima (Fondamenta) consegna la
 * cornice — pagina, menu, schede — e un file per ogni schermata che le altre cinque riempiranno:
 * ognuno esporta il componente con le sue props, e queste props sono il CONTRATTO fra le sessioni
 * (vedi `__tests__/components/crm/contratto-segnaposto.test.tsx`). Finché la schermata vera non c'è,
 * il file rende questo riquadro.
 *
 * `nome` e `dati` finiscono negli attributi `data-*`: non sono per chi guarda, servono ai test per
 * verificare che la cornice abbia passato a ogni schermata la sede e l'id giusti — il motivo per cui
 * le props che il segnaposto non mostra non sono ignorate del tutto. Solo uuid: nessun dato di una
 * famiglia passa di qui.
 *
 * La sessione che sostituisce un segnaposto lo butta via per intero, questo file compreso se non lo
 * usa più nessuno.
 */
export function Segnaposto({ nome, dati }: { nome: string; dati?: Record<string, string | undefined> }) {
  const t = useTranslations('crmShell')
  const attributi: Record<string, string> = {}
  for (const [chiave, valore] of Object.entries(dati ?? {})) {
    if (valore !== undefined) attributi[`data-${chiave}`] = valore
  }
  return (
    <div
      role="status"
      data-crm-segnaposto={nome}
      {...attributi}
      className="flex items-center gap-3 rounded-card border border-dashed border-kidville-line bg-kidville-white p-6 font-maven text-kidville-sub"
    >
      <Construction size={20} aria-hidden className="shrink-0 text-kidville-green" />
      <span>{t('inCostruzione')}</span>
    </div>
  )
}
