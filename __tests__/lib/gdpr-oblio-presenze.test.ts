import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto, type Scrittura } from '../fixtures/finto-supabase'
import { anonimizzaAlunno } from '@/lib/gdpr/esegui'

// =============================================================================
// L'OBLIO DEVE ARRIVARE AL MOTIVO DELL'ASSENZA (privacy, ciclo 2 · 2026-08-07)
//
// `presenze.giustificazione_testo` è testo libero che l'interfaccia stessa invita
// a riempire con un dato sanitario: il segnaposto dice «Es. febbre, visita
// medica, motivi familiari…». Da questo ciclo viene raccolto su tutti e tre i
// gradi. `presenze.note_appello` è il suo gemello scritto dal docente.
//
// Misurato prima di scrivere questo test: `src/lib/gdpr/esegui.ts` tratta
// sedici tabelle e `presenze` non c'era; `patchAlunno` azzera `note_mediche`,
// `allergies` e `allergeni` e non tocca il registro delle presenze. Dopo una
// cancellazione chiesta da una famiglia il nome del bambino diventava un
// segnaposto e **il motivo della sua assenza restava leggibile per sempre**,
// agganciato a un `alunno_id` che le altre tabelle permettono ancora di
// correlare.
//
// Le asserzioni sono sulla MUTAZIONE (che cosa è rimasto scritto nella riga),
// mai sul valore di ritorno da solo: un conteggio a 1 non dice se la colonna è
// davvero vuota, e un helper che esiste e non viene chiamato è un difetto che
// questo repo ha già pagato (`obliaFotoNewsAlunno`, scritta e testata mesi prima
// di essere invocata).
// =============================================================================

const AT = '2026-08-07T09:00:00Z'
const NOSTRO = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ALTRO = 'bbbbbbbb-0000-4000-8000-00000000000b'

/** Due righe del bambino da dimenticare e una di un altro bambino (controllo positivo). */
function dbConPresenze(): DBFinto {
  return {
    presenze: [
      {
        id: 'p-1',
        alunno_id: NOSTRO,
        data: '2026-07-20',
        stato: 'assente',
        giustificata: true,
        giustificata_da: 'genitore-1',
        giustificazione_testo: 'DATO SANITARIO DI PROVA',
        note_appello: null,
        registrato_da: null,
      },
      {
        id: 'p-2',
        alunno_id: NOSTRO,
        data: '2026-07-21',
        stato: 'presente',
        giustificata: false,
        giustificazione_testo: null,
        note_appello: 'NOTA DEL DOCENTE DI PROVA',
        registrato_da: 'docente-1',
      },
      {
        id: 'p-altro',
        alunno_id: ALTRO,
        data: '2026-07-20',
        stato: 'assente',
        giustificata: true,
        giustificazione_testo: 'MOTIVO DI UN ALTRO BAMBINO',
        note_appello: 'NOTA DI UN ALTRO BAMBINO',
        registrato_da: null,
      },
    ],
  }
}

describe('anonimizzaAlunno — il motivo dell’assenza e le note dell’appello', () => {
  it('azzera `giustificazione_testo` e `note_appello` dell’alunno, e SOLO le sue righe', async () => {
    const db = dbConPresenze()
    const client = creaFintoSupabase(db)

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    const nostre = db.presenze.filter((p) => p.alunno_id === NOSTRO)
    for (const riga of nostre) {
      expect(riga.giustificazione_testo, `motivo residuo sulla riga ${riga.id}`).toBeNull()
      expect(riga.note_appello, `nota d’appello residua sulla riga ${riga.id}`).toBeNull()
    }

    // Controllo positivo: l'oblio di un bambino non autorizza a toccare il dato
    // di un altro. Senza questa riga, un `update` senza filtro passerebbe.
    const altrui = db.presenze.find((p) => p.id === 'p-altro')!
    expect(altrui.giustificazione_testo).toBe('MOTIVO DI UN ALTRO BAMBINO')
    expect(altrui.note_appello).toBe('NOTA DI UN ALTRO BAMBINO')

    expect(r.presenzeBonificate).toBe(2)
  })

  it('la RIGA di presenza resta: si toglie il testo, non il fatto della frequenza', async () => {
    const db = dbConPresenze()
    const client = creaFintoSupabase(db)

    await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    // I dati sulla frequenza hanno un obbligo di conservazione documentale
    // (informativa, «Conservazione dei dati»): l'assenza del 20 luglio resta
    // un'assenza. Ciò che esce è il testo libero di natura sanitaria.
    expect(db.presenze).toHaveLength(3)
    const p1 = db.presenze.find((p) => p.id === 'p-1')!
    expect(p1.giustificazione_testo).toBeNull()
    expect(p1.stato).toBe('assente')
    expect(p1.data).toBe('2026-07-20')
    expect(p1.giustificata).toBe(true)
  })

  it('non riscrive le righe che non hanno niente da togliere', async () => {
    const scritture: Scrittura[] = []
    const db: DBFinto = {
      presenze: [
        { id: 'p-1', alunno_id: NOSTRO, data: '2026-07-20', stato: 'presente', giustificazione_testo: null, note_appello: null },
      ],
    }
    const client = creaFintoSupabase(db, [], { scritture })

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    // Un UPDATE che tocca ogni riga a ogni oblio sposta `updated_at` a vuoto e
    // gonfia il conteggio che finisce nel log: si scrive solo dove c'è testo.
    const suPresenze = scritture.filter((s) => s.tabella === 'presenze')
    expect(suPresenze.flatMap((s) => s.colpite)).toEqual([])
    expect(r.presenzeBonificate).toBe(0)
  })

  it('degrada in silenzio se la colonna non esiste (DB E2E della CI, non migrato)', async () => {
    const db = dbConPresenze()
    const client = creaFintoSupabase(db, [], { errori: { presenze: { code: '42703' } } })

    const r = await anonimizzaAlunno(client, { id: NOSTRO }, AT, 'test')

    expect(r.presenzeBonificate).toBe(0)
    // Nessuna eccezione: l'oblio del resto deve poter andare avanti.
    expect(r.iscrizioniScrubbate).toBe(0)
  })
})
