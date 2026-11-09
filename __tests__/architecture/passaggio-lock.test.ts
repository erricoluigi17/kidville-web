import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente, riga, type SorgenteMascherato } from '../fixtures/sorgente'

/**
 * COMPITO 4.8.11 · I TRE LOCK DEL PASSAGGIO D'ANNO.
 *
 *  1. UNA PORTA SOLA (`passaggio-una-porta`): le funzioni SQL `passaggio_*` si nominano fra virgolette solo in
 *     `src/lib/anno/passaggio.ts`; le tabelle `passaggi_anno*` si leggono solo lì e non si scrivono mai da `src/`.
 *  2. MAI DA UN CRON (`passaggio-non-da-cron`): il passaggio lo fa la segreteria. Nessun file di `src/` fuori dalla porta e
 *     dalle sue sei route importa la porta; nessun `cron.schedule` nelle migrazioni nomina una funzione `passaggio_*`.
 *  3. L'ORDINE DELLA CONFERMA (`passaggio-ordine-conferma`): nell'ULTIMA definizione di `passaggio_conferma` i passi stanno nell'ordine
 *     che regge lo specchio (uscite col vecchio attivo → docenti → didattica → cambio di stato → specchio → confermato).
 *
 * Ogni lock dichiara quanto ha letto (un lock che scansiona zero file è verde: è già successo) e ha il suo controllo positivo su testo finto.
 */

const CWD = process.cwd()
const rel = (f: string) => path.relative(CWD, f).split(path.sep).join('/')
const PORTA = 'src/lib/anno/passaggio.ts'
const RISPOSTE = 'src/lib/anno/passaggio-risposte.ts'
const ROUTE_DIR = 'src/app/api/admin/anni/[annoSedeId]/passaggio/'
const FUNZIONI = [
  'passaggio_anteprima', 'passaggio_calcola', 'passaggio_riga_correggi', 'passaggio_docente_imposta',
  'passaggio_copia_didattica', 'passaggio_conferma', 'passaggio_annulla', 'passaggio_conferma_tardiva',
]
const TABELLE = ['passaggi_anno', 'passaggi_anno_righe', 'passaggi_anno_docenti']

interface Sorgente { percorso: string; m: SorgenteMascherato }
const sorgenti = (): Sorgente[] =>
  fileSorgente(path.join(CWD, 'src')).map((f) => ({ percorso: rel(f), m: mascheraSorgente(fs.readFileSync(f, 'utf8')) }))

function violazioniPorta(files: Sorgente[]): string[] {
  const out: string[] = []
  for (const f of files) {
    if (f.percorso === PORTA) continue
    for (const nome of FUNZIONI) {
      const re = new RegExp(`(['"\`])${nome}\\1`, 'g')
      let h: RegExpExecArray | null
      while ((h = re.exec(f.m.senzaCommenti)) !== null) out.push(`${f.percorso}:${riga(f.m.originale, h.index)} — la funzione \`${nome}\` si chiama solo da ${PORTA}`)
    }
    for (const t of TABELLE) {
      const re = new RegExp(`\\.\\s*from\\s*\\(\\s*(['"\`])${t}\\1`, 'g')
      let h: RegExpExecArray | null
      while ((h = re.exec(f.m.senzaCommenti)) !== null) out.push(`${f.percorso}:${riga(f.m.originale, h.index)} — la tabella \`${t}\` si legge solo da ${PORTA}`)
    }
  }
  return out
}

/** Nella porta le tabelle `passaggi_anno*` si leggono soltanto: dopo `.from('…')` mai insert/upsert/update/delete. */
function scrittureNellaPorta(m: SorgenteMascherato): string[] {
  const out: string[] = []
  for (const t of TABELLE) {
    const re = new RegExp(`\\.\\s*from\\s*\\(\\s*(['"\`])${t}\\1\\s*\\)\\s*\\.\\s*(insert|upsert|update|delete)\\b`, 'g')
    let h: RegExpExecArray | null
    while ((h = re.exec(m.senzaCommenti)) !== null) out.push(`${t}: ${h[2]}`)
  }
  return out
}

function importatoreDellaPorta(files: Sorgente[]): string[] {
  const out: string[] = []
  for (const f of files) {
    if (f.percorso === PORTA || f.percorso === RISPOSTE || f.percorso.startsWith(ROUTE_DIR)) continue
    if (/(['"])(@\/lib\/anno\/passaggio|\.{1,2}\/(?:[\w./-]*\/)?passaggio)\1/.test(f.m.senzaCommenti)) out.push(f.percorso)
  }
  return out
}

function cronNominaPassaggio(sql: string): string[] {
  const out: string[] = []
  const re = /cron\s*\.\s*(?:schedule|alter_job)\s*\(/gi
  let h: RegExpExecArray | null
  while ((h = re.exec(sql)) !== null) {
    const pezzo = sql.slice(h.index, h.index + 600)
    const chiusa = pezzo.search(/\)\s*;/)
    const corpo = chiusa >= 0 ? pezzo.slice(0, chiusa) : pezzo
    // (giro 2, R6) Unica eccezione: `passaggio_ricopia_schede` ricopia le schede il giorno dell'inizio di un passaggio GIÀ confermato dal
    // titolare; non calcola, non conferma e non annulla niente. Ogni altra `passaggio_*` da cron resta vietata.
    if (/\bpassaggio_(?!ricopia_schede\b)\w+/i.test(corpo)) out.push(corpo.slice(0, 80).replace(/\s+/g, ' '))
  }
  return out
}

/** Ogni marcatore deve comparire, e dopo quelli che lo precedono. */
function ordine(corpo: string, marcatori: Array<[string, RegExp]>): string[] {
  const out: string[] = []
  let ultimo = -1
  for (const [nome, re] of marcatori) {
    const i = corpo.search(re)
    if (i < 0) { out.push(`manca: ${nome}`); continue }
    if (i < ultimo) out.push(`fuori ordine: ${nome}`)
    ultimo = Math.max(ultimo, i)
  }
  return out
}

const MARCATORI: Array<[string, RegExp]> = [
  ['uscite col vecchio attivo', /SET stato = 'uscito'/],
  ['docenti', /INSERT INTO public\.utenti_sezioni/],
  ['didattica', /passaggio_copia_didattica\(/],
  ['cambio di stato', /UPDATE public\.anni_sede SET stato = 'corrente'/],
  ['specchio', /alunni_riallinea_da_frequenze\(/],
  ['confermato', /SET stato = 'confermato'/],
]

/** Il corpo dell'ULTIMA definizione di `passaggio_conferma` (le migrazioni in ordine di nome). */
function corpoUltimaConferma(): string {
  const dir = path.join(CWD, 'supabase/migrations')
  let corpo = ''
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, n), 'utf8')
    const re = /CREATE OR REPLACE FUNCTION public\.passaggio_conferma\(/g
    let h: RegExpExecArray | null
    while ((h = re.exec(sql)) !== null) {
      const resto = sql.slice(h.index)
      const fine = resto.indexOf('$$;', resto.indexOf('$$') + 2)
      if (fine > 0) corpo = resto.slice(0, fine)
    }
  }
  return corpo
}

describe('passaggio-una-porta', () => {
  it('le funzioni e le tabelle del passaggio stanno solo nella porta, che non scrive mai le tabelle', () => {
    const files = sorgenti()
    expect(files.length, 'ha letto abbastanza file di src/').toBeGreaterThan(500)
    const porta = files.find((f) => f.percorso === PORTA)
    expect(porta, 'la porta esiste').toBeDefined()
    for (const nome of FUNZIONI.filter((n) => n !== 'passaggio_calcola' && n !== 'passaggio_copia_didattica')) {
      expect(porta!.m.senzaCommenti, `la porta nomina ${nome}`).toContain(nome)
    }
    expect(violazioniPorta(files)).toEqual([])
    expect(scrittureNellaPorta(porta!.m)).toEqual([])
  })

  it('controllo positivo: un file qualunque che chiama la funzione o legge la tabella fa rosso', () => {
    const finto: Sorgente[] = [{
      percorso: 'src/x.ts',
      m: mascheraSorgente(`supabase.rpc('passaggio_conferma', {}); supabase.from('passaggi_anno').select('*'); // 'passaggio_annulla'`),
    }]
    expect(violazioniPorta(finto)).toHaveLength(2)
    expect(scrittureNellaPorta(mascheraSorgente(`s.from('passaggi_anno_righe').update({})`))).toEqual(['passaggi_anno_righe: update'])
  })
})

describe('passaggio-non-da-cron', () => {
  it('nessun file fuori dalla porta e dalle sue route importa la porta', () => {
    expect(importatoreDellaPorta(sorgenti())).toEqual([])
  })

  it('nessun cron.schedule delle migrazioni nomina una funzione passaggio_*', () => {
    const dir = path.join(CWD, 'supabase/migrations')
    const file = fs.readdirSync(dir).filter((n) => n.endsWith('.sql'))
    expect(file.length, 'ha letto abbastanza migrazioni').toBeGreaterThan(250)
    const trovati = file.flatMap((n) => cronNominaPassaggio(fs.readFileSync(path.join(dir, n), 'utf8')).map((x) => `${n}: ${x}`))
    expect(trovati).toEqual([])
  })

  it('controllo positivo: un import della porta da un altro file, o un cron.schedule sul passaggio, fa rosso', () => {
    const finto: Sorgente[] = [{ percorso: 'src/app/api/x/route.ts', m: mascheraSorgente(`import { confermaPassaggio } from '@/lib/anno/passaggio'`) }]
    expect(importatoreDellaPorta(finto)).toEqual(['src/app/api/x/route.ts'])
    expect(cronNominaPassaggio(`SELECT cron.schedule('x', '0 3 * * *', $$SELECT public.passaggio_conferma(a, b)$$);`)).toHaveLength(1)
    expect(cronNominaPassaggio(`SELECT cron.schedule('x', '0 3 * * *', $$SELECT public.altro()$$);`)).toEqual([])
  })
})

describe('passaggio-ordine-conferma', () => {
  it('nell’ultima definizione di passaggio_conferma i passi stanno nell’ordine voluto', () => {
    const corpo = corpoUltimaConferma()
    expect(corpo.length, 'ha trovato un corpo vero').toBeGreaterThan(2000)
    expect(ordine(corpo, MARCATORI)).toEqual([])
  })

  it('controllo positivo: lo specchio prima del cambio di stato, o un passo che manca, fa rosso', () => {
    const buono = `SET stato = 'uscito'; INSERT INTO public.utenti_sezioni; passaggio_copia_didattica(1); UPDATE public.anni_sede SET stato = 'corrente'; alunni_riallinea_da_frequenze(1); SET stato = 'confermato'`
    expect(ordine(buono, MARCATORI)).toEqual([])
    const storto = `SET stato = 'uscito'; INSERT INTO public.utenti_sezioni; passaggio_copia_didattica(1); alunni_riallinea_da_frequenze(1); UPDATE public.anni_sede SET stato = 'corrente'; SET stato = 'confermato'`
    expect(ordine(storto, MARCATORI)).toEqual(['fuori ordine: specchio'])
    expect(ordine(`SET stato = 'uscito'`, MARCATORI)).toContain('manca: specchio')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// GIRO DI CORREZIONE 1 · S27 — la prova del rosso sui sorgenti VERI.
// I "controlli positivi" qui sopra girano su testi inventati: provano la regex, non che il lock guardi i file di questo repo. Qui si
// prende il sorgente vero, lo si guasta in memoria (mai su disco) e si pretende che il lock diventi rosso; il sorgente intatto resta verde.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('passaggio-lock — la prova del rosso sui sorgenti veri', () => {
  const leggiFile = (percorso: string) => fs.readFileSync(path.join(CWD, percorso), 'utf8')

  it('la porta vera, con una scrittura su passaggi_anno_righe aggiunta in memoria, fa rosso; intatta no', () => {
    const vera = leggiFile(PORTA)
    expect(scrittureNellaPorta(mascheraSorgente(vera))).toEqual([])
    const guasta = `${vera}\nexport const x = (s: any) => s.from('passaggi_anno_righe').update({ esito: 'esce' })\n`
    expect(scrittureNellaPorta(mascheraSorgente(guasta))).toEqual(['passaggi_anno_righe: update'])
  })

  it('una route vera, con la chiamata diretta a una funzione del passaggio, fa rosso se non è la porta', () => {
    const percorso = 'src/app/api/admin/anni/[annoSedeId]/passaggio/nomi/route.ts'
    const route = leggiFile(percorso)
    const intatta: Sorgente[] = [{ percorso, m: mascheraSorgente(route) }]
    expect(violazioniPorta(intatta)).toEqual([])
    const guasta: Sorgente[] = [{ percorso, m: mascheraSorgente(`${route}\nvoid supabase.rpc('passaggio_conferma', {})\n`) }]
    expect(violazioniPorta(guasta)).toHaveLength(1)
    const leggeLaTabella: Sorgente[] = [{ percorso, m: mascheraSorgente(`${route}\nvoid supabase.from('passaggi_anno').select('id')\n`) }]
    expect(violazioniPorta(leggeLaTabella)).toHaveLength(1)
  })

  it('la conferma vera, con lo specchio spostato in cima, fa rosso; intatta no', () => {
    const vera = corpoUltimaConferma()
    expect(ordine(vera, MARCATORI)).toEqual([])
    expect(ordine(`PERFORM public.alunni_riallinea_da_frequenze(NULL);\n${vera}`, MARCATORI)).toEqual(['fuori ordine: specchio'])
    expect(ordine(vera.replace(/SET stato = 'uscito'/g, "SET stato = 'altro'"), MARCATORI)).toEqual(['manca: uscite col vecchio attivo'])
  })

  it('un file vero fuori dalla porta che importa la porta fa rosso', () => {
    const percorso = 'src/app/(dashboard)/admin/students/passaggio/page.tsx'
    const pagina = leggiFile(percorso)
    const intatto: Sorgente[] = [{ percorso, m: mascheraSorgente(pagina) }]
    expect(importatoreDellaPorta(intatto)).toEqual([])
    const guasto: Sorgente[] = [{ percorso, m: mascheraSorgente(`import { confermaPassaggio } from '@/lib/anno/passaggio'\n${pagina}`) }]
    expect(importatoreDellaPorta(guasto)).toEqual([percorso])
  })
})
