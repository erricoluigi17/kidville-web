import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto, Riga, Scrittura } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'

/**
 * LA LIBERATORIA FOTO ARRIVA AL BAMBINO ANCHE DAL GIRO AUTOMATICO.
 *
 * ─── IL DIFETTO, MISURATO ───────────────────────────────────────────────────
 * Gli import sono DUE e solo uno leggeva i consensi:
 *  · a mano, `PATCH /api/admin/iscrizioni`, che li copiava tutti e tre;
 *  · in blocco, il giro notturno (`iscrizioni/import-massivo` → `eseguiDomanda`),
 *    che non li nominava affatto. Il record dell'alunno non conteneva le tre
 *    colonne, che cadevano sul DEFAULT `false` — cioè su un «no» che nessuna
 *    famiglia aveva detto.
 *
 * Misurato in produzione il 2026-09-05: **474 bambini** sono entrati dal giro
 * automatico, e i due creati OGGI hanno tutti e tre i consensi a `false` mentre
 * la loro domanda porta il «sì» alla galleria. I 472 di prima risultano giusti
 * solo perché il backfill della migrazione `20260801081502` è stato ripassato
 * sopra a mano: **una riparazione periodica, non una correzione**. È la forma
 * peggiore di un guasto — invisibile finché qualcuno continua a rimediare.
 *
 * ─── LA REGOLA DEL BIANCO ───────────────────────────────────────────────────
 * Istruzione del titolare (2026-09-05): la preferenza sulle foto **lasciata in
 * bianco vale come CONSENSO DATO**. Ribalta il default della colonna, quindi qui
 * si prova in tutti e due i versi: il bianco diventa `true`, e il «no» detto
 * davvero resta `false`.
 *
 * ─── PERCHÉ IL FINTO CLIENT E NON UN MOCK PIATTO ────────────────────────────
 * `finto-supabase` applica i filtri e conserva le scritture: l'asserzione è su
 * CHE COSA finisce nella riga di `alunni`, non su quante righe tornano. Con un
 * mock piatto questo difetto sarebbe verde con e senza la correzione — il numero
 * di righe scritte era giusto anche prima.
 */

const SEDE = 'd53b0fbc-0000-4000-8000-00000000000a'
const SEC = 'c4a00000-0000-4000-8000-00000000004a'
const DOMANDA = 'f0000000-0000-4000-8000-000000000001'
const CLASSE = '4 ANNI A'
/** Codice fiscale palesemente sintetico: il repository è pubblico. */
const CF_FINTO = 'XXXXXX00X00X000X'

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => ({
  ...log,
  EVENTI_PERSISTITI: new Set(['iscrizione', 'anagrafica']),
}))

import { alunnoDiRiferimento } from '@/lib/iscrizioni/import/esegui'
import { CONSENSI_FOTO_CANALI } from '@/lib/forms/enrollment-template'
import { BIANCO_VALE_CONSENSO, consensiFotoDaProva } from '@/lib/iscrizioni/consensi-foto'

const grezzo = { codice_fiscale: CF_FINTO, data_nascita: '2020-01-01' }

const assegnazione = {
  nome: 'Nome', cognome: 'Cognome', classe: CLASSE, retta: 150, aCaricoDi: null,
} as Parameters<typeof alunnoDiRiferimento>[2]

type Blocco = { field_id: string; accepted: boolean }

/**
 * `consents_log` è la PROVA congelata dal server all'invio, non `data` (che è
 * ciò che il client ha mandato). `prova: null` = domanda anteriore al passo
 * consensi: 86 domande approvate stanno esattamente così.
 */
const dbBase = (prova: { blocchi: Blocco[] } | null): DBFinto => ({
  sections: [{ id: SEC, scuola_id: SEDE, name: CLASSE }],
  alunni: [],
  enrollment_submissions: [{ id: DOMANDA, scuola_id: SEDE, consents_log: prova }],
})

const tuttiETre = (accepted: boolean): { blocchi: Blocco[] } => ({
  blocchi: Object.keys(CONSENSI_FOTO_CANALI).map((field_id) => ({ field_id, accepted })),
})

let scritture: Scrittura[]
const client = (db: DBFinto, errori?: Record<string, { code: string; message?: string }>) => {
  scritture = []
  return creaFintoSupabase(db, [], {
    scritture,
    errori,
    rpc: { iscrizioni_segna_creato: () => ({ data: null, error: null }) },
  })
}

/** La riga passata all'ultima scrittura su `alunni` (insert o patch dell'update). */
const scrittaSuAlunni = (): Riga => {
  const s = scritture.filter((x) => x.tabella === 'alunni')
  expect(s.length, 'nessuna scrittura su `alunni`').toBeGreaterThan(0)
  return s[s.length - 1].valori[0] as Riga
}

const esegui = (db: DBFinto, errori?: Record<string, { code: string; message?: string }>) =>
  alunnoDiRiferimento(client(db, errori), grezzo, assegnazione, SEDE, DOMANDA)

beforeEach(() => vi.clearAllMocks())

describe('import in blocco — i consensi foto arrivano sulla riga del bambino', () => {
  it('i tre consensi accettati → le tre colonne a true', async () => {
    // ⚠️ È IL TEST CHE DEVE FALLIRE PRIMA DELLA CORREZIONE: oggi il record non
    // contiene affatto le tre colonne, quindi il bambino nasce sul default
    // `false` e la famiglia che aveva detto sì risulta aver detto no.
    const esito = await esegui(dbBase(tuttiETre(true)))

    expect(esito).not.toHaveProperty('errore')
    const riga = scrittaSuAlunni()
    expect(riga.consenso_privacy, 'galleria riservata').toBe(true)
    expect(riga.consenso_foto_sito, 'sito web').toBe(true)
    expect(riga.consenso_foto_social, 'canali social').toBe(true)
  })

  it('un «no» detto davvero resta un no: gli altri canali non lo contagiano', async () => {
    const prova = {
      blocchi: [
        { field_id: 'consenso_foto_galleria', accepted: true },
        { field_id: 'consenso_foto_sito', accepted: false },
        { field_id: 'consenso_foto_social', accepted: true },
      ],
    }
    await esegui(dbBase(prova))

    const riga = scrittaSuAlunni()
    // Controllo positivo: se tutto fosse `false` per un altro motivo, questo
    // rigo diventerebbe rosso e il «no» qui sotto non proverebbe più niente.
    expect(riga.consenso_privacy).toBe(true)
    expect(riga.consenso_foto_social).toBe(true)
    expect(riga.consenso_foto_sito, 'il rifiuto della famiglia deve sopravvivere').toBe(false)
  })

  it('nessuna prova (domanda anteriore al passo consensi) → le tre colonne a true', async () => {
    // LA REGOLA DEL BIANCO, ed è l'opposto del default della colonna: chi non è
    // mai stato interrogato risulta consenziente, per decisione del titolare.
    await esegui(dbBase(null))

    const riga = scrittaSuAlunni()
    expect(riga.consenso_privacy).toBe(true)
    expect(riga.consenso_foto_sito).toBe(true)
    expect(riga.consenso_foto_social).toBe(true)
  })

  it('prova vuota (`blocchi: []`) → vale come bianco, non come rifiuto', async () => {
    await esegui(dbBase({ blocchi: [] }))

    const riga = scrittaSuAlunni()
    expect(riga.consenso_privacy).toBe(true)
    expect(riga.consenso_foto_sito).toBe(true)
    expect(riga.consenso_foto_social).toBe(true)
  })

  it('la prova NON si legge → nessun consenso scritto, e il guasto è LOGGATO', async () => {
    // Il bianco vale come sì solo su una prova LETTA DAVVERO. Una lettura caduta
    // non è un bianco: è un non-so, e da un non-so non si inventa un consenso a
    // pubblicare la foto di un minore. Le colonne restano fuori dal record e
    // decide il default.
    const esito = await esegui(dbBase(tuttiETre(true)), {
      'enrollment_submissions:select': { code: '42703', message: 'column "consents_log" does not exist' },
    })

    // L'iscrizione non si ferma per questo: il bambino entra lo stesso.
    expect(esito).not.toHaveProperty('errore')
    const riga = scrittaSuAlunni()
    expect(riga).not.toHaveProperty('consenso_privacy')
    expect(riga).not.toHaveProperty('consenso_foto_sito')
    expect(riga).not.toHaveProperty('consenso_foto_social')

    const righe = log.logEvento.mock.calls.filter(
      ([, livello, campi]) =>
        livello === 'error' && (campi as { esito?: string })?.esito === 'consensi-foto-non-letti',
    )
    expect(righe, 'una prova non letta deve lasciare una riga, non passare in silenzio').toHaveLength(1)
  })
})

describe('bambino GIÀ in anagrafica — il bianco riempie un vuoto, non sovrascrive', () => {
  const conAlunnoEsistente = (prova: { blocchi: Blocco[] } | null): DBFinto => {
    const db = dbBase(prova)
    db.alunni = [{
      id: 'a-esistente', scuola_id: SEDE, codice_fiscale: CF_FINTO,
      nome: 'Nome', cognome: 'Cognome', classe_sezione: CLASSE,
      // La famiglia aveva già detto NO ai social, registrato dalla segreteria.
      consenso_privacy: true, consenso_foto_sito: true, consenso_foto_social: false,
    }]
    return db
  }

  it('con la prova: l’aggiornamento la onora, anche quando dice no', async () => {
    await esegui(conAlunnoEsistente({
      blocchi: [
        { field_id: 'consenso_foto_galleria', accepted: false },
        { field_id: 'consenso_foto_sito', accepted: true },
        { field_id: 'consenso_foto_social', accepted: true },
      ],
    }))

    const patch = scrittaSuAlunni()
    expect(patch.consenso_privacy, 'un ripensamento verso il NO deve passare').toBe(false)
    expect(patch.consenso_foto_sito).toBe(true)
    expect(patch.consenso_foto_social).toBe(true)
  })

  it('senza la prova: i consensi già registrati NON si toccano', async () => {
    // Qui il bianco NON può valere come sì: la riga esiste già e porta una
    // preferenza registrata. Sovrascriverla vorrebbe dire che una domanda vecchia
    // e muta cancella un «no» detto a voce in segreteria — l'esatto danno che la
    // granularità per canale esiste per impedire.
    await esegui(conAlunnoEsistente(null))

    const patch = scrittaSuAlunni()
    expect(patch).not.toHaveProperty('consenso_privacy')
    expect(patch).not.toHaveProperty('consenso_foto_sito')
    expect(patch).not.toHaveProperty('consenso_foto_social')
    // Controllo positivo: l'update è avvenuto davvero (classe e retta).
    expect(patch.classe_sezione).toBe(CLASSE)
  })
})

// Lock COMPORTAMENTALE guidato dalla mappa: un quarto canale aggiunto domani a
// `CONSENSI_FOTO_CANALI` entra qui da solo, e se il giro automatico non lo
// portasse a destinazione questo file diventerebbe rosso senza che nessuno lo
// riscriva.
describe('lock — ogni canale della mappa arriva sulla propria colonna, dal giro automatico', () => {
  for (const [fieldId, colonna] of Object.entries(CONSENSI_FOTO_CANALI)) {
    it(`«${fieldId}» → «${colonna}», e solo su quella`, async () => {
      // Tutti e tre presenti nella prova: solo quello in esame è accettato. La
      // prova è COMPLETA di proposito — con i canali mancanti scatterebbe la
      // regola del bianco, e l'asserzione «gli altri restano false» proverebbe
      // il contrario di ciò che dice.
      const blocchi = Object.keys(CONSENSI_FOTO_CANALI).map((id) => ({
        field_id: id, accepted: id === fieldId,
      }))
      await esegui(dbBase({ blocchi }))

      const riga = scrittaSuAlunni()
      expect(riga[colonna], `${fieldId} non arriva su ${colonna}`).toBe(true)
      for (const altra of Object.values(CONSENSI_FOTO_CANALI)) {
        if (altra !== colonna) expect(riga[altra], `${fieldId} ha contaminato ${altra}`).toBe(false)
      }
    })
  }
})

describe('la regola sta in un posto solo, e i due import la chiamano', () => {
  const MODULO = 'src/lib/iscrizioni/consensi-foto.ts'
  const CHIAMANTI = [
    'src/app/api/admin/iscrizioni/route.ts',
    'src/lib/iscrizioni/import/esegui.ts',
  ]
  const sorgente = async (f: string) => {
    const { readFileSync } = await import('node:fs')
    return readFileSync(f, 'utf8')
  }

  it('il modulo legge la PROVA e percorre la mappa, invece di elencare i canali a mano', async () => {
    const modulo = await sorgente(MODULO)
    // Dalla prova (`consents_log`), non da `data`: `data` è ciò che il client ha
    // mandato, `consents_log` è ciò che il server ha verificato e congelato.
    expect(modulo).toContain('consents_log')
    // L'elenco dei canali viene dalla mappa: è l'unica difesa contro il
    // ripetersi dell'elenco troncato al primo canale (privacy F4).
    expect(modulo).toContain('CONSENSI_FOTO_CANALI')
    expect(modulo).toContain("from '@/lib/forms/enrollment-template'")
  })

  it('nessuno dei due import si riscrive la regola per conto proprio', async () => {
    // È il difetto che questo lavoro chiude: la regola esisteva in un solo
    // chiamante, l'altro non ce l'aveva, e nessun test se ne accorgeva. Due copie
    // divergono; una copia sola, chiamata da due posti, no.
    for (const f of CHIAMANTI) {
      const src = await sorgente(f)
      expect(src, `${f} non delega a @/lib/iscrizioni/consensi-foto`).toContain(
        '@/lib/iscrizioni/consensi-foto',
      )
      for (const colonna of Object.values(CONSENSI_FOTO_CANALI)) {
        expect(src, `${f} nomina a mano la colonna ${colonna}`).not.toContain(`${colonna}:`)
      }
    }
  })

  it('controllo positivo: la mappa porta davvero i tre canali', () => {
    // Senza questo, una mappa svuotata renderebbe vere per vuoto tutte le
    // asserzioni «per ogni canale» di questo file.
    expect(Object.keys(CONSENSI_FOTO_CANALI)).toEqual(
      expect.arrayContaining(['consenso_foto_galleria', 'consenso_foto_sito', 'consenso_foto_social']),
    )
    expect(CONSENSI_FOTO_CANALI.consenso_foto_galleria).toBe('consenso_privacy')
  })
})

describe('consensiFotoDaProva — la regola, senza database intorno', () => {
  it('il bianco vale come consenso DATO, e ribalta il default della colonna', () => {
    // Le colonne di `alunni` sono `default false`: qui il bianco diventa `true`
    // per istruzione del titolare (2026-09-05). La costante esiste perché chi
    // legge fra sei mesi sappia che è voluto, non ereditato.
    expect(BIANCO_VALE_CONSENSO).toBe(true)
    for (const prova of [null, undefined, {}, { blocchi: null }, { blocchi: [] }]) {
      const colonne = consensiFotoDaProva(prova)
      for (const colonna of Object.values(CONSENSI_FOTO_CANALI)) {
        expect(colonne[colonna], `${JSON.stringify(prova)} → ${colonna}`).toBe(true)
      }
    }
  })

  it('con la prova si onora la prova, in entrambi i versi', () => {
    const blocchi = Object.keys(CONSENSI_FOTO_CANALI).map((field_id, i) => ({
      field_id, accepted: i === 0,
    }))
    const colonne = consensiFotoDaProva({ blocchi })
    const canali = Object.entries(CONSENSI_FOTO_CANALI)
    expect(colonne[canali[0][1]], 'il sì accettato').toBe(true)
    for (const [, colonna] of canali.slice(1)) {
      expect(colonne[colonna], 'il no rifiutato').toBe(false)
    }
  })

  it('un blocco senza `accepted` non vale come sì: solo `true` accetta', () => {
    // `accepted: undefined` o `'true'` (stringa) non sono un consenso: la prova
    // dice sì solo con il booleano. Il caso nasce da payload malformati.
    const blocchi = Object.keys(CONSENSI_FOTO_CANALI).map((field_id) => ({ field_id }))
    const colonne = consensiFotoDaProva({ blocchi })
    for (const colonna of Object.values(CONSENSI_FOTO_CANALI)) {
      expect(colonne[colonna]).toBe(false)
    }
  })
})

describe('degrado su un database indietro di una migrazione', () => {
  /**
   * Il DB E2E della CI è un progetto separato e non è migrato: PostgREST
   * risponde `PGRST204` e respinge l'INTERA riga, non il campo di troppo. Senza
   * il degrado un ambiente indietro di una migrazione non «perderebbe un
   * consenso»: annullerebbe l'iscrizione.
   *
   * Il finto client di serie non serve qui: un errore iniettato lo restituisce
   * SEMPRE, mentre la cosa da provare è che il secondo tentativo — quello senza
   * la colonna — RIESCA. Quindi si intercetta il solo `insert` su `alunni`,
   * lasciando tutto il resto al finto client vero.
   */
  const clientSenzaColonna = (db: DBFinto, colonna: string, tentativi: Riga[]) => {
    scritture = []
    const vero = creaFintoSupabase(db, [], {
      scritture,
      rpc: { iscrizioni_segna_creato: () => ({ data: null, error: null }) },
    })
    const rifiuto = {
      code: 'PGRST204',
      message: `Could not find the '${colonna}' column of 'alunni' in the schema cache`,
    }
    return new Proxy(vero, {
      get(bersaglio, prop) {
        if (prop !== 'from') return Reflect.get(bersaglio, prop)
        return (tabella: string) => {
          const b = vero.from(tabella) as unknown as Record<string, unknown>
          if (tabella !== 'alunni') return b
          return new Proxy(b, {
            get(bb, pp) {
              if (pp !== 'insert') return Reflect.get(bb, pp)
              return (rec: Riga) => {
                tentativi.push({ ...rec })
                if (colonna in rec) {
                  return { select: () => ({ single: async () => ({ data: null, error: rifiuto }) }) }
                }
                return (bb.insert as (r: Riga) => unknown)(rec)
              }
            },
          })
        }
      },
    })
  }

  it('PGRST204 sulla colonna nuova → si riprova senza, e l’iscrizione RIESCE', async () => {
    const tentativi: Riga[] = []
    const db = dbBase(tuttiETre(true))
    const esito = await alunnoDiRiferimento(
      clientSenzaColonna(db, 'consenso_foto_social', tentativi),
      grezzo, assegnazione, SEDE, DOMANDA,
    )

    expect(tentativi.length, 'la scrittura deve essere stata ritentata').toBe(2)
    expect(tentativi[0]).toHaveProperty('consenso_foto_social')
    expect(tentativi[1]).not.toHaveProperty('consenso_foto_social')
    // Si toglie la colonna NOMINATA, non tutte: gli altri due consensi restano.
    expect(tentativi[1].consenso_foto_sito).toBe(true)
    expect(tentativi[1].consenso_privacy).toBe(true)
    // E il bambino entra davvero: è questo che il degrado esiste per garantire.
    expect(esito).not.toHaveProperty('errore')
    expect(db.alunni).toHaveLength(1)
  })
})
