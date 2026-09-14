import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import itCampi from '../../messages/it/parentForms.json'
import enCampi from '../../messages/en/parentForms.json'
import {
  MSG_CAMPO_OBBLIGATORIO,
  MSG_CODICE_FISCALE_NON_VALIDO,
} from '@/lib/forms/validate-fields'

/**
 * ─── IL CODICE FISCALE RESPINTO SI LEGGE NELLA LINGUA DI CHI COMPILA (2026-09-14) ─
 *
 * `validateField` respinge da oggi il codice fiscale con il carattere di controllo
 * sbagliato. È la frase che ferma una famiglia a metà del modulo pubblico, e le porte
 * pubbliche hanno il catalogo inglese completo: una frase italiana sotto un campo di
 * una pagina inglese è la «mezza traduzione» che `messaggio-campo.ts` esiste per
 * impedire.
 *
 * ⚠️ PERCHÉ QUI IL TRADUTTORE È INGLESE. Il mock di `test/setup.ts` risolve sui soli
 * cataloghi italiani, e in italiano la voce del catalogo È la costante: un render
 * italiano mostrerebbe la stessa frase sia se la sostituzione avviene, sia se il
 * messaggio grezzo passa dritto. È la trappola che la testata di
 * `obbligo-nella-lingua-di-chi-legge.test.tsx` racconta di sé. In inglese le due
 * stringhe divergono, e il test ha i denti.
 */
vi.mock('next-intl', async () => {
  const en = (await import('../../messages/en/parentForms.json')).default as Record<string, string>
  return {
    useTranslations: (ns?: string) => (chiave: string) =>
      (ns === 'parentForms' ? en[chiave] : undefined) ?? `${ns}.${chiave}`,
  }
})

import { useMessaggioCampo } from '@/components/features/forms/messaggio-campo'

describe('i18n — il codice fiscale respinto', () => {
  it('la frase sta in ENTRAMBI i cataloghi, e in inglese è davvero inglese', () => {
    expect(itCampi.codiceFiscaleNonValido, 'manca in italiano').toBe(MSG_CODICE_FISCALE_NON_VALIDO)
    expect(enCampi.codiceFiscaleNonValido, 'manca in inglese').toBeTruthy()
    expect(enCampi.codiceFiscaleNonValido, 'l’inglese ricopia l’italiano').not.toBe(
      itCampi.codiceFiscaleNonValido,
    )
  })

  it('la mappatura scambia la costante con la voce del catalogo', () => {
    const { result } = renderHook(() => useMessaggioCampo())
    // Prova di sanità del banco: l'obbligo, che la mappatura traduce da prima, esce
    // inglese. Se questa riga cadesse, il traduttore finto non starebbe funzionando e
    // la riga dopo non misurerebbe niente.
    expect(result.current({ message: MSG_CAMPO_OBBLIGATORIO })).toBe(enCampi.campoObbligatorio)
    expect(result.current({ message: MSG_CODICE_FISCALE_NON_VALIDO })).toBe(
      enCampi.codiceFiscaleNonValido,
    )
  })
})
