import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// LOCK di sicurezza — nessuna password in chiaro nei file tracciati
//
// Il repository è stato PUBBLICO fino al 2026-07-26 e la password comune dei 41
// account TEST `test.*@kidville.test` — account ATTIVI in produzione, uno dei quali
// di segreteria, con vista sull'anagrafica dell'intera sede — era scritta in chiaro
// in 9 file committati (PRD, spec, script e2e, perfino nell'HTML dei report 360°).
// La password è stata ruotata il 2026-07-26 e i valori tolti dal repo: questo lock
// impedisce che ne rientri una, sotto qualunque nome.
//
// Come si passa il lock: la password si legge da una variabile d'ambiente
// (`KV_TEST_PASSWORD`) e lo script fallisce subito se manca. Mai un default, mai un
// valore committato, mai stampata dentro un report generato.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()

// Eccezioni motivate. NON aggiungere qui una password nuova per far passare il gate:
// spostala in una variabile d'ambiente. Chiave = percorso del file (relativo alla root).
// (2026-07-31) L'allowlist è VUOTA, e l'ultima eccezione è caduta col peggiore
// dei precedenti: la password del seed E2E — `scripts/seed-e2e.mjs`,
// `e2e/fixtures.ts`, `docs/e2e.md` — era esentata perché «il DB E2E della CI non
// contiene dati reali». Era vero del database; non dell'ACCOUNT. Il 29/07 il
// provisioning delle sedi ha collegato `admin.e2e@kidville.test` a Kidville
// Aversa e Kidville Cesa, e quella password è rimasta valida in PRODUZIONE su un
// `ruolo='admin'` per due giorni, in un repository pubblico. La lezione non è
// «serviva un'eccezione più stretta»: è che una password committata non resta
// dove l'hai messa. Ora si legge da `KV_E2E_PASSWORD` (e2e/lib/e2e-password.mjs).
const ECCEZIONI: Record<string, string> = {}

const ESTENSIONI = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md', '.mdx',
  '.json', '.yml', '.yaml', '.sql', '.sh', '.txt', '.html', '.env',
])

/** Identificatore/chiave che parla di password (KV_PASSWORD, userPassword, pwd, …). */
const CHIAVE = String.raw`[A-Za-z0-9_.\-]*(?:password|passwd|pwd)[A-Za-z0-9_.\-]*`

/** `PASSWORD = '…'` · `password: "…"` · `KV_PASSWORD='…'` */
const ASSEGNAZIONE = new RegExp(String.raw`\b${CHIAVE}\s*[:=]{1,3}\s*(['"\`])([^'"\`\n]*)\1`, 'gi')

/** Prosa markdown: «password comune \`Segreto\`» · «pwd \`Segreto\`» */
const IN_PROSA = new RegExp(String.raw`(?:password|passwd|pwd)[^\n\`]{0,60}\`([^\`\n]{1,80})\``, 'gi')

/** HTML generato: «Password unica di test: <span…>Segreto</span>» (report, artefatti) */
const IN_MARKUP = new RegExp(String.raw`(?:password|passwd|pwd)[^\n<]{0,60}<[^<>\n]{0,80}>([^<>\n]{1,80})<`, 'gi')

const SEGNAPOSTO = [
  'password', 'passwd', 'pwd', 'process.env', 'changeme', 'segnaposto', 'placeholder',
  'esempio', 'example', 'your', 'tuo', 'todo', 'redacted', 'omissis', 'xxx', '***', '…', '...',
  // Letterali che dichiarano da soli di essere finti (fixture di test, esempi nei documenti).
  'segret', 'fint', 'fake', 'dummy',
]

/**
 * Un letterale «somiglia a una password» se è lungo, non è un segnaposto e mescola
 * almeno 3 classi di caratteri su 4 (minuscole, maiuscole, cifre, simboli).
 * Deliberatamente stretto: meglio pochi allarmi veri che un lock che tutti ignorano.
 */
export function sembraUnaPassword(valore: string): boolean {
  const v = valore.trim()
  if (v.length < 8 || v.length > 80) return false
  if (/\s/.test(v)) return false
  // Segnaposto espliciti e interpolazioni: <…>, ${…}, $VAR, {{…}}
  if (/^[<${]/.test(v) || v.endsWith('>')) return false
  const basso = v.toLowerCase()
  if (SEGNAPOSTO.some((s) => basso.includes(s))) return false
  // Nome di variabile d'ambiente (KV_TEST_PASSWORD) o costante SCREAMING_CASE.
  if (/^[A-Z][A-Z0-9_]*$/.test(v)) return false
  // Path, URL, import: non sono password.
  if (/^[./~]|:\/\/|^@/.test(v)) return false
  // Un INDIRIZZO E-MAIL non è una password, e nei documenti che parlano di
  // account ne compare uno accanto alla parola «password» in quasi ogni riga
  // («la password dell'account `x@y.test`»). Senza questa calibrazione il lock
  // urla su prosa innocua, e un lock che urla a vuoto finisce per raccogliere
  // eccezioni — che è il modo in cui la password del seed E2E è rimasta
  // committata per mesi. Compromesso accettato: una password fatta ESATTAMENTE
  // come un indirizzo e-mail (`Pa@ssw0rd.info`) sfuggirebbe; il TLD alfabetico
  // di 2+ lettere tiene fuori i casi realistici (`Kidv@lle.2026!` resta rilevata).
  if (/^[A-Za-z0-9_.+*%-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}$/.test(v)) return false
  // Frammenti di codice citati nei documenti: `auth.admin.updateUserById`,
  // `ALLOW_HEADER_IDENTITY='false'`, `getModuleConfig()`.
  if (/[=()[\];,<>|]/.test(v)) return false
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v)) return false
  const classi = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length
  return classi >= 3
}

export interface Rilievo {
  riga: number
  valore: string
  contesto: string
}

export function trovaPasswordInChiaro(testo: string, file = 'x.md'): Rilievo[] {
  const rilievi: Rilievo[] = []
  // La prosa con backtick è un pattern da documento: nel codice i backtick sono
  // template literal e produrrebbero solo rumore.
  const regole = /\.mdx?$/i.test(file)
    ? [ASSEGNAZIONE, IN_PROSA, IN_MARKUP]
    : [ASSEGNAZIONE, IN_MARKUP]
  testo.split('\n').forEach((riga, i) => {
    for (const re of regole) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(riga)) !== null) {
        const valore = m[m.length - 1]
        if (!sembraUnaPassword(valore)) continue
        // `'KidvilleParent_' + Math.random()…`: un prefisso concatenato non è una credenziale.
        if (/^\s*\+/.test(riga.slice(m.index + m[0].length))) continue
        rilievi.push({ riga: i + 1, valore, contesto: riga.trim().slice(0, 120) })
      }
    }
  })
  return rilievi
}

function fileTracciati(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter(Boolean)
}

// Test unitari e mock: girano contro stub, non contro un server di autenticazione, e
// usano per definizione credenziali inventate («password», 'x', 'tmp-pass-123').
// `e2e/**` NON è escluso: quelle campagne parlano con il DB di PRODUZIONE.
const FUORI_PERIMETRO = /^(?:__tests__|test)\//

describe('lock sicurezza · nessuna password in chiaro nei file tracciati', () => {
  const files = fileTracciati().filter((f) => {
    if (FUORI_PERIMETRO.test(f)) return false
    const punto = f.lastIndexOf('.')
    return punto >= 0 && ESTENSIONI.has(f.slice(punto).toLowerCase())
  })

  it('trova i file da scandire (sanity: il lock non gira a vuoto)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  // Campione assemblato per concatenazione: il letterale non compare mai per intero
  // in questo file, altrimenti il lock si autodenuncerebbe.
  const campione = 'Cipo' + 'lla.2026!'
  const q = "'"

  it('il rilevatore riconosce una password in chiaro (prova di validità del regex)', () => {
    expect(trovaPasswordInChiaro(`export const PASSWORD = ${q}${campione}${q};`, 'a.ts')).toHaveLength(1)
    expect(trovaPasswordInChiaro(`  { email, password: ${q}${campione}${q} }`, 'a.mjs')).toHaveLength(1)
    expect(trovaPasswordInChiaro('Password comune: `' + campione + '`', 'a.md')).toHaveLength(1)
    expect(
      trovaPasswordInChiaro(`<p>Password unica di test: <span class="mono">${campione}</span></p>`, 'a.mjs'),
    ).toHaveLength(1)
    // L'esclusione degli indirizzi e-mail è STRETTA: una password che contiene
    // una chiocciola resta una password.
    expect(trovaPasswordInChiaro('Password comune: `' + 'Kidv@' + 'lle.2026!`', 'a.md')).toHaveLength(1)
  })

  it('il rilevatore NON urla su segnaposto e rimandi (calibrazione)', () => {
    const casi: [string, string][] = [
      ['export const PASSWORD = process.env.KV_TEST_PASSWORD;', 'a.ts'],
      ['const PASSWORD = requireTestPassword();', 'a.mjs'],
      [`password: ${q}${q},`, 'a.ts'],
      [`password: ${q}x${q},`, 'a.ts'],
      [`await page.locator('#password').fill(PASSWORD);`, 'a.ts'],
      ['export MAESTRO_KV_PASSWORD="<password degli account TEST>"', 'a.md'],
      ['maestro test -e KV_PASSWORD="$KV_TEST_PASSWORD" \\', 'a.md'],
      ['La password sta nella variabile `KV_TEST_PASSWORD`.', 'a.md'],
      ['il reset della password (`auth.admin.updateUserById` con password random)', 'a.md'],
      ['La password è nel gestore di credenziali del titolare.', 'a.md'],
      [`const tempPassword = ${q}KidvilleParent_${q} + Math.random().toString(36);`, 'a.ts'],
      // Indirizzi e-mail citati accanto alla parola «password»: nei documenti che
      // parlano di account sono la norma, e non sono credenziali.
      ['la password era valida su `admin.e2e@kidville.test` — ruolo `admin`', 'a.md'],
      ['Ruotare la password dei 4 account `*.e2e@kidville.test` in produzione', 'a.md'],
    ]
    for (const [testo, file] of casi) {
      expect(trovaPasswordInChiaro(testo, file), `falso positivo su: ${testo}`).toHaveLength(0)
    }
  })

  it('nessun file tracciato contiene una password in chiaro', () => {
    const trovati: string[] = []
    for (const f of files) {
      if (f in ECCEZIONI) continue
      const abs = join(ROOT, f)
      let stat
      try {
        stat = statSync(abs)
      } catch {
        continue // file rimosso dall'indice ma ancora listato: non è un problema di sicurezza
      }
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue
      for (const r of trovaPasswordInChiaro(readFileSync(abs, 'utf8'), f)) {
        trovati.push(`${f}:${r.riga} → «${r.valore}»  |  ${r.contesto}`)
      }
    }
    expect(
      trovati,
      'Password in chiaro nel repo (il repository è stato pubblico fino al 2026-07-26).\n' +
        trovati.map((t) => `  · ${t}`).join('\n') +
        '\n\nCosa fare: togli il valore dal file e leggilo da una variabile d\'ambiente ' +
        '(negli script e2e è `KV_TEST_PASSWORD`, vedi e2e/lib/test-password.mjs), facendo FALLIRE ' +
        'subito lo script se manca — niente default, niente stringa vuota. Nei documenti lascia solo il ' +
        'rimando («gestore di credenziali del titolare / variabile KV_TEST_PASSWORD»). Se la password ' +
        'era già stata pubblicata, va anche RUOTATA: toglierla dal file non la toglie dalla storia git.',
    ).toEqual([])
  })

  it('le eccezioni sono ancora tutte necessarie (niente allowlist zombie)', () => {
    const inutili = Object.keys(ECCEZIONI).filter((f) => {
      try {
        return trovaPasswordInChiaro(readFileSync(join(ROOT, f), 'utf8'), f).length === 0
      } catch {
        return true // file sparito
      }
    })
    expect(
      inutili,
      `Queste eccezioni non servono più (il file non contiene più una password in chiaro, o non esiste): ` +
        `${inutili.join(', ')}. Toglile da ECCEZIONI in questo test, così l'allowlist resta corta e credibile.`,
    ).toEqual([])
  })
})
