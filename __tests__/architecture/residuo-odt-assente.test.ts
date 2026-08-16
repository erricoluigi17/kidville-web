import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * LOCK · dei «Template Certificati ODT» non deve restare NIENTE sotto `src/`.
 *
 * ─── COSA ERA ───────────────────────────────────────────────────────────────────
 *
 * Una linguetta di `/admin/modulistica` prometteva alla Segreteria di caricare la carta
 * intestata della scuola in formato ODT. Era un mockup, e in modo misurabile: i tre
 * `onChange` salvavano il NOME del file scelto in uno `useState` e basta — nessun
 * caricamento, nessuna riga nel database, nessuno storage — e il badge verde spariva al
 * primo aggiornamento della pagina. Chi ci aveva trascinato dentro la carta intestata
 * credeva di averla consegnata al prodotto. La carta vera, da questo ramo, arriva dal
 * motore dei Prestampati (`src/lib/carta/`).
 *
 * ─── PERCHÉ IL LOCK, E NON SOLO LA CANCELLAZIONE ────────────────────────────────
 *
 * Perché la cancellazione, la prima volta, non è stata completa e nessuno se n'è accorto.
 * Tolto il tab il 2026-08-16, la tabella `certificati_templates` è rimasta in `src/`: non
 * come lettura o scrittura — quelle erano davvero zero, ed è la misura che aveva tranquillizzato
 * tutti — ma come **`CREATE TABLE`**, dentro il SQL di `admin/apply-fase4-migration`, con
 * indice, RLS e una `CREATE POLICY … FOR ALL USING (true)`. Cioè il repo si portava dietro la
 * macchina per rifare la tabella che stava dichiarando morta.
 *
 * La lezione che questo file mette per iscritto: **«zero righe la leggono» non è «zero righe
 * la nominano»**. Un residuo che CREA è più vivo di uno che legge.
 *
 * ─── LA MISURA SU CUI POGGIA ────────────────────────────────────────────────────
 *
 * In produzione la tabella non esiste, e non è un'opinione (2026-08-16):
 *   to_regclass('public.certificati_templates')                       → null
 *   pg_class × pg_namespace su tutti gli schemi, qualunque `relkind`  → 0 righe
 * Non c'è quindi nessun `DROP TABLE` da applicare: non c'è mai stata niente da droppare.
 * L'unico posto dove `certificati_templates` esisteva ancora era questo repo.
 */

const RADICE = process.cwd()

/**
 * Le tracce che, sotto `src/`, non devono più comparire — e perché.
 *
 * Sono le MACCHINE: la tabella, l'estensione che il campo di caricamento accettava, il tipo
 * MIME che gli faceva da filtro.
 *
 * ⚠️ Il divieto vale anche per i COMMENTI, e la scelta è stata pesata. L'esenzione della
 * prosa sarebbe stata più gentile — si spiega meglio ciò che si può nominare — ma renderebbe
 * il criterio impossibile da verificare a mano: chi rimisura fa
 * `grep -rn certificati_templates src/`, e una riga di commento gliene restituisce una. Un
 * lock che pretende una cosa diversa da quella che il grep misura è un lock che litiga con
 * chi lo controlla. Quindi il nome esatto vive **qui**, in questo file, che è il posto dove
 * si va a cercare il perché; là dove il blocco è stato tolto si scrive in italiano che cosa
 * c'era e si rimanda a questo lock. Cancellare non è nascondere, se resta scritto dove.
 */
const RESIDUI_VIETATI = new Map<RegExp, string>([
  [
    /certificati_templates/,
    'la tabella dei template ODT: non esiste in produzione e nessuno la legge — ' +
      'se ricompare, ricompare la macchina che la crea',
  ],
  [
    /\.odt\b/i,
    "l'estensione che i tre campi del mockup accettavano: la carta intestata vera è un PDF, " +
      'e vive in `src/lib/carta/asset/`',
  ],
  [
    /vnd\.oasis\.opendocument/i,
    'il tipo MIME dei documenti OpenDocument: filtrava il caricamento che non caricava niente',
  ],
])

function sorgenti(): string[] {
  const trovati: string[] = []
  const cammina = (dir: string) => {
    for (const voce of readdirSync(dir)) {
      const percorso = join(dir, voce)
      if (statSync(percorso).isDirectory()) cammina(percorso)
      else if (/\.(ts|tsx)$/.test(voce)) trovati.push(percorso)
    }
  }
  cammina(join(RADICE, 'src'))
  return trovati
}

const FILE = sorgenti()

/** Le righe di un testo che contengono il residuo, coi loro numeri. */
function righeColResiduo(testo: string, pattern: RegExp): number[] {
  return testo
    .split('\n')
    .map((riga, i) => (pattern.test(riga) ? i + 1 : 0))
    .filter((n) => n > 0)
}

describe('lock architettura · nessun residuo dei template ODT sotto src/', () => {
  it('il lock sta guardando qualcosa: i sorgenti si leggono davvero', () => {
    // Senza questa riga il divieto qui sotto sarebbe verde su una scansione che non
    // trova nessun file — cioè su niente.
    expect(FILE.length).toBeGreaterThan(500)
  })

  it('riconosce il residuo dov’era davvero: il SQL, il campo, il filtro', () => {
    // Controllo positivo. Senza, i tre divieti qui sotto sarebbero verdi anche con una
    // regexp che non prende niente — cioè su un lock che non vieta.
    const finto = [
      '    CREATE TABLE IF NOT EXISTS certificati_templates (',
      "    accept: '.odt',",
      "    type: 'application/vnd.oasis.opendocument.text',",
      '    const nienteDaVedere = 1',
    ].join('\n')
    expect(righeColResiduo(finto, /certificati_templates/)).toEqual([1])
    expect(righeColResiduo(finto, /\.odt\b/i)).toEqual([2])
    expect(righeColResiduo(finto, /vnd\.oasis\.opendocument/i)).toEqual([3])
  })

  for (const [pattern, motivo] of RESIDUI_VIETATI) {
    it(`nessun sorgente nomina ${pattern.source}`, () => {
      const colpevoli: string[] = []
      for (const percorso of FILE) {
        for (const n of righeColResiduo(readFileSync(percorso, 'utf8'), pattern)) {
          colpevoli.push(`${relative(RADICE, percorso)}:${n}`)
        }
      }
      expect(
        colpevoli,
        `Residuo ODT ritrovato in:\n  ${colpevoli.join('\n  ')}\n` +
          `Motivo del divieto: ${motivo}.`,
      ).toEqual([])
    })
  }
})
