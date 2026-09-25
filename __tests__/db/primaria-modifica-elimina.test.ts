// @vitest-environment node

/**
 * P0 dei sei interventi — la migrazione `20260924220000_primaria_modifica_elimina.sql`,
 * eseguita su PGlite dal FILE VERO della cartella delle migrazioni, sopra le parti della
 * baseline (e di `20260909121501_sblocchi_audit_per_slot.sql`) che tocca.
 *
 * Che cosa si prova:
 *  · è IDEMPOTENTE: tre giri di fila, e il terzo lascia lo stesso stato del primo — gira
 *    sia in produzione (una volta, dall'integrazione) sia sul DB della CI (più volte);
 *  · impreparati: il tipo esiste, il riempimento segue la decisione del titolare, e un
 *    giro successivo non ribalta il tipo di una riga scritta dopo;
 *  · impreparati del genitore: sempre «giustificato», imposto dal trigger anche quando chi
 *    scrive non conosce la colonna (la finestra del deploy);
 *  · allegati del registro: eliminare una lezione NON cancella più gli allegati, ma li
 *    ammette solo se già nel cestino con lo slot d'origine — che il trigger copia a ogni
 *    aggancio, anche sugli allegati caricati dopo la migrazione;
 *  · sblocchi: i quattro tipi nuovi, e lo sblocco per classe+giorno (senza ora).
 *
 * Ogni prova ha il suo controllo negativo: lo stesso scenario SENZA la migrazione dà
 * l'esito opposto, altrimenti la prova non misurerebbe niente.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

const CARTELLA = join(process.cwd(), 'supabase/migrations')
const MIGRAZIONE = readFileSync(join(CARTELLA, '20260924220000_primaria_modifica_elimina.sql'), 'utf8')
const SBLOCCHI_PER_SLOT = readFileSync(join(CARTELLA, '20260909121501_sblocchi_audit_per_slot.sql'), 'utf8')

// uuid palesemente finti: nessuna persona, nessuna sezione vera.
const SEZIONE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ALUNNO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const UTENTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LEZIONE_1 = '11111111-1111-4111-8111-111111111111'
const LEZIONE_2 = '22222222-2222-4222-8222-222222222222'

/** Le parti della baseline che la migrazione tocca o legge, con i vincoli coi loro nomi veri. */
const DDL_BASE = `
  CREATE TABLE public.utenti (id uuid PRIMARY KEY);
  CREATE TABLE public.sections (id uuid PRIMARY KEY);
  CREATE TABLE public.alunni (id uuid PRIMARY KEY);
  CREATE TABLE public.registro_orario (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    section_id uuid,
    data date NOT NULL,
    ora_lezione integer NOT NULL,
    CONSTRAINT registro_orario_ora_lezione_check CHECK (ora_lezione >= 1 AND ora_lezione <= 8)
  );
  CREATE TABLE public.allegati_registro (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    registro_id uuid NOT NULL,
    ambito text DEFAULT 'argomento' NOT NULL,
    tipo text NOT NULL,
    file_url text NOT NULL,
    caricato_da uuid,
    CONSTRAINT allegati_registro_tipo_check CHECK (tipo = ANY (ARRAY['pdf'::text, 'immagine'::text]))
  );
  ALTER TABLE ONLY public.allegati_registro
    ADD CONSTRAINT allegati_registro_registro_id_fkey
    FOREIGN KEY (registro_id) REFERENCES public.registro_orario(id) ON DELETE CASCADE;
  CREATE TABLE public.giustifiche_didattiche (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    alunno_id uuid NOT NULL,
    section_id uuid,
    data date NOT NULL,
    motivo text,
    origine text NOT NULL,
    CONSTRAINT giustifiche_didattiche_origine_check CHECK (origine = ANY (ARRAY['genitore'::text, 'docente'::text]))
  );
  CREATE TABLE public.student_documents (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id uuid NOT NULL,
    file_url text NOT NULL
  );
  CREATE TABLE public.sblocchi_audit (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    entita_tipo text NOT NULL,
    entita_id uuid NOT NULL,
    dirigente_id uuid,
    motivazione text NOT NULL,
    CONSTRAINT sblocchi_audit_entita_tipo_check CHECK (entita_tipo = ANY (ARRAY['registro'::text, 'valutazione'::text, 'nota'::text, 'scrutinio'::text]))
  );
`

const DATI = `
  INSERT INTO public.utenti VALUES ('${UTENTE}');
  INSERT INTO public.sections VALUES ('${SEZIONE}');
  INSERT INTO public.alunni VALUES ('${ALUNNO}');
  INSERT INTO public.registro_orario (id, section_id, data, ora_lezione) VALUES
    ('${LEZIONE_1}', '${SEZIONE}', '2026-09-21', 2),
    ('${LEZIONE_2}', '${SEZIONE}', '2026-09-22', 3);
  INSERT INTO public.allegati_registro (registro_id, tipo, file_url) VALUES
    ('${LEZIONE_1}', 'pdf', 'finto/1.pdf'),
    ('${LEZIONE_2}', 'immagine', 'finto/2.jpg');
  INSERT INTO public.giustifiche_didattiche (alunno_id, data, motivo, origine) VALUES
    ('${ALUNNO}', '2026-09-21', 'Impreparato giustificato', 'docente'),
    ('${ALUNNO}', '2026-09-21', 'testo scritto dal docente', 'docente'),
    ('${ALUNNO}', '2026-09-21', 'testo del genitore', 'genitore');
`

const aperti: PGlite[] = []

async function nuovoDb(opzioni: { migrata: boolean }): Promise<PGlite> {
  const db = new PGlite()
  aperti.push(db)
  await db.exec(DDL_BASE)
  await db.exec(SBLOCCHI_PER_SLOT)
  await db.exec(DATI)
  if (opzioni.migrata) await db.exec(MIGRAZIONE)
  return db
}

afterEach(async () => {
  while (aperti.length > 0) await aperti.pop()!.close()
})

/** Il codice SQLSTATE dell'errore, oppure 'ok' se l'istruzione passa. */
async function esito(db: PGlite, sql: string): Promise<string> {
  try {
    await db.exec(sql)
    return 'ok'
  } catch (e) {
    return (e as { code?: string }).code ?? 'errore-senza-codice'
  }
}

async function righe<T>(db: PGlite, sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows
}

describe('20260924220000_primaria_modifica_elimina — idempotenza', () => {
  it('tre giri di fila passano, e lo stato dopo il terzo è quello dopo il primo', async () => {
    const db = await nuovoDb({ migrata: true })
    const fotografa = async () => ({
      giustifiche: await righe(db, `SELECT origine, motivo, tipo FROM giustifiche_didattiche ORDER BY origine, motivo NULLS FIRST`),
      allegati: await righe(db, `SELECT slot_section_id, slot_data::text, slot_ora_lezione FROM allegati_registro ORDER BY slot_data`),
      vincoli: await righe(db, `
        SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS d
          FROM pg_constraint
         WHERE conrelid IN ('allegati_registro'::regclass, 'giustifiche_didattiche'::regclass,
                            'student_documents'::regclass, 'sblocchi_audit'::regclass)
         ORDER BY 1, 2`),
      indici: await righe(db, `SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE '%cestino%' ORDER BY 1`),
      trigger: await righe(db, `
        SELECT tgrelid::regclass::text AS t, tgname
          FROM pg_trigger
         WHERE NOT tgisinternal
         ORDER BY 1, 2`),
    })
    const dopoIlPrimo = await fotografa()
    await db.exec(MIGRAZIONE)
    await db.exec(MIGRAZIONE)
    expect(await fotografa()).toEqual(dopoIlPrimo)
    // I due trigger esistono, UNA volta ciascuno: il DROP IF EXISTS + CREATE non li raddoppia.
    expect(dopoIlPrimo.trigger).toEqual([
      { t: 'allegati_registro', tgname: 'trg_allegati_registro_copia_slot' },
      { t: 'giustifiche_didattiche', tgname: 'trg_giustifiche_didattiche_genitore_giustificato' },
    ])
    // E la FK verso la lezione resta UNA: un giro successivo non ne aggiunge una seconda.
    const fkLezione = (dopoIlPrimo.vincoli as { d: string }[]).filter((v) => v.d.includes('REFERENCES registro_orario'))
    expect(fkLezione).toHaveLength(1)
    expect(fkLezione[0].d).toContain('ON DELETE SET NULL')
  })

  it('gli indici parziali del cestino esistono su allegati e fascicolo', async () => {
    const db = await nuovoDb({ migrata: true })
    const indici = await righe<{ indexname: string; indexdef: string }>(
      db,
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname LIKE '%cestino%' ORDER BY 1`,
    )
    expect(indici.map((i) => i.indexname)).toEqual(['idx_allegati_registro_cestino', 'idx_student_documents_cestino'])
    for (const i of indici) expect(i.indexdef).toMatch(/WHERE \(eliminato_il IS NOT NULL\)/)
  })
})

describe('impreparati — tipo separato dal motivo', () => {
  it('riempimento: genitore → giustificato; il testo fisso del docente → impreparato con motivo NULL', async () => {
    const db = await nuovoDb({ migrata: true })
    expect(
      await righe(db, `SELECT origine, motivo, tipo FROM giustifiche_didattiche ORDER BY origine, motivo NULLS FIRST`),
    ).toEqual([
      { origine: 'docente', motivo: null, tipo: 'impreparato' },
      // Un motivo scritto davvero dal docente non si tocca.
      { origine: 'docente', motivo: 'testo scritto dal docente', tipo: 'impreparato' },
      { origine: 'genitore', motivo: 'testo del genitore', tipo: 'giustificato' },
    ])
  })

  it('un giro successivo non ribalta il tipo di una riga scritta dopo la migrazione', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(`
      INSERT INTO giustifiche_didattiche (alunno_id, data, motivo, origine, tipo)
      VALUES ('${ALUNNO}', '2026-09-23', 'Impreparato giustificato', 'docente', 'giustificato')`)
    await db.exec(MIGRAZIONE)
    expect(
      await righe(db, `SELECT motivo, tipo FROM giustifiche_didattiche WHERE data = '2026-09-23'`),
    ).toEqual([{ motivo: 'Impreparato giustificato', tipo: 'giustificato' }])
  })

  it('il tipo ammette solo impreparato e giustificato (senza migrazione la colonna non esiste)', async () => {
    const migrata = await nuovoDb({ migrata: true })
    const inserisci = (tipo: string) =>
      `INSERT INTO giustifiche_didattiche (alunno_id, data, origine, tipo) VALUES ('${ALUNNO}', '2026-09-23', 'docente', '${tipo}')`
    expect(await esito(migrata, inserisci('giustificato'))).toBe('ok')
    expect(await esito(migrata, inserisci('assente'))).toBe('23514')

    const vecchia = await nuovoDb({ migrata: false })
    expect(await esito(vecchia, inserisci('giustificato'))).toBe('42703')
  })

  // La route del genitore di PRIMA (la finestra del deploy) non scrive il tipo: è l'INSERT
  // qui sotto, senza la colonna `tipo`.
  const dichiarazioneDelGenitore = `
    INSERT INTO giustifiche_didattiche (alunno_id, data, motivo, origine)
    VALUES ('${ALUNNO}', '2026-09-24', 'dichiarata dopo il merge', 'genitore')`
  const tipoDelGenitore = `SELECT tipo FROM giustifiche_didattiche WHERE data = '2026-09-24'`

  it('un INSERT del genitore SENZA tipo esce «giustificato», non col predefinito', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(dichiarazioneDelGenitore)
    expect(await righe(db, tipoDelGenitore)).toEqual([{ tipo: 'giustificato' }])
  })

  it('un UPDATE che mette «impreparato» su una riga del genitore la lascia «giustificato»', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(dichiarazioneDelGenitore)
    expect(await esito(db, `UPDATE giustifiche_didattiche SET tipo = 'impreparato' WHERE data = '2026-09-24'`)).toBe('ok')
    expect(await righe(db, tipoDelGenitore)).toEqual([{ tipo: 'giustificato' }])
    // Anche la riga del genitore riempita dalla migrazione resiste.
    await db.exec(`UPDATE giustifiche_didattiche SET tipo = 'impreparato' WHERE motivo = 'testo del genitore'`)
    expect(
      await righe(db, `SELECT tipo FROM giustifiche_didattiche WHERE motivo = 'testo del genitore'`),
    ).toEqual([{ tipo: 'giustificato' }])
    // E il docente, invece, il tipo lo sceglie davvero: il trigger non tocca le sue righe.
    await db.exec(`UPDATE giustifiche_didattiche SET tipo = 'giustificato' WHERE motivo = 'testo scritto dal docente'`)
    await db.exec(`UPDATE giustifiche_didattiche SET tipo = 'impreparato' WHERE motivo = 'testo scritto dal docente'`)
    expect(
      await righe(db, `SELECT tipo FROM giustifiche_didattiche WHERE motivo = 'testo scritto dal docente'`),
    ).toEqual([{ tipo: 'impreparato' }])
  })

  it('controllo negativo: SENZA il trigger il genitore esce «impreparato» e l\'UPDATE passa', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(`DROP TRIGGER trg_giustifiche_didattiche_genitore_giustificato ON giustifiche_didattiche`)
    await db.exec(dichiarazioneDelGenitore)
    expect(await righe(db, tipoDelGenitore)).toEqual([{ tipo: 'impreparato' }])
    await db.exec(`UPDATE giustifiche_didattiche SET tipo = 'impreparato' WHERE motivo = 'testo del genitore'`)
    expect(
      await righe(db, `SELECT tipo FROM giustifiche_didattiche WHERE motivo = 'testo del genitore'`),
    ).toEqual([{ tipo: 'impreparato' }])
  })
})

describe('allegati del registro — la lezione eliminata non si porta via gli allegati', () => {
  it('lo slot d\'origine è riempito sugli allegati che esistono già', async () => {
    const db = await nuovoDb({ migrata: true })
    expect(
      await righe(db, `SELECT registro_id, slot_section_id, slot_data::text AS slot_data, slot_ora_lezione FROM allegati_registro ORDER BY slot_data`),
    ).toEqual([
      { registro_id: LEZIONE_1, slot_section_id: SEZIONE, slot_data: '2026-09-21', slot_ora_lezione: 2 },
      { registro_id: LEZIONE_2, slot_section_id: SEZIONE, slot_data: '2026-09-22', slot_ora_lezione: 3 },
    ])
  })

  it('senza migrazione eliminare la lezione CANCELLA gli allegati (CASCADE): è il difetto', async () => {
    const db = await nuovoDb({ migrata: false })
    expect(await esito(db, `DELETE FROM registro_orario WHERE id = '${LEZIONE_1}'`)).toBe('ok')
    expect(await righe(db, `SELECT count(*)::int AS n FROM allegati_registro`)).toEqual([{ n: 1 }])
  })

  it('eliminare la lezione con allegati FUORI dal cestino è rifiutato, rumorosamente', async () => {
    const db = await nuovoDb({ migrata: true })
    expect(await esito(db, `DELETE FROM registro_orario WHERE id = '${LEZIONE_1}'`)).toBe('23514')
    expect(await righe(db, `SELECT count(*)::int AS n FROM registro_orario`)).toEqual([{ n: 2 }])
  })

  it('prima nel cestino, poi la lezione: l\'allegato resta, orfano, nel cestino, con lo slot', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(`
      UPDATE allegati_registro SET eliminato_il = now(), eliminato_da = '${UTENTE}'
       WHERE registro_id = '${LEZIONE_1}';
      DELETE FROM registro_orario WHERE id = '${LEZIONE_1}';`)
    expect(
      await righe(db, `
        SELECT registro_id, eliminato_il IS NOT NULL AS nel_cestino, eliminato_da,
               slot_section_id, slot_data::text AS slot_data, slot_ora_lezione
          FROM allegati_registro WHERE slot_data = '2026-09-21'`),
    ).toEqual([
      { registro_id: null, nel_cestino: true, eliminato_da: UTENTE, slot_section_id: SEZIONE, slot_data: '2026-09-21', slot_ora_lezione: 2 },
    ])
    // Uscire dal cestino senza una lezione a cui riagganciarsi non si può.
    expect(await esito(db, `UPDATE allegati_registro SET eliminato_il = NULL WHERE registro_id IS NULL`)).toBe('23514')
    // Rifirmata la lezione nello stesso slot, il riaggancio passa.
    await db.exec(`INSERT INTO registro_orario (id, section_id, data, ora_lezione) VALUES ('${LEZIONE_1}', '${SEZIONE}', '2026-09-21', 2)`)
    expect(
      await esito(db, `UPDATE allegati_registro SET eliminato_il = NULL, eliminato_da = NULL, registro_id = '${LEZIONE_1}' WHERE registro_id IS NULL`),
    ).toBe('ok')
  })

  // Gli allegati caricati DOPO la migrazione: il caricamento di oggi non scrive lo slot.
  const LEZIONE_3 = '33333333-3333-4333-8333-333333333333'
  const lezioneECaricamento = `
    INSERT INTO registro_orario (id, section_id, data, ora_lezione) VALUES ('${LEZIONE_3}', '${SEZIONE}', '2026-09-25', 4);
    INSERT INTO allegati_registro (registro_id, tipo, file_url) VALUES ('${LEZIONE_3}', 'pdf', 'finto/caricato-dopo.pdf');`
  // La SOSTITUZIONE: la riga vecchia va nel cestino e basta, nessuno scrive lo slot.
  const sostituzione = `
    UPDATE allegati_registro SET eliminato_il = now(), eliminato_da = '${UTENTE}'
     WHERE file_url = 'finto/caricato-dopo.pdf';`
  const eliminaLezione3 = `DELETE FROM registro_orario WHERE id = '${LEZIONE_3}'`

  it('(a) un allegato caricato dopo la migrazione, SENZA slot, esce con lo slot della sua lezione', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(lezioneECaricamento)
    expect(
      await righe(db, `
        SELECT slot_section_id, slot_data::text AS slot_data, slot_ora_lezione
          FROM allegati_registro WHERE file_url = 'finto/caricato-dopo.pdf'`),
    ).toEqual([{ slot_section_id: SEZIONE, slot_data: '2026-09-25', slot_ora_lezione: 4 }])
  })

  it('(a) lo slot passato dal chiamante non vince su quello della lezione', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(`
      INSERT INTO allegati_registro (registro_id, tipo, file_url, slot_section_id, slot_data, slot_ora_lezione)
      VALUES ('${LEZIONE_2}', 'pdf', 'finto/slot-sbagliato.pdf', '${ALUNNO}', '2020-01-01', 8)`)
    expect(
      await righe(db, `
        SELECT slot_section_id, slot_data::text AS slot_data, slot_ora_lezione
          FROM allegati_registro WHERE file_url = 'finto/slot-sbagliato.pdf'`),
    ).toEqual([{ slot_section_id: SEZIONE, slot_data: '2026-09-22', slot_ora_lezione: 3 }])
  })

  it('(b) sostituito (cestino senza toccare lo slot) e poi lezione eliminata: passa, e l\'allegato resta nel cestino con lo slot', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(lezioneECaricamento)
    await db.exec(sostituzione)
    expect(await esito(db, eliminaLezione3)).toBe('ok')
    expect(
      await righe(db, `
        SELECT registro_id, eliminato_il IS NOT NULL AS nel_cestino,
               slot_section_id, slot_data::text AS slot_data, slot_ora_lezione
          FROM allegati_registro WHERE file_url = 'finto/caricato-dopo.pdf'`),
    ).toEqual([
      { registro_id: null, nel_cestino: true, slot_section_id: SEZIONE, slot_data: '2026-09-25', slot_ora_lezione: 4 },
    ])
  })

  it('(b) controllo negativo: SENZA il trigger la stessa sequenza fa fallire il DELETE con 23514', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(`DROP TRIGGER trg_allegati_registro_copia_slot ON allegati_registro`)
    await db.exec(lezioneECaricamento)
    await db.exec(sostituzione)
    expect(await esito(db, eliminaLezione3)).toBe('23514')
    expect(await righe(db, `SELECT count(*)::int AS n FROM registro_orario WHERE id = '${LEZIONE_3}'`)).toEqual([{ n: 1 }])
  })

  it('agganciare a una lezione che non esiste è rifiutato (23503), come farebbe la FK', async () => {
    const db = await nuovoDb({ migrata: true })
    expect(
      await esito(db, `INSERT INTO allegati_registro (registro_id, tipo, file_url)
                       VALUES ('${LEZIONE_3}', 'pdf', 'finto/senza-lezione.pdf')`),
    ).toBe('23503')
  })

  it('cancellare chi ha cestinato azzera eliminato_da, non l\'allegato né il documento', async () => {
    const db = await nuovoDb({ migrata: true })
    await db.exec(`
      UPDATE allegati_registro SET eliminato_il = now(), eliminato_da = '${UTENTE}' WHERE registro_id = '${LEZIONE_2}';
      INSERT INTO student_documents (student_id, file_url, eliminato_il, eliminato_da)
      VALUES ('${ALUNNO}', 'finto/doc.pdf', now(), '${UTENTE}');`)
    expect(await esito(db, `DELETE FROM utenti WHERE id = '${UTENTE}'`)).toBe('ok')
    expect(await righe(db, `SELECT eliminato_da FROM allegati_registro WHERE eliminato_il IS NOT NULL`)).toEqual([{ eliminato_da: null }])
    expect(await righe(db, `SELECT eliminato_da FROM student_documents`)).toEqual([{ eliminato_da: null }])
  })
})

describe('sblocchi della Direzione — tipi nuovi e sblocco per classe+giorno', () => {
  /** Uno sblocco «giorno»; `colonna`/`valore` aggiungono un campo che il giorno non deve avere. */
  const giorno = (colonna?: string, valore?: string) =>
    `INSERT INTO sblocchi_audit (entita_tipo, section_id, data, motivazione${colonna ? `, ${colonna}` : ''})
     VALUES ('giorno', '${SEZIONE}', '2026-09-21', 'motivo'${colonna ? `, ${valore}` : ''})`

  it('senza migrazione lo sblocco del giorno è rifiutato', async () => {
    const db = await nuovoDb({ migrata: false })
    expect(await esito(db, giorno())).toBe('23514')
  })

  it('il giorno è ammesso con sezione e data, e SOLO così', async () => {
    const db = await nuovoDb({ migrata: true })
    expect(await esito(db, giorno())).toBe('ok')
    expect(await esito(db, giorno('ora_lezione', '2'))).toBe('23514')
    expect(await esito(db, giorno('entita_id', `'${LEZIONE_1}'`))).toBe('23514')
    expect(
      await esito(db, `INSERT INTO sblocchi_audit (entita_tipo, section_id, motivazione) VALUES ('giorno', '${SEZIONE}', 'motivo')`),
    ).toBe('23514')
  })

  it('impreparato, allegato e firma per voce; i tipi di prima restano; un tipo inventato no', async () => {
    const db = await nuovoDb({ migrata: true })
    const perVoce = (tipo: string) =>
      `INSERT INTO sblocchi_audit (entita_tipo, entita_id, motivazione) VALUES ('${tipo}', gen_random_uuid(), 'motivo')`
    for (const tipo of ['impreparato', 'allegato', 'firma', 'registro', 'valutazione', 'nota', 'scrutinio']) {
      expect(await esito(db, perVoce(tipo)), tipo).toBe('ok')
    }
    expect(await esito(db, perVoce('inventato'))).toBe('23514')
    // La firma si può sbloccare anche per slot, come il registro.
    expect(
      await esito(db, `INSERT INTO sblocchi_audit (entita_tipo, section_id, data, ora_lezione, motivazione)
                       VALUES ('firma', '${SEZIONE}', '2026-09-21', 2, 'motivo')`),
    ).toBe('ok')
    // Un tipo che non è «giorno» senza bersaglio resta rifiutato, come prima.
    expect(
      await esito(db, `INSERT INTO sblocchi_audit (entita_tipo, section_id, data, motivazione)
                       VALUES ('nota', '${SEZIONE}', '2026-09-21', 'motivo')`),
    ).toBe('23514')
  })

  it('senza migrazione i tipi nuovi sono rifiutati', async () => {
    const db = await nuovoDb({ migrata: false })
    expect(
      await esito(db, `INSERT INTO sblocchi_audit (entita_tipo, entita_id, motivazione) VALUES ('impreparato', gen_random_uuid(), 'motivo')`),
    ).toBe('23514')
  })
})
