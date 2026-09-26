// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'

const MIGRAZIONE = 'supabase/migrations/20260925180000_gallery_pubblicazione_idempotente.sql'
const OWNER = '11111111-1111-4111-8111-111111111111'
const SEDE = '22222222-2222-4222-8222-222222222222'
const UPLOAD = '33333333-3333-4333-8333-333333333333'
const ALTRO = '44444444-4444-4444-8444-444444444444'
const PAYLOAD = { file_url: `uploads/${OWNER}/foto.jpg`, file_type: 'foto', caption: null as string | null,
  tag_students: [ALTRO], is_broadcast: false, target_classes: ['Classe test'] }
let db: PGlite
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE TABLE public.schools (id uuid PRIMARY KEY);
    CREATE TABLE public.galleria_media_v2 (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uploaded_by uuid NOT NULL,
      scuola_id uuid NOT NULL, file_url text NOT NULL, file_type varchar(20) NOT NULL DEFAULT 'foto',
      caption text, tag_students uuid[] NOT NULL DEFAULT '{}', is_broadcast boolean DEFAULT false,
      target_classes text[], created_at timestamptz DEFAULT now(), eliminato_il timestamptz,
      file_rimosso_il timestamptz
    );
    ALTER TABLE public.galleria_media_v2 ENABLE ROW LEVEL SECURITY;
    GRANT ALL ON public.galleria_media_v2 TO service_role;
  `)
  if (existsSync(MIGRAZIONE)) await db.exec(readFileSync(MIGRAZIONE, 'utf8'))
})
beforeEach(async () => {
  await db.exec('TRUNCATE public.galleria_media_v2, public.gallery_photo_uploads')
  await db.query('INSERT INTO public.schools(id) VALUES ($1::uuid), ($2::uuid) ON CONFLICT DO NOTHING', [SEDE, ALTRO])
})
afterAll(async () => { await db.close() })
async function pubblica(payload = PAYLOAD, owner = OWNER, sede = SEDE, upload: string | null = UPLOAD) {
  try {
    const q = await db.query<{ result: { ok: boolean; created?: boolean; code?: string; media?: { id: string; tag_students: string[]; target_classes: string[] } } }>(
      'SELECT public.gallery_publish_photo($1::uuid, $2::uuid, $3::uuid, $4::jsonb) AS result',
      [owner, sede, upload, JSON.stringify(payload)],
    )
    return q.rows[0].result
  } catch (error) { return { ok: false, code: (error as { code?: string }).code } }
}
async function conta() { return (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM galleria_media_v2')).rows[0].n }

describe('pubblicazione foto · SQL eseguito in PostgreSQL isolato PGlite', () => {
  it('media, tag e destinatari sono un unico commit', async () => {
    const r = await pubblica()
    expect(r).toMatchObject({ ok: true, created: true, media: { tag_students: [ALTRO], target_classes: ['Classe test'] } })
    expect(await conta()).toBe(1)
  })
  it('una risposta persa si rilegge con lo stesso media id', async () => {
    const primo = await pubblica()
    const replay = await pubblica()
    expect(replay).toMatchObject({ ok: true, created: false, media: { id: primo.media?.id } })
    expect(await conta()).toBe(1)
  })
  it('stesso upload e payload diverso danno conflitto senza sovrascrivere', async () => {
    await pubblica()
    expect(await pubblica({ ...PAYLOAD, caption: 'Diversa' })).toMatchObject({ ok: false, code: 'UPLOAD_CONFLICT' })
    expect(await conta()).toBe(1)
  })
  it('la chiave separa autore e sede', async () => {
    expect((await pubblica()).ok).toBe(true)
    expect((await pubblica(PAYLOAD, ALTRO)).ok).toBe(true)
    expect((await pubblica(PAYLOAD, OWNER, ALTRO)).ok).toBe(true)
    expect(await conta()).toBe(3)
  })
  it('due inserimenti legacy con upload NULL restano distinti', async () => {
    expect((await pubblica(PAYLOAD, OWNER, SEDE, null)).ok).toBe(true)
    expect((await pubblica(PAYLOAD, OWNER, SEDE, null)).ok).toBe(true)
    expect(await conta()).toBe(2)
  })
  it('richieste sovrapposte convergono; PGlite serializza la connessione', async () => {
    const risultati = await Promise.all(Array.from({ length: 8 }, () => pubblica()))
    expect(risultati.filter(r => r.created)).toHaveLength(1)
    expect(new Set(risultati.map(r => r.media?.id)).size).toBe(1)
    expect(await conta()).toBe(1)
  })
  it('un errore su un tag annulla anche il media', async () => {
    expect((await pubblica({ ...PAYLOAD, tag_students: ['non-uuid'] })).ok).toBe(false)
    expect(await conta()).toBe(0)
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM gallery_photo_uploads')).rows[0].n).toBe(0)
  })
  it('il replay non resuscita una foto nel cestino', async () => {
    await pubblica()
    await db.exec('UPDATE galleria_media_v2 SET eliminato_il = now()')
    expect(await pubblica()).toMatchObject({ ok: false, code: 'UPLOAD_DELETED' })
    expect(await conta()).toBe(1)
  })
  it('la cancellazione definitiva non permette di ricreare la foto con lo stesso upload', async () => {
    const prima = await pubblica()
    expect(prima.ok).toBe(true)
    await db.exec('DELETE FROM galleria_media_v2')
    expect(await pubblica()).toMatchObject({ ok: false, code: 'UPLOAD_DELETED' })
    expect(await conta()).toBe(0)
  })
  it('replay concorrenti dopo la purga restano tutti eliminati', async () => {
    await pubblica()
    await db.exec('DELETE FROM galleria_media_v2')
    const replay = await Promise.all(Array.from({ length: 8 }, () => pubblica()))
    expect(replay.every(r => !r.ok && r.code === 'UPLOAD_DELETED')).toBe(true)
    expect(await conta()).toBe(0)
  })
  it('il ledger rifiuta una sede inesistente senza lasciare media o chiavi orfane', async () => {
    expect(await pubblica(PAYLOAD, OWNER, '55555555-5555-4555-8555-555555555555')).toMatchObject({ ok: false, code: '23503' })
    expect(await conta()).toBe(0)
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM gallery_photo_uploads')).rows[0].n).toBe(0)
  })
  it('la rimozione dell’intera sede elimina il relativo ledger senza bloccare la cancellazione', async () => {
    await pubblica()
    await db.query('DELETE FROM public.schools WHERE id = $1::uuid', [SEDE])
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM gallery_photo_uploads')).rows[0].n).toBe(0)
  })
  it('riapplicare sopra la versione senza FK ripara il vincolo e preserva il tombstone', async () => {
    await pubblica()
    await db.exec('DELETE FROM public.galleria_media_v2; ALTER TABLE public.gallery_photo_uploads DROP CONSTRAINT IF EXISTS gallery_photo_uploads_scuola_id_fkey')
    await db.exec(readFileSync(MIGRAZIONE, 'utf8'))
    await db.exec(readFileSync(MIGRAZIONE, 'utf8'))
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int n FROM pg_constraint WHERE conrelid = 'public.gallery_photo_uploads'::regclass AND contype = 'f' AND confrelid = 'public.schools'::regclass")
    expect(rows[0].n).toBe(1)
    expect(await pubblica()).toMatchObject({ ok: false, code: 'UPLOAD_DELETED' })
  })
  it('anon e authenticated non possono eseguire la RPC; service_role sì', async () => {
    const firma = 'public.gallery_publish_photo(uuid,uuid,uuid,jsonb)'
    const { rows } = await db.query<{ a: boolean; u: boolean; s: boolean }>(
      "SELECT has_function_privilege('anon', $1, 'execute') a, has_function_privilege('authenticated', $1, 'execute') u, has_function_privilege('service_role', $1, 'execute') s", [firma])
    expect(rows[0]).toEqual({ a: false, u: false, s: true })
    const acl = await db.query<{ rls: boolean; anon: boolean; auth: boolean; cancellabile: boolean }>(`
      SELECT relrowsecurity rls,
        has_table_privilege('anon', 'public.gallery_photo_uploads', 'select') anon,
        has_table_privilege('authenticated', 'public.gallery_photo_uploads', 'insert') auth,
        has_table_privilege('service_role', 'public.gallery_photo_uploads', 'delete') cancellabile
      FROM pg_class WHERE oid = 'public.gallery_photo_uploads'::regclass
    `)
    expect(acl.rows[0]).toEqual({ rls: true, anon: false, auth: false, cancellabile: false })
  })
})
