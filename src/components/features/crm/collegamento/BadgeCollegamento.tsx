'use client'

import { useTranslations } from 'next-intl'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import type { BambinoRow } from '@/lib/crm/tipi'

/**
 * CRM della segreteria · lo stato del collegamento fra un bambino e la sua domanda di iscrizione.
 *
 * UN SOLO badge, il primo che combacia in questo ordine (è la tabella del piano, Compito 4.3):
 *
 *  1. `da_verificare`                                      → domanda respinta, da controllare;
 *  2. iscritto con `domanda_id`                            → domanda collegata;
 *  3. iscritto, `domanda_id` nullo, `domanda_collegata_il` → la domanda c'era ed è sparita;
 *  4. iscritto senza domanda                               → iscritto a mano;
 *  5. `nota_collegamento = 'altra_domanda'`                → ne è arrivata un'altra.
 *
 * Tutto il resto (un bambino aperto, in lista d'attesa, perso…) non porta badge: il «niente da dire»
 * non è un'informazione, e un'etichetta su ogni riga le toglierebbe valore a quelle che contano.
 *
 * ⚠️ L'ordine ha un effetto che è bene sapere: un bambino GIÀ iscritto con la nota `altra_domanda`
 * mostra il badge 2, 3 o 4 e non il 5 — la nota resta in banca dati, ma da qui non si vede. È come
 * dice la tabella; se in segreteria serve vederla anche lì, la modifica è una riga in questo file.
 *
 * `data-collegamento` serve ai test e ai collaudi: dice QUALE riga della tabella ha vinto senza
 * dover leggere la frase (che cambia con la lingua).
 */
type Stato = 'da_verificare' | 'iscritto_collegata' | 'iscritto_non_piu_presente' | 'iscritto_a_mano' | 'altra_domanda'

function statoDi(b: BambinoRow): Stato | null {
  if (b.da_verificare) return 'da_verificare'
  if (b.esito === 'iscritto') {
    if (b.domanda_id) return 'iscritto_collegata'
    if (b.domanda_collegata_il) return 'iscritto_non_piu_presente'
    return 'iscritto_a_mano'
  }
  if (b.nota_collegamento === 'altra_domanda') return 'altra_domanda'
  return null
}

const TONO: Record<Stato, BadgeTone> = {
  da_verificare: 'warn',
  iscritto_collegata: 'success',
  // La domanda è sparita: il bambino è iscritto lo stesso, ma qualcuno deve sapere perché.
  iscritto_non_piu_presente: 'warn',
  iscritto_a_mano: 'neutral',
  altra_domanda: 'evidenza',
}

export function BadgeCollegamento({ bambino }: { bambino: BambinoRow }) {
  const t = useTranslations('crmCollegamento')
  const stato = statoDi(bambino)
  if (stato === null) return null

  const testo: Record<Stato, string> = {
    da_verificare: t('badgeDaVerificare'),
    iscritto_collegata: t('badgeIscrittoCollegata'),
    iscritto_non_piu_presente: t('badgeIscrittoNonPiuPresente'),
    iscritto_a_mano: t('badgeIscrittoAMano'),
    altra_domanda: t('badgeAltraDomanda'),
  }

  return (
    <Badge tone={TONO[stato]} aCapo data-collegamento={stato}>
      {testo[stato]}
    </Badge>
  )
}
