'use client'

import { useContext } from 'react'
import { Contrast } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { AccessibilityContext } from '@/lib/accessibility/context'

// Comando di Alto Contrasto per le superfici PUBBLICHE (modulo d'iscrizione e
// pagine legali), cioè per chi non è ancora — o non sarà mai — dentro l'app.
//
// Perché esiste: `ContrastMenuButton` nasce per i menu account e finora viveva
// SOLO lì. Il collaudo del 2026-08-02 l'ha misurato: su /iscrizione, da cui
// arrivano ~9 domande l'ora da famiglie vere, i bottoni in pagina erano due
// («Indietro» e «Avanti») e nessuno offriva l'accessibilità. L'unico rimedio del
// prodotto era irraggiungibile proprio a chi non ha ancora le credenziali.
//
// Sta in UN posto solo di proposito: cinque pagine che si copiano la stessa
// stringa di classi sono cinque occasioni di divergere, ed è esattamente il modo
// in cui la sidebar desktop era rimasta indietro rispetto alle superfici mobile.
// Chi aggiunge una pagina pubblica monta questo, non una copia.
//
// L'etichetta è TESTO, non solo l'icona: un comando di accessibilità che si
// annuncia con la sola icona è il primo a non essere trovato da chi ne ha
// bisogno. Il bordo è `kidville-green` (6,51:1 su bianco, 5,86:1 su crema); in
// Alto Contrasto la coppia è forzata dalle regole `.kv-public` di `globals.css`.
const CLASSI =
  'inline-flex items-center gap-2 rounded-pill border border-kidville-green px-3.5 py-2 ' +
  'font-maven text-sm font-semibold text-kidville-green transition-colors hover:bg-kidville-green-soft'

/**
 * ⚠️ Legge il contesto DIRETTAMENTE invece di passare da `useAccessibility()`,
 * che lancia quando il provider manca.
 *
 * Non è una scorciatoia per far passare i test: è una scelta sul rischio. Questo
 * bottone è un comando ACCESSORIO montato dentro il modulo con cui le famiglie
 * consegnano codici fiscali di minori, allergie e note mediche. Se un domani un
 * albero lo rendesse fuori dal provider — un layout nuovo, un embed, una pagina
 * d'errore — `useAccessibility()` farebbe cadere l'INTERO modulo d'iscrizione
 * per un pulsante di contorno. È lo stesso principio per cui il logger è
 * fail-open: un guasto dell'accessorio non può diventare un guasto del prodotto.
 *
 * Il degrado non è però silenzioso a livello di gate: il lock
 * `__tests__/a11y/contrasto-bordi-superfici-pubbliche.test.tsx` (§3bis) verifica
 * sia che il bottone compaia col provider, sia che il root layout monti davvero
 * `AccessibilityProvider` — che è la condizione reale in produzione.
 */
export function PublicContrastButton() {
  const t = useTranslations('shared')
  const ctx = useContext(AccessibilityContext)
  if (!ctx) return null
  return (
    <button type="button" onClick={ctx.toggle} aria-pressed={ctx.highContrast} className={CLASSI}>
      <Contrast size={16} strokeWidth={2.2} className="shrink-0" aria-hidden="true" />
      <span>{t('altoContrasto')}</span>
    </button>
  )
}
