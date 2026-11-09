import type { PGlite } from '@electric-sql/pglite'
import {
  applicaPr2, applicaServiziMensili, creaDbAnnoPr2, SCHEMA_AVVISI_CHAT_VOCI_GENITORE, SCHEMA_ISCRIZIONE_ANNO, SCHEMA_LEGAMI_GENITORE, SCHEMA_RETTE,
} from './schema-anno-pglite'

/**
 * PR 4.6 · IL BANCO DELLE RETTE (PGlite): la catena fino a M45e, le tabelle delle voci e dei legami, il banco delle rette
 * (`SCHEMA_RETTE`), i servizi mensili e le due testate della 4.6. Due sedi, la categoria `retta`, le impostazioni di sede con
 * il vecchio default di 150 (la prova che NON viene più letto). Solo uuid finti. Le date sono FISSE: nessun `now()`.
 */

export const SEDE_A = '22222222-2222-4222-8222-222222222222'
export const SEDE_B = '22222222-2222-4222-8222-222222222223'
export const CAT_RETTA = 'c0000000-0000-4000-8000-000000000001'
export const CAT_SERVIZIO = 'c0000000-0000-4000-8000-000000000002'
export const UTENTE = '99999999-0000-4000-8000-000000000009'

/** `${sede}:${anno_inizio}` → `anni_sede.id` */
export type MappaAnni = Record<string, string>

export async function creaBancoRette(opzioni: { fino?: 'M46a' | 'M46b' } = {}): Promise<{ db: PGlite; anni: MappaAnni }> {
  const db = await creaDbAnnoPr2({ sedi: [SEDE_A, SEDE_B], fino: 'M45e', completo: true, codaPrima: SCHEMA_ISCRIZIONE_ANNO })
  await db.exec(SCHEMA_AVVISI_CHAT_VOCI_GENITORE)
  await db.exec(SCHEMA_LEGAMI_GENITORE)
  await db.exec(SCHEMA_RETTE)
  await applicaServiziMensili(db)
  await applicaPr2(db, 'M46a')
  if (opzioni.fino === 'M46b') await applicaPr2(db, 'M46b')
  // la migrazione dell'anno ha COPIATO il default di sede (150) nel listino, con la sua categoria: qui il listino riparte vuoto,
  // come lo vuole ogni prova, e la categoria `retta` è una sola
  await db.exec('DELETE FROM public.listino_voci')
  await db.exec("DELETE FROM public.payment_categories WHERE slug = 'retta'")
  await db.query(`INSERT INTO public.payment_categories (id, scuola_id, nome, slug, is_sistema) VALUES ($1, NULL, 'Retta', 'retta', true)`, [CAT_RETTA])
  await db.query(
    `INSERT INTO public.payment_categories (id, scuola_id, nome, slug, mensile, attivo) VALUES ($1, NULL, 'Pre-scuola', 'prescuola', true, true)`,
    [CAT_SERVIZIO])
  // il vecchio default di sede resta a 150 ovunque: la generazione NON deve più leggerlo
  for (const s of [SEDE_A, SEDE_B]) {
    await db.query(`INSERT INTO public.admin_settings (scuola_id, retta_default_importo) VALUES ($1, 150)`, [s])
  }
  // lo specchio alunni -> frequenze scriverebbe una frequenza di OGGI a ogni alunno inserito: le prove le scrivono a mano, con date fisse
  await db.exec('UPDATE public.anno_regole SET specchio_alunni_attivo = false')
  const anni: MappaAnni = {}
  const r = await db.query<{ scuola_id: string; anno_inizio: number; id: string }>(
    `SELECT s.scuola_id, y.anno_inizio, s.id FROM public.anni_sede s JOIN public.anni_scolastici y ON y.id = s.anno_id`)
  for (const x of r.rows) anni[`${x.scuola_id}:${x.anno_inizio}`] = x.id
  return { db, anni }
}

let contatore = 0
/** Un uuid finto, diverso a ogni chiamata (stabile dentro un file di prova). */
export function uuidFinto(prefisso = '1'): string {
  contatore += 1
  return `${prefisso.repeat(8)}-0000-4000-8000-${String(contatore).padStart(12, '0')}`
}

export interface OpzioniAlunno {
  sede?: string
  nascita?: string
  sezione?: string | null
  classe?: string | null
  stato?: string
}

export async function creaAlunno(db: PGlite, id: string, o: OpzioniAlunno = {}): Promise<string> {
  await db.query(
    `INSERT INTO public.alunni (id, scuola_id, section_id, classe_sezione, data_nascita, stato)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, o.sede ?? SEDE_A, o.sezione ?? null, o.classe === undefined ? 'A' : o.classe, o.nascita ?? '2022-03-01', o.stato ?? 'iscritto'])
  return id
}

export interface OpzioniFrequenza {
  sede?: string
  anno?: number
  stato?: 'in_attesa' | 'iscritto' | 'ritirato' | 'trasferito' | 'uscito'
  retta?: number | null
  esente?: boolean
  aCaricoDi?: string | null
  ingresso?: string
  uscita?: string | null
  sezione?: string | null
  tipo?: 'conferma' | 'nuova' | null
  origine?: string
}

export async function creaFrequenza(db: PGlite, anni: MappaAnni, alunno: string, o: OpzioniFrequenza = {}): Promise<string> {
  const sede = o.sede ?? SEDE_A
  const annoSede = anni[`${sede}:${o.anno ?? 2026}`]
  if (!annoSede) throw new Error(`nessun anno ${o.anno ?? 2026} per la sede ${sede}`)
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.frequenze (alunno_id, anno_sede_id, anno_id, scuola_id, origine, stato, tipo, data_ingresso, data_uscita,
                                   retta_mensile, retta_esente, retta_a_carico_di, section_id)
     SELECT $1, s.id, s.anno_id, s.scuola_id, $3, $4, $5, COALESCE($6::date, s.inizio), $7::date, $8, $9, $10, $11
       FROM public.anni_sede s WHERE s.id = $2
     RETURNING id`,
    [alunno, annoSede, o.origine ?? 'recupero', o.stato ?? 'iscritto', o.tipo ?? null, o.ingresso ?? null, o.uscita ?? null,
      o.retta ?? null, o.esente ?? false, o.aCaricoDi ?? null, o.sezione ?? null])
  return r.rows[0].id
}

export async function creaSezione(db: PGlite, anni: MappaAnni, nome: string, fascia: string | null, sede = SEDE_A): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.sections (scuola_id, anno_id, name, school_type, fascia)
     SELECT $1, s.anno_id, $3, 'infanzia', $4 FROM public.anni_sede s WHERE s.id = $2 RETURNING id`,
    [sede, anni[`${sede}:2026`], nome, fascia])
  return r.rows[0].id
}

export async function listino(db: PGlite, anni: MappaAnni, anno: number, importo: number | null, o: { sede?: string; fascia?: string | null; mesi?: number[] | null; voce?: string; categoria?: string } = {}): Promise<void> {
  const voce = o.voce ?? 'retta'
  await db.query(
    `INSERT INTO public.listino_voci (anno_sede_id, voce, fascia, payment_category_id, importo, mesi)
     VALUES ($1, $2, $3, $4, $5, $6::smallint[])`,
    [anni[`${o.sede ?? SEDE_A}:${anno}`], voce, o.fascia ?? null, o.categoria ?? (voce === 'retta' ? CAT_RETTA : CAT_SERVIZIO), importo, o.mesi ?? null])
}

export async function inRollback(db: PGlite, fn: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN')
  try { await fn() } finally { await db.exec('ROLLBACK') }
}

export async function una<T = string>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<Record<string, T>>(sql, params)
  return Object.values(r.rows[0])[0] as T
}
export async function righe<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows
}
/** Il messaggio (cioè il codice) dell'errore che una query solleva, o `null` se non ne solleva. */
export async function errore(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  // uno SAVEPOINT: dentro una transazione un errore la lascerebbe annullata
  await db.exec('SAVEPOINT prova_errore')
  try {
    await db.query(sql, params)
    await db.exec('RELEASE SAVEPOINT prova_errore')
    return null
  } catch (e) {
    await db.exec('ROLLBACK TO SAVEPOINT prova_errore')
    return (e as { message: string }).message
  }
}
