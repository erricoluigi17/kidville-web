import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ATTESA_MAX_MS, ATTESE_RITENTATIVO_MS } from '@/lib/push/native-push'
import { BUDGET_RITENTATIVI_MS, LIMITE_LETTURA, SOGLIA_PRESA_MS, TETTO_GIRO_MS } from '@/lib/push/dispatch'
import { ID_PER_QUERY } from '@/lib/db/blocchi'
import { tettoMs } from '@/lib/logging/external'
import { tettoMsArea } from '@/lib/logging/supabase-fetch'
import {
  BLOCCHI,
  CASO_PEGGIORE_GIRO_MS,
  CHIUSURA_MS,
  DISPOSITIVI_PER_DESTINATARIO,
  DURATA_MINIMA_FUNZIONE_S,
  GIRO_LENTO_PRIMA_DEL_CICLO_MS,
  INVIO_CON_RITENTATIVI_MS,
  INVIO_SENZA_RITENTATIVI_MS,
} from '@/lib/push/durata-dispatch'

// =============================================================================
// LA DURATA DELLA FUNZIONE È LA TERZA DIFESA DELLA PRESA (vedi «IL PREZZO DELLA PRESA» in
// `src/lib/push/dispatch.ts`). Il giro prende le notifiche PRIMA di spedirle: se la piattaforma lo
// tronca, restano marcate, non partono più e non resta una riga di log.
//
// Questo file NON sostituisce `native-push` con un finto: le costanti dei ritentativi devono
// essere quelle vere, altrimenti il conto misura il finto.
// =============================================================================

/** Il sorgente senza commenti (blocco e riga intera): un lock non si immunizza col proprio commento. */
const senzaCommenti = (sorgente: string) => sorgente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('il caso peggiore di un giro è ricavato dai tetti veri', () => {
  it('un invio nativo cominciato poco prima del budget ha tutti i ritentativi: token + tentativi al tetto + attese', () => {
    const fcm = tettoMs('fcm')
    // Il conto del critico, come limite inferiore: 10 + 1 + 10 + 3 + 10 (le attese della scaletta)…
    const conScaletta = (ATTESE_RITENTATIVO_MS.length + 1) * fcm + ATTESE_RITENTATIVO_MS.reduce((a, b) => a + b, 0)
    expect(INVIO_CON_RITENTATIVI_MS).toBeGreaterThanOrEqual(conScaletta)
    // …ma un `429` con `Retry-After` fa aspettare fino a ATTESA_MAX_MS, e il token OAuth può
    // andare in timeout anche lui: il conto vero li comprende.
    expect(INVIO_CON_RITENTATIVI_MS).toBeGreaterThanOrEqual(
      fcm + (ATTESE_RITENTATIVO_MS.length + 1) * fcm + ATTESE_RITENTATIVO_MS.length * ATTESA_MAX_MS,
    )
    expect(INVIO_SENZA_RITENTATIVI_MS).toBeGreaterThanOrEqual(fcm)
    expect(INVIO_SENZA_RITENTATIVI_MS).toBeGreaterThanOrEqual(tettoMs('web-push'))
  })

  it('copre i due scenari: notifica al bordo del BUDGET e notifica al bordo del TETTO, con tutti i dispositivi', () => {
    // Misurati il 25/09: al massimo 4 dispositivi per utente. Il margine non scende sotto.
    expect(DISPOSITIVI_PER_DESTINATARIO).toBeGreaterThanOrEqual(4)
    const altri = (DISPOSITIVI_PER_DESTINATARIO - 1) * INVIO_SENZA_RITENTATIVI_MS
    expect(CASO_PEGGIORE_GIRO_MS).toBeGreaterThan(BUDGET_RITENTATIVI_MS + INVIO_CON_RITENTATIVI_MS + altri)
    expect(CASO_PEGGIORE_GIRO_MS).toBeGreaterThan(TETTO_GIRO_MS + DISPOSITIVI_PER_DESTINATARIO * INVIO_SENZA_RITENTATIVI_MS)
    expect(DURATA_MINIMA_FUNZIONE_S * 1_000).toBeGreaterThanOrEqual(CASO_PEGGIORE_GIRO_MS)
  })

  it('60 s non bastano: è il valore che lasciava troncare la presa', () => {
    // Il `maxDuration = 60` del giro 3 era costruito su «tetto + una notifica senza ritentativi».
    // Con la soglia vera il lock qui sotto lo rifiuta.
    expect(60).toBeLessThan(DURATA_MINIMA_FUNZIONE_S)
  })
})

describe('le fasi su Supabase: blocchi e tetti delle aree vere', () => {
  // Il conto si rifà QUI dalle costanti vere, non si rilegge da `durata-dispatch`: un `BLOCCHI`
  // cablato a 5 resterebbe uguale a sé stesso, ma non a `ceil(LIMITE_LETTURA / ID_PER_QUERY)`.
  const blocchi = Math.ceil(LIMITE_LETTURA / ID_PER_QUERY)
  const db = tettoMsArea('db')
  const rpc = tettoMsArea('rpc')

  it('i blocchi sono quelli che LIMITE_LETTURA e ID_PER_QUERY impongono', () => {
    expect(BLOCCHI).toBe(blocchi)
    expect(BLOCCHI).toBeGreaterThanOrEqual(5)
  })

  it('la chiusura è il ritorno in coda di TUTTI i blocchi più un blocco di rimozione, al tetto di `db`', () => {
    expect(CHIUSURA_MS).toBe((blocchi + 1) * db)
  })

  it('il giro lento prima del ciclo: dal controllo prima della presa, presa a blocchi, badge, ritorno di tutte le prese', () => {
    // Le letture (GET) non entrano: postgrest-js le ritenta con attese senza limite, e le ferma il
    // controllo di SOGLIA_PRESA_MS. Dopo il controllo solo scritture e RPC, che non ritenta.
    expect(GIRO_LENTO_PRIMA_DEL_CICLO_MS).toBe(SOGLIA_PRESA_MS + blocchi * db + rpc + blocchi * db)
    expect(CASO_PEGGIORE_GIRO_MS).toBeGreaterThanOrEqual(GIRO_LENTO_PRIMA_DEL_CICLO_MS)
    // I due scenari degli invii ora comprendono la chiusura intera.
    expect(CASO_PEGGIORE_GIRO_MS).toBeGreaterThanOrEqual(
      BUDGET_RITENTATIVI_MS +
        INVIO_CON_RITENTATIVI_MS +
        (DISPOSITIVI_PER_DESTINATARIO - 1) * INVIO_SENZA_RITENTATIVI_MS +
        (blocchi + 1) * db,
    )
    expect(CASO_PEGGIORE_GIRO_MS).toBeGreaterThanOrEqual(
      TETTO_GIRO_MS + DISPOSITIVI_PER_DESTINATARIO * INVIO_SENZA_RITENTATIVI_MS + (blocchi + 1) * db,
    )
    // Il conto sottostimato del giro 4 (190 s) non passa più.
    expect(DURATA_MINIMA_FUNZIONE_S).toBeGreaterThan(190)
  })
})

describe('la soglia SEGUE i parametri da cui dipende (modulo ricaricato con valori diversi)', () => {
  // Con i valori di oggi `tettoMsArea('db')` e il default coincidono (15 s), e un nome d'area
  // sbagliato (`'rest'`) darebbe lo stesso numero: solo un tetto finto che DISTINGUE le aree fa
  // diventare rosso quel difetto. Idem per i blocchi: solo cambiando LIMITE_LETTURA e
  // ID_PER_QUERY si vede se la soglia li segue o è cablata.
  afterEach(() => {
    vi.doUnmock('@/lib/logging/supabase-fetch')
    vi.doUnmock('@/lib/db/blocchi')
    vi.doUnmock('@/lib/push/dispatch')
    vi.resetModules()
  })

  it('la chiusura e il giro lento usano il tetto dell\'area `db` e quello dell\'area `rpc`, per nome', async () => {
    vi.resetModules()
    vi.doMock('@/lib/logging/supabase-fetch', async (orig) => ({
      ...(await orig<typeof import('@/lib/logging/supabase-fetch')>()),
      // Un'area che il giro non usa vale un'enormità: se qualcuno la chiede, il conto esplode.
      tettoMsArea: (area: string) => (area === 'db' ? 17_000 : area === 'rpc' ? 13_000 : 999_000),
    }))
    const m = await import('@/lib/push/durata-dispatch')
    expect(m.CHIUSURA_MS).toBe((m.BLOCCHI + 1) * 17_000)
    expect(m.GIRO_LENTO_PRIMA_DEL_CICLO_MS).toBe(SOGLIA_PRESA_MS + m.BLOCCHI * 17_000 + 13_000 + m.BLOCCHI * 17_000)
  })

  it('ID_PER_QUERY che scende alza la soglia', async () => {
    vi.resetModules()
    vi.doMock('@/lib/db/blocchi', async (orig) => ({
      ...(await orig<typeof import('@/lib/db/blocchi')>()),
      ID_PER_QUERY: 50,
    }))
    const m = await import('@/lib/push/durata-dispatch')
    expect(m.BLOCCHI).toBe(Math.ceil(LIMITE_LETTURA / 50))
    expect(m.GIRO_LENTO_PRIMA_DEL_CICLO_MS).toBe(SOGLIA_PRESA_MS + 2 * m.BLOCCHI * tettoMsArea('db') + tettoMsArea('rpc'))
    expect(m.DURATA_MINIMA_FUNZIONE_S).toBeGreaterThan(DURATA_MINIMA_FUNZIONE_S)
  })

  it('il giro lento parte dalla soglia del controllo prima della presa, non da una stima delle letture', async () => {
    // Le letture prima della presa non hanno un tetto (i ritentativi di postgrest-js sui GET):
    // il conto le sostituisce con la soglia oltre cui il giro non prende niente. Se la soglia
    // sale, sale anche il giro lento, di altrettanto.
    vi.resetModules()
    vi.doMock('@/lib/push/dispatch', async (orig) => ({
      ...(await orig<typeof import('@/lib/push/dispatch')>()),
      SOGLIA_PRESA_MS: SOGLIA_PRESA_MS + 60_000,
    }))
    const m = await import('@/lib/push/durata-dispatch')
    expect(m.GIRO_LENTO_PRIMA_DEL_CICLO_MS).toBe(GIRO_LENTO_PRIMA_DEL_CICLO_MS + 60_000)
  })

  it('LIMITE_LETTURA che sale alza la soglia', async () => {
    vi.resetModules()
    vi.doMock('@/lib/push/dispatch', async (orig) => ({
      ...(await orig<typeof import('@/lib/push/dispatch')>()),
      LIMITE_LETTURA: 2 * LIMITE_LETTURA,
    }))
    const m = await import('@/lib/push/durata-dispatch')
    expect(m.BLOCCHI).toBe(Math.ceil((2 * LIMITE_LETTURA) / ID_PER_QUERY))
    expect(m.CHIUSURA_MS).toBe((m.BLOCCHI + 1) * tettoMsArea('db'))
    expect(m.DURATA_MINIMA_FUNZIONE_S).toBeGreaterThan(DURATA_MINIMA_FUNZIONE_S)
  })
})

describe('ogni route che chiama il dispatch vive quanto il caso peggiore del giro', () => {
  it('`export const maxDuration` ≥ DURATA_MINIMA_FUNZIONE_S in ogni route di src/app che chiama `eseguiDispatch`', () => {
    // Si legge come TESTO senza commenti: un `maxDuration` citato in un commento non deve bastare.
    // Diventa rosso anche per una route nuova (la chat, in `after()`) che chiami il dispatch senza
    // dichiararlo.
    const radice = join(process.cwd(), 'src', 'app')
    const route: string[] = []
    const visita = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) visita(p)
        else if (/^route\.(ts|tsx|js)$/.test(e.name)) route.push(p)
      }
    }
    visita(radice)

    const chiamanti: string[] = []
    for (const f of route) {
      const testo = senzaCommenti(readFileSync(f, 'utf8'))
      if (!/\beseguiDispatch\b/.test(testo)) continue
      const rel = relative(process.cwd(), f)
      chiamanti.push(rel)
      const m = testo.match(/^export\s+const\s+maxDuration\s*=\s*(\d+)\s*$/m)
      expect(m, `${rel} chiama eseguiDispatch senza \`export const maxDuration = N\``).not.toBeNull()
      expect(
        Number(m![1]),
        `${rel}: maxDuration sotto il caso peggiore del giro (${DURATA_MINIMA_FUNZIONE_S} s)`,
      ).toBeGreaterThanOrEqual(DURATA_MINIMA_FUNZIONE_S)
    }
    // Non resta verde a vuoto: la route del cron c'è sempre.
    expect(chiamanti).toContain(join('src', 'app', 'api', 'push', 'dispatch', 'route.ts'))
  })
})
