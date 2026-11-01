import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import { anonimizzaAlunno } from '@/lib/gdpr/esegui'
import { obliaCrmAlunno } from '@/lib/crm/oblio'

// =============================================================================
// L'OBLIO DI UN ALUNNO ARRIVA AL CRM DELLA SEGRETERIA (2026-11-01, PR-B dopo #276)
//
// Misurato prima di scrivere questo test: `anonimizzaAlunno` non nominava nessuna tabella `crm_*`,
// e cercava i movimenti di cassa solo per codice fiscale. L'entrata dei contanti della quota porta
// il NOME del bambino («Quota d'iscrizione 2027/28 – nome (CRM)»): dopo un oblio restava in cassa,
// come restavano nome e data di nascita del bambino nel CRM e i contatti della famiglia.
// Le asserzioni sono sulla MUTAZIONE del finto database, mai sul solo conteggio.
// =============================================================================

const RPC_OBLIO_VIDEO = {
  video_intent_oblio_alunno: async () => ({ data: { ok: true, intenti: 0, revocati: 0 }, error: null }),
}

const AT = '2026-11-01T09:00:00Z'
const SEDE = 'e2e00000-0000-4000-8000-00000000d000'
const NOSTRO = 'aaaaaaaa-0000-4000-8000-00000000000a'
const ALTRO = 'bbbbbbbb-0000-4000-8000-00000000000b'

function db(opz: { fratelloInChiaro?: boolean } = {}): DBFinto {
  return {
    crm_schede: [
      {
        id: 'sch-1', scuola_id: SEDE, genitore_nome: 'GENITORE DI PROVA', telefono1: '3330000000', telefono2: null,
        email1: 'prova@example.com', email2: null, telefoni_norm: ['3330000000'], email_norm: ['prova@example.com'],
        routine: 'ROUTINE DI PROVA', paura: 'PAURA DI PROVA', desiderio: 'DESIDERIO DI PROVA',
        anonimizzata_il: null, aggiornata_il: '2026-10-31T10:00:00Z',
      },
      {
        id: 'sch-2', scuola_id: SEDE, genitore_nome: 'ALTRA FAMIGLIA', telefono1: '3331111111', telefono2: null,
        email1: null, email2: null, telefoni_norm: ['3331111111'], email_norm: [],
        routine: 'ROUTINE ALTRA', paura: null, desiderio: null, anonimizzata_il: null, aggiornata_il: '2026-10-31T10:00:00Z',
      },
    ],
    crm_bambini: [
      {
        id: 'b-1', scuola_id: SEDE, scheda_id: 'sch-1', alunno_id: NOSTRO, nome: 'BAMBINO DI PROVA',
        data_nascita: '2023-05-10', motivo_nota: 'NOTA DI PROVA', esito: 'iscritto', quota_cassa_movimento_id: 'm-2',
      },
      ...(opz.fratelloInChiaro
        ? [{
            id: 'b-fratello', scuola_id: SEDE, scheda_id: 'sch-1', alunno_id: null, nome: 'FRATELLO DI PROVA',
            data_nascita: '2025-02-01', motivo_nota: null, esito: 'aperto', quota_cassa_movimento_id: null,
          }]
        : []),
      {
        id: 'b-altro', scuola_id: SEDE, scheda_id: 'sch-2', alunno_id: ALTRO, nome: 'ALTRO BAMBINO',
        data_nascita: '2022-01-01', motivo_nota: null, esito: 'iscritto', quota_cassa_movimento_id: 'm-9',
      },
    ],
    crm_eventi: [
      // La prima quota in contanti, poi corretta: l'entrata m-1 è stornata (contro-movimento m-1c) e
      // `quota_cassa_movimento_id` punta solo a m-2. m-1 si ritrova dall'evento.
      { id: 'e-1', scuola_id: SEDE, scheda_id: 'sch-1', tipo: 'quota_segnata', dati: { bambino_id: 'b-1', movimento_id: 'm-1' }, testo: null },
      { id: 'e-2', scuola_id: SEDE, scheda_id: 'sch-1', tipo: 'quota_corretta', dati: { bambino_id: 'b-1', movimento_id: 'm-2' }, testo: null },
      { id: 'e-3', scuola_id: SEDE, scheda_id: 'sch-1', tipo: 'nota', dati: {}, testo: 'NOTA DELLA TELEFONATA CHE LO NOMINA' },
      { id: 'e-4', scuola_id: SEDE, scheda_id: 'sch-2', tipo: 'nota', dati: {}, testo: 'NOTA DI UN ALTRA FAMIGLIA' },
      { id: 'e-5', scuola_id: SEDE, scheda_id: 'sch-2', tipo: 'quota_segnata', dati: { bambino_id: 'b-altro', movimento_id: 'm-9' }, testo: null },
    ],
    cassa_movimenti: [
      { id: 'm-1', scuola_id: SEDE, importo: 150, descrizione: "Quota d'iscrizione 2027/28 – BAMBINO DI PROVA (CRM)", note: null, storno_motivo: 'Quota corretta dal CRM', storno_di: null },
      { id: 'm-1c', scuola_id: SEDE, importo: 150, descrizione: null, note: null, storno_motivo: null, storno_di: 'm-1' },
      { id: 'm-2', scuola_id: SEDE, importo: 180, descrizione: "Quota d'iscrizione 2027/28 – BAMBINO DI PROVA (CRM)", note: null, storno_motivo: null, storno_di: null },
      { id: 'm-9', scuola_id: SEDE, importo: 150, descrizione: "Quota d'iscrizione 2027/28 – ALTRO BAMBINO (CRM)", note: null, storno_motivo: null, storno_di: null },
    ],
  }
}

const riga = (d: DBFinto, tabella: string, id: string) => d[tabella].find((r) => r.id === id)!

describe('obliaCrmAlunno — il bambino del CRM, la sua quota in cassa, la scheda della famiglia', () => {
  it('svuota il bambino collegato e tutte le entrate della sua quota, anche quella stornata', async () => {
    const d = db()
    const esito = await obliaCrmAlunno(creaFintoSupabase(d), NOSTRO, AT, 'test')

    const b = riga(d, 'crm_bambini', 'b-1')
    expect(b.nome).toBeNull()
    expect(b.data_nascita).toBeNull()
    expect(b.motivo_nota).toBeNull()
    // L'esito e il collegamento restano: le statistiche per persona non cambiano.
    expect(b.esito).toBe('iscritto')
    expect(b.alunno_id).toBe(NOSTRO)

    expect(riga(d, 'cassa_movimenti', 'm-1').descrizione).toBe('[rimosso]')
    expect(riga(d, 'cassa_movimenti', 'm-2').descrizione).toBe('[rimosso]')
    // Importi intatti: la cassa torna. Il contro-movimento non aveva descrizione e resta com'era.
    expect(riga(d, 'cassa_movimenti', 'm-2').importo).toBe(180)
    expect(riga(d, 'cassa_movimenti', 'm-1c').descrizione).toBeNull()

    expect(esito).toEqual({ bambini: 1, schede: 1, cassa: 2, completo: true })
  })

  it('con nessun bambino in chiaro anonimizza la scheda e il testo del suo storico', async () => {
    const d = db()
    await obliaCrmAlunno(creaFintoSupabase(d), NOSTRO, AT, 'test')

    const s = riga(d, 'crm_schede', 'sch-1')
    for (const campo of ['genitore_nome', 'telefono1', 'email1', 'routine', 'paura', 'desiderio']) {
      expect(s[campo], `${campo} residuo`).toBeNull()
    }
    expect(s.telefoni_norm).toEqual([])
    expect(s.email_norm).toEqual([])
    expect(s.anonimizzata_il).toBe(AT)
    expect(riga(d, 'crm_eventi', 'e-3').testo).toBeNull()
    // Gli eventi restano (date, tipi, attribuzioni), e i loro dati sono solo id.
    expect(d.crm_eventi).toHaveLength(5)
  })

  it('non tocca un altro bambino, la sua scheda, la sua entrata di cassa', async () => {
    const d = db()
    await obliaCrmAlunno(creaFintoSupabase(d), NOSTRO, AT, 'test')

    expect(riga(d, 'crm_bambini', 'b-altro').nome).toBe('ALTRO BAMBINO')
    expect(riga(d, 'crm_schede', 'sch-2').genitore_nome).toBe('ALTRA FAMIGLIA')
    expect(riga(d, 'crm_schede', 'sch-2').anonimizzata_il).toBeNull()
    expect(riga(d, 'crm_eventi', 'e-4').testo).toBe('NOTA DI UN ALTRA FAMIGLIA')
    expect(riga(d, 'cassa_movimenti', 'm-9').descrizione).toContain('ALTRO BAMBINO')
  })

  it('un fratello ancora in chiaro tiene viva la scheda della famiglia', async () => {
    const d = db({ fratelloInChiaro: true })
    const esito = await obliaCrmAlunno(creaFintoSupabase(d), NOSTRO, AT, 'test')

    expect(riga(d, 'crm_bambini', 'b-1').nome).toBeNull()
    expect(riga(d, 'crm_bambini', 'b-fratello').nome).toBe('FRATELLO DI PROVA')
    expect(riga(d, 'crm_schede', 'sch-1').genitore_nome).toBe('GENITORE DI PROVA')
    expect(riga(d, 'crm_schede', 'sch-1').anonimizzata_il).toBeNull()
    expect(riga(d, 'crm_eventi', 'e-3').testo).toBe('NOTA DELLA TELEFONATA CHE LO NOMINA')
    expect(esito.schede).toBe(0)
    expect(esito.completo).toBe(true)
  })

  it('senza le tabelle del CRM (database E2E della CI) non fa niente e non è un guasto', async () => {
    const d = db()
    const esito = await obliaCrmAlunno(creaFintoSupabase(d, [], { errori: { crm_bambini: { code: '42P01' } } }), NOSTRO, AT, 'test')
    expect(esito).toEqual({ bambini: 0, schede: 0, cassa: 0, completo: true })
  })

  it('una lettura fallita NON è «niente da dimenticare»', async () => {
    const d = db()
    const esito = await obliaCrmAlunno(creaFintoSupabase(d, [], { errori: { crm_bambini: { code: '57014' } } }), NOSTRO, AT, 'test')
    expect(esito.completo).toBe(false)
    expect(riga(d, 'crm_bambini', 'b-1').nome).toBe('BAMBINO DI PROVA')
  })

  it('se il bambino non si è potuto svuotare, la scheda resta com\'è', async () => {
    const d = db()
    const esito = await obliaCrmAlunno(
      creaFintoSupabase(d, [], { errori: { 'crm_bambini:update': { code: '57014' } } }), NOSTRO, AT, 'test',
    )
    expect(esito.completo).toBe(false)
    expect(riga(d, 'crm_schede', 'sch-1').genitore_nome).toBe('GENITORE DI PROVA')
  })
})

describe('anonimizzaAlunno — il CRM entra nell\'oblio dell\'alunno', () => {
  it('riporta bambini e schede del CRM, somma la cassa e conta il guasto fra le letture fallite', async () => {
    const d = db()
    const r = await anonimizzaAlunno(creaFintoSupabase(d, [], { rpc: RPC_OBLIO_VIDEO }), { id: NOSTRO }, AT, 'test')
    expect(r.crmBambiniBonificati).toBe(1)
    expect(r.crmSchedeAnonimizzate).toBe(1)
    expect(r.cassa).toBe(2)
    expect(riga(d, 'cassa_movimenti', 'm-2').descrizione).toBe('[rimosso]')

    const guasto = await anonimizzaAlunno(
      creaFintoSupabase(db(), [], { errori: { crm_bambini: { code: '57014' } }, rpc: RPC_OBLIO_VIDEO }), { id: NOSTRO }, AT, 'test',
    )
    expect(guasto.lettureFallite).toBeGreaterThan(0)
  })
})
