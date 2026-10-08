import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, fileSorgente, riga } from '../fixtures/sorgente'

// =============================================================================
// LOCK · chi chiama `anonimizzaAlunno` guarda prima il registro della primaria.
//
// LA REGOLA (titolare, 2026-10-08): voti, pagelle, scrutini, note disciplinari e
// certificati delle competenze sono il registro della scuola, che la legge
// obbliga a conservare — è l'eccezione dell'art. 17 §3 lett. b del GDPR. Il
// registro della primaria NON si cancella e NON si anonimizza, da NESSUNA porta.
//
// IL DIFETTO CHE QUESTO LOCK IMPEDISCE DI RIPETERE (2026-10-09). La regola era
// stata messa su `admin/gdpr/erase`, e `admin/gdpr/richieste` — la porta che
// evade la richiesta di cancellazione della FAMIGLIA, in blocco su tutti i figli
// non iscritti — chiamava `anonimizzaAlunno` senza nessun controllo. Nessun test
// era rosso: ogni route aveva i suoi, e nessuno guardava le route che non
// conosceva. Una porta nuova (l'eliminazione definitiva di
// `admin/students/elimina`, per esempio) avrebbe ripetuto lo stesso buco.
//
// LA FORMA: ogni file di `src/` che CHIAMA `anonimizzaAlunno(` — esclusa la sua
// definizione in `src/lib/gdpr/esegui.ts` — deve chiamare anche
// `leggiRegistroPrimaria(` o `alunniConRegistroPrimaria(`
// (`src/lib/alunni/registro-primaria.ts`). La scansione legge il sorgente con
// commenti e stringhe spenti (`mascheraSorgente`): un nome citato in un
// commento che spiega la regola non conta né come chiamata né come controllo.
//
// Il lock non prova che il controllo stia PRIMA della scrittura né che il suo
// esito sia rispettato: quello lo provano i test di ciascuna route
// (`gdpr-erase-registro-primaria`, `admin-gdpr-richieste-registro-primaria`).
// Prova che nessuna porta lo dimentichi del tutto.
// =============================================================================

const RADICE = path.resolve(__dirname, '../..')
const SRC = path.join(RADICE, 'src')
const DEFINIZIONE = 'src/lib/gdpr/esegui.ts'

const CHIAMATA = /\banonimizzaAlunno\s*\(/g
const CONTROLLO = /\b(?:leggiRegistroPrimaria|alunniConRegistroPrimaria)\s*\(/
// Un import rinominato renderebbe il chiamante invisibile alla scansione.
const ALIAS = /\banonimizzaAlunno\s+as\s+\w+/

interface Chiamante {
  file: string
  righe: number[]
  controlla: boolean
}

function chiamanti(): Chiamante[] {
  const out: Chiamante[] = []
  for (const assoluto of fileSorgente(SRC)) {
    const file = path.relative(RADICE, assoluto).split(path.sep).join('/')
    if (file === DEFINIZIONE) continue
    const { struttura } = mascheraSorgente(fs.readFileSync(assoluto, 'utf8'))
    const righe = [...struttura.matchAll(CHIAMATA)].map((m) => riga(struttura, m.index ?? 0))
    if (righe.length === 0) continue
    out.push({ file, righe, controlla: CONTROLLO.test(struttura) })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

describe('LOCK · chi anonimizza un alunno guarda prima il registro della primaria', () => {
  it('la definizione esclusa esiste davvero (un’esclusione scaduta è una porta aperta)', () => {
    const percorso = path.join(RADICE, DEFINIZIONE)
    expect(fs.existsSync(percorso), `${DEFINIZIONE} non esiste più: aggiorna DEFINIZIONE`).toBe(true)
    const { struttura } = mascheraSorgente(fs.readFileSync(percorso, 'utf8'))
    expect(struttura, `${DEFINIZIONE} non definisce più anonimizzaAlunno`).toMatch(/function\s+anonimizzaAlunno\s*\(/)
  })

  it('controllo positivo: la scansione trova almeno due chiamanti (oggi gdpr/erase e gdpr/richieste)', () => {
    const elenco = chiamanti().map((c) => c.file)
    // Un lock che scandisce zero file è verde per sempre: se questo numero
    // scende, la scansione è diventata cieca (cartella spostata, nome cambiato),
    // non il codice più sicuro.
    expect(elenco.length, `chiamanti trovati: ${JSON.stringify(elenco)}`).toBeGreaterThanOrEqual(2)
    expect(elenco).toContain('src/app/api/admin/gdpr/erase/route.ts')
    expect(elenco).toContain('src/app/api/admin/gdpr/richieste/route.ts')
  })

  it('ogni chiamante di anonimizzaAlunno chiama anche leggiRegistroPrimaria o alunniConRegistroPrimaria', () => {
    const senza = chiamanti()
      .filter((c) => !c.controlla)
      .map((c) => `${c.file} (anonimizzaAlunno alla riga ${c.righe.join(', ')})`)
    expect(
      senza,
      'Questi file anonimizzano un alunno senza guardare il registro della primaria. Regola del ' +
        'titolare (2026-10-08): voti, pagelle, scrutini, note e certificati delle competenze sono il ' +
        'registro che la legge obbliga a conservare (GDPR art. 17 §3 lett. b) — NON si cancellano e ' +
        'NON si anonimizzano, da nessuna porta. Prima di chiamare anonimizzaAlunno chiama ' +
        'leggiRegistroPrimaria (un alunno) o alunniConRegistroPrimaria (più alunni) da ' +
        '`@/lib/alunni/registro-primaria`, fermati su una lettura fallita (`ok: false`) e salta o ' +
        'rifiuta chi ha il registro. Esempi: admin/gdpr/erase (409), admin/gdpr/richieste (salta e ' +
        'lo scrive nell’esito).',
    ).toEqual([])
  })

  it('nessuno importa anonimizzaAlunno con un altro nome (la scansione non lo vedrebbe)', () => {
    const rinominati: string[] = []
    for (const assoluto of fileSorgente(SRC)) {
      const { struttura } = mascheraSorgente(fs.readFileSync(assoluto, 'utf8'))
      if (ALIAS.test(struttura)) rinominati.push(path.relative(RADICE, assoluto).split(path.sep).join('/'))
    }
    expect(rinominati, 'importa anonimizzaAlunno col suo nome: il lock cerca `anonimizzaAlunno(`').toEqual([])
  })
})
