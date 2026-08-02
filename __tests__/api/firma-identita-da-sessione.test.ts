/**
 * Le quattro route della FIRMA prendono l'identità dalla SESSIONE, mai dall'header.
 *
 * IL DIFETTO (audit 2026-07-30, voce «2. L'identità da header aggira il proprio
 * interruttore», rimasta APERTA fino al 2026-07-31).
 * `ALLOW_HEADER_IDENTITY` è a `false` in produzione, ma il flag vive DENTRO
 * `resolveIdentity`. Queste quattro route chiamavano `getRequestUserId` in diretta,
 * cioè leggevano `x-user-id` / `?userId=` **saltando l'interruttore**. Conseguenze:
 *
 *  · `note/firma:POST` produce una **firma elettronica con valore legale**
 *    (`fea_audit_log`, il codice cita il CAD art. 20) attribuibile a un genitore
 *    qualunque da chiunque ne conoscesse l'uuid — senza sessione, senza password.
 *  · le tre route OTP spedivano il codice all'indirizzo del genitore su richiesta
 *    di chiunque: un canale d'invio email azionabile dall'esterno, senza limite.
 *
 * Il presidio residuo era il solo OTP via email. Non basta: l'OTP dimostra che chi
 * firma legge quella casella, non che sia lui ad aver chiesto di firmare.
 *
 * QUESTO FILE è un lock di FORMA, non di caso: verifica sul sorgente che nessuna
 * delle quattro chiami `getRequestUserId`, e che tutte passino da `requireUser`
 * (che è l'unico punto in cui `ALLOW_HEADER_IDENTITY` è letto). Un lock di forma
 * regge anche quando la route viene riscritta; una prova d'integrazione sul singolo
 * status no.
 *
 * PROVA DI VALIDITÀ (eseguita, 2026-07-31): rimettendo `getRequestUserId` in
 * `note/firma/route.ts` questo file diventa rosso su due asserzioni — «non importa
 * getRequestUserId» e «passa da requireUser».
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RADICE = process.cwd()

/** Le quattro route che il 30/07 leggevano l'identità dall'header. */
const ROUTE_FIRMA = [
  'src/app/api/parent/primaria/note/firma/route.ts',
  'src/app/api/parent/primaria/note/firma/otp/route.ts',
  'src/app/api/parent/primaria/pagella/firma/otp/route.ts',
  'src/app/api/parent/presenze/giustifica/otp/route.ts',
]

/**
 * Gli UNICI due punti di `src/app/api/**` autorizzati a leggere l'identità
 * dall'header, ciascuno con la sua ragione. Allowlist a MATCH ESATTO: un file
 * nuovo non ci finisce dentro per somiglianza di percorso.
 */
const AMMESSI = new Map<string, string>([
  [
    'src/app/api/logs/route.ts',
    'Il valore NON è un\'identità, è un\'etichetta di correlazione sul log del client: ' +
      'la route non concede niente in base ad esso. Documentato nel file, righe 45-55.',
  ],
  [
    'src/app/api/me/route.ts',
    'Legge l\'header SOLO dentro `process.env.ALLOW_HEADER_IDENTITY !== \'false\' ? … : null`, ' +
      'cioè rispetta l\'interruttore invece di scavalcarlo (route.ts:79).',
  ],
])

function tuttiIFileRoute(dir: string, acc: string[] = []): string[] {
  for (const voce of readdirSync(dir)) {
    const p = join(dir, voce)
    if (statSync(p).isDirectory()) tuttiIFileRoute(p, acc)
    else if (voce === 'route.ts') acc.push(p)
  }
  return acc
}

describe('firma e OTP: l\'identità viene dalla sessione, non dall\'header', () => {
  it.each(ROUTE_FIRMA)('%s non importa getRequestUserId', (rel) => {
    const src = readFileSync(join(RADICE, rel), 'utf8')
    expect(src).not.toMatch(/import\s*\{[^}]*\bgetRequestUserId\b[^}]*\}/)
    expect(src).not.toMatch(/\bgetRequestUserId\s*\(/)
  })

  it.each(ROUTE_FIRMA)('%s passa da requireUser e nega senza sessione', (rel) => {
    const src = readFileSync(join(RADICE, rel), 'utf8')
    // `requireUser` è l'unica porta che consulta ALLOW_HEADER_IDENTITY.
    expect(src).toMatch(/\bawait\s+requireUser\s*\(\s*request\s*\)/)
    // …e la sua risposta di rifiuto deve essere restituita, non ignorata.
    expect(src).toMatch(/if\s*\(\s*\w+\.response\s*\)\s*return\s+\w+\.response/)
  })

  it('nessun\'altra route di src/app/api legge l\'identità dall\'header', () => {
    const colpevoli: string[] = []
    for (const assoluto of tuttiIFileRoute(join(RADICE, 'src/app/api'))) {
      const rel = assoluto.slice(RADICE.length + 1)
      if (AMMESSI.has(rel)) continue
      if (/\bgetRequestUserId\s*\(/.test(readFileSync(assoluto, 'utf8'))) colpevoli.push(rel)
    }
    expect(colpevoli, [
      'Queste route leggono l\'identità dall\'header/query saltando ALLOW_HEADER_IDENTITY.',
      'Usa `requireUser(request)` (o `requireParentOfStudent`) — è l\'unico punto che',
      'consulta l\'interruttore. Se il valore NON è un\'identità ma un\'etichetta,',
      'aggiungilo ad AMMESSI con la ragione scritta per esteso.',
    ].join('\n')).toEqual([])
  })

  it('l\'allowlist resta di due voci: allargarla è una decisione, non una svista', () => {
    expect([...AMMESSI.keys()].sort()).toEqual([
      'src/app/api/logs/route.ts',
      'src/app/api/me/route.ts',
    ])
  })
})
