// @vitest-environment node
/**
 * LOCK · «questo bambino ha un'allergia» si decide in UN POSTO SOLO, e quel posto
 * è `src/lib/mensa/allergeni.ts`. La nota medica NON è un'allergia.
 *
 * ─── IL DIFETTO, misurato in produzione il 2026-09-07 ──────────────────────────
 *
 * Nel repo convivevano due mondi che si chiamavano tutti e due «allergie»:
 *  · gli ALLERGENI veri — `alunni.allergeni` (le 14 chiavi UE) e `alunni.allergies`
 *    (il testo libero) — che la sezione Mensa/Cucina usava correttamente;
 *  · le NOTE MEDICHE — `alunni.note_mediche`, che il modulo d'iscrizione etichetta
 *    letteralmente «Note Mediche (BES, DSA, patologie)»
 *    (`src/lib/forms/enrollment-template.ts`).
 *
 * Tutto ciò che l'utente vedeva sotto la parola «Allergie» contava il secondo:
 * la StatCard dell'anagrafica, i badge della tabella e della card, il riquadro
 * della home del docente, l'alert del PRANZO nel diario, il campo `allergie` della
 * scheda attività. Misurato il 2026-09-07 su **657 iscritti non archiviati**: 44
 * note mediche, 63 testi `allergies` (6 negazioni ⇒ 57 operativi, 27 conteggiabili
 * fra i 14 UE), **29 bambini con una nota medica e nessuna allergia** — contati
 * ogni giorno fra gli allergici — e **zero** delle 44 note che nomini un
 * allergene. ⚠️ Sono una fotografia: crescono, si rimisurano, non si copiano.
 *
 * Nessun test era rosso, e non poteva esserlo: `note_mediche` è una colonna vera,
 * valorizzata, e il codice la leggeva bene. Sbagliava la DOMANDA, non la lettura.
 *
 * ─── COSA SORVEGLIA ────────────────────────────────────────────────────────────
 *  1. I predicati del motore hanno UNA definizione sola, e sta nel motore.
 *  2. Nessun file fuori dal motore ricava un CONTEGGIO o un BADGE «allergie»
 *     da `note_mediche`: niente `filter(… note_mediche …)` sotto una parola che
 *     dice allergia, niente `hasAllergie = … note_mediche`.
 *  3. I consumatori IMPORTANO il predicato invece di riscriverlo, e nessuno si
 *     ricostruisce la regola della negazione con una regex propria.
 *  4. Il motore resta importabile dal SERVER (le rotte lo importano).
 *
 * NON verifica che la regola sia GIUSTA: quello è
 * `__tests__/lib/allergeni-motore.test.ts` (i predicati, la negazione a
 * vocabolario intero, il caso reale che il criterio a sottostringa cancellava) e
 * `__tests__/api/students-segnale-allergie.test.ts` (i due segnali sulla risposta
 * vera della rotta, su tre alunni disgiunti).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const RADICE = path.join(process.cwd(), 'src')

const MOTORE = path.join('src', 'lib', 'mensa', 'allergeni.ts')

/** I predicati che compongono la politica: una definizione a testa, nel motore. */
const PREDICATI = ['haAllergiaConteggiabile', 'haAllergiaOperativa', 'isNegazione', 'allergeniAlunno', 'chiaviAllergeni', 'etichetteAllergie']

/** Via i commenti: un lock non si aggira — né si innesca — con una frase. */
const soloCodice = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

function fileTs(dir: string, out: string[] = []): string[] {
  for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, voce.name)
    if (voce.isDirectory()) fileTs(p, out)
    else if (/\.tsx?$/.test(voce.name)) out.push(p)
  }
  return out
}

const FILE = fileTs(RADICE).map((assoluto) => ({
  relativo: path.relative(process.cwd(), assoluto),
  codice: soloCodice(fs.readFileSync(assoluto, 'utf-8')),
}))

const di = (relativo: string) => FILE.find((f) => f.relativo === relativo)

/**
 * Le righe in cui si LEGGE il VALORE della nota medica e, nella stessa riga, si
 * parla di allergie. È la firma esatta del difetto: un conteggio, un badge o un
 * campo che si chiama allergia e prende il suo valore da `note_mediche`.
 *
 * ⚠️ IL CRITERIO È PER RIGA, E DISTINGUE IL VALORE DAL NOME DELLA COLONNA. La
 * prima stesura guardava la sola compresenza delle due parole e trovava SETTE
 * righe innocenti: elenchi di colonne (`allowedFields`, `COLONNE_FRAGILI`,
 * `CHIAVI_SANITARIE_ISCRIZIONE`, il riassunto d'audit), la stringa di `select()`
 * di `diary/students`, la destrutturazione della rotta dell'elenco e un tipo in
 * `TaskCard`. Lì «note_mediche» è il NOME di una colonna che sta accanto a
 * un'altra: nessuno ci sta contando niente. Un lock che segna quelle righe è un
 * lock che si impara a spegnere.
 *
 * Il valore si legge in un modo solo: `qualcosa.note_mediche` (o
 * `.ha_note_mediche`, il segnale della lista). Quello è il difetto.
 */
function righeChePartonoDallaNota(codice: string): string[] {
  const colpevoli: string[] = []
  for (const riga of codice.split('\n')) {
    if (!/\.\s*(?:ha_)?note_mediche\b/.test(riga)) continue
    if (!/allerg/i.test(riga)) continue
    colpevoli.push(riga.trim())
  }
  // ⚠️ E LA STESSA COSA SU PIÙ RIGHE, che il giro per riga NON vede. Provato
  // rompendo il codice apposta: riportando la home del docente a
  //     const allergie = students.filter(
  //       (s) => s.note_mediche && …
  //     )
  // il difetto è tornato ESATTAMENTE com'era e la regola per riga è rimasta
  // verde, perché la parola «allergie» sta sulla riga sopra. Un lock che non
  // vede l'unica forma in cui il difetto è davvero comparso non è un lock.
  //
  // Qui si guarda l'ASSEGNAZIONE: un nome che contiene «allerg», un `=` o un `:`,
  // e poco dopo — a capo quanto vuole, ma senza attraversare un `;` o una graffa,
  // cioè restando nella stessa espressione — la LETTURA di `.note_mediche`.
  // La VIRGOLA chiude il frammento come il punto e virgola: due proprietà vicine
  // in un oggetto (`allergies: c.allergies ?? null, note_mediche: c.note_mediche`)
  // sono una COPIA di due colonne, non una derivazione — misurato, erano gli unici
  // due falsi positivi rimasti (`admin/iscrizioni` e `prestampati/banco`).
  for (const [frammento] of codice.matchAll(/\w*allerg\w*\s*[:=]\s*[^;{},]{0,240}?\.\s*(?:ha_)?note_mediche\b/gi)) {
    colpevoli.push(frammento.replace(/\s+/g, ' ').trim())
  }
  return colpevoli
}

/** Gli specificatori importati da un file: `import`, `import type`, `import()`. */
function specificatori(codice: string): string[] {
  const trovati: string[] = []
  for (const [, s] of codice.matchAll(/^[ \t]*import\s+[^;]*?from\s+['"]([^'"]+)['"]/gm)) trovati.push(s)
  for (const [, s] of codice.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) trovati.push(s)
  return trovati
}

describe('LOCK · un motore solo per «ha un\'allergia», e non è la nota medica', () => {
  it('la misura vede davvero i sorgenti (controllo positivo)', () => {
    // Senza questo, un percorso sbagliato renderebbe VERDI tutte le regole qui
    // sotto: «zero file letti» e «zero violazioni» hanno lo stesso colore.
    expect(FILE.length).toBeGreaterThan(500)
    expect(FILE.map((f) => f.relativo)).toContain(MOTORE)
    // E il motore contiene davvero ciò che il lock crede di sorvegliare.
    expect(di(MOTORE)!.codice).toContain('haAllergiaConteggiabile')
  })

  it('i predicati hanno UNA definizione sola, e sta nel motore', () => {
    for (const nome of PREDICATI) {
      const re = new RegExp(`export\\s+function\\s+${nome}\\b`)
      const definizioni = FILE.filter((f) => re.test(f.codice)).map((f) => f.relativo)
      expect(
        definizioni,
        `${nome} deve essere definita una volta sola, in ${MOTORE}: una seconda copia ` +
          'è la divergenza che questo lock esiste per impedire.',
      ).toEqual([MOTORE])
    }
  })

  it('nessun file ricava un CONTEGGIO o un BADGE «allergie» da `note_mediche`', () => {
    const colpevoli: string[] = []
    for (const f of FILE) {
      if (f.relativo === MOTORE) continue
      for (const riga of righeChePartonoDallaNota(f.codice)) {
        colpevoli.push(`${f.relativo} → ${riga}`)
      }
    }
    expect(
      colpevoli,
      '`note_mediche` è la casella «Note Mediche (BES, DSA, patologie)» del modulo\n' +
        'd\'iscrizione: non è un\'allergia, e in produzione ZERO delle 44 note ne nomina una.\n' +
        'Una riga che mette insieme la parola «allergia» e `note_mediche` è il difetto che\n' +
        'ha fatto contare 44 bambini al posto di 27 (misurato il 2026-09-07). Le\n' +
        'allergie si chiedono a\n' +
        '`haAllergiaConteggiabile` (contatori e badge) o a `haAllergiaOperativa`\n' +
        '(elenchi della cucina), e la nota medica ha il suo segnale e la sua etichetta.\n' +
        colpevoli.join('\n'),
    ).toEqual([])
  })

  it('i consumatori IMPORTANO il predicato dal motore invece di riscriverlo', () => {
    // Chi conta o accende un badge deve passare da qui. Elenco DICHIARATO: cresce
    // quando nasce un nuovo consumatore, e un file che sparisce da `src` fa
    // fallire questa riga invece di lasciare un buco muto. Uno stesso file può
    // comparire più volte, una per predicato: chi compone l'elenco E decide la
    // negazione deve importarli entrambi.
    // ⚠️ IL PREDICATO GIUSTO DIPENDE DALLA DOMANDA, e l'elenco lo dichiara file per
    // file. Chi CONTA (la StatCard dell'anagrafica, il segnale `ha_allergie` della
    // rotta) sta sui 14 UE; chi ELENCA — la cucina, l'alert del pranzo, la card del
    // docente — tiene anche il testo non riconosciuto. La home del docente stava
    // sul predicato dei contatori pur essendo un elenco: misurato in produzione il
    // 2026-09-07, 57 bambini con una restrizione scritta contro 27 che la nominano
    // fra i 14 — 30 sparivano dalla card.
    const CONSUMATORI: { file: string; predicato: string }[] = [
      { file: path.join('src', 'app', 'api', 'admin', 'students', 'route.ts'), predicato: 'haAllergiaConteggiabile' },
      { file: path.join('src', 'app', '(dashboard)', 'teacher', 'page.tsx'), predicato: 'haAllergiaOperativa' },
      { file: path.join('src', 'app', 'api', 'mensa', 'report', 'route.ts'), predicato: 'haAllergiaOperativa' },
      // Le superfici che compongono COSA si legge accanto al nome: una sola regola
      // (`etichetteAllergie`), non una copia a testa che diverge.
      { file: path.join('src', 'app', 'api', 'mensa', 'report', 'route.ts'), predicato: 'etichetteAllergie' },
      { file: path.join('src', 'app', 'api', 'tasks', 'route.ts'), predicato: 'etichetteAllergie' },
      { file: path.join('src', 'components', 'features', 'teacher', 'diary', 'DiaryEventEditor.tsx'), predicato: 'etichetteAllergie' },
      // ⚠️ LA QUINTA SUPERFICIE, che questo elenco NON nominava e che perciò è
      // rimasta indietro senza far fallire niente: la panoramica della classe di
      // primaria accendeva un badge rosso da una regola sua — `allergeni.join()`
      // se c'è, altrimenti `allergies` — cioè il difetto già corretto in
      // `mensa/report` (una fonte VINCE sull'altra invece di sommarsi), con le
      // chiavi grezze e senza il filtro della negazione. Misurato in produzione
      // il 2026-09-07: 15 bambini di primaria con un testo in `allergies`, 1 dei
      // quali è una negazione ⇒ un badge rosso che diceva «NESSUNA».
      { file: path.join('src', 'app', '(dashboard)', 'teacher', 'primaria', '[sectionId]', 'page.tsx'), predicato: 'etichetteAllergie' },
      // Il prestampato di banco è dove `etichetteAllergie` è NATA (`colonnaAllergie`),
      // ed era l'unica superficie che non la chiamava: la copia sommava le due
      // colonne ma non toglieva la negazione, e il foglio con cui si prepara il
      // piatto stampava «Nessuna» accanto al nome di 6 bambini su 657.
      { file: path.join('src', 'app', 'api', 'prestampati', 'banco.ts'), predicato: 'etichetteAllergie' },
      // Chi mostra la NOTA MEDICA deve decidere con la stessa regola della
      // negazione, non con una `/nessuna/` propria: vedi la prova più in basso.
      { file: path.join('src', 'app', '(dashboard)', 'teacher', 'page.tsx'), predicato: 'isNegazione' },
      { file: path.join('src', 'components', 'features', 'teacher', 'diary', 'DiaryEventEditor.tsx'), predicato: 'isNegazione' },
    ]
    for (const { file, predicato } of CONSUMATORI) {
      const f = di(file)
      expect(f, `${file} non esiste più: aggiorna questo elenco invece di lasciarlo mentire`).toBeTruthy()
      expect(
        f!.codice,
        `${file} deve importare ${predicato} da @/lib/mensa/allergeni`,
      ).toMatch(new RegExp(`import\\s*\\{[^}]*\\b${predicato}\\b[^}]*\\}\\s*from\\s*'@/lib/mensa/allergeni'`))
    }
  })

  it('nessuno si riscrive la regola della NEGAZIONE con una regex propria', () => {
    // `/nessun/` sparso per il codice è il modo in cui la regola diverge: lo
    // script di backfill la cercava a SOTTOSTRINGA e cancellava un bambino con
    // restrizioni vere. A runtime la decide `isNegazione`, e basta.
    //
    // ⚠️ QUI C'ERA UN'ECCEZIONE SCRITTA A MANO, ED È STATA TOLTA. Diceva: «la
    // home del docente tiene una `/nessuna/` sua sul gruppo delle NOTE MEDICHE,
    // che è un altro criterio per un altro elenco». Non lo era: era la stessa
    // regex a sottostringa che questa regola dichiara pericolosa, applicata alla
    // colonna sanitaria più delicata dell'anagrafica — «Epilessia, nessuna
    // terapia in corso» spariva dalla card. Un lock che si scrive un'esenzione
    // per una riga sbagliata insegna al prossimo che l'esenzione si può
    // chiedere. Ora la home usa `isNegazione` e l'eccezione non serve più.
    //
    // Il perimetro resta la riga, e solo dove si parla di ALLERGIE: una
    // `/nessun/` in un contesto che con le allergie non c'entra (un testo di
    // interfaccia, un nome di file) non è questa classe di difetto.
    const colpevoli: string[] = []
    for (const f of FILE) {
      if (f.relativo === MOTORE) continue
      for (const riga of f.codice.split('\n')) {
        if (!/\/[^/\n]*nessun/i.test(riga)) continue
        if (!/allerg/i.test(riga)) continue
        colpevoli.push(`${f.relativo} → ${riga.trim()}`)
      }
    }
    expect(
      colpevoli,
      'La negazione («Nessuna», «N/A») si riconosce con `isNegazione` del motore, a\n' +
        'vocabolario intero. Una regex locale su «nessun» torna al criterio a\n' +
        'sottostringa, che in produzione dichiara negazione una frase che parla di un\n' +
        'fastidio al lattosio e di molluschi.\n' +
        colpevoli.join('\n'),
    ).toEqual([])
  })

  it('il motore resta importabile dal SERVER: niente `use client`', () => {
    // Tre rotte lo importano: il giorno in cui diventasse un modulo client la
    // build cadrebbe, e cadrebbe lontano da qui.
    const testo = fs.readFileSync(path.join(process.cwd(), MOTORE), 'utf-8')
    expect(testo).not.toMatch(/^\s*['"]use client['"]/m)
  })

  it('nessun file sotto `src/app/api` importa da `src/components`', () => {
    // La politica condivisa fra schermata e rotta sta in `src/lib`: è la frontiera
    // RSC, che `eslint` non vede e `tsc --noEmit` nemmeno.
    const prefisso = path.join('src', 'app', 'api') + path.sep
    const colpevoli: string[] = []
    for (const f of FILE.filter((x) => x.relativo.startsWith(prefisso))) {
      for (const s of specificatori(f.codice)) {
        if (s.startsWith('@/components')) colpevoli.push(`${f.relativo} → ${s}`)
      }
    }
    expect(colpevoli).toEqual([])
  })
})
