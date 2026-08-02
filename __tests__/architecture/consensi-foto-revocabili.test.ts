import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK · un consenso che non si può revocare non è un consenso
//
// LA STORIA. Il 2026-08-01 nascono due colonne nuove — `consenso_foto_sito` e
// `consenso_foto_social` — perché il modulo d'iscrizione chiede tre consensi
// fotografici distinti, uno per canale (provv. Garante 725 del 27/11/2025), e
// fino a quel giorno solo il primo aveva una destinazione. La migrazione le
// riempie dalle domande già approvate: 141 famiglie avevano risposto.
//
// Il collaudo dello stesso giorno ha trovato che le due colonne erano SOLA
// SCRITTURA D'IMPORTAZIONE: lo schema zod di `PATCH /api/admin/students`
// conosceva solo `consenso_privacy`, `allowedFields` pure, e il pannello
// dell'anagrafica mostrava una sola spunta. Una famiglia che cambiava idea non
// aveva nessuna strada per farlo registrare — art. 7 §3 GDPR: «revocare il
// consenso dev'essere facile quanto prestarlo».
//
// PERCHÉ UN LOCK, e non solo i test della route. Il difetto non stava in un
// comportamento sbagliato ma in una CATENA INTERROTTA: colonna → schema →
// allowlist → interfaccia. Tre anelli su quattro erano a posto. Un test della
// route sorveglia due anelli; questo li guarda tutti, ed è la ragione per cui il
// prossimo consenso che verrà aggiunto (un quarto canale, un consenso diverso)
// non potrà fermarsi a metà strada senza che qualcosa diventi rosso.
//
// PERCHÉ TESTUALE. Montare il pannello dell'anagrafica in un test significa
// portarsi dietro next-intl, il router, i fetch delle sezioni e dei fratelli:
// costa più del gate intero e diventerebbe fragile per motivi che non c'entrano
// con i consensi. Qui si guarda che ogni anello NOMINI il campo — che è
// esattamente ciò che mancava.
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = process.cwd()
const leggi = (rel: string) => readFileSync(join(RADICE, rel), 'utf8')

const ROUTE = 'src/app/api/admin/students/route.ts'
const PANNELLO = 'src/components/features/admin/StudentDetailPanel.tsx'

/**
 * I tre canali, con la chiave di catalogo dell'etichetta che li accompagna.
 * `consenso_privacy` è il canale storico (galleria riservata): sta qui come
 * CONTROLLO POSITIVO — se il parser smettesse di trovare le occorrenze, sarebbe
 * lui a cadere per primo, e le altre due prove non sarebbero verdi per finta.
 */
const CANALI = [
  { colonna: 'consenso_privacy', etichetta: 'detailLiberatoria' },
  { colonna: 'consenso_foto_sito', etichetta: 'detailConsensoSito' },
  { colonna: 'consenso_foto_social', etichetta: 'detailConsensoSocial' },
] as const

/** Il blocco `const allowedFields = [ … ]` della PATCH singola. */
function allowedFields(): string[] {
  const m = leggi(ROUTE).match(/const\s+allowedFields\s*=\s*\[([\s\S]*?)\]/)
  if (!m) return []
  return [...m[1].matchAll(/'([a-z_]+)'/gi)].map((x) => x[1])
}

describe('lock architettura · i consensi fotografici si possono revocare da un’interfaccia', () => {
  it('l’allowlist della PATCH si legge davvero (sanity)', () => {
    // Un parser rotto renderebbe verdi per sempre le prove qui sotto, su niente.
    expect(allowedFields().length).toBeGreaterThan(20)
  })

  it.each(CANALI)('`$colonna` è accettato dallo schema zod della PATCH', ({ colonna }) => {
    expect(
      new RegExp(`${colonna}\\s*:\\s*z\\.`).test(leggi(ROUTE)),
      `Lo schema zod di ${ROUTE} non dichiara \`${colonna}\`: la richiesta viene ` +
        'scartata dalla validazione prima ancora di arrivare all\'allowlist, e la revoca ' +
        'non ha nessuna strada.',
    ).toBe(true)
  })

  it.each(CANALI)('`$colonna` è nell’allowlist dei campi aggiornabili', ({ colonna }) => {
    expect(
      allowedFields(),
      `\`${colonna}\` non è in \`allowedFields\`: il campo arriva validato e poi viene ` +
        'buttato via in silenzio — il salvataggio risponde 200 e non cambia niente, che è ' +
        'il modo peggiore di non funzionare.',
    ).toContain(colonna)
  })

  it.each(CANALI)('`$colonna` ha un comando nell’anagrafica ($etichetta)', ({ colonna, etichetta }) => {
    const pannello = leggi(PANNELLO)
    expect(
      pannello.includes(`form.${colonna}`),
      `Il pannello dell'anagrafica non mostra nessun comando per \`${colonna}\`. La route ` +
        'saprebbe scriverlo, ma nessuno in segreteria può farlo: per la famiglia che ha ' +
        'cambiato idea è come se la revoca non esistesse.',
    ).toBe(true)
    expect(
      pannello.includes(`t('${etichetta}')`),
      `Manca l'etichetta \`${etichetta}\` accanto al comando di \`${colonna}\`: una spunta ` +
        'senza nome non dice a chi la usa quale canale sta aprendo o chiudendo.',
    ).toBe(true)
  })

  it.each(CANALI)('l’etichetta di `$colonna` è tradotta in ENTRAMBE le lingue', ({ etichetta }) => {
    for (const lingua of ['it', 'en']) {
      const catalogo = JSON.parse(leggi(`messages/${lingua}/adminStudents.json`)) as Record<string, string>
      expect(
        catalogo[etichetta],
        `Manca \`${etichetta}\` nel catalogo ${lingua}: con l'interfaccia in quella lingua ` +
          'la spunta resterebbe senza nome, o col nome nell\'altra lingua.',
      ).toBeTruthy()
    }
  })
})
