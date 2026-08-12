import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileSorgente, mascheraSorgente, riga } from '../fixtures/sorgente'
import { COLONNE_DOCUMENTO } from '@/lib/personale/percorso-documento'
import { PERSONALE_FIELDS } from '@/lib/forms/personale-template'

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  IL NOME DI UNA COLONNA CHE TIENE UN DOCUMENTO NON SI SCRIVE DUE VOLTE       ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * ── PERCHÉ ESISTE QUESTO LOCK, e la misura che l'ha reso necessario ────────────
 *
 * `src/lib/personale/percorso-documento.ts` porta in testata questa promessa, e la
 * fa derivare da `PERSONALE_FIELDS`: le colonne del documento si LEGGONO dal
 * template, non si ribattono. Il 13/08/2026 la promessa era vera nella rotta
 * pubblica e **falsa a un file di distanza**: `src/app/api/gdpr/retention-personale`
 * conteneva
 *
 *     const COLONNE_DOCUMENTO = ['documento_fronte_path', 'documento_retro_path'] as const
 *
 * cioè una seconda sorgente di verità, con accanto un commento che parlava di «un
 * posto solo» riferendosi a sé stessa.
 *
 * ⚠️ LA MISURA, non la deduzione: aggiunto un terzo campo `file`
 * (`documento_terzo_path`) a `PERSONALE_FIELDS`, la suite dava **136 test rossi in
 * 14 file** e `__tests__/api/gdpr-retention-personale.test.ts` restava **93/93
 * VERDE**. Tradotto: una terza faccia sarebbe entrata dal modulo pubblico, sarebbe
 * stata archiviata nel bucket, e la conservazione non l'avrebbe cancellata **mai** —
 * senza che un solo test lo dicesse. Un documento d'identità conservato per sempre è
 * esattamente ciò che quel job esiste per impedire.
 *
 * ── COSA VIETA, e cosa NON vieta (la differenza è tutto) ───────────────────────
 *
 * Vieta una cosa sola: un ELENCO i cui membri sono SOLO nomi di colonne del
 * documento. È quella la seconda sorgente di verità — la lista su cui qualcuno
 * itererà, e che una faccia in più lascerebbe indietro in silenzio.
 *
 * NON vieta che quei nomi compaiano in un elenco più grande, e sono due casi veri
 * che devono continuare a passare:
 *
 *  · `COLONNE_DETTAGLIO` di `admin/anagrafica-personale:GET` li nomina fra trenta
 *    colonne: è una PROIEZIONE esplicita, e una faccia dimenticata lì si vede subito
 *    (il campo non torna), non fra novanta giorni da un file che nessuno cancella;
 *  · la lista di redazione di `@/lib/audit/riassunto` li nomina insieme a
 *    `documento_path` — il nome STORICO, che su `alunni` e `parents` (cioè sui
 *    MINORI) è ancora quello vero. Farla derivare dal template CANCELLEREBBE quel
 *    nome dalla redazione: è il caso in cui la copia è la cosa giusta, e va lasciata
 *    stare.
 *
 * NON vieta nemmeno la mappa `{ fronte: …, retro: … }` di
 * `admin/anagrafica-personale/scansione`: là l'ordine di un array non è un contratto
 * e la scelta di scrivere i due nomi per esteso è dichiarata, con un test che li
 * confronta con `COLONNE_DOCUMENTO`. Un oggetto non è un elenco su cui si itera.
 */

const RADICE = path.join(process.cwd(), 'src')

/** I file che possono nominare le colonne per esteso: è lì che nascono. */
const SORGENTI_LEGITTIME = new Set(['src/lib/forms/personale-template.ts'])

/**
 * Gli elenchi di stringhe letterali del file, come insiemi di valori.
 *
 * Si legge da `senzaCommenti` (commenti spenti, stringhe leggibili): un array
 * scritto DENTRO un commento per spiegare il difetto qui sopra non deve far
 * scattare il lock — in questo repo i commenti che ricopiano il codice sbagliato
 * sono decine, scritti apposta.
 */
function elenchiDiLetterali(src: string): { valori: string[]; indice: number }[] {
  const { senzaCommenti } = mascheraSorgente(src)
  const fuori: { valori: string[]; indice: number }[] = []
  // Un `[` seguito SOLO da stringhe letterali, virgole e spazi, fino al `]`.
  const rx = /\[\s*((?:(['"`])[A-Za-z0-9_]+\2\s*,?\s*)+)\]/g
  let m: RegExpExecArray | null
  while ((m = rx.exec(senzaCommenti)) !== null) {
    const valori = [...m[1].matchAll(/(['"`])([A-Za-z0-9_]+)\1/g)].map((v) => v[2])
    fuori.push({ valori, indice: m.index })
  }
  return fuori
}

/** L'elenco è una SECONDA sorgente di verità sulle colonne del documento? */
function eUnaCopia(valori: string[]): boolean {
  if (valori.length < 2) return false
  return valori.every((v) => (COLONNE_DOCUMENTO as readonly string[]).includes(v))
}

describe('le colonne del documento del personale hanno una sorgente sola', () => {
  it('`COLONNE_DOCUMENTO` si DERIVA dal template, e non è vuota', () => {
    // FAIL-CLOSED al contrario: se un giorno la lettura tornasse vuota, tutto il
    // resto di questo file diventerebbe vacuamente verde — `every` su un insieme
    // vuoto risponde `true`, e nessuna copia verrebbe più riconosciuta.
    const dalTemplate = PERSONALE_FIELDS.filter((c) => c.type === 'file').map((c) => c.id)
    expect(dalTemplate.length).toBeGreaterThanOrEqual(2)
    expect([...COLONNE_DOCUMENTO]).toEqual(dalTemplate)
  })

  it('nessun file di `src/` ridichiara l’elenco delle colonne del documento', () => {
    const colpe: string[] = []
    for (const file of fileSorgente(RADICE)) {
      const rel = path.relative(process.cwd(), file).split(path.sep).join('/')
      if (SORGENTI_LEGITTIME.has(rel)) continue
      const src = fs.readFileSync(file, 'utf8')
      for (const elenco of elenchiDiLetterali(src)) {
        if (!eUnaCopia(elenco.valori)) continue
        colpe.push(`${rel}:${riga(src, elenco.indice)} → [${elenco.valori.join(', ')}]`)
      }
    }
    expect(
      colpe,
      'Questo elenco ricopia i nomi delle colonne che tengono il documento d’identità del ' +
        'personale invece di leggerli da `COLONNE_DOCUMENTO` (@/lib/personale/percorso-documento). ' +
        'Il giorno in cui il template dichiara una faccia in più, questa copia resta indietro in ' +
        'silenzio: il file entra nel bucket e la conservazione non lo cancella mai. È il difetto ' +
        'misurato il 13/08/2026 su `gdpr/retention-personale` — 136 test rossi ovunque, e quel ' +
        'file 93/93 verde.',
    ).toEqual([])
  })

  it('`gdpr/retention-personale` legge le colonne dal modulo condiviso', () => {
    // NOMINATO, e non lasciato al lock generico: è il file in cui la copia è vissuta,
    // ed è anche l'unico in cui la sua assenza non produrrebbe nessun rosso. Un lock
    // che vieta una forma non garantisce che la forma giusta sia stata adottata.
    const src = fs.readFileSync(
      path.join(RADICE, 'app/api/gdpr/retention-personale/route.ts'),
      'utf8',
    )
    expect(
      /import\s*\{[^}]*\bCOLONNE_DOCUMENTO\b[^}]*\}\s*from\s*['"]@\/lib\/personale\/percorso-documento['"]/.test(
        src,
      ),
      'la conservazione del personale non importa `COLONNE_DOCUMENTO`: sta di nuovo decidendo ' +
        'da sola quali colonne tengono un documento',
    ).toBe(true)
  })

  it('CONTROLLO POSITIVO: il rilevatore riconosce la copia che è davvero esistita', () => {
    // Un lock che non si sa se guarda qualcosa è peggio di nessun lock. Qui si dà in
    // pasto al rilevatore la riga ESATTA che stava in `retention-personale` fino al
    // 13/08/2026, e si pretende che scatti.
    const copiaVera =
      "const COLONNE_DOCUMENTO = ['documento_fronte_path', 'documento_retro_path'] as const"
    const trovati = elenchiDiLetterali(copiaVera).filter((e) => eUnaCopia(e.valori))
    expect(trovati, 'il rilevatore non riconosce più la copia che ha motivato questo lock').toHaveLength(1)

    // E il suo complementare: una proiezione che nomina le due colonne in mezzo ad
    // altre NON deve scattare, altrimenti il lock verrebbe spento dal primo falso
    // allarme — che è il modo più rapido perché un presidio sparisca.
    const proiezione = "const COLONNE = ['fiscal_code', 'documento_fronte_path', 'documento_retro_path']"
    expect(elenchiDiLetterali(proiezione).filter((e) => eUnaCopia(e.valori))).toHaveLength(0)

    // E il commento che RICOPIA il difetto per spiegarlo resta invisibile al lock.
    const dentroUnCommento = `// era: ['documento_fronte_path', 'documento_retro_path']\nconst x = 1`
    expect(elenchiDiLetterali(dentroUnCommento).filter((e) => eUnaCopia(e.valori))).toHaveLength(0)
  })
})
