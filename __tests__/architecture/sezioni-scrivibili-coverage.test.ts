import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente, riga } from '../fixtures/sorgente'

/**
 * COVERAGE-LOCK (PR 4.3, compito 4.3.6): una route che SCRIVE e verifica la sezione lo fa con
 * `assertSezioneScrivibile`, non con `assertSezioneInScope`.
 *
 * Perché: un docente vede in sola lettura le sezioni degli anni `in_chiusura` e `chiuso`. `assertSezioneInScope`
 * le lascia passare (va bene per le `GET`); in scrittura il docente riceverebbe un 200 sul registro di un anno
 * passato. La rete vera, per tutti i ruoli, è la guardia DB `ANNO_CHIUSO` della PR 3-B (non prima del 02/12/2026):
 * fino ad allora è questo gate applicativo a impedirlo.
 *
 * Il lock guarda ogni file di `src/` che esporta `POST`/`PUT`/`PATCH`/`DELETE`: una chiamata a
 * `assertSezioneInScope(` dentro un handler di scrittura, o nei suoi helper non esportati fuori da ogni `GET`, è
 * un errore, salvo file in `ECCEZIONI` con la ragione. Una `GET` resta su `assertSezioneInScope`.
 *
 * ── COSA COPRE QUESTO LOCK, e cosa no (detto con precisione) ──
 *  · COPRE (automatico): le route di scrittura che chiamano `assertSezioneInScope(` direttamente.
 *  · NON lo vede (ma è a posto, ognuno col suo test): `assertSezionePrimariaFirmabile` (la firma del registro di
 *    primaria guarda l'anno della classe: `primaria-registro-supplenza.test.ts`), `puoAccedereFascicolo` con
 *    l'azione `upload`/`delete`/`sostituisci` (solo sezioni scrivibili: `anno-accesso-docenti-letture.test.ts`),
 *    `verificaTargetAvvisoDocente` (solo i nomi delle sezioni scrivibili: `avvisi-gate-scrittura-anno.test.ts`).
 *    Quei gate vivono in `src/lib`, e questo lock non li segue: se ne nasce uno nuovo, la sola difesa è la revisione.
 *  · NON coperti per scelta: `GATE_NON_COPERTI` qui sotto.
 *
 * Limite dichiarato: un helper che sta in un ALTRO file (`src/lib`) e serve sia letture sia scritture non si vede
 * da qui; per quelli vale la lista `HELPER_CONDIVISI` (documentata, senza controllo automatico).
 */

const SRC = path.resolve(__dirname, '../../src')
const METODI_SCRITTURA = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** file di route (relativo a `src/`) → ragione per cui una sua scrittura resta su `assertSezioneInScope`. */
export const ECCEZIONI: Record<string, string> = {}

/**
 * Helper di `src/lib` che chiamano `assertSezioneInScope` per letture E scritture: non si convertono, e il
 * chiamante in scrittura aggiunge da sé il controllo (o il rischio è accettato).
 */
export const HELPER_CONDIVISI: Record<string, string> = {
  'lib/sezioni/risoluzione.ts':
    'risolviSezione serve le sole GET (modulistica, certificati, registro, diario, armadietti: lo si legge dai chiamanti, nessuna POST/PATCH/DELETE la usa): una lettura di un anno passato resta lecita, e le scritture passano da assertSezioneScrivibile',
}

/**
 * Gate di scope che restano com'erano anche in scrittura, e perché. Il lock non li controlla: li dichiara, con la
 * ragione, perché sia chiaro che non sono una dimenticanza.
 */
export const GATE_NON_COPERTI: Record<string, string> = {
  assertAlunnoInScope:
    'vale per le GET e per le scritture che NON sono di un docente sul registro di classe (genitori, staff): una scrittura di un docente passa da `assertAlunnoScrivibile`, e il lock qui sotto lo verifica handler per handler. «La ferma la guardia del database» NON è una ragione: a guardia spenta (lo stato della produzione) e, con la 4.9 giro 1, anche su `in_chiusura` a guardia accesa la guardia non ferma un docente',
  assertClasseNomeInScope:
    'vale per le GET e per le scritture che NON sono di un docente sul registro di classe: una scrittura di un docente passa da `assertClasseNomeScrivibile`, e il lock qui sotto lo verifica handler per handler. «La ferma la guardia del database» NON è una ragione (vedi `assertAlunnoInScope`)',
}

/**
 * (PR 4.9, giro 1-bis) Le scritture di un docente (handler POST/PUT/PATCH/DELETE che chiamano `requireDocente(`) che NON portano un
 * gate di sezione scrivibile, e la ragione VERA di ciascuna: che cosa la route scrive e perché non è una scrittura del docente su
 * una classe. Non «la copre la guardia», che a guardia spenta è falso.
 */
export const SCRITTURE_DOCENTI_SENZA_GATE: Record<string, string> = {
  'app/api/tasks/route.ts': 'scrive `task_interni`, un incarico interno dello staff: `target_class` è un’etichetta e `student_id` sta nel JSON; la sede è legata da `resolveScuolaScrittura`',
  'app/api/tasks/[id]/route.ts': 'stessa tabella `task_interni`, la sede è legata da `assertSedeRigaInScope`: non è una scrittura sul registro di una classe',
  'app/api/tasks/upload/route.ts': 'carica un file nel bucket `task_allegati`: nessuna sezione né alunno',
  'app/api/avvisi/upload/route.ts': 'carica un allegato: nessuna sezione né alunno; il bersaglio dell’avviso lo gate-a la route degli avvisi',
  'app/api/avvisi/upload/rimuovi/route.ts': 'rimuove un allegato dal bucket: nessuna sezione né alunno',
  'app/api/gallery/upload/route.ts': 'scrive un file in `uploads/<userId>/`, senza riga di registro né sezione',
  'app/api/gallery/upload-url/route.ts': 'firma l’URL di upload dello stesso percorso, senza sezione',
  'app/api/gallery/route.ts': 'il media non ha `section_id`: porta `scuola_id`, `tag_students` e `target_classes` (broadcast, riservato alla Direzione). I tag sono già controllati per sede da `assertTagStudentsInScope`; un gate per alunno cambierebbe il comportamento (foto di gruppo con bambini di altre classi). DECISIONE DI PRODOTTO APERTA: vietare i tag di bambini la cui classe è in sola lettura',
  'app/api/panic-alert/route.ts': 'emergenza: un allarme non si blocca in agosto. Scrive il flag `panic_alert` su `presenze`, quindi È una scrittura sul registro, e la ragione è di sicurezza, non tecnica',
  'app/api/news/route.ts': 'l’educator crea solo una bozza o una proposta di notizia: `target_classes` è il pubblico, non un registro di classe',
  'app/api/news/[id]/route.ts': 'bozza o proposta di notizia di cui l’educator è autore: non è un registro di classe',
  'app/api/news/upload/route.ts': 'carica un file della notizia: nessuna sezione né alunno',
  'app/api/news/instagram/valida/route.ts': 'valida un link, non scrive su una classe',
  'app/api/agenda/route.ts': 'la DELETE toglie un evento d’agenda DELLA SEDE (`eventi_agenda` non ha una classe): solo il creatore o la Direzione, controllato nella route; la POST che lo crea su una classe è gate-ata',
  'app/api/video-uploads/[id]/route.ts': 'agisce su un intento già aperto dal POST, che è gate-ato su `destinatari.classi`',
  'app/api/video-uploads/[id]/firma/route.ts': 'firma un intento già aperto dal POST, che è gate-ato su `destinatari.classi`',
}

/** Il gate di sezione scrivibile, in una delle sue forme (o delegato a un helper che lo contiene e ha il suo test). */
const GATE_SCRIVIBILE = /\b(?:assertSezioneScrivibile|assertAlunnoScrivibile|assertClasseNomeScrivibile|assertSezionePrimariaFirmabile|verificaTargetAvvisoDocente|allegatoDaGestire)\s*\(/

/** Gli handler di scrittura che chiamano `requireDocente(`: `{metodo, haGate}`. Uno stesso file può averne più d'uno. */
export function scrittureDocente(testo: string): Array<{ metodo: string; haGate: boolean }> {
  const { senzaCommenti } = mascheraSorgente(testo)
  const esportati = [...senzaCommenti.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)]
    .map((m) => ({ i: m.index as number, metodo: m[1] }))
  const out: Array<{ metodo: string; haGate: boolean }> = []
  // Gli helper del file (fuori dagli export, prima del primo) che contengono il gate: un handler che li chiama lo eredita.
  const preludio = esportati.length ? senzaCommenti.slice(0, esportati[0].i) : senzaCommenti
  const helperConGate = [...preludio.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/g)]
    .map((m, k, tutti) => ({ nome: m[1], corpo: preludio.slice(m.index, k + 1 < tutti.length ? tutti[k + 1].index : undefined) }))
    .filter((h) => GATE_SCRIVIBILE.test(h.corpo))
    .map((h) => h.nome)
  esportati.forEach((e, k) => {
    if (!METODI_SCRITTURA.has(e.metodo)) return
    const corpo = senzaCommenti.slice(e.i, k + 1 < esportati.length ? esportati[k + 1].i : undefined)
    if (!/\brequireDocente\s*\(/.test(corpo)) return
    const viaHelper = helperConGate.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(corpo))
    out.push({ metodo: e.metodo, haGate: GATE_SCRIVIBILE.test(corpo) || viaHelper })
  })
  return out
}

type Chiamata = { file: string; riga: number; metodo: string }

/** Le chiamate a `assertSezioneInScope(` che stanno in un handler di scrittura (o in un helper fuori dalle GET). */
export function chiamateInScritturaConInScope(file: string, testo: string): Chiamata[] {
  const { senzaCommenti } = mascheraSorgente(testo)
  const esportati = [...senzaCommenti.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)]
    .map((m) => ({ i: m.index, metodo: m[1] }))
  if (!esportati.some((e) => METODI_SCRITTURA.has(e.metodo))) return []
  const out: Chiamata[] = []
  for (const c of senzaCommenti.matchAll(/\bassertSezioneInScope\s*\(/g)) {
    let metodo = 'helper'
    for (const e of esportati) if (e.i <= c.index) metodo = e.metodo
    if (metodo === 'GET') continue
    out.push({ file, riga: riga(testo, c.index), metodo })
  }
  return out
}

const analisi = fileSorgente(SRC).map((f) => ({ file: path.relative(SRC, f), testo: fs.readFileSync(f, 'utf8') }))
const violazioni = analisi.flatMap((a) => chiamateInScritturaConInScope(a.file, a.testo))
const conScrivibile = analisi.filter((a) => /\bassertSezioneScrivibile\s*\(/.test(mascheraSorgente(a.testo).senzaCommenti))

describe('le scritture verificano la sezione con assertSezioneScrivibile', () => {
  it('lo scanner (provato su sorgenti finti)', () => {
    const src = (corpo: string) => `export const GET = withRoute('x:GET', async () => { ${corpo} })`
    const scrittura = (corpo: string) =>
      `${src("await assertSezioneInScope(a, b, c)")}\nexport const POST = withRoute('x:POST', async () => { ${corpo} })`
    expect(chiamateInScritturaConInScope('a.ts', scrittura('await assertSezioneInScope(a, b, c)'))).toHaveLength(1)
    expect(chiamateInScritturaConInScope('a.ts', scrittura('await assertSezioneScrivibile(a, b, c)'))).toHaveLength(0)
    // solo GET: nessuna scrittura, nessun problema
    expect(chiamateInScritturaConInScope('a.ts', src('await assertSezioneInScope(a, b, c)'))).toHaveLength(0)
    // un commento non conta
    expect(chiamateInScritturaConInScope('a.ts', scrittura('// assertSezioneInScope(a, b, c)'))).toHaveLength(0)
    // un helper non esportato prima dei metodi, in un file che scrive
    expect(chiamateInScritturaConInScope('a.ts',
      `async function h() { await assertSezioneInScope(a, b, c) }\n${scrittura('')}`)).toHaveLength(1)
  })

  it('il lock vede le route (minimi: un lock che scansiona zero file è verde)', () => {
    expect(analisi.length).toBeGreaterThan(500)
    expect(conScrivibile.length).toBeGreaterThanOrEqual(25)
  })

  it('nessuna scrittura resta su assertSezioneInScope', () => {
    const fuori = violazioni
      .filter((v) => !(v.file in ECCEZIONI))
      .map((v) => `${v.file}:${v.riga} (${v.metodo})`)
    expect(fuori, 'in una scrittura usa assertSezioneScrivibile (stessa firma)').toEqual([])
  })

  it('i gate dichiarati non coperti hanno una ragione e esistono ancora', () => {
    const scope = fs.readFileSync(path.join(SRC, 'lib/auth/scope.ts'), 'utf8')
    for (const [nome, ragione] of Object.entries(GATE_NON_COPERTI)) {
      expect(ragione.length, nome).toBeGreaterThan(40)
      expect(new RegExp(`export\\s+async\\s+function\\s+${nome}\\b`).test(scope), `${nome}: voce morta`).toBe(true)
    }
  })

  it('ogni eccezione ha una ragione e serve ancora', () => {
    for (const [file, ragione] of Object.entries({ ...ECCEZIONI, ...HELPER_CONDIVISI })) {
      expect(ragione.length, file).toBeGreaterThan(20)
    }
    for (const file of Object.keys(ECCEZIONI)) {
      expect(violazioni.some((v) => v.file === file), `${file} non ha più violazioni: togliere la voce`).toBe(true)
    }
    for (const file of Object.keys(HELPER_CONDIVISI)) {
      expect(analisi.some((a) => a.file === file && /assertSezioneInScope\s*\(/.test(a.testo)), `${file}: voce morta`).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// (PR 4.9, giro 1-bis) Ogni scrittura di un docente ha il gate della sezione scrivibile, o una ragione VERA per non averlo.
const route = analisi.filter((a) => /(^|\/)route\.ts$/.test(a.file))
const esaminate = route.flatMap((a) => scrittureDocente(a.testo).map((h) => ({ file: a.file, ...h })))

describe('le scritture dei docenti hanno il gate della sezione scrivibile', () => {
  it('lo scanner (provato su sorgenti finti: una route guastata in memoria diventa rossa)', () => {
    const route = (corpo: string) =>
      `export const GET = withRoute('x:GET', async () => { await requireDocente(r) })\n` +
      `export const POST = withRoute('x:POST', async () => { await requireDocente(r); ${corpo} })`
    expect(scrittureDocente(route('await assertAlunnoScrivibile(a, b, c)'))).toEqual([{ metodo: 'POST', haGate: true }])
    // la route guastata: il gate tolto, o tornato al gate di lettura
    expect(scrittureDocente(route(''))).toEqual([{ metodo: 'POST', haGate: false }])
    expect(scrittureDocente(route('await assertAlunnoInScope(a, b, c)'))).toEqual([{ metodo: 'POST', haGate: false }])
    // un commento non è un gate
    expect(scrittureDocente(route('// assertSezioneScrivibile(a, b, c)'))).toEqual([{ metodo: 'POST', haGate: false }])
    // requireDocente nella sola GET: la scrittura è dello staff, non del docente
    expect(scrittureDocente(
      `export const GET = withRoute('x:GET', async () => { await requireDocente(r) })\n` +
      `export const POST = withRoute('x:POST', async () => { await requireStaff(r) })`)).toEqual([])
  })

  it('dichiara quante scritture ha esaminato (un lock che ne esamina zero è verde)', () => {
    expect(route.length).toBeGreaterThan(300)
    expect(esaminate.length, 'gli handler di scrittura con requireDocente').toBeGreaterThanOrEqual(25)
    const senza = esaminate.filter((e) => !e.haGate)
    expect(esaminate.length - senza.length, 'quelle col gate').toBeGreaterThanOrEqual(10)
    expect(new Set(senza.map((e) => e.file)).size).toBe(Object.keys(SCRITTURE_DOCENTI_SENZA_GATE).length)
  })

  it('nessuna scrittura di un docente resta senza gate se non è in registro con la sua ragione', () => {
    const fuori = esaminate.filter((e) => !e.haGate && !(e.file in SCRITTURE_DOCENTI_SENZA_GATE)).map((e) => `${e.file} (${e.metodo})`)
    expect(fuori, 'usa assertAlunnoScrivibile / assertClasseNomeScrivibile / assertSezioneScrivibile, oppure dichiara la ragione vera').toEqual([])
  })

  it('le voci del registro hanno una ragione che non è «la copre la guardia», e servono ancora', () => {
    for (const [file, ragione] of Object.entries(SCRITTURE_DOCENTI_SENZA_GATE)) {
      expect(ragione.length, file).toBeGreaterThan(30)
      expect(/copre la guardia|ferma (il|la) (database|guardia)/i.test(ragione), `${file}: la guardia non è una ragione`).toBe(false)
      expect(esaminate.some((e) => e.file === file && !e.haGate), `${file}: voce morta (ha il gate o non è più una scrittura di docente)`).toBe(true)
    }
  })
})
