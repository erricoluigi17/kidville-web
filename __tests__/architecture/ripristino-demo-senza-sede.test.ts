import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * COMPITO 4.9.7 · IL FILE DI RIPRISTINO DELLA SIMULAZIONE IN DEMO NON NOMINA UNA SEDE E NON TOCCA L'ANAGRAFICA REALE.
 *
 * `docs/superpowers/simulazione/ripristino-demo.sql` lo esegue il titolare, a mano, una volta. Il rischio non è che sbagli una
 * virgola: è che un `DELETE` senza ancora, o con l'uuid di una sede cablato, giri su una sede VERA. Dalla revisione (R4) il file è UN
 * blocco unico: `BEGIN; DO $$ … $$; COMMIT;` in una richiesta sola, e le istruzioni stanno DENTRO il blocco `DO`, che si ferma da solo
 * con `RAISE EXCEPTION`. Il lock lo legge così: separa il blocco dal resto, e guarda i due pezzi con regole diverse.
 *
 * Il file:
 *  · non contiene nessun uuid (la sede e la data sono segnaposto da compilare);
 *  · non nomina `enrollment_submissions` (le domande di iscrizione vere, con i dati di minori) né le tabelle dell'anagrafica
 *    (`alunni`, `tutori`, `genitori`, `utenti`, `anagrafica_*`): le sole tabelle toccate sono quelle della simulazione;
 *  · ogni `DELETE` e ogni `UPDATE` dentro il blocco ha un `WHERE` che passa da `_sedi_simulazione`, la tabella temporanea con la sola sede
 *    scritta in `c_sede` (già verificata come sede di prova: `e2e00000…` o unica in `anno_regole.sedi_simulazione`); non scrive mai con `INSERT`/`TRUNCATE`/`MERGE` su una tabella vera;
 *  · ha la forma `BEGIN; DO …; COMMIT;` e il COMMIT è UNO, DOPO il blocco: dentro il blocco non c'è nessuna chiusura della
 *    transazione, e dopo il COMMIT restano solo letture;
 *  · il blocco si ferma (RAISE EXCEPTION) per i sette motivi dichiarati in testa.
 *
 * Non è cieco: dichiara il minimo di istruzioni esaminate, e ha il suo controllo positivo su SQL finto.
 */

const FILE = path.resolve(__dirname, '../../docs/superpowers/simulazione/ripristino-demo.sql')
/** Tre DELETE (gettoni, passaggi, cronologia) e due UPDATE (gli stati: prima i non-corrente, poi il corrente). */
const MIN_ISTRUZIONI_DI_SCRITTURA = 5
const MIN_RAISE = 12
const CODICI_DI_STOP = ['RIPRISTINO_SEGNAPOSTO', 'RIPRISTINO_SEDI_NON_UNA', 'RIPRISTINO_SEDE_DIVERSA', 'RIPRISTINO_SEDE_NON_DI_PROVA', 'RIPRISTINO_DATA', 'RIPRISTINO_FOTOGRAFIA', 'RIPRISTINO_CONTEGGI']

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const TABELLE_VIETATE = /\b(enrollment_submissions|alunni|tutori|genitori|utenti|anagrafica_[a-z_]+|famiglie|pagamenti|presenze|valutazioni|chat_messages)\b/i

function senzaCommenti(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}
/** Toglie il contenuto dei testi tra apici: una parola dentro un messaggio non è un'istruzione. */
function senzaTesti(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''")
}

interface Pezzi { blocco: string | null; fuori: string[] }
/** Separa il blocco `DO $tag$ … $tag$;` dal resto. Il resto diventa una lista di istruzioni, con `DO_BLOCK` al posto del blocco. */
function pezzi(sql: string): Pezzi {
  const pulito = senzaCommenti(sql)
  const m = /\bDO\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$\s*;/i.exec(pulito)
  const blocco = m ? m[2] : null
  const resto = m ? pulito.replace(m[0], ' DO_BLOCK; ') : pulito
  return { blocco, fuori: resto.split(';').map((s) => s.trim()).filter(Boolean) }
}

/** Le istruzioni di scrittura sui dati veri (non sulle tabelle temporanee `_...`) del blocco: DELETE e UPDATE. */
function scritture(blocco: string): string[] {
  const t = senzaTesti(blocco)
  const out: string[] = []
  for (const m of t.matchAll(/(?<!for\s)(?<!on\s)\b(delete\s+from|update)\b[^;]*;/gi)) out.push(m[0].replace(/\s+/g, ' ').trim())
  return out.filter((s) => !/^(delete\s+from|update)\s+_/i.test(s))
}

function problemi(sql: string): string[] {
  const out: string[] = []
  const pulito = senzaCommenti(sql)
  if (UUID.test(sql)) out.push('contiene un uuid')
  const vietata = TABELLE_VIETATE.exec(pulito)
  if (vietata) out.push(`nomina la tabella ${vietata[1]}`)

  const { blocco, fuori } = pezzi(sql)
  if (blocco === null) {
    out.push('non ha un blocco DO')
    return out
  }
  for (const s of scritture(blocco)) {
    if (!/\bwhere\b/i.test(s)) out.push(`senza WHERE: ${s.slice(0, 60)}`)
    else if (!/_sedi_simulazione/.test(s)) out.push(`WHERE non ancorato a _sedi_simulazione: ${s.slice(0, 60)}`)
  }
  const t = senzaTesti(blocco)
  const scrittaVera = /\b(insert\s+into|truncate(?:\s+table)?|merge\s+into)\s+(?!_)(\S+)/i.exec(t)
  if (scrittaVera) out.push(`scrive con ${scrittaVera[1].toUpperCase()} su ${scrittaVera[2]}`)
  for (const m of t.matchAll(/\bdrop\s+(?:table|schema|function|trigger)\s+(?:if\s+exists\s+)?(\S+)/gi)) {
    if (!m[1].startsWith('_')) out.push(`toglie un oggetto vero con DROP: ${m[1]}`)
  }
  if (/\b(commit|rollback|end\s+transaction)\s*;/i.test(t)) out.push('il blocco chiude la transazione da solo')

  // La forma: BEGIN; DO_BLOCK; COMMIT; e poi solo letture.
  const attive = fuori.map((s) => s.toLowerCase())
  if (attive[0] !== 'begin') out.push('la prima istruzione non è BEGIN')
  if (attive[1] !== 'do_block') out.push('fra BEGIN e il blocco c’è dell’altro, o il blocco non è subito dopo BEGIN')
  if (attive.filter((s) => s === 'commit').length !== 1) out.push('il COMMIT non è uno solo')
  if (attive[2] !== 'commit') out.push('il COMMIT non segue subito il blocco')
  if (attive.includes('rollback')) out.push('contiene un ROLLBACK')
  for (const s of attive.slice(3)) {
    if (!/^select\b/.test(s)) out.push(`dopo il COMMIT c'è altro che una lettura: ${s.slice(0, 40)}`)
    if (/\b(insert|update|delete|truncate|merge|drop|alter|create)\b/.test(senzaTesti(s))) out.push(`una lettura dopo il COMMIT scrive: ${s.slice(0, 40)}`)
  }
  return out
}

describe('ripristino-demo.sql · non nomina una sede e non tocca l’anagrafica', () => {
  const sql = fs.readFileSync(FILE, 'utf8')

  it('non è cieco: il file esiste, ha il suo blocco e almeno le istruzioni di scrittura che deve avere', () => {
    const { blocco } = pezzi(sql)
    expect(blocco, 'il blocco DO c’è').not.toBeNull()
    expect(scritture(blocco ?? '').length).toBeGreaterThanOrEqual(MIN_ISTRUZIONI_DI_SCRITTURA)
  })

  it('nessun problema nel file', () => {
    expect(problemi(sql)).toEqual([])
  })

  it('ha la forma BEGIN; DO …; COMMIT; con il COMMIT dopo il blocco (una richiesta sola)', () => {
    const { fuori } = pezzi(sql)
    expect(fuori.slice(0, 3).map((s) => s.toLowerCase())).toEqual(['begin', 'do_block', 'commit'])
  })

  it('il blocco si ferma da solo: ha i sei codici di stop e abbastanza RAISE EXCEPTION', () => {
    const { blocco } = pezzi(sql)
    const corpo = blocco ?? ''
    expect((corpo.match(/\braise\s+exception\b/gi) ?? []).length).toBeGreaterThanOrEqual(MIN_RAISE)
    for (const c of CODICI_DI_STOP) expect(corpo, `il codice ${c}`).toContain(c)
  })

  it('controlla che le sedi in simulazione siano UNA (cardinalità) e che sia quella attesa', () => {
    const corpo = pezzi(sql).blocco ?? ''
    expect(corpo).toMatch(/sedi_simulazione/)
    expect(corpo).toMatch(/cardinality\s*\(/i)
    expect(corpo).toMatch(/is distinct from v_sede/i)
  })

  it('i segnaposto della sede, della data e degli stati ci sono: finché non li sostituisci il file si ferma', () => {
    const pulito = senzaCommenti(sql)
    expect(pulito).toContain("'<DEMO>'")
    expect(pulito).toContain("'AAAA-MM-GG'")
    expect(pulito).toContain("('AAAA/AA', 'corrente', false)")
  })
})

describe('il controllo positivo, su SQL finto', () => {
  /** Un file finto con la forma giusta, in cui si cambia una cosa per volta. */
  const finto = (corpo: string, dopo = '', prima = '') =>
    `BEGIN;\n${prima}DO $x$\nBEGIN\n  CREATE TEMP TABLE _sedi_simulazione AS SELECT 1 AS scuola_id;\n${corpo}\nEND\n$x$;\nCOMMIT;\n${dopo}`
  const bene = 'DELETE FROM public.passaggi_anno p WHERE p.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione);'

  it('un blocco ben formato è verde', () => {
    expect(problemi(finto(bene))).toEqual([])
  })
  it('un DELETE senza WHERE è rosso', () => {
    expect(problemi(finto('DELETE FROM public.passaggi_anno;'))).toHaveLength(1)
  })
  it('un DELETE con un WHERE che non passa da _sedi_simulazione è rosso', () => {
    expect(problemi(finto('DELETE FROM public.passaggi_anno WHERE stato = 1;'))).toHaveLength(1)
  })
  it('un UPDATE con il WHERE ancorato è verde; senza ancora è rosso', () => {
    expect(problemi(finto('UPDATE public.anni_sede a SET stato = 1 WHERE a.scuola_id IN (SELECT scuola_id FROM _sedi_simulazione);'))).toEqual([])
    expect(problemi(finto('UPDATE public.anni_sede a SET stato = 1 WHERE a.id IS NOT NULL;'))).toHaveLength(1)
  })
  it('una scrittura nascosta in un’istruzione dopo una IF, su più righe, è vista lo stesso', () => {
    expect(problemi(finto('IF true THEN\n  DELETE FROM public.passaggi_anno\n   WHERE stato = 1;\nEND IF;'))).toHaveLength(1)
  })
  it('un uuid cablato è rosso', () => {
    expect(problemi(finto(bene.replace(';', " AND p.id = '22222222-2222-4222-8222-222222222222';")))).toContain('contiene un uuid')
  })
  it('una tabella dell’anagrafica è rossa', () => {
    expect(problemi(finto('DELETE FROM public.alunni WHERE scuola_id IN (SELECT scuola_id FROM _sedi_simulazione);'))).toContain('nomina la tabella alunni')
  })
  it('un INSERT, un TRUNCATE o un MERGE su una tabella vera sono rossi; su una temporanea no', () => {
    expect(problemi(finto('INSERT INTO public.passaggi_anno (id) VALUES (1);')).join()).toContain('INSERT')
    expect(problemi(finto('TRUNCATE public.passaggi_anno;')).join()).toContain('TRUNCATE')
    expect(problemi(finto('INSERT INTO _stati_iniziali (x) VALUES (1);'))).toEqual([])
  })
  it('un COMMIT dentro il blocco è rosso; una parola «commit» in un messaggio no', () => {
    expect(problemi(finto('COMMIT;')).join()).toContain('il blocco chiude la transazione da solo')
    expect(problemi(finto("RAISE NOTICE 'commit;';"))).toEqual([])
  })
  it('la forma: senza BEGIN, con un COMMIT di troppo, con altro fra BEGIN e il blocco, con una scrittura dopo il COMMIT', () => {
    expect(problemi(finto(bene).replace('BEGIN;\n', '')).join()).toContain('la prima istruzione non è BEGIN')
    expect(problemi(finto(bene, 'COMMIT;')).join()).toContain('il COMMIT non è uno solo')
    expect(problemi(finto(bene, '', 'SELECT 1;\n')).join()).toContain('fra BEGIN e il blocco')
    expect(problemi(finto(bene, "DELETE FROM public.passaggi_anno WHERE true;")).join()).toContain('dopo il COMMIT')
    expect(problemi(finto(bene, 'SELECT count(*) FROM public.passaggi_anno;'))).toEqual([])
  })
  it('un file senza blocco DO è rosso', () => {
    expect(problemi('BEGIN;\nCOMMIT;')).toContain('non ha un blocco DO')
  })
  it('le parole dei commenti non contano', () => {
    expect(problemi(finto(bene + '\n-- DELETE FROM public.alunni; COMMIT;\n/* UPDATE x */'))).toEqual([])
  })
})
