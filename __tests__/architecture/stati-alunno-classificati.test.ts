import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATI_TENDINA } from '@/lib/alunni/stato'

// =============================================================================
// LA PROMESSA CHE `@/lib/alunni/stato` FACEVA SENZA POTERLA MANTENERE.
//
// Fino al 2026-08-12 quel modulo scriveva: «un elenco chiuso, il giorno che si
// aggiunge uno stato, rende rosso `__tests__/lib/alunni-stato.test.ts`». Era
// falso, ed è stato MISURATO in collaudo il 2026-08-12: aggiungendo
// `<option value="trasferito">` alla tendina di `StudentDetailPanel.tsx` sono
// rimasti verdi 997 test. Quel file importa solo dal modulo, e la tendina non la
// vede nessuno. (La stessa aggiunta, con questo file in piedi, è rossa: provata
// prima di scriverlo e non dedotta.)
//
// La via per cui uno stato nuovo entra davvero in produzione è la `<select>`:
// la PATCH di `admin/students` valida `stato` con `z.unknown()` e la colonna non
// ha vincolo `CHECK`, quindi qualunque `value=` scritto lì arriva intatto in
// tabella. E uno stato non classificato non è un dettaglio estetico: quei
// bambini diventano DEFINITIVAMENTE non cancellabili — 409 su `gdpr/erase`,
// assenti da `gdpr/candidates` — cioè un'istanza dell'art. 17 che il prodotto
// non sa evadere.
//
// Il giro si chiude in tre direzioni:
//   1. una `<option>` nuova nella tendina, non dichiarata → rosso QUI;
//   2. una voce tolta da `STATI_TENDINA` mentre la tendina la offre → rosso QUI;
//   3. una voce nuova in `STATI_TENDINA` non classificata → rosso in
//      `__tests__/lib/alunni-stato.test.ts`, che è il file dove si DECIDE di che
//      parte del confine sta.
//
// ⚠️ E SE L'ÀNCORA SPARISCE, IL LOCK NON TACE. Un file che non offre più nessuno
// degli stati noti **e** non nomina `STATI_TENDINA` è un lock che ha smesso di
// guardare, e qui è rosso. Un guard verde perché non trova più niente è peggio
// di nessun guard: è quello che ha fatto passare 997 test su una tendina con uno
// stato di troppo.
// =============================================================================

/** I due punti in cui il prodotto offre uno stato all'alunno (misurati il 2026-08-12). */
const TENDINE = [
  // La tendina che SCRIVE: `StudentDetailPanel` → PATCH `admin/students`.
  'src/components/features/admin/StudentDetailPanel.tsx',
  // Il filtro dell'elenco: non scrive, ma dichiara quali stati il prodotto crede
  // che esistano. Se i due insiemi divergono, un bambino esiste in anagrafica e
  // non è filtrabile da nessuna parte.
  'src/app/(dashboard)/admin/students/page.tsx',
]

/**
 * QUALUNQUE `<option value="…">…</option>`, etichetta COMPRESA COM'È SCRITTA.
 *
 * ⚠️ QUESTA RIGA È NATA DA UN BUCO MISURATO, e il buco aveva la forma esatta che
 * questo file dichiarava di sorvegliare. Fino al 2026-08-13 il pattern era
 * `<option value="([^"]*)">\{t\('([^']*)'\)\}<\/option>`: PRETENDEVA l'etichetta
 * `{t('…')}` per riconoscere un'opzione. Due mutazioni sulla tendina di
 * `StudentDetailPanel.tsx`, eseguite:
 *   · `<option value="trasferito">{t('statoTrasferito')}</option>` → **rosso**, 1/6;
 *   · `<option value="trasferito">Trasferito</option>`             → **verde**, 6/6.
 * Cioè: lo stato nuovo passava indisturbato proprio scrivendo l'etichetta a mano,
 * che è anche la scorciatoia più probabile di chi aggiunge una voce in fretta. Il
 * secondo `it` prometteva di prendere «un'etichetta scritta a mano invece che con
 * `t()`» e non poteva scattare: `opzioniDellaTendina` scartava quelle opzioni con
 * questa stessa regex PRIMA di restituirle. Un filtro che elimina i casi che il
 * test successivo esiste per giudicare.
 *
 * Adesso l'etichetta si CATTURA GREZZA e la si giudica dopo. Le due domande sono
 * separate: «quali valori offre la tendina» (il lock degli stati) e «l'etichetta
 * è quella giusta, e passa da `t()`» (il lock dell'i18n). Nessuna delle due può
 * più far sparire dall'altra il caso che la interessa.
 */
const OPZIONE = /<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g
/** L'etichetta ammessa: `{t('statoQualcosa')}`, e nient'altro. */
const ETICHETTA_TRADOTTA = /^\{t\('([^']*)'\)\}$/
/** L'àncora: una qualunque `<option>` di uno stato noto. */
const ANCORA = (s: string) => `<option value="${s}"`

/**
 * Le voci che NON sono stati e stanno nella stessa tendina, dichiarate una per
 * una. `all` è il «tutti gli stati» del filtro: non finisce mai in colonna
 * perché quella tendina non scrive, filtra. L'elenco è per file e chiuso — una
 * voce nuova non può nascondersi dietro l'etichetta di «sentinella».
 */
const SENTINELLE: Record<string, string[]> = {
  'src/app/(dashboard)/admin/students/page.tsx': ['all'],
  'src/components/features/admin/StudentDetailPanel.tsx': [],
}

/**
 * Le opzioni della `<select>` DELLO STATO, prese dal blocco intero.
 *
 * Non si cercano le opzioni per nome — sarebbe circolare: troverebbe solo quelle
 * che ci si aspetta, e una `<option value="trasferito">` aggiunta domani
 * resterebbe invisibile, che è esattamente il difetto. Si trova la tendina (dal
 * primo stato noto) e poi si legge TUTTO ciò che offre.
 */
function opzioniDellaTendina(file: string): { valore: string; etichetta: string }[] {
  const sorgente = readFileSync(file, 'utf8')
  const posizioni = STATI_TENDINA.map((s) => sorgente.indexOf(ANCORA(s))).filter((i) => i >= 0)
  if (posizioni.length === 0) {
    // Deroga unica ed esplicita: il giorno in cui la tendina si genererà dalla
    // costante condivisa non ci saranno più `<option>` letterali, e sarà un
    // miglioramento. Il lock lo accetta solo se il file nomina `STATI_TENDINA`.
    expect(
      sorgente,
      `${file}: nessuna \`<option>\` di uno stato noto e nessun riferimento a ` +
      `\`STATI_TENDINA\`. O la tendina si è spostata, o ha cambiato forma: in ` +
      `entrambi i casi questo lock ha smesso di guardarla e va riportato sul punto giusto.`,
    ).toMatch(/\bSTATI_TENDINA\b/)
    return []
  }
  const dentro = Math.min(...posizioni)
  const apre = sorgente.lastIndexOf('<select', dentro)
  const chiude = sorgente.indexOf('</select>', dentro)
  expect(apre >= 0 && chiude > apre, `${file}: la tendina dello stato non è dentro un <select>`).toBe(true)
  const sentinelle = SENTINELLE[file] ?? []
  return [...sorgente.slice(apre, chiude).matchAll(OPZIONE)]
    // `etichetta` è il testo GREZZO fra i due tag, `trim`ato solo per tollerare
    // un'opzione andata a capo: che sia una chiamata a `t()` lo decide il test,
    // non questo filtro. Vedi il perché sopra `OPZIONE`.
    .map((m) => ({ valore: m[1], etichetta: m[2].trim() }))
    .filter((o) => !sentinelle.includes(o.valore))
}

describe('lock architettura · ogni stato che la tendina offre è classificato dal modulo', () => {
  it.each(TENDINE)('%s offre esattamente gli stati dichiarati', (file) => {
    const opzioni = opzioniDellaTendina(file)
    if (opzioni.length === 0) return // deroga già verificata: rende dalla costante
    expect(
      [...new Set(opzioni.map((o) => o.valore))].sort(),
      `Gli stati offerti da ${file} non coincidono con \`STATI_TENDINA\`. Uno stato ` +
      `che la tendina scrive e il modulo non conosce non è classificabile: per ` +
      `\`gdpr/candidates\` quel bambino non esiste e per \`gdpr/erase\` è un 409 — ` +
      `cioè un diritto all'oblio che il prodotto non sa evadere. Aggiungilo a ` +
      `\`STATI_TENDINA\` e DECIDI di che parte del confine sta.`,
    ).toEqual([...STATI_TENDINA].sort())
  })

  it.each(TENDINE)('%s non attacca a uno stato l\'etichetta di un altro', (file) => {
    // `<option value="ritirato">{t('statoSospeso')}</option>` sarebbe una tendina
    // che scrive una cosa e ne mostra un'altra: nessun test di comportamento se
    // ne accorgerebbe, e la segreteria archivierebbe un bambino credendo di
    // sospenderlo.
    //
    // ⚠️ E PRIMA ANCORA: l'etichetta dev'essere una chiamata a `t()`. Un'etichetta
    // scritta a mano è italiano cablato in un'interfaccia che ha due lingue — e
    // fino al 2026-08-13 era anche il modo di aggiungere uno stato senza far
    // rosso niente, perché la regex che raccoglie le opzioni pretendeva `{t()}` e
    // quindi le opzioni scritte a mano non arrivavano nemmeno qui. Le due
    // asserzioni stanno in quest'ordine perché è l'ordine in cui si sbaglia.
    for (const { valore, etichetta } of opzioniDellaTendina(file)) {
      const chiave = ETICHETTA_TRADOTTA.exec(etichetta)?.[1]
      expect(
        chiave,
        `${file}: l'opzione «${valore}» ha l'etichetta \`${etichetta}\`, che non passa da ` +
        '`t()`. Un\'etichetta letterale è italiano cablato in un\'interfaccia bilingue, ed è ' +
        'la forma con cui uno stato nuovo entra in tendina senza che nessun lock lo veda.',
      ).toBeDefined()
      expect(chiave, `${file}: l'opzione «${valore}» mostra l'etichetta \`${etichetta}\``)
        .toBe(`stato${valore.charAt(0).toUpperCase()}${valore.slice(1)}`)
    }
  })

  it('nessun\'altra tendina di stato è rimasta fuori da questo elenco', () => {
    // Il lock guarda due file per nome: se domani ne nasce un terzo, guardare
    // solo questi due sarebbe una cecità silenziosa. Qui si cerca su TUTTO
    // `src/` un'opzione di uno stato noto, e si pretende che i file che la
    // contengono siano tutti e soli quelli dichiarati.
    const trovati = sorgenti('src', '.tsx').filter((f) => {
      const testo = readFileSync(f, 'utf8')
      return STATI_TENDINA.some((s) => testo.includes(ANCORA(s)))
    })
    expect(
      trovati.sort(),
      'Un file offre stati dell\'alunno e non è sorvegliato: aggiungilo a `TENDINE`.',
    ).toEqual([...TENDINE].sort())
  })

  it('il valore che ENTRA in colonna passa dalla costante, non da una stringa', () => {
    // L'altra metà di rilievo: la costante deve governare almeno ciò che si
    // SCRIVE. Fino al 2026-08-12 `@/lib/alunni/stato` sosteneva di governare
    // anche i filtri di lettura e non era vero (11 punti con la stringa a mano);
    // le scritture erano cinque, e sono passate dalla costante. Questa riga
    // impedisce alla sesta di nascere già scollegata.
    //
    // ⚠️ QUESTA REGEX NON DISTINGUE IL CODICE DAI COMMENTI, ed è voluto: un
    // commento che cita `stato: '…'` — per esempio riportando il corpo di una
    // `PATCH` misurata — diventa rosso e va riscritto (`stato` = `'iscritto'`).
    // È un fastidio piccolo, e il verso in cui si sbaglia è quello giusto: per
    // capire dov'è un letterale «vero» servirebbe un parser, e un lock che tenta
    // di riconoscere le stringhe dentro un template o una concatenazione
    // sbaglierebbe lasciando passare una scrittura, non un commento.
    const colpevoli = [...sorgenti('src', '.ts'), ...sorgenti('src', '.tsx')].filter((f) =>
      /\bstato:\s*'(iscritto|ritirato|sospeso)'/.test(readFileSync(f, 'utf8')),
    )
    expect(
      colpevoli.sort(),
      'Qui si scrive `alunni.stato` con una stringa letterale: usa `STATO_ISCRITTO` / ' +
      '`STATO_RITIRATO` da `@/lib/alunni/stato`, che è il posto in cui quel valore è deciso.',
    ).toEqual([])
  })
})

/** Tutti i sorgenti con una certa estensione sotto una cartella, ricorsivamente. */
function sorgenti(cartella: string, estensione: string): string[] {
  const out: string[] = []
  for (const voce of readdirSync(cartella, { withFileTypes: true })) {
    const p = join(cartella, voce.name)
    if (voce.isDirectory()) out.push(...sorgenti(p, estensione))
    else if (voce.name.endsWith(estensione)) out.push(p)
  }
  return out
}
