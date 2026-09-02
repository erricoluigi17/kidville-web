/**
 * Ruoli staff assegnabili dalla Direzione (DL-028).
 * Il ruolo `genitore` NON è assegnabile dal pannello Staff (le famiglie sono
 * gestite a parte). Helper puri per validazione + label.
 */
import { useTranslations } from 'next-intl'
import type { AppRole } from './require-staff'

export const RUOLI_ASSEGNABILI: { value: AppRole; label: string }[] = [
  { value: 'educator', label: 'Docente' },
  { value: 'segreteria', label: 'Segreteria' },
  { value: 'cuoca', label: 'Cuoca' },
  { value: 'coordinator', label: 'Direzione' },
  { value: 'admin', label: 'Amministratore' },
]

export const RUOLI_VALIDI: AppRole[] = RUOLI_ASSEGNABILI.map((r) => r.value)

export function isRuoloAssegnabile(r: unknown): r is AppRole {
  return typeof r === 'string' && (RUOLI_VALIDI as string[]).includes(r)
}

export function labelRuolo(r: string): string {
  return RUOLI_ASSEGNABILI.find((x) => x.value === r)?.label ?? r
}

/**
 * PRESENTAZIONE: la stringa di ruolo che il browser ha in mano è Direzione?
 *
 * Prende una `string` e non un `AppUser` perché lato client il ruolo arriva così — da
 * `useRuoloCockpit()`, che fuori dal provider vale `''`. Quel `''` risponde `false`, ed è
 * il verso giusto in cui sbagliare: mentre la fetch del provider è in volo non si disegna
 * un totale economico.
 *
 * ⚠️ Serve a decidere COSA MOSTRARE, mai se qualcuno può: la decisione vera è
 * `eDirezione()` in `predicati-ruolo.ts`, sul server, sui ruoli reali. Dove il numero è un
 * segreto vero il server lo OMETTE; qui si nasconde soltanto ciò che il browser ha già.
 */
export function eDirezioneCockpit(ruolo: string | null | undefined): boolean {
  return ruolo === 'admin' || ruolo === 'coordinator'
}

/**
 * Hook locale-aware per l'etichetta di un ruolo (namespace `etichette`,
 * chiavi `ruolo_<code>`). Da usare nei componenti client. Se la chiave non
 * esiste (codice ignoto), degrada alla funzione pura `labelRuolo` — che
 * restituisce l'etichetta IT o, in ultima istanza, il codice grezzo — MAI la
 * chiave i18n. Retro-compatibile: `labelRuolo` resta la fonte per il server.
 */
export function useLabelRuolo(): (r: string) => string {
  const t = useTranslations('etichette')
  return (r: string) => {
    const k = `ruolo_${r}`
    return t.has(k) ? t(k) : labelRuolo(r)
  }
}
