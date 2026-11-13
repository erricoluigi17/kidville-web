import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Chi esce per una SCELTA dell'utente deve passare da `ConfermaUscita`: un tocco sbagliato su «Esci» (successo nel
// collaudo del 13/11, foglio in scorrimento) chiude la sessione. Il lock legge i file con l'AST di TypeScript, non con
// espressioni regolari: commenti e stringhe li gestisce il parser (un `/*` dentro una stringa non nasconde codice, un
// commento che nomina `doLogout` non fa scattare niente). Cerca OGNI riferimento a `doLogout`, a
// `@/lib/auth/logout` (import statico o dinamico) e a `.signOut` in tutto `src/`, e lo ammette solo in un elenco
// chiuso di file. Eccezioni dichiarate:
//  · `lib/auth/logout.ts`: dove `doLogout` e `signOut` vivono;
//  · `BiometricGate`: è l'ultima via d'uscita quando la biometria non passa, non deve diventare un vicolo cieco;
//  · `CambiaPasswordCard`: l'uscita lì è l'effetto obbligato del cambio password, non una scelta.
// I chiamanti ammessi «con conferma» devono avere un elemento JSX `<ConfermaUscita onConferma=…>` (un import non basta)
// e ogni riferimento a `doLogout`/`signOut` deve stare DENTRO quell'`onConferma`, direttamente o attraverso una
// funzione con nome (`const onLogout = …`) i cui usi stanno tutti, a loro volta, dentro l'`onConferma`.
// Gli alias si risolvono dall'AST: `import { doLogout as esci }` e `const { signOut } = …` / `{ signOut: esci }` (binding pattern)
// contano come `doLogout`/`signOut`, e i loro usi seguono le stesse regole. (Gli identificatori si confrontano per testo:
// può sbagliare solo verso il rosso.)
// L'analisi è STATICA: una chiave costruita a runtime (`auth['sign' + 'Out']()`) o un identificatore dentro una chiave
// computata (`{ [nome]: esci }`) non si vedono.
const ECCEZIONI = [
  'src/lib/auth/logout.ts',
  'src/components/providers/BiometricGate.tsx',
  'src/components/features/account/CambiaPasswordCard.tsx',
]
const CON_CONFERMA_ATTESI = [
  'src/components/ui/LogoutMenuButton.tsx',
  'src/components/ui/UserMenu.tsx',
  'src/app/(dashboard)/parent/profilo/page.tsx',
]
const MODULO_LOGOUT = '@/lib/auth/logout'

function elenca(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) elenca(p, out)
    else if (/\.tsx?$/.test(n)) out.push(p.split('\\').join('/'))
  }
  return out
}

function parse(percorso: string, src: string): ts.SourceFile {
  return ts.createSourceFile(percorso, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(percorso) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function visita(n: ts.Node, f: (x: ts.Node) => void): void {
  f(n)
  ts.forEachChild(n, (c) => visita(c, f))
}

const NOMI_USCITA = ['doLogout', 'signOut']

/** Il testo di una chiave: `a`, `'a'`, `['a']`. */
function testoChiave(k: ts.Node | undefined): string | null {
  if (!k) return null
  if (ts.isIdentifier(k) || ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) return k.text
  if (ts.isComputedPropertyName(k)) return testoChiave(k.expression)
  return null
}

/** Il nome «vero» di un import o di una destrutturazione: `a as b` → `a`, `{ a: b }` / `{ 'a': b }` → `a`, `{ a }` → `a`. */
function nomeOriginale(n: ts.ImportSpecifier | ts.BindingElement): string | null {
  return testoChiave(n.propertyName ?? n.name)
}

/**
 * I nomi LOCALI sotto cui `doLogout`/`signOut` entrano in un file: `import { doLogout as esci }` e
 * `const { signOut: esci } = …` (o senza rinomina). Si risolvono dall'AST, non dal testo.
 */
function alias(sf: ts.SourceFile): Set<string> {
  const a = new Set<string>()
  visita(sf, (n) => {
    if (ts.isImportSpecifier(n) || (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent))) {
      const orig = nomeOriginale(n)
      if (orig && NOMI_USCITA.includes(orig) && ts.isIdentifier(n.name)) a.add(n.name.text)
    }
  })
  return a
}

/**
 * Un nodo che sta nella DICHIARAZIONE di un import o di una destrutturazione (non è un uso): il nome locale o la chiave
 * (`a`, `'a'`, `['a']`). NON lo è il valore di default (`{ x = doLogout }`): quello è un riferimento vero.
 */
function eDichiarazione(n: ts.Node): boolean {
  const p = n.parent
  if (!p) return false
  if (ts.isImportSpecifier(p)) return true
  if (ts.isBindingElement(p) && ts.isObjectBindingPattern(p.parent)) {
    if (p.name === n || p.propertyName === n) return true
  }
  // chiave computata: `{ ['signOut']: esci }` — la stringa sta dentro un ComputedPropertyName che è la propertyName
  if (ts.isComputedPropertyName(p) && ts.isBindingElement(p.parent) && p.parent.propertyName === p) return true
  return false
}

/**
 * `doLogout` come identificatore, `.signOut` / `['signOut']` come proprietà, un alias risolto, la destrutturazione
 * stessa, o la stringa del modulo (import statico o dinamico).
 */
function eRiferimentoUscita(n: ts.Node, nomi: Set<string>): boolean {
  if (ts.isIdentifier(n)) {
    if (nomi.has(n.text)) return true
    if (n.text === 'doLogout') return true
    if (n.text === 'signOut' && n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return true
    // `const { signOut } = …`: la destrutturazione stessa è un riferimento (conta per «chi chiama»), anche senza uso.
    if (n.text === 'signOut' && eDichiarazione(n)) return true
  }
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
    if (n.text === MODULO_LOGOUT) return true
    if (NOMI_USCITA.includes(n.text)) {
      // `supabase.auth['signOut']`
      if (n.parent && ts.isElementAccessExpression(n.parent) && n.parent.argumentExpression === n) return true
      // `const { 'signOut': esci } = …` / `{ ['signOut']: esci }`: la destrutturazione stessa è un riferimento
      if (eDichiarazione(n)) return true
    }
  }
  return false
}

/** I riferimenti all'uscita in un sorgente (nodi), senza contare commenti né testo di stringhe qualunque. */
function riferimenti(sf: ts.SourceFile): ts.Node[] {
  const nomi = alias(sf)
  const r: ts.Node[] = []
  visita(sf, (n) => {
    if (eRiferimentoUscita(n, nomi)) r.push(n)
  })
  return r
}

/** Classifica i sorgenti: chi riferisce l'uscita fuori dalle eccezioni. Esportata per provare il lock sul rosso. */
export function chiamanti(sorgenti: Record<string, string>): string[] {
  return Object.keys(sorgenti)
    .filter((p) => !ECCEZIONI.includes(p))
    .filter((p) => riferimenti(parse(p, sorgenti[p])).length > 0)
}

function dentroOnConferma(n: ts.Node): boolean {
  for (let c: ts.Node | undefined = n; c; c = c.parent) {
    if (ts.isJsxAttribute(c) && ts.isIdentifier(c.name) && c.name.text === 'onConferma') {
      const tag = c.parent?.parent
      if (tag && (ts.isJsxOpeningElement(tag) || ts.isJsxSelfClosingElement(tag)) && tag.tagName.getText() === 'ConfermaUscita') return true
    }
  }
  return false
}

/** Il nome della funzione/variabile che racchiude `n` (la più vicina con un nome), o `null` se anonima. */
function nomeContenitore(n: ts.Node): string | null {
  for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
    if (ts.isFunctionDeclaration(c) && c.name) return c.name.text
    if (ts.isVariableDeclaration(c) && ts.isIdentifier(c.name)) return c.name.text
    if (ts.isJsxAttribute(c)) return null
  }
  return null
}

/** Violazioni di un chiamante ammesso: niente `<ConfermaUscita onConferma=…>`, o un riferimento all'uscita fuori da quel percorso. */
export function violazioni(percorso: string, src: string): string[] {
  const sf = parse(percorso, src)
  const v: string[] = []
  let haConferma = false
  visita(sf, (n) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === 'ConfermaUscita') {
      if (n.attributes.properties.some((a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === 'onConferma')) haConferma = true
    }
  })
  if (!haConferma) v.push(`${percorso}: manca <ConfermaUscita onConferma=…> (un import non basta)`)

  // Usi di un nome (funzione intermedia) in tutto il file, esclusa la sua dichiarazione.
  const usiDi = (nome: string): ts.Identifier[] => {
    const u: ts.Identifier[] = []
    visita(sf, (n) => {
      if (!ts.isIdentifier(n) || n.text !== nome) return
      const p = n.parent
      if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name === n) return
      if (ts.isImportSpecifier(p)) return
      u.push(n)
    })
    return u
  }
  const ammesso = (n: ts.Node, visti: Set<string>): boolean => {
    if (dentroOnConferma(n)) return true
    const nome = nomeContenitore(n)
    if (!nome || visti.has(nome)) return false
    visti.add(nome)
    const usi = usiDi(nome)
    return usi.length > 0 && usi.every((u) => ammesso(u, visti))
  }
  for (const r of riferimenti(sf)) {
    // L'import della funzione non è un uso; la stringa del modulo sta solo nell'import.
    if (ts.isStringLiteral(r) && ts.isImportDeclaration(r.parent)) continue
    if (eDichiarazione(r)) continue
    if (!ammesso(r, new Set())) {
      const { line } = sf.getLineAndCharacterOfPosition(r.getStart())
      v.push(`${percorso}:${line + 1}: «${r.getText()}» fuori dal percorso di conferma (onConferma)`)
    }
  }
  return v
}

const tutti = Object.fromEntries(elenca('src').map((p) => [p, readFileSync(p, 'utf8')]))

describe('ogni uscita scelta dall\'utente passa dalla conferma', () => {
  const trovati = chiamanti(tutti)

  it('esamina src/ per intero (il lock non è cieco)', () => {
    expect(Object.keys(tutti).length).toBeGreaterThan(1000)
    expect(trovati.sort()).toEqual([...CON_CONFERMA_ATTESI].sort())
  })

  it.each(CON_CONFERMA_ATTESI)('%s ha <ConfermaUscita onConferma=…> e l\'uscita solo da lì', (p) => {
    expect(violazioni(p, tutti[p])).toEqual([])
  })

  it('le eccezioni esistono ancora (altrimenti l\'elenco è vecchio)', () => {
    for (const e of ECCEZIONI) expect(tutti[e], e).toBeDefined()
  })
})

// PROVA DEL ROSSO, nel test stesso: le forme rotte apposta devono essere viste dal lock. Se una passasse, il lock
// sarebbe di nuovo cieco su quella forma.
describe('il lock vede le forme rotte (prova del rosso)', () => {
  const buono = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'
import { doLogout } from '@/lib/auth/logout'
export function X() { return <><button onClick={() => setC(true)}>Esci</button><ConfermaUscita open onConferma={() => doLogout()} /></> }`

  it('il caso buono non ha violazioni', () => {
    expect(violazioni('x.tsx', buono)).toEqual([])
  })
  it('un handler con nome usato SOLO da onConferma è ammesso', () => {
    const ok = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout } from '@/lib/auth/logout'\nexport function X() { const onLogout = async () => { await doLogout() }; return <ConfermaUscita open onConferma={onLogout} /> }`
    expect(violazioni('x.tsx', ok)).toEqual([])
  })
  it('variante 1: onClick={doLogout} senza parentesi', () => {
    const rotto = `import { doLogout } from '@/lib/auth/logout'\nexport const X = () => <button onClick={doLogout}>Esci</button>`
    expect(chiamanti({ 'x.tsx': rotto })).toEqual(['x.tsx'])
    expect(violazioni('x.tsx', rotto).length).toBeGreaterThan(0)
  })
  it('variante 2: onClick={async () => { await doLogout() }} con le graffe', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout } from '@/lib/auth/logout'\nexport const X = () => <><ConfermaUscita open onConferma={() => {}} /><button onClick={async () => { await doLogout() }}>Esci</button></>`
    expect(chiamanti({ 'x.tsx': rotto })).toEqual(['x.tsx'])
    expect(violazioni('x.tsx', rotto).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
  })
  it('variante 3: import di ConfermaUscita senza uso', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout } from '@/lib/auth/logout'\nexport const X = () => <button onClick={() => void doLogout()}>Esci</button>`
    expect(violazioni('x.tsx', rotto).some((m) => m.includes('manca <ConfermaUscita'))).toBe(true)
  })
  it('variante 4: un nuovo pulsante che chiama supabase.auth.signOut direttamente', () => {
    const rotto = `export const X = () => <button onClick={() => supabase.auth.signOut()}>Esci</button>`
    expect(chiamanti({ 'x.tsx': rotto })).toEqual(['x.tsx'])
  })
  it('variante 5 (nuova): chiamante INDIRETTO — onLogout() usato anche da onClick, dentro un file ammesso', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout } from '@/lib/auth/logout'\nexport function X() { const onLogout = async () => { await doLogout() }; return <><button onClick={onLogout}>Esci</button><ConfermaUscita open onConferma={onLogout} /></> }`
    expect(violazioni('x.tsx', rotto).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
  })
  it('variante 5b: handler con nome usato SOLO da onClick, con una conferma che non lo usa', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout } from '@/lib/auth/logout'\nexport function X() { const onLogout = () => doLogout(); return <><button onClick={onLogout}>Esci</button><ConfermaUscita open onConferma={() => {}} /></> }`
    expect(violazioni('x.tsx', rotto).length).toBeGreaterThan(0)
  })
  it('variante 6 (nuova): una stringa con `/*` non nasconde il codice che la segue', () => {
    const rotto = `const a = '/*'\nexport const X = () => <button onClick={() => supabase.auth.signOut()}>Esci</button>\nconst b = '*/'`
    expect(chiamanti({ 'x.tsx': rotto })).toEqual(['x.tsx'])
  })
  it('variante 7 (nuova): import con alias — `doLogout as esci` usato fuori da onConferma', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout as esci } from '@/lib/auth/logout'\nexport function X() { return <><button onClick={() => esci()}>Esci</button><ConfermaUscita open onConferma={() => {}} /></> }`
    expect(violazioni('x.tsx', rotto).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
  })
  it('variante 7b: l\'alias usato SOLO dentro onConferma è ammesso', () => {
    const ok = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout as esci } from '@/lib/auth/logout'\nexport function X() { return <ConfermaUscita open onConferma={() => esci()} /> }`
    expect(violazioni('x.tsx', ok)).toEqual([])
  })
  it('variante 8 (nuova): destrutturazione — `const { signOut } = supabase.auth` usato fuori da onConferma', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nexport function X() { const { signOut } = supabase.auth; return <><button onClick={() => signOut()}>Esci</button><ConfermaUscita open onConferma={() => {}} /></> }`
    expect(violazioni('x.tsx', rotto).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
  })
  it('variante 8b: destrutturazione con rinomina — `{ signOut: esci }` — e import dinamico `{ doLogout: esci }`', () => {
    const a = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nexport function X() { const { signOut: esci } = supabase.auth; return <><button onClick={() => esci()}>Esci</button><ConfermaUscita open onConferma={() => {}} /></> }`
    expect(violazioni('x.tsx', a).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
    const b = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nexport function X() { return <><button onClick={async () => { const { doLogout: esci } = await import('@/lib/auth/logout'); await esci() }}>Esci</button><ConfermaUscita open onConferma={() => {}} /></> }`
    expect(violazioni('x.tsx', b).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
  })
  it('variante 8c: la destrutturazione usata SOLO dentro onConferma è ammessa', () => {
    const ok = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nexport function X() { return <ConfermaUscita open onConferma={async () => { const { signOut } = supabase.auth; await signOut({ scope: 'local' }) }} /> }`
    expect(violazioni('x.tsx', ok)).toEqual([])
  })
  it('variante 9 (nuova): il valore di DEFAULT di una destrutturazione — `const { x = doLogout } = o; x()` — è un riferimento', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout } from '@/lib/auth/logout'\nexport function X(o: any) { const { x = doLogout } = o; return <><button onClick={() => x()}>Esci</button><ConfermaUscita open onConferma={() => {}} /></> }`
    expect(violazioni('x.tsx', rotto).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
  })
  it('variante 10 (nuova): chiave fra apici nella destrutturazione — `{ \'signOut\': esci } = …` — è un alias', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nexport function X() { const { 'signOut': esci } = supabase.auth; return <><button onClick={() => esci()}>Esci</button><ConfermaUscita open onConferma={() => {}} /></> }`
    expect(violazioni('x.tsx', rotto).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
    const computata = rotto.replace("'signOut':", "['signOut']:")
    expect(violazioni('x.tsx', computata).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
  })
  it('variante 11 (nuova): accesso con parentesi quadre — `supabase.auth[\'signOut\']()` — è visto', () => {
    const rotto = `export const X = () => <button onClick={() => supabase.auth['signOut']()}>Esci</button>`
    expect(chiamanti({ 'x.tsx': rotto })).toEqual(['x.tsx'])
    const ok = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nexport const X = () => <ConfermaUscita open onConferma={() => supabase.auth['signOut']({ scope: 'local' })} />`
    expect(violazioni('x.tsx', ok)).toEqual([])
    const fuori = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nexport const X = () => <><button onClick={() => supabase.auth['signOut']()}>Esci</button><ConfermaUscita open onConferma={() => {}} /></>`
    expect(violazioni('x.tsx', fuori).some((m) => m.includes('fuori dal percorso di conferma'))).toBe(true)
  })
  it('un import dinamico del modulo viene visto', () => {
    expect(chiamanti({ 'x.tsx': `export const X = async () => { const m = await import('@/lib/auth/logout'); await m.doLogout() }` })).toEqual(['x.tsx'])
  })
  it('un commento o una stringa che nominano doLogout non fanno scattare il lock', () => {
    expect(chiamanti({ 'x.tsx': '// usa doLogout() dopo la conferma\n/* doLogout */\nexport const X = "doLogout"' })).toEqual([])
  })
})

// Decisione di Luigi del 13/11/2026: «Esci» chiude la sessione SOLO su questo dispositivo. Il lato server
// dell'uscita non deve chiudere sessioni (né `auth.admin.signOut` né una uscita globale): toglie solo i cookie di
// questo browser. Il client passa `scope: 'local'` (vedi `__tests__/lib/logout.test.ts`).
describe('l\'uscita non tocca le altre sessioni', () => {
  const route = parse('route.ts', readFileSync('src/app/api/auth/logout/route.ts', 'utf8'))
  it('POST /api/auth/logout non chiama nessun signOut', () => {
    const nomi: string[] = []
    visita(route, (n) => {
      if (ts.isIdentifier(n) && (n.text === 'signOut' || n.text === 'admin')) nomi.push(n.text)
    })
    expect(nomi).toEqual([])
  })
  it('doLogout chiama signOut con scope local e mai senza', () => {
    const sf = parse('logout.ts', readFileSync('src/lib/auth/logout.ts', 'utf8'))
    const chiamate: ts.CallExpression[] = []
    visita(sf, (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'signOut') chiamate.push(n)
    })
    expect(chiamate).toHaveLength(1)
    const arg = chiamate[0].arguments[0]
    expect(arg && ts.isObjectLiteralExpression(arg)).toBe(true)
    const scope = (arg as ts.ObjectLiteralExpression).properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'scope') as ts.PropertyAssignment | undefined
    expect(scope && ts.isStringLiteral(scope.initializer) && scope.initializer.text).toBe('local')
  })
})
