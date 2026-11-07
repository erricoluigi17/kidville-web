import { readFileSync } from 'node:fs'
import { describe, it, expect, afterAll } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { creaDbAnnoPr2, applicaPr2 } from '../helpers/schema-anno-pglite'

/**
 * CORREZIONE DEL 07/11 · `gallery_photo_uploads` esce dal registro dell'anno.
 *
 * La chiave anti-doppione della pubblicazione delle foto sopravvive alla foto (nessuna FK verso il media) e
 * `gallery_publish_photo` la scrive PRIMA della foto: per il trigger generico non ha madre e non ha anno, e il CHECK
 * messo da V1 rifiuta l'INSERT (23514). V2 si ferma sulle righe orfane (ANNO_RIEMPIMENTO_INCOMPLETO).
 * La migrazione `*_anno_foto_anti_doppione_fuori_registro.sql` sta fra V1 e V2.
 *
 * Qui la tabella e la RPC sono quelle VERE (lette dal file della #170); `galleria_media_v2` ha solo le colonne
 * che servono. Solo uuid finti.
 */

const SEDE = '22222222-2222-4222-8222-222222222222'
const OWNER = '11111111-1111-4111-8111-111111111111'
const UPLOAD = '33333333-3333-4333-8333-333333333333'
const ORFANO = '44444444-4444-4444-8444-444444444444'
const MIGRAZIONE_RPC = 'supabase/migrations/20260925180000_gallery_pubblicazione_idempotente.sql'

/**
 * La madre come in produzione, meno le colonne che non servono. `giorno_competenza` ha un DEFAULT fisso dentro il
 * 2026/27: la foto vera lo riceve dal suo trigger di competenza, e il test non deve dipendere dal giorno in cui gira.
 * La RPC e `gallery_photo_uploads` (senza FK verso il media) li crea poi il file vero della #170.
 */
const CODA_PRIMA = `
  CREATE TABLE public.galleria_media_v2 (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uploaded_by uuid NOT NULL,
    scuola_id uuid NOT NULL, file_url text NOT NULL, file_type varchar(20) NOT NULL DEFAULT 'foto',
    caption text, tag_students uuid[] NOT NULL DEFAULT '{}', is_broadcast boolean DEFAULT false,
    target_classes text[], created_at timestamptz DEFAULT now(), eliminato_il timestamptz,
    file_rimosso_il timestamptz, giorno_competenza date DEFAULT DATE '2026-10-15'
  );
` + readFileSync(MIGRAZIONE_RPC, 'utf8')

const PAYLOAD = { file_url: `uploads/${OWNER}/foto.jpg`, file_type: 'foto', caption: null as string | null,
  tag_students: [] as string[], is_broadcast: false, target_classes: ['Classe test'] }

const dbDaChiudere: PGlite[] = []
afterAll(async () => { for (const d of dbDaChiudere) await d.close() })

type Risultato = { ok: boolean; created?: boolean; media?: { id: string; anno_id?: string | null } }

async function nuovoDb(o: { fino: 'V1' | 'FOTO' | 'V2'; senzaFoto?: boolean; orfano?: boolean }): Promise<PGlite> {
  const d = await creaDbAnnoPr2({
    sedi: [SEDE], fino: o.fino, senzaFoto: o.senzaFoto, codaPrima: CODA_PRIMA,
    // una chiave senza più la foto (cestino purgato): il suo anno non si può calcolare
    dopoM1: o.orfano ? async (db) => {
      await db.query(
        `INSERT INTO public.gallery_photo_uploads (owner_id, scuola_id, upload_id, payload_hash, media_id)
         VALUES ($1, $2, $3, 'h', $4)`, [OWNER, SEDE, UPLOAD, ORFANO])
    } : undefined,
  })
  dbDaChiudere.push(d)
  return d
}
async function pubblica(d: PGlite, upload: string = UPLOAD): Promise<Risultato> {
  const q = await d.query<{ result: Risultato }>(
    'SELECT public.gallery_publish_photo($1::uuid, $2::uuid, $3::uuid, $4::jsonb) AS result',
    [OWNER, SEDE, upload, JSON.stringify(PAYLOAD)])
  return q.rows[0].result
}
async function una<T>(d: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  return Object.values((await d.query<Record<string, T>>(sql, params)).rows[0])[0] as T
}
async function codice(p: Promise<unknown>): Promise<string> {
  try { await p } catch (e) {
    const x = e as { code?: string; message?: string }
    return /^[A-Z_]+$/.test(x.message ?? '') ? x.message! : (x.code ?? x.message ?? 'senza-codice')
  }
  return 'nessun-errore'
}

describe('foto anti-doppione · la correzione che porta la chiave fuori dal registro', () => {
  it('1 · SENZA la correzione la pubblicazione è rifiutata con 23514 (il guasto di produzione)', async () => {
    const d = await nuovoDb({ fino: 'V1' })
    expect(await codice(pubblica(d))).toBe('23514')
    expect(await una<number>(d, 'SELECT count(*)::int FROM public.galleria_media_v2')).toBe(0)
  })

  it('2 · CON la correzione la foto si pubblica con il suo anno, e il replay non la ricrea', async () => {
    const d = await nuovoDb({ fino: 'FOTO' })
    const prima = await pubblica(d)
    expect(prima).toMatchObject({ ok: true, created: true })
    const anno = await una<string>(d, `SELECT anno_id FROM public.galleria_media_v2 WHERE id = $1`, [prima.media!.id])
    expect(anno).toBe(await una<string>(d, `SELECT anno_id FROM public.anni_sede s
      JOIN public.anni_scolastici y ON y.id = s.anno_id WHERE s.scuola_id = $1 AND y.anno_inizio = 2026`, [SEDE]))
    expect(await pubblica(d)).toMatchObject({ ok: true, created: false, media: { id: prima.media!.id } })
    expect(await una<number>(d, 'SELECT count(*)::int FROM public.galleria_media_v2')).toBe(1)
  })

  it('3 · con una chiave orfana V2 senza la correzione si ferma; con la correzione si applica', async () => {
    const senza = await nuovoDb({ fino: 'V1', senzaFoto: true, orfano: true })
    expect(await codice(applicaPr2(senza, 'V2'))).toBe('ANNO_RIEMPIMENTO_INCOMPLETO')
    expect(await una<boolean>(senza, 'SELECT controlli_rigidi FROM public.anno_regole')).toBe(false)

    const con = await nuovoDb({ fino: 'V2', orfano: true })
    expect(await una<boolean>(con, 'SELECT controlli_rigidi FROM public.anno_regole')).toBe(true)
    expect(await una<number>(con, 'SELECT count(*)::int FROM public.gallery_photo_uploads')).toBe(1)
  })

  it('4 · la tabella non ha più anno: né colonna, né vincoli, né indici, né trigger, né riga nel registro', async () => {
    const t = 'public.gallery_photo_uploads'
    // controllo positivo: prima della correzione colonna, CHECK, FK composta e indice ci sono (altrimenti il test sotto è cieco)
    const prima = await nuovoDb({ fino: 'V1' })
    expect(await una<number>(prima, `SELECT count(*)::int FROM pg_constraint WHERE conrelid = '${t}'::regclass AND conname ILIKE '%anno%'`)).toBeGreaterThanOrEqual(2)
    expect(await una<number>(prima, `SELECT count(*)::int FROM pg_indexes WHERE tablename = 'gallery_photo_uploads' AND indexname ILIKE '%anno%'`)).toBeGreaterThanOrEqual(1)
    const d = await nuovoDb({ fino: 'V2' })
    expect(await una<number>(d, `SELECT count(*)::int FROM pg_attribute
      WHERE attrelid = '${t}'::regclass AND attname = 'anno_id' AND NOT attisdropped`)).toBe(0)
    expect(await una<number>(d, `SELECT count(*)::int FROM pg_constraint
      WHERE conrelid = '${t}'::regclass AND (conname ILIKE '%anno%' OR pg_get_constraintdef(oid) ILIKE '%anno_id%')`)).toBe(0)
    expect(await una<number>(d, `SELECT count(*)::int FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'gallery_photo_uploads' AND (indexname ILIKE '%anno%' OR indexdef ILIKE '%anno_id%')`)).toBe(0)
    expect(await una<number>(d, `SELECT count(*)::int FROM pg_trigger
      WHERE tgrelid = '${t}'::regclass AND tgname = 'trg_zz_anno_assegna_e_verifica'`)).toBe(0)
    expect(await una<number>(d, `SELECT count(*)::int FROM public.anno_tabelle WHERE tabella = 'gallery_photo_uploads'`)).toBe(0)
    const inv = await d.query<{ invariante: string; tabella: string; righe: number }>(
      `SELECT invariante, tabella, righe::int FROM public.anno_invarianti() WHERE invariante IN ('10a', '10b')`)
    expect(inv.rows.length).toBeGreaterThan(0)
    expect(inv.rows.filter((r) => r.righe > 0)).toEqual([])
    expect(inv.rows.some((r) => r.tabella === 'gallery_photo_uploads')).toBe(false)
    // la riconciliazione guarda solo il registro: nessuna differenza nasce per la chiave
    const diff = await d.query<{ tabella: string }>(`SELECT tabella FROM public.anno_riconciliazione_differenze()`)
    expect(diff.rows.filter((r) => r.tabella === 'gallery_photo_uploads')).toEqual([])
  })

  it('5 · la migrazione è ripetibile, e si applica anche se il CHECK era già stato tolto a mano', async () => {
    const d = await nuovoDb({ fino: 'FOTO' })
    await applicaPr2(d, 'FOTO')
    await applicaPr2(d, 'FOTO')

    const a_mano = await nuovoDb({ fino: 'V1' })
    await a_mano.exec(`ALTER TABLE public.gallery_photo_uploads DROP CONSTRAINT IF EXISTS gallery_photo_uploads_anno_id_presente`)
    await applicaPr2(a_mano, 'FOTO')
    expect(await una<number>(a_mano, `SELECT count(*)::int FROM public.anno_tabelle WHERE tabella = 'gallery_photo_uploads'`)).toBe(0)
    expect(await pubblica(a_mano)).toMatchObject({ ok: true, created: true })
  })
})
