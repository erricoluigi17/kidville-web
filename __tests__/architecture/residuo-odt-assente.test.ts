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
 * Sono le MACCHINE, non la parola: la tabella, l'estensione che il campo di caricamento
 * accettava, il tipo MIME che gli faceva da filtro. Nominare `certificati_templates` in una
 * riga di commento non è un residuo — è il modo in cui si spiega a chi verrà dopo perché
 * quel blocco non c'è più. Un lock che vieta anche di PARLARE della cosa morta obbliga a
 * cancellarla in silenzio, ed è il silenzio che ha fatto sopravvivere questo residuo.
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

/** Una riga di commento è prosa: spiega, non esegue. */
function eCommento(riga: string): boolean {
  return /^\s*(\/\/|\/\*|\*|--)/.test(riga)
}

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

/** Le righe ESEGUIBILI di un testo che contengono il residuo, coi loro numeri. */
function righeColResiduo(testo: string, pattern: RegExp): number[] {
  return testo
    .split('\n')
    .map((riga, i) => (!eCommento(riga) && pattern.test(riga) ? i + 1 : 0))
    .filter((n) => n > 0)
}

describe('lock architettura · nessun residuo dei template ODT sotto src/', () => {
  it('il lock sta guardando qualcosa: i sorgenti si leggono davvero', () => {
    // Senza questa riga il divieto qui sotto sarebbe verde su una scansione che non
    // trova nessun file — cioè su niente.
    expect(FILE.length).toBeGreaterThan(500)
  })

  it("l'esenzione dei commenti non spegne il lock: il SQL vero resta preso", () => {
    // È il controllo che tiene onesta la regola qui sopra. Se «prosa» finisse per
    // includere anche il codice, questo file diventerebbe un lock che non vieta niente.
    const finto = [
      '    -- 5. Tabella Template Certificati (ODT)',
      '    CREATE TABLE IF NOT EXISTS certificati_templates (',
      "    accept: '.odt',",
    ].join('\n')
    expect(righeColResiduo(finto, /certificati_templates/)).toEqual([2])
    expect(righeColResiduo(finto, /\.odt\b/i)).toEqual([3])
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
