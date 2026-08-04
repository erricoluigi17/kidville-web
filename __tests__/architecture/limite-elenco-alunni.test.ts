import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { LIMITE_ELENCO_ALUNNI } from '@/lib/api/paginazione'

// =============================================================================
// T11-F5 (seconda metà) — il tetto ribattuto a mano in DIECI file.
//
// «Una regola valida per due strade deve vivere in un posto solo» è la lezione
// che questo repo ha già pagato — POST/PUT avvisi, tasks/avvisi, 1 OTP su 4 —
// e qui le strade sono dieci. Dieci copie del numero `1000` sono dieci
// occasioni di cambiarne nove: chi alzasse il tetto della route senza rifare
// il giro delle pagine lascerebbe otto elenchi ancora tagliati, e senza
// nessun errore che lo dica.
//
// Il lock è testuale perché il difetto È testuale: un numero scritto a mano
// in un template literal non ha nessun comportamento da osservare finché non
// esiste la 1001-esima riga in produzione. Quello che il lock NON può provare
// — che l'elenco tronchi rumorosamente — è provato altrove, e da un test di
// comportamento: `__tests__/api/students-troncamento-visibile.test.ts`.
// =============================================================================

/** I dieci punti che chiedono l'elenco alunni (misurati il 2026-08-04). */
const CHIAMANTI = [
  'src/app/(dashboard)/admin/mensa/page.tsx',
  'src/app/(dashboard)/admin/students/page.tsx',
  'src/app/(dashboard)/admin/students/sezioni/[id]/page.tsx',
  'src/app/(dashboard)/admin/protocolli/page.tsx',
  'src/components/features/admin/SectionsView.tsx',
  'src/components/features/admin/mensa/PrenotazioneSegreteria.tsx',
  'src/components/features/admin/pagamenti/PaymentsDashboard.tsx',
  'src/components/features/admin/pagamenti/GeneratoreCategoria.tsx',
  'src/components/features/admin/pagamenti/TicketMensaPanel.tsx',
  'src/components/features/admin/pagamenti/FiscalePanel.tsx',
]

const sorgente = (f: string) => readFileSync(f, 'utf8')

describe('il tetto degli elenchi alunni vive in UN POSTO SOLO', () => {
  it.each(CHIAMANTI)('%s non scrive il tetto a mano', (file) => {
    const testo = sorgente(file)
    // Nessun `limit=<numero>` letterale nell'URL: né 1000, né un altro valore
    // inventato sul momento.
    const letterali = testo.match(/limit=\d+/g) ?? []
    expect(letterali).toEqual([])
  })

  it.each(CHIAMANTI)('%s importa la costante condivisa e la usa nell\'URL', (file) => {
    const testo = sorgente(file)
    expect(testo).toMatch(/import\s*\{[^}]*\bLIMITE_ELENCO_ALUNNI\b[^}]*\}\s*from\s*'@\/lib\/api\/paginazione'/)
    // E la usa DOVE serve: interpolata nella query string dell'elenco alunni.
    expect(testo).toMatch(/limit=\$\{LIMITE_ELENCO_ALUNNI\}/)
  })

  it('la costante non supera il massimo che la route accetta davvero', () => {
    // Un tetto più alto del clamp della route non allarga niente: dà solo
    // l'illusione di averlo alzato. Il massimo si legge dallo schema zod.
    const route = sorgente('src/app/api/admin/students/route.ts')
    const clamp = /Math\.min\(Math\.max\(Number\(v \?\? \d+\) \|\| \d+, \d+\), (\d+)\)/.exec(route)
    expect(clamp, 'clamp del `limit` non più riconoscibile in students/route.ts').not.toBeNull()
    expect(LIMITE_ELENCO_ALUNNI).toBeLessThanOrEqual(Number(clamp![1]))
  })
})
