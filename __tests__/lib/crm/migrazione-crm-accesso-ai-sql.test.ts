// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2 } from '../../helpers/schema-anno-pglite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const CARTELLA = join(process.cwd(), 'supabase/migrations')
function migrazione(suffisso: string): string {
  const f = readdirSync(CARTELLA).find((x) => x.endsWith(suffisso))
  if (!f) throw new Error(`migrazione *${suffisso} non trovata`)
  return readFileSync(join(CARTELLA, f), 'utf8')
}

const uuid = (pref: string, n: number) => `${pref}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const SEDE_A = uuid('a0000000', 1)
const SEDE_B = uuid('a0000000', 2)
const P1 = uuid('b0000000', 1) // Direzione con entrambe le sedi
const P2 = uuid('b0000000', 2) // una collega della sede A
// La segretaria della sede B. Serve davvero: il vincolo `crm_appuntamenti_no_sovrapposti` vale per PERSONA
// (`assegnata_a`), non per sede. Una prova «stesso numero in un'altra sede» che usasse P1 alla stessa ora
// prenderebbe `slot_occupato` per colpa della persona, e non direbbe niente sulle schede.
const P_B = uuid('b0000000', 3)
const ADMIN = uuid('b0000000', 9)
const INT_A = uuid('d0000000', 1)
const INT_B = uuid('d0000000', 2)
const INT_NUOVA = uuid('d0000000', 3)
const IMPRONTA_1 = '1'.repeat(64)
const IMPRONTA_2 = '2'.repeat(64)
const TEL = '333 000 0001'
const TEL_NORM = '3330000001'
const TEL2 = '333 000 0002'
const TEL2_NORM = '3330000002'
const NASCITA = '2023-03-15'
// Fra trenta giorni, alle 08:30 UTC: il test non scade col calendario.
const FRA_30 = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 30 * 86_400_000 + 8.5 * 3_600_000).toISOString()

let db: PGlite
type Esito = Record<string, unknown> & { esito?: string }

async function prenota(o: Partial<Record<string, unknown>> = {}): Promise<Esito> {
  const p = {
    integrazione: INT_A, sede: SEDE_A, chiave: 'chiave-0001', impronta: IMPRONTA_1, inizio: FRA_30, durata: 45,
    candidati: [P1], tel: TEL, telNorm: TEL_NORM, email: null, emailNorm: null, genitore: 'Famiglia Prova',
    origine: 'whatsapp', bambini: [{ nome: 'Bimbo Prova', data_nascita: NASCITA }], routine: null, paura: null, desiderio: null,
    ...o,
  }
  const r = await db.query<{ r: Esito }>(
    `SELECT public.crm_ai_prenota($1,$2,$3,$4,$5::timestamptz,$6,$7::uuid[],$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17) AS r`,
    [p.integrazione, p.sede, p.chiave, p.impronta, p.inizio, p.durata,
     Array.isArray(p.candidati) ? `{${p.candidati.join(',')}}` : null,
     p.tel, p.telNorm, p.email, p.emailNorm, p.genitore, p.origine, JSON.stringify(p.bambini), p.routine, p.paura, p.desiderio],
  )
  return r.rows[0].r
}
async function contatto(o: Partial<Record<string, unknown>> = {}): Promise<Esito> {
  const p = { sede: SEDE_A, tel: TEL, telNorm: TEL_NORM, email: null, emailNorm: null, genitore: null, origine: 'sito', bambini: [], ...o }
  const r = await db.query<{ r: Esito }>(
    `SELECT public.crm_ai_registra_contatto($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS r`,
    [p.sede, p.tel, p.telNorm, p.email, p.emailNorm, p.genitore, p.origine, JSON.stringify(p.bambini)],
  )
  return r.rows[0].r
}
const conta = async (tabella: string, dove = 'true') =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM public.${tabella} WHERE ${dove}`)).rows[0].n)

const annulla = async (id: unknown, integrazione = INT_A, sede = SEDE_A) =>
  (await db.query<{ r: Esito }>('SELECT public.crm_ai_annulla($1,$2,$3) AS r', [integrazione, sede, id])).rows[0].r

const richiamo = async (o: {
  id?: unknown; tel?: string; genitore?: string; origine?: string | null; motivo?: string; integrazione?: string; sede?: string
} = {}) =>
  (await db.query<{ r: Esito }>('SELECT public.crm_ai_richiamo($1,$2,$3,$4,$5,$6,$7,$8) AS r', [
    o.integrazione ?? INT_A, o.sede ?? SEDE_A, o.id ?? null, o.tel ?? null, o.tel ? TEL_NORM : null,
    o.genitore ?? null, o.origine === undefined ? (o.tel ? 'whatsapp' : null) : o.origine, o.motivo ?? 'salute',
  ])).rows[0].r

const ruoliCrm = `
  CREATE TABLE public.cassa_movimenti (id uuid PRIMARY KEY);
  ALTER TABLE public.utenti ADD COLUMN scuola_id uuid REFERENCES public.schools(id),
    ADD COLUMN ruolo text, ADD COLUMN archiviato_il timestamptz, ADD COLUMN nome text, ADD COLUMN cognome text;
  CREATE TABLE public.utenti_scuole (
    utente_id uuid REFERENCES public.utenti(id), scuola_id uuid REFERENCES public.schools(id),
    PRIMARY KEY (utente_id, scuola_id)
  );
`

beforeAll(async () => {
  db = await creaDbAnnoPr2({
    sedi: [SEDE_A, SEDE_B], fino: 'M3',
    // Le funzioni di contabilità richiedono altre tabelle e non partecipano alla scrittura dell’assistente.
    codaPrima: ruoliCrm + migrazione('_crm_segreteria.sql') + migrazione('_crm_quota_e_settimane.sql').split('-- ── 6)')[0],
  })
  await db.exec(migrazione('_anno_crm_anno_id.sql'))
  await db.exec(migrazione('_crm_accesso_ai.sql'))
  await db.exec(migrazione('_crm_accesso_ai.sql'))
  await db.exec(`
    INSERT INTO public.utenti (id, scuola_id, ruolo, cognome) VALUES
      ('${P1}', '${SEDE_A}', 'admin', 'Prova A'),
      ('${P2}', '${SEDE_A}', 'segreteria', 'Prova B'),
      ('${P_B}', '${SEDE_B}', 'segreteria', 'Prova C'),
      ('${ADMIN}', '${SEDE_A}', 'admin', 'Prova D');
    INSERT INTO public.utenti_scuole (utente_id, scuola_id) VALUES ('${P1}', '${SEDE_B}');
  `)
}, 120_000)
afterAll(async () => { if (db) await db.close() })

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.crm_ai_richieste, public.crm_integrazioni, public.crm_schede,
      public.crm_settimane, public.crm_indisponibilita CASCADE;
    UPDATE public.anno_regole SET controlli_rigidi = true, dichiarato_transitorio = false,
      guardia_attiva = true, guardia_osserva = false;
    INSERT INTO public.crm_integrazioni (id, scuola_id, nome, token_impronta, token_coda, creata_da)
    VALUES ('${INT_A}', '${SEDE_A}', 'Assistente', '${'a'.repeat(64)}', 'AAAA', '${ADMIN}'),
           ('${INT_B}', '${SEDE_B}', 'Assistente', '${'b'.repeat(64)}', 'BBBB', '${ADMIN}');
  `)
  // Le fasce valgono per eredità: la settimana registrata è quella precedente al giorno richiesto.
  await db.query(`
    WITH orario AS (SELECT $1::timestamptz AT TIME ZONE 'Europe/Rome' AS civile), settimane AS (
      INSERT INTO public.crm_settimane (scuola_id, settimana)
        SELECT id, date_trunc('week', civile)::date - 7 FROM public.schools, orario
      RETURNING id, scuola_id
    )
    INSERT INTO public.crm_fasce (scuola_id, settimana_id, giorno_settimana, ora_inizio, ora_fine, durata_slot_min)
      SELECT scuola_id, id, extract(isodow FROM civile)::smallint, civile::time,
             (civile + interval '90 minutes')::time, 45
        FROM settimane, orario
  `, [FRA_30])
})

describe('crm_ai_prenota', () => {
  it('1 · famiglia nuova: scheda, bambino, visita e storico in una volta', async () => {
    const r = await prenota()
    expect(r.esito).toBe('creata')
    expect(r.scheda_creata).toBe(true)
    expect(r.assegnata_a).toBe(P1)
    expect(await conta('crm_schede', `creato_via = 'ai' AND creato_da IS NULL AND telefoni_norm = ARRAY['${TEL_NORM}']`)).toBe(1)
    expect(await conta('crm_bambini')).toBe(1)
    expect(await conta('crm_appuntamenti', `fissato_via = 'ai' AND fissato_da IS NULL AND stato = 'in_programma' AND assegnata_a = '${P1}' AND durata_min = 45`)).toBe(1)
    const eventi = await db.query<{ tipo: string; autore_via: string }>(`SELECT tipo, autore_via FROM public.crm_eventi`)
    // In ordine alfabetico: l'orologio di PGlite può dare lo stesso istante a due eventi della stessa transazione.
    expect(eventi.rows.map((e) => e.tipo).sort()).toEqual(['appuntamento_fissato', 'bambino_aggiunto', 'creata'])
    expect(eventi.rows.every((e) => e.autore_via === 'ai')).toBe(true)
    expect(await conta('crm_ai_richieste', `risposta IS NOT NULL AND conclusa_il IS NOT NULL AND appuntamento_id IS NOT NULL`)).toBe(1)
  })
  it('2 · la stessa richiesta ripetuta non crea una seconda visita (R5)', async () => {
    const prima = await prenota()
    const seconda = await prenota()
    expect(seconda.ripetuta).toBe(true)
    expect(seconda.esito).toBe('creata')
    expect(seconda.appuntamento_id).toBe(prima.appuntamento_id)
    expect(await conta('crm_appuntamenti')).toBe(1)
    expect(await conta('crm_schede')).toBe(1)
  })
  it('3 · stessa chiave, corpo diverso: chiave_riusata, e non scrive niente (R5)', async () => {
    await prenota()
    const r = await prenota({ impronta: IMPRONTA_2, tel: TEL2, telNorm: TEL2_NORM })
    expect(r).toEqual({ esito: 'chiave_riusata' })
    expect(await conta('crm_schede')).toBe(1)
  })
  it('4 · la famiglia ha già una visita in programma: gia_prenotato, con l’orario esistente', async () => {
    const prima = await prenota()
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2, tel: '+39 333-0000001' })
    expect(r.esito).toBe('gia_prenotato')
    expect(r.appuntamento_id).toBe(prima.appuntamento_id)
    expect(new Date(r.inizio as string).toISOString()).toBe(FRA_30)
    expect(await conta('crm_appuntamenti')).toBe(1)
    expect(await conta('crm_schede')).toBe(1)
  })
  it('5 · un’altra famiglia sullo stesso orario e sulla stessa persona: slot_occupato (R1, R3)', async () => {
    await prenota()
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2, tel: TEL2, telNorm: TEL2_NORM })
    expect(r.esito).toBe('slot_occupato')
    expect(await conta('crm_appuntamenti')).toBe(1)
    // la famiglia resta in scheda: è un contatto vero, e l'assistente le proporrà un altro orario
    expect(await conta('crm_schede')).toBe(2)
    expect(await conta('crm_ai_richieste', `chiave = 'chiave-0002' AND risposta->>'esito' = 'slot_occupato'`)).toBe(1)
  })
  it('6 · con due candidate, la seconda famiglia va alla collega libera (R1)', async () => {
    await prenota()
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2, tel: TEL2, telNorm: TEL2_NORM, candidati: [P1, P2] })
    expect(r.esito).toBe('creata')
    expect(r.assegnata_a).toBe(P2)
    expect(await conta('crm_appuntamenti')).toBe(2)
  })
  it('7 · lo stesso numero in un’altra sede è un’altra scheda', async () => {
    await prenota()
    // La sede B ha la SUA persona (P_B): alla stessa ora P1 è già occupata dalla visita della sede A.
    const r = await prenota({ integrazione: INT_B, sede: SEDE_B, chiave: 'chiave-000b', candidati: [P_B] })
    expect(r.esito).toBe('creata')
    expect(r.scheda_creata).toBe(true)
    expect(r.assegnata_a).toBe(P_B)
    expect(await conta('crm_schede', `scuola_id = '${SEDE_B}'`)).toBe(1)
    expect(await conta('crm_schede', `scuola_id = '${SEDE_A}'`)).toBe(1)
  })
  it('7-bis · la stessa persona non riceve due sedi alla stessa ora: il vincolo è sulla persona', async () => {
    await prenota()
    const r = await prenota({ integrazione: INT_B, sede: SEDE_B, chiave: 'chiave-000b', candidati: [P1] })
    expect(r.esito).toBe('slot_occupato')
  })
  it('8 · un bambino «perso» torna «aperto», senza doppione', async () => {
    await prenota()
    await db.exec(`UPDATE public.crm_appuntamenti SET stato = 'annullato';
                   UPDATE public.crm_bambini SET esito = 'perso', motivo_perdita = 'prezzo', esito_origine = 'manuale';`)
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2 })
    expect(r.esito).toBe('creata')
    expect(r.scheda_creata).toBe(false)
    expect(await conta('crm_bambini')).toBe(1)
    expect(await conta('crm_bambini', `esito = 'aperto' AND motivo_perdita IS NULL AND esito_origine = 'automatico' AND esito_da IS NULL`)).toBe(1)
    expect(await conta('crm_eventi', `tipo = 'esito_cambiato' AND autore_via = 'ai' AND dati->>'da' = 'perso' AND dati->>'a' = 'aperto'`)).toBe(1)
  })
  it('9 · due gemelli (stessa data, nomi diversi) sono due bambini (R10)', async () => {
    await prenota({ bambini: [{ nome: 'Bimbo Prova', data_nascita: NASCITA }, { nome: 'Bimba Prova', data_nascita: NASCITA }] })
    expect(await conta('crm_bambini')).toBe(2)
  })
  it('una visita in programma ma già PASSATA non blocca una prenotazione nuova', async () => {
    await prenota()
    await db.exec(`UPDATE public.crm_appuntamenti SET inizio = now() - interval '3 days', fine = now() - interval '3 days' + interval '45 minutes';`)
    const r = await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2 })
    expect(r.esito).toBe('creata')
  })
  it('le tre domande del copione si scrivono solo dove la scheda è vuota', async () => {
    await prenota({ routine: 'dorme al pomeriggio' })
    await db.exec(`UPDATE public.crm_appuntamenti SET stato = 'annullato';`)
    await prenota({ chiave: 'chiave-0002', impronta: IMPRONTA_2, routine: 'altro testo', paura: 'il distacco' })
    expect(await conta('crm_schede', `routine = 'dorme al pomeriggio' AND paura = 'il distacco' AND desiderio IS NULL`)).toBe(1)
  })
  it('senza candidate o senza sede lancia 22023', async () => {
    await expect(prenota({ candidati: [] })).rejects.toMatchObject({ code: '22023' })
  })
})

describe('crm_ai_registra_contatto', () => {
  it('10 · due volte lo stesso numero, scritto in due modi: una scheda sola (R4)', async () => {
    const prima = await contatto({ bambini: [{ nome: null, data_nascita: NASCITA }] })
    const seconda = await contatto({ tel: '0039 333-0000001' })
    expect(prima.creata).toBe(true)
    expect(seconda).toEqual({ scheda_id: prima.scheda_id, creata: false })
    expect(await conta('crm_schede')).toBe(1)
    // poi arriva la prenotazione col NOME: completa il bambino che c'era, non ne crea un secondo
    await prenota()
    expect(await conta('crm_bambini')).toBe(1)
    expect(await conta('crm_bambini', `nome = 'Bimbo Prova' AND data_nascita::text = '${NASCITA}'`)).toBe(1)
  })
  it('una scheda anonimizzata non si riusa: ne nasce una nuova', async () => {
    const prima = await contatto()
    await db.exec(`UPDATE public.crm_schede SET anonimizzata_il = now();`)
    const seconda = await contatto()
    expect(seconda.creata).toBe(true)
    expect(seconda.scheda_id).not.toBe(prima.scheda_id)
  })
  it('riconosce la famiglia anche dalla sola email', async () => {
    const prima = await contatto({ email: 'Prova@Example.com', emailNorm: 'prova@example.com' })
    const seconda = await contatto({ tel: TEL2, telNorm: TEL2_NORM, email: 'prova@example.com', emailNorm: 'prova@example.com' })
    expect(seconda).toEqual({ scheda_id: prima.scheda_id, creata: false })
  })
})

describe('i vincoli delle due tabelle', () => {
  it('11 · una sola chiave attiva per sede; dopo la revoca se ne può creare un’altra', async () => {
    const altra = `INSERT INTO public.crm_integrazioni (scuola_id, nome, token_impronta, token_coda, creata_da)
                   VALUES ('${SEDE_A}', 'Seconda', '${'c'.repeat(64)}', 'CCCC', '${ADMIN}')`
    await expect(db.exec(altra)).rejects.toMatchObject({ code: '23505' })
    await db.exec(`UPDATE public.crm_integrazioni SET revocata_il = now(), revocata_da = '${ADMIN}' WHERE id = '${INT_A}'`)
    await db.exec(altra)
    expect(await conta('crm_integrazioni', `scuola_id = '${SEDE_A}'`)).toBe(2)
  })
  it('12 · una richiesta non può dichiarare una sede diversa da quella della sua chiave', async () => {
    await expect(
      db.exec(`INSERT INTO public.crm_ai_richieste (scuola_id, integrazione_id, chiave, operazione, impronta)
               VALUES ('${SEDE_B}', '${INT_A}', 'chiave-0009', 'prenota', '${IMPRONTA_1}')`),
    ).rejects.toMatchObject({ code: '23503' })
  })
  it('revocata_il e revocata_da stanno insieme', async () => {
    await expect(db.exec(`UPDATE public.crm_integrazioni SET revocata_il = now() WHERE id = '${INT_A}'`)).rejects.toMatchObject({ code: '23514' })
  })
})

describe('controlli aggiunti dalla ripresa', () => {
  it('la stessa coppia telefono ed email riconduce alla stessa scheda', async () => {
    const recapiti = { email: 'Prova@Example.com', emailNorm: 'prova@example.com' }
    const prima = await contatto(recapiti)
    expect(await contatto(recapiti)).toEqual({ scheda_id: prima.scheda_id, creata: false })
  })

  it('recapiti che portano a due schede danno un errore controllato e nessuna scrittura', async () => {
    await contatto()
    await contatto({ tel: TEL2, telNorm: TEL2_NORM, email: 'Prova@Example.com', emailNorm: 'prova@example.com' })
    const recapiti = { email: 'Prova@Example.com', emailNorm: 'prova@example.com' }
    await expect(contatto(recapiti)).rejects.toMatchObject({ code: 'P0001', message: 'AMBIGUITA_CONTATTO' })
    await expect(prenota(recapiti)).rejects.toMatchObject({ code: 'P0001', message: 'AMBIGUITA_CONTATTO' })
    expect(await conta('crm_schede')).toBe(2)
    expect(await conta('crm_eventi')).toBe(2)
    expect(await conta('crm_ai_richieste')).toBe(0)
    expect(await conta('crm_appuntamenti')).toBe(0)
  })

  it('la sola data non identifica uno fra due gemelli', async () => {
    await contatto({ bambini: [{ nome: 'Bimbo Prova', data_nascita: NASCITA }, { nome: 'Bimba Prova', data_nascita: NASCITA }] })
    await expect(contatto({ bambini: [{ nome: null, data_nascita: NASCITA }] }))
      .rejects.toMatchObject({ code: 'P0001', message: 'AMBIGUITA_BAMBINO' })
    expect(await conta('crm_bambini')).toBe(2)
  })

  it('un anno mancante non distingue due gemelli con la stessa data', async () => {
    const { scheda_id: scheda } = await contatto({ bambini: [{ nome: 'Bimbo Prova', data_nascita: NASCITA }] })
    await db.exec(`UPDATE public.crm_bambini SET esito = 'perso'`)
    // Riproduce una riga precedente ai vincoli d’anno. La guardia resta attiva.
    await db.exec(`
      ALTER TABLE public.crm_bambini ALTER COLUMN anno_id DROP NOT NULL;
      UPDATE public.anno_regole SET controlli_rigidi = false;
    `)
    try {
      await db.query(`
        INSERT INTO public.crm_bambini (scheda_id, scuola_id, nome, data_nascita, esito)
          VALUES ($1, $2, 'Bimba Prova', $3, 'perso')
      `, [scheda, SEDE_A, NASCITA])
      await db.exec('UPDATE public.anno_regole SET controlli_rigidi = true')
      const eventiPrima = await conta('crm_eventi')
      expect(await conta('crm_bambini', 'anno_id IS NULL')).toBe(1)

      await expect(contatto({ bambini: [{ nome: null, data_nascita: NASCITA }] }))
        .rejects.toMatchObject({ code: 'P0001', message: 'AMBIGUITA_BAMBINO' })
      expect(await conta('crm_bambini', `esito = 'perso'`)).toBe(2)
      expect(await conta('crm_eventi')).toBe(eventiPrima)

      await contatto({ bambini: [{ nome: 'Bimba Prova', data_nascita: NASCITA }] })
      expect(await conta('crm_bambini', `nome = 'Bimba Prova' AND esito = 'aperto' AND anno_id IS NOT NULL`)).toBe(1)
      expect(await conta('crm_bambini', `nome = 'Bimbo Prova' AND esito = 'perso'`)).toBe(1)
    } finally {
      await db.exec(`
        DELETE FROM public.crm_bambini WHERE anno_id IS NULL;
        ALTER TABLE public.crm_bambini ALTER COLUMN anno_id SET NOT NULL;
        UPDATE public.anno_regole SET controlli_rigidi = true;
      `)
    }
  })

  it('due bambini con stessa data e senza nomi non confluiscono in una riga', async () => {
    await expect(contatto({ bambini: [{ nome: null, data_nascita: NASCITA }, { nome: null, data_nascita: NASCITA }] }))
      .rejects.toMatchObject({ code: 'P0001', message: 'AMBIGUITA_BAMBINO' })
    expect(await conta('crm_bambini')).toBe(0)
    expect(await conta('crm_schede')).toBe(0)
  })

  it.each([true, false])('dichiara anno corrente e prossimo con guardia attiva=%s', async (attiva) => {
    await db.query('UPDATE public.anno_regole SET guardia_attiva = $1, guardia_osserva = NOT $1', [attiva])
    await contatto({ bambini: [
      { nome: 'Bimbo Prova', data_nascita: NASCITA },
      { nome: 'Bimba Prova', data_nascita: NASCITA, anno_ingresso: 'prossimo' },
    ] })
    const anni = await db.query(`
      SELECT b.anno_ingresso, a.anno_inizio, s.stato FROM public.crm_bambini b
        JOIN public.anni_scolastici a ON a.id = b.anno_id
        JOIN public.anni_sede s ON s.anno_id = b.anno_id AND s.scuola_id = b.scuola_id
       ORDER BY a.anno_inizio
    `)
    expect(anni.rows).toEqual([
      { anno_ingresso: 'non_indicato', anno_inizio: 2026, stato: 'corrente' },
      { anno_ingresso: 'prossimo', anno_inizio: 2027, stato: 'in_preparazione' },
    ])
    expect(await conta('correzioni_anno_chiuso_usi')).toBe(0)
    expect(await conta('anno_guardia_osservazioni')).toBe(0)
  })

  it('con l’anno prossimo in chiusura rifiuta la scrittura senza aggirare la guardia', async () => {
    await db.query(`UPDATE public.anni_sede SET stato = 'in_chiusura' WHERE scuola_id = $1 AND stato = 'in_preparazione'`, [SEDE_A])
    try {
      await expect(contatto({ bambini: [{ nome: 'Bimbo Prova', data_nascita: NASCITA, anno_ingresso: 'prossimo' }] }))
        .rejects.toMatchObject({ message: 'ANNO_CHIUSO' })
      expect(await conta('crm_schede')).toBe(0)
      expect(await conta('correzioni_anno_chiuso_usi')).toBe(0)
    } finally {
      await db.query(`UPDATE public.anni_sede SET stato = 'in_preparazione' WHERE scuola_id = $1 AND stato = 'in_chiusura'`, [SEDE_A])
    }
  })

  it('ricontrolla una fascia ritirata e salva una ripetizione precedente anche dopo il ritiro', async () => {
    const prima = await prenota()
    await db.exec('DELETE FROM public.crm_fasce')
    expect(await prenota()).toEqual({ ...prima, ripetuta: true })
    expect(await prenota({ chiave: 'chiave-0002', tel: TEL2, telNorm: TEL2_NORM }))
      .toEqual({ esito: 'fuori_disponibilita' })
    expect(await conta('crm_schede')).toBe(1)
    expect(await conta('crm_ai_richieste')).toBe(1)
  })

  it('verifica griglia, durata, intera visita, anticipo e sede delle candidate', async () => {
    const conInizio = (min: number) => new Date(Date.parse(FRA_30) + min * 60_000).toISOString()
    for (const argomenti of [
      { inizio: conInizio(5) }, { durata: 60 }, { inizio: conInizio(90) },
      { inizio: new Date(Date.now() + 60_000).toISOString() }, { candidati: [P_B] },
    ]) expect(await prenota(argomenti)).toEqual({ esito: 'fuori_disponibilita' })
    expect(await conta('crm_appuntamenti')).toBe(0)
    expect(await conta('crm_schede')).toBe(0)
    expect((await prenota({ candidati: null })).esito).toBe('creata')
  })

  it('una candidata già proposta perde l’assegnabilità se archiviata o rimossa dal ponte', async () => {
    const argomenti = { sede: SEDE_B, integrazione: INT_B, candidati: [P1] }
    const { rows: [prima] } = await db.query<{ persone: string[] }>(
      'SELECT public.crm_ai_candidati($1, $2, 45, $3) AS persone', [SEDE_B, FRA_30, `{${P1}}`],
    )
    expect(prima.persone).toEqual([P1])
    try {
      await db.query('UPDATE public.utenti SET archiviato_il = now() WHERE id = $1', [P1])
      expect(await prenota(argomenti)).toEqual({ esito: 'fuori_disponibilita' })
      await db.query('UPDATE public.utenti SET archiviato_il = NULL WHERE id = $1', [P1])
      await db.query('DELETE FROM public.utenti_scuole WHERE utente_id = $1 AND scuola_id = $2', [P1, SEDE_B])
      expect(await prenota(argomenti)).toEqual({ esito: 'fuori_disponibilita' })
      expect(await conta('crm_appuntamenti')).toBe(0)
      expect(await conta('crm_schede')).toBe(0)
      expect((await prenota({ ...argomenti, candidati: [P1, P_B] })).assegnata_a).toBe(P_B)
    } finally {
      await db.query('UPDATE public.utenti SET archiviato_il = NULL WHERE id = $1', [P1])
      await db.query('INSERT INTO public.utenti_scuole (utente_id, scuola_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [P1, SEDE_B])
    }
  })

  it('una settimana registrata vuota interrompe l’eredità', async () => {
    await db.query(`
      INSERT INTO public.crm_settimane (scuola_id, settimana)
      SELECT $2, date_trunc('week', $1::timestamptz AT TIME ZONE 'Europe/Rome')::date
    `, [FRA_30, SEDE_A])
    expect(await prenota()).toEqual({ esito: 'fuori_disponibilita' })
  })

  it('una nuova assenza della candidata o della sede prevale sulle fasce', async () => {
    await db.query(`
      INSERT INTO public.crm_indisponibilita (scuola_id, utente_id, dal, al, motivo, creata_da)
      VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '15 minutes', 'altro', $4)
    `, [SEDE_A, P1, FRA_30, ADMIN])
    expect(await prenota()).toEqual({ esito: 'fuori_disponibilita' })
    const r = await prenota({ candidati: [P1, P2] })
    expect(r.assegnata_a).toBe(P2)
    await db.query('UPDATE public.crm_indisponibilita SET utente_id = NULL WHERE scuola_id = $1', [SEDE_A])
    expect(await prenota({ chiave: 'chiave-0002', tel: TEL2, telNorm: TEL2_NORM, candidati: [P1, P2] }))
      .toEqual({ esito: 'fuori_disponibilita' })
  })
})

describe('annullamento e proprietà della visita', () => {
  it('annulla e registra l’evento una volta sola, anche sul retry', async () => {
    const visita = (await prenota()).appuntamento_id
    expect(await conta('crm_appuntamenti', `integrazione_id = '${INT_A}'`)).toBe(1)
    expect(await annulla(visita)).toEqual({ esito: 'annullata', appuntamento_id: visita, gia_annullata: false })
    expect(await annulla(visita)).toEqual({ esito: 'annullata', appuntamento_id: visita, gia_annullata: true })
    expect(await conta('crm_eventi', `tipo = 'appuntamento_annullato' AND autore_via = 'ai' AND dati->>'appuntamento_id' = '${visita}'`)).toBe(1)
    expect(await conta('crm_appuntamenti', `stato = 'annullato'`)).toBe(1)
  })

  it('l’altra sede, la chiave revocata e quella nuova non possono annullare', async () => {
    const visita = (await prenota()).appuntamento_id
    expect(await annulla(visita, INT_B, SEDE_B)).toEqual({ esito: 'non_trovato' })
    await db.query('UPDATE public.crm_integrazioni SET revocata_il = now(), revocata_da = $1 WHERE id = $2', [ADMIN, INT_A])
    expect(await annulla(visita)).toEqual({ esito: 'token_non_valido' })
    expect(await prenota()).toEqual({ esito: 'token_non_valido' })
    await db.query(`INSERT INTO public.crm_integrazioni (id, scuola_id, nome, token_impronta, token_coda, creata_da)
                    VALUES ($1, $2, 'Nuova', repeat('c', 64), 'CCCC', $3)`, [INT_NUOVA, SEDE_A, ADMIN])
    expect((await prenota({ integrazione: INT_NUOVA })).esito).toBe('gia_prenotato')
    expect(await annulla(visita, INT_NUOVA)).toEqual({ esito: 'non_trovato' })
    expect(await conta('crm_eventi', `tipo = 'appuntamento_annullato'`)).toBe(0)
  })

  it('una visita manuale può essere trovata ma non annullata dalla chiave', async () => {
    const scheda = (await contatto()).scheda_id
    const { rows: [visita] } = await db.query<{ id: string }>(`
      INSERT INTO public.crm_appuntamenti (scuola_id, scheda_id, inizio, fine, assegnata_a)
        VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '45 minutes', $4) RETURNING id
    `, [SEDE_A, scheda, FRA_30, P1])
    expect(await prenota()).toMatchObject({ esito: 'gia_prenotato', appuntamento_id: visita.id })
    expect(await annulla(visita.id)).toEqual({ esito: 'non_trovato' })
    expect(await conta('crm_eventi', `tipo = 'appuntamento_annullato'`)).toBe(0)
  })

  it('una visita svolta resta svolta', async () => {
    const visita = (await prenota()).appuntamento_id
    await db.query(`UPDATE public.crm_appuntamenti SET stato = 'svolto' WHERE id = $1`, [visita])
    expect(await annulla(visita)).toEqual({ esito: 'stato_non_ammesso' })
    expect(await conta('crm_appuntamenti', `stato = 'svolto'`)).toBe(1)
  })
})

describe('richiamo E4', () => {
  it('scrive azione e due eventi atomici, con motivo fisso e senza duplicare il retry', async () => {
    const visita = await prenota()
    const r = await richiamo({ id: visita.scheda_id })
    expect(r).toMatchObject({ esito: 'ok', scheda_id: visita.scheda_id, creata: true })
    expect(await richiamo({ tel: TEL })).toEqual({ ...r, creata: false })
    expect(await conta('crm_azioni', `tipo = 'richiamare' AND responsabile = '${P1}'
      AND (scadenza AT TIME ZONE 'Europe/Rome')::time = time '10:30'`)).toBe(1)
    expect(await conta('crm_eventi', `tipo = 'azione_pianificata' AND autore_via = 'ai' AND dati->>'azione_id' = '${r.azione_id}'`)).toBe(1)
    expect(await conta('crm_eventi', `tipo = 'nota' AND autore_via = 'ai' AND testo = 'Passaggio dell’assistente: messaggio sulla salute, da leggere in chat.'`)).toBe(1)
  })

  it('il primo richiamo via telefono conserva origine e nome della famiglia', async () => {
    const r = await richiamo({ tel: TEL, genitore: 'Famiglia Prova', origine: 'whatsapp' })
    expect(r).toMatchObject({ esito: 'ok', creata: true })
    const { rows } = await db.query(`
      SELECT origine, genitore_nome, creato_via FROM public.crm_schede WHERE id = $1
    `, [r.scheda_id])
    expect(rows).toEqual([{ origine: 'whatsapp', genitore_nome: 'Famiglia Prova', creato_via: 'ai' }])

    const replay = await richiamo({ tel: TEL, genitore: 'Altro Nome', origine: 'instagram' })
    expect(replay).toEqual({ ...r, creata: false })
    expect(await conta('crm_schede', `genitore_nome = 'Famiglia Prova' AND origine = 'whatsapp'`)).toBe(1)
    expect(await conta('crm_azioni')).toBe(1)
  })

  it('richiede l’origine via telefono e rifiuta metadati estranei quando si usa la scheda', async () => {
    await expect(richiamo({ tel: TEL, origine: null })).rejects.toMatchObject({ code: '22023' })
    expect(await conta('crm_schede')).toBe(0)
    const { scheda_id: scheda } = await contatto()
    await expect(richiamo({ id: scheda, genitore: 'Famiglia Prova', origine: 'whatsapp' }))
      .rejects.toMatchObject({ code: '22023' })
    expect(await conta('crm_azioni')).toBe(0)
  })

  it('una nota rifiutata fa annullare anche azione, contatto nuovo ed eventi', async () => {
    await db.exec(`ALTER TABLE public.crm_eventi ADD CONSTRAINT test_nota CHECK (tipo <> 'nota')`)
    try {
      await expect(richiamo({ tel: TEL })).rejects.toMatchObject({ code: '23514' })
      expect(await conta('crm_azioni')).toBe(0)
      expect(await conta('crm_schede')).toBe(0)
      expect(await conta('crm_eventi')).toBe(0)
    } finally {
      await db.exec('ALTER TABLE public.crm_eventi DROP CONSTRAINT test_nota')
    }
  })

  it('uno già aperto dalla segreteria si ritrova, uno chiuso non impedisce il prossimo', async () => {
    const scheda = (await contatto()).scheda_id
    const { rows: [azione] } = await db.query<{ id: string }>(`
      INSERT INTO public.crm_azioni (scuola_id, scheda_id, tipo, scadenza, responsabile)
      VALUES ($1, $2, 'richiamare', now(), $3) RETURNING id
    `, [SEDE_A, scheda, P2])
    expect(await richiamo({ id: scheda })).toMatchObject({ esito: 'ok', azione_id: azione.id, creata: false })
    expect(await conta('crm_eventi', `tipo IN ('nota', 'azione_pianificata')`)).toBe(0)
    await db.query('UPDATE public.crm_azioni SET fatta_il = now() WHERE id = $1', [azione.id])
    const nuova = await richiamo({ id: scheda })
    expect(nuova.creata).toBe(true)
    expect(nuova.azione_id).not.toBe(azione.id)
  })

  it('impedisce un richiamo su altra sede, con token revocato o motivo libero', async () => {
    const scheda = (await contatto()).scheda_id
    expect(await richiamo({ id: scheda, sede: SEDE_B, integrazione: INT_B })).toEqual({ esito: 'non_trovata' })
    await expect(richiamo({ id: scheda, motivo: 'testo libero' })).rejects.toMatchObject({ code: '22023' })
    await db.query('UPDATE public.crm_integrazioni SET revocata_il = now(), revocata_da = $1 WHERE id = $2', [ADMIN, INT_A])
    expect(await richiamo({ id: scheda })).toEqual({ esito: 'token_non_valido' })
    expect(await conta('crm_azioni')).toBe(0)
  })
})

describe('vincoli e privilegi effettivi', () => {
  it('la proprietà della visita non può puntare alla chiave di un’altra sede', async () => {
    const visita = (await prenota()).appuntamento_id
    await expect(db.query('UPDATE public.crm_appuntamenti SET integrazione_id = $1 WHERE id = $2', [INT_B, visita]))
      .rejects.toMatchObject({ code: '23503' })
    expect(await conta('crm_appuntamenti', `integrazione_id = '${INT_A}'`)).toBe(1)
  })

  it('solo service_role può vedere le nuove tabelle ed eseguire le funzioni', async () => {
    const privilegi = await db.query<{ ruolo: string; tabelle: boolean[]; funzioni: boolean[] }>(`
      SELECT r.rolname AS ruolo,
        ARRAY[has_table_privilege(r.rolname, 'public.crm_integrazioni', 'SELECT'),
              has_table_privilege(r.rolname, 'public.crm_ai_richieste', 'SELECT')] AS tabelle,
        array_agg(DISTINCT has_function_privilege(r.rolname, p.oid, 'EXECUTE')) AS funzioni
        FROM pg_roles r
        CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
         AND n.nspname = 'public' AND p.proname LIKE 'crm_ai_%'
       GROUP BY r.rolname
       ORDER BY r.rolname
    `)
    expect(privilegi.rows).toEqual([
      { ruolo: 'anon', tabelle: [false, false], funzioni: [false] },
      { ruolo: 'authenticated', tabelle: [false, false], funzioni: [false] },
      { ruolo: 'service_role', tabelle: [true, true], funzioni: [true] },
    ])

    // La fixture non ha i default grants del baseline Supabase sulle tabelle già esistenti.
    await db.exec(`
      GRANT ALL ON public.crm_schede, public.crm_bambini, public.crm_appuntamenti, public.crm_eventi,
        public.crm_settimane, public.crm_fasce, public.crm_indisponibilita, public.crm_azioni,
        public.utenti, public.utenti_scuole, public.anni_sede TO service_role;
      SET ROLE service_role;
    `)
    try {
      const r = await prenota()
      expect(r.esito).toBe('creata')
      expect((await annulla(r.appuntamento_id)).esito).toBe('annullata')
    } finally {
      await db.exec('RESET ROLE')
    }
  })

  it('se fallisce l’evento, lo stato della visita e il retry rimangono coerenti', async () => {
    const visita = (await prenota()).appuntamento_id
    await db.exec(`ALTER TABLE public.crm_eventi ADD CONSTRAINT test_evento_annulla CHECK (tipo <> 'appuntamento_annullato')`)
    try {
      await expect(annulla(visita)).rejects.toMatchObject({ code: '23514' })
      expect(await conta('crm_appuntamenti', `stato = 'in_programma'`)).toBe(1)
    } finally {
      await db.exec('ALTER TABLE public.crm_eventi DROP CONSTRAINT test_evento_annulla')
    }
    expect(await annulla(visita)).toMatchObject({ esito: 'annullata', gia_annullata: false })
  })

  it('una seconda richiesta ritrova il conflitto salvato anche se la visita precedente viene annullata', async () => {
    const prima = await prenota()
    const richiesta = { chiave: 'chiave-0002', impronta: IMPRONTA_2, tel: TEL2, telNorm: TEL2_NORM }
    const occupato = await prenota(richiesta)
    expect(occupato.esito).toBe('slot_occupato')
    await annulla(prima.appuntamento_id)
    expect(await prenota(richiesta)).toEqual({ ...occupato, ripetuta: true })
    expect((await prenota({ ...richiesta, chiave: 'chiave-0003' })).esito).toBe('creata')
    expect(await conta('crm_schede')).toBe(2)
  })
})
