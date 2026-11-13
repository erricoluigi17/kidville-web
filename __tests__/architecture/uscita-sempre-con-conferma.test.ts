import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Chi esce per una SCELTA dell'utente deve passare da `ConfermaUscita`: un tocco sbagliato su «Esci» (successo nel
// collaudo del 13/11, foglio in scorrimento) chiude la sessione. Il lock NON prova a capire il corpo di un
// `onClick` (cieco su `{async () => {…}}`, su `onClick={doLogout}`, su `.then(doLogout)`): cerca OGNI riferimento a
// `doLogout`, a `@/lib/auth/logout` e a `auth.signOut` in tutto `src/`, fuori dai commenti, e lo ammette solo in
// un elenco chiuso di file. Eccezioni dichiarate:
//  · `lib/auth/logout.ts`: dove `doLogout` e `signOut` vivono;
//  · `BiometricGate`: è l'ultima via d'uscita quando la biometria non passa, non deve diventare un vicolo cieco;
//  · `CambiaPasswordCard`: l'uscita lì è l'effetto obbligato del cambio password, non una scelta.
// I chiamanti ammessi «con conferma» devono avere `<ConfermaUscita` (con l'angolo: un import non basta) e
// `onConferma=`, e `doLogout` deve comparire SOLO come argomento di quel `onConferma`/da un suo handler.
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

function elenca(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) elenca(p, out)
    else if (/\.tsx?$/.test(n)) out.push(p.split('\\').join('/'))
  }
  return out
}

// Il sorgente senza i commenti (di riga e di blocco): i commenti nominano `doLogout` a parole.
export function senzaCommenti(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((r) => r.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
}

const RIFERIMENTO = /\bdoLogout\b|@\/lib\/auth\/logout|\bauth\s*\.\s*signOut\b|\.signOut\s*\(/

/** Classifica i sorgenti: chi riferisce l'uscita fuori dalle eccezioni. Esportata per provare il lock sul rosso. */
export function chiamanti(sorgenti: Record<string, string>): string[] {
  return Object.keys(sorgenti)
    .filter((p) => !ECCEZIONI.includes(p))
    .filter((p) => RIFERIMENTO.test(senzaCommenti(sorgenti[p])))
}

/** Violazioni di un chiamante: niente `<ConfermaUscita`/`onConferma=`, o `doLogout` usato fuori da quel contesto. */
export function violazioni(percorso: string, src: string): string[] {
  const s = senzaCommenti(src)
  const v: string[] = []
  if (!/<ConfermaUscita\b/.test(s)) v.push(`${percorso}: manca <ConfermaUscita (un import non basta)`)
  if (!/\bonConferma\s*=/.test(s)) v.push(`${percorso}: manca onConferma=`)
  // `doLogout` va chiamato solo da un handler che NON è un onClick/onPress/onSelect diretto di un elemento.
  const diretto = /\bon(Click|Press|Select|PointerUp|TouchEnd|MouseDown|KeyDown)\s*=\s*\{(?:(?!\bonConferma\b)[\s\S])*?\bdoLogout\b/
  if (diretto.test(s)) v.push(`${percorso}: doLogout dentro un gestore diretto (senza conferma)`)
  return v
}

const tutti = Object.fromEntries(elenca('src').map((p) => [p, readFileSync(p, 'utf8')]))

describe('ogni uscita scelta dall\'utente passa dalla conferma', () => {
  const trovati = chiamanti(tutti)

  it('esamina src/ per intero (il lock non è cieco)', () => {
    expect(Object.keys(tutti).length).toBeGreaterThan(1000)
    expect(trovati.sort()).toEqual([...CON_CONFERMA_ATTESI].sort())
  })

  it.each(CON_CONFERMA_ATTESI)('%s ha <ConfermaUscita, onConferma= e nessun doLogout diretto', (p) => {
    expect(violazioni(p, tutti[p])).toEqual([])
  })

  it('le eccezioni esistono ancora (altrimenti l\'elenco è vecchio)', () => {
    for (const e of ECCEZIONI) expect(tutti[e], e).toBeDefined()
  })
})

// PROVA DEL ROSSO, nel test stesso: tre forme rotte apposta devono essere viste dal lock. Se una passasse, il lock
// sarebbe di nuovo cieco su quella forma.
describe('il lock vede le forme rotte (prova del rosso)', () => {
  const buono = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'
import { doLogout } from '@/lib/auth/logout'
export function X() { return <><button onClick={() => setC(true)}>Esci</button><ConfermaUscita open onConferma={() => doLogout()} /></> }`

  it('il caso buono non ha violazioni', () => {
    expect(violazioni('x.tsx', buono)).toEqual([])
  })
  it('variante 1: onClick={doLogout} senza parentesi', () => {
    const rotto = `import { doLogout } from '@/lib/auth/logout'\nexport const X = () => <button onClick={doLogout}>Esci</button>`
    expect(chiamanti({ 'x.tsx': rotto })).toEqual(['x.tsx'])
    expect(violazioni('x.tsx', rotto).length).toBeGreaterThan(0)
  })
  it('variante 2: onClick={async () => { await doLogout() }} con le graffe', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout } from '@/lib/auth/logout'\nexport const X = () => <><ConfermaUscita open onConferma={() => {}} /><button onClick={async () => { await doLogout() }}>Esci</button></>`
    expect(chiamanti({ 'x.tsx': rotto })).toEqual(['x.tsx'])
    expect(violazioni('x.tsx', rotto).some((m) => m.includes('gestore diretto'))).toBe(true)
  })
  it('variante 3: import di ConfermaUscita senza uso', () => {
    const rotto = `import { ConfermaUscita } from '@/components/ui/ConfermaUscita'\nimport { doLogout } from '@/lib/auth/logout'\nexport const X = () => <button onClick={() => void doLogout()}>Esci</button>`
    expect(violazioni('x.tsx', rotto).some((m) => m.includes('manca <ConfermaUscita'))).toBe(true)
  })
  it('variante 4: un nuovo pulsante che chiama supabase.auth.signOut direttamente', () => {
    const rotto = `export const X = () => <button onClick={() => supabase.auth.signOut()}>Esci</button>`
    expect(chiamanti({ 'x.tsx': rotto })).toEqual(['x.tsx'])
  })
  it('un commento che nomina doLogout non fa scattare il lock', () => {
    expect(chiamanti({ 'x.tsx': '// usa doLogout() dopo la conferma\nexport const X = 1' })).toEqual([])
  })
})

// Decisione di Luigi del 13/11/2026: «Esci» chiude la sessione SOLO su questo dispositivo. Il lato server
// dell'uscita non deve chiudere sessioni (né `auth.admin.signOut` né una uscita globale): toglie solo i cookie di
// questo browser. Il client passa `scope: 'local'` (vedi `__tests__/lib/logout.test.ts`).
describe('l\'uscita non tocca le altre sessioni', () => {
  const route = senzaCommenti(readFileSync('src/app/api/auth/logout/route.ts', 'utf8'))
  it('POST /api/auth/logout non chiama nessun signOut', () => {
    expect(route).not.toMatch(/signOut|admin\./)
  })
  it('doLogout chiama signOut con scope local e mai senza', () => {
    const src = senzaCommenti(readFileSync('src/lib/auth/logout.ts', 'utf8'))
    expect(src).toContain("signOut({ scope: 'local' })")
    expect(src).not.toMatch(/signOut\(\s*\)/)
  })
})
