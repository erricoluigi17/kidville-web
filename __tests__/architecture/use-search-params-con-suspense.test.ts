// @vitest-environment node
/**
 * LOCK · una pagina STATICA che legge `useSearchParams()` sta dentro un `<Suspense>`.
 *
 * ─── PERCHÉ ESISTE ─────────────────────────────────────────────────────────────
 *
 * Non per il rischio, che è basso: per la GIUSTIFICAZIONE, che era falsa e sarebbe stata
 * creduta. Il 2026-08-16 `src/app/(dashboard)/parent/modulistica/page.tsx` ha introdotto
 * `useSearchParams()` senza confine di sospensione, e la nota accanto diceva che non
 * serviva «tanto `/admin/modulistica` usa lo stesso schema e compila». Misurato: quella
 * pagina il `<Suspense fallback={null}>` ce l'ha da prima di quel ramo
 * (`git show main:'src/app/(dashboard)/admin/modulistica/page.tsx' | grep Suspense`), e la
 * build passava per un motivo diverso e non dichiarato — `src/app/layout.tsx` fa
 * `await cookies()`, che rende dinamica ogni rotta e disinnesca il bailout. Cioè un
 * appoggio silenzioso su una riga di un altro file: il giorno in cui quella `cookies()`
 * sparisce, `npm run build` cade con `missing-suspense-with-csr-bailout`, e la
 * documentazione di Next nel repo lo dice in chiaro
 * (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md`).
 *
 * Un commento sbagliato è peggio di nessun commento: chi lo rilegge fra sei mesi si fida.
 * Questo lock esiste perché la regola non torni a vivere in una frase.
 *
 * ─── PERCHÉ SOLO LE PAGINE STATICHE ────────────────────────────────────────────
 *
 * Il bailout riguarda la prerenderizzazione statica. Le rotte con un segmento dinamico
 * (`[sectionId]`) statiche non sono mai, e infatti — misurato il 2026-08-16 sul repo
 * intero — le uniche nove pagine con `useSearchParams` e senza `Suspense` erano tutte
 * sotto `teacher/primaria/[sectionId]/…`. Pretendere il confine anche lì vorrebbe dire un
 * lock nato rosso, che si tacita togliendo la regola invece che applicandola.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.join(process.cwd(), 'src/app')

/** Tutte le `page.tsx` sotto `src/app`, col percorso relativo alla radice del repo. */
function pagine(): string[] {
  const trovate: string[] = []
  const cammina = (dir: string): void => {
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, voce.name)
      if (voce.isDirectory()) cammina(completo)
      else if (voce.name === 'page.tsx') trovate.push(path.relative(process.cwd(), completo))
    }
  }
  cammina(APP)
  return trovate
}

/** `[id]` in un segmento del percorso: quella rotta statica non è mai. */
const haSegmentoDinamico = (percorso: string): boolean => /\[[^\]]+\]/.test(percorso)

describe('lock architettura · `useSearchParams()` dentro un confine di sospensione', () => {
  const tutte = pagine()

  it('il lock sta guardando qualcosa: le pagine si trovano e qualcuna legge la query', () => {
    expect(tutte.length).toBeGreaterThan(20)
    const conQuery = tutte.filter((p) => fs.readFileSync(p, 'utf8').includes('useSearchParams'))
    // Senza questa misura il test sarebbe verde su una cartella `src/app` rinominata.
    expect(conQuery.length).toBeGreaterThan(5)
  })

  it('nessuna pagina statica legge la query senza `<Suspense>` sopra', () => {
    const scoperte = tutte.filter((percorso) => {
      if (haSegmentoDinamico(percorso)) return false
      const sorgente = fs.readFileSync(percorso, 'utf8')
      return sorgente.includes('useSearchParams') && !sorgente.includes('Suspense')
    })
    expect(
      scoperte,
      'una pagina prerenderizzabile che legge `useSearchParams()` senza confine di ' +
        'sospensione fa cadere `npm run build` con `missing-suspense-with-csr-bailout`. ' +
        'Oggi non cade solo perché `src/app/layout.tsx` fa `await cookies()`, che è un ' +
        'appoggio su un altro file: si estrae il corpo in un componente interno e lo si ' +
        'avvolge in `<Suspense fallback={null}>`, come fanno tutte le altre.',
    ).toEqual([])
  })
})
