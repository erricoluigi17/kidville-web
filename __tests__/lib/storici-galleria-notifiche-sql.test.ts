// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sede = 'a0000000-0000-4000-8000-000000000001'
const altraSede = 'a0000000-0000-4000-8000-000000000002'
const autore = 'b0000000-0000-4000-8000-000000000001'
const genitore = 'c0000000-0000-4000-8000-000000000001'
const altroGenitore = 'c0000000-0000-4000-8000-000000000002'
const media = 'd0000000-0000-4000-8000-000000000001'
const altraFoto = 'd0000000-0000-4000-8000-000000000002'
const fotoAltraSede = 'd0000000-0000-4000-8000-000000000003'
const giorno = '2000-01-14'
const politica = { giornoCompetenza: giorno, giornoOperazioneRoma: giorno, sopprimiGenitori: false }
let db: PGlite

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table galleria_media_v2(id uuid primary key,scuola_id uuid,uploaded_by uuid,eliminato_il timestamptz,
      politica_operazione jsonb,giorno_competenza date,created_at timestamptz default '2000-01-14T12:00:00Z');
    create table notifiche(id uuid primary key default gen_random_uuid(),utente_id uuid,tipo text,titolo text,corpo text,link text,
      entita_tipo text,entita_id uuid,creato_il timestamptz default now(),letta_il timestamptz,push_inviata_il timestamptz,
      invio_programmato_il timestamptz,giorno_competenza date,politica_operazione jsonb);
    create table app_log(livello text,evento text,sorgente text,messaggio text,fingerprint text,contesto jsonb);
  `)
  const migrazione = readFileSync(join(process.cwd(), 'supabase/migrations/20261015183000_storici_stampe_rettifiche.sql'), 'utf8')
  const inizio = migrazione.indexOf('-- BEGIN notifiche galleria con provenienza')
  const fine = migrazione.indexOf('-- END notifiche galleria con provenienza')
  if (inizio >= 0 && fine > inizio) await db.exec(migrazione.slice(inizio, fine))
}, 30000)
afterAll(async () => { await db?.close() })
beforeEach(async () => {
  await db.exec('truncate notifiche,galleria_media_v2,app_log')
  await db.query('insert into galleria_media_v2(id,scuola_id,uploaded_by) values($1,$2,$3),($4,$2,$3),($5,$6,$3)', [media,sede,autore,altraFoto,fotoAltraSede,altraSede])
})

async function accoda(id = media, scuola = sede, genitori = [genitore], policy = politica) {
  return (await db.query<{ n: number }>('select notifiche_galleria_accoda($1,$2,$3,$4,$5,30) as n', [scuola,autore,id,genitori,policy])).rows[0].n
}
async function ritira(id = media, scuola = sede, data = giorno) {
  return (await db.query<{ n: number }>('select notifiche_galleria_ritira($1,$2,$3,$4) as n', [scuola,autore,id,data])).rows[0].n
}
async function righe() {
  return (await db.query<{ id: string; utente_id: string; politica_operazione: { galleria?: { scuolaId: string; mediaIds: string[] } }; push_inviata_il: Date | null }>('select id,utente_id,politica_operazione,push_inviata_il from notifiche order by utente_id,id')).rows
}

describe('annunci galleria atomici con provenienza del singolo contenuto', () => {
  it('unisce due foto nello stesso avviso e ritira soltanto l’origine corretta', async () => {
    expect(await accoda()).toBe(1)
    const primoId = (await righe())[0].id
    expect(await accoda(altraFoto)).toBe(1)
    const id = (await righe())[0].id
    expect(id).not.toBe(primoId)
    expect(await righe()).toMatchObject([{ id, politica_operazione: { galleria: { scuolaId: sede, mediaIds: [media,altraFoto] } } }])
    expect(await ritira()).toBe(1)
    expect(await righe()).toMatchObject([{ id, politica_operazione: { galleria: { mediaIds: [altraFoto] } } }])
    expect(await ritira(altraFoto)).toBe(1)
    expect(await righe()).toEqual([])
  })
  it('preserva un altro destinatario, un’altra giornata, un’altra sede e una push già inviata', async () => {
    await accoda()
    await accoda(altraFoto,sede,[altroGenitore])
    await accoda(fotoAltraSede,altraSede)
    await accoda(media,sede,[genitore],{ ...politica, giornoCompetenza: '2026-10-15' })
    const originale = (await db.query<{ id: string }>("select id from notifiche where utente_id=$1 and giorno_competenza=$2 and politica_operazione#>>'{galleria,scuolaId}'=$3",[genitore,giorno,sede])).rows[0]
    await db.query('update notifiche set push_inviata_il=now() where id=$1',[originale.id])
    expect(await ritira()).toBe(0)
    expect(await righe()).toHaveLength(4)
    expect(await ritira(media,sede,'2026-10-15')).toBe(1)
    expect(await righe()).toHaveLength(3)
    expect((await righe()).find(r => r.id === originale.id)?.push_inviata_il).not.toBeNull()
  })
  it('non attribuisce al media o alla sede le vecchie notifiche senza provenienza', async () => {
    await db.query("insert into notifiche(utente_id,tipo,entita_tipo,entita_id,creato_il) values($1,'galleria','galleria',$2,'2000-01-14T21:55:00Z')",[genitore,autore])
    const legacy = (await righe())[0].id
    await accoda()
    expect(await righe()).toHaveLength(2)
    expect(await ritira()).toBe(1)
    expect(await righe()).toMatchObject([{ id: legacy, politica_operazione: null }])
  })
  it('deduplica destinatari e replay senza perdere le origini concorrenti', async () => {
    const esiti = await Promise.all([accoda(media,sede,[genitore,genitore]),accoda(altraFoto)])
    expect(esiti).toEqual([1,1])
    expect(await righe()).toHaveLength(1)
    expect((await righe())[0].politica_operazione.galleria?.mediaIds).toEqual([media,altraFoto])
    await accoda()
    expect(await righe()).toHaveLength(1)
    expect((await righe())[0].politica_operazione.galleria?.mediaIds).toEqual([media,altraFoto])
  })
  it('un dispatcher che ha già letto il vecchio batch non invia in anticipo la foto aggiunta', async () => {
    await accoda()
    await db.exec("update notifiche set invio_programmato_il=now()-interval '1 minute'")
    const candidate = (await db.query<{ id: string }>('select id from notifiche where push_inviata_il is null and invio_programmato_il<=now()')).rows
    expect(candidate).toHaveLength(1)
    await accoda(altraFoto)
    // Stesso CAS del dispatcher: può avere una lista letta prima dell'upload.
    const presa = await db.query('update notifiche set push_inviata_il=now() where id=$1 and push_inviata_il is null returning id',[candidate[0].id])
    expect(presa.rows).toEqual([])
    expect((await db.query('select id from notifiche where push_inviata_il is null and invio_programmato_il>now()')).rows).toHaveLength(1)
  })
  it('il replay dopo presa o consegna non crea un secondo annuncio dello stesso media', async () => {
    await accoda()
    await db.exec('update notifiche set push_inviata_il=now()')
    expect(await accoda()).toBe(0)
    expect(await righe()).toHaveLength(1)
    expect((await righe())[0].push_inviata_il).not.toBeNull()
  })
  it('un replay non sovrascrive la policy originale con il giorno del nuovo tentativo', async () => {
    await accoda()
    await accoda(media,sede,[genitore],{ ...politica, giornoOperazioneRoma: '2026-10-15' })
    expect((await righe())[0].politica_operazione).toMatchObject(politica)
  })
  it('silenzio storico: non cancella né aggrega le notifiche degli altri contenuti', async () => {
    await accoda(altraFoto)
    expect(await accoda(media,sede,[genitore],{ ...politica, sopprimiGenitori: true })).toBe(0)
    expect((await righe())[0].politica_operazione.galleria?.mediaIds).toEqual([altraFoto])
  })
  it('nega un contenuto fuori sede o di un altro autore, senza mutazioni parziali', async () => {
    await expect(accoda(fotoAltraSede,sede)).rejects.toMatchObject({ code: '22023' })
    await expect(db.query('select notifiche_galleria_ritira($1,$2,$3,$4)',[sede,altroGenitore,media,giorno])).rejects.toMatchObject({ code: '22023' })
    expect(await righe()).toEqual([])
  })
  it('un contenuto già cestinato non ricrea un annuncio dopo il ritiro', async () => {
    await accoda()
    await db.query('update galleria_media_v2 set eliminato_il=now() where id=$1',[media])
    expect(await righe()).toEqual([])
    expect(await ritira()).toBe(0)
    expect(await accoda()).toBe(0)
    expect(await righe()).toEqual([])
  })
  it('la policy rettificata sulla fonte blocca il replay di un intento precedente ammesso', async () => {
    await accoda()
    await db.query('update galleria_media_v2 set politica_operazione=$1 where id=$2',[{ ...politica, sopprimiGenitori: true },media])
    expect(await righe()).toEqual([])
    expect(await ritira()).toBe(0)
    expect(await accoda()).toBe(0)
    expect(await righe()).toEqual([])
  })
  it('il cestino storico e il ritiro sono una transazione: un guasto lascia entrambi invariati, il retry li completa', async () => {
    await accoda()
    await db.exec(`create function prova_ritiro_fallito() returns trigger language plpgsql as $$
      begin raise exception 'Guasto fittizio nel ritiro' using errcode='57014'; end $$;
      create trigger prova_ritiro_fallito before delete on notifiche for each row execute function prova_ritiro_fallito();`)
    try {
      await expect(db.query('update galleria_media_v2 set eliminato_il=now() where id=$1',[media])).rejects.toMatchObject({ code: '57014' })
      expect((await db.query<{ eliminato_il: Date | null }>('select eliminato_il from galleria_media_v2 where id=$1',[media])).rows[0].eliminato_il).toBeNull()
      expect(await righe()).toHaveLength(1)
    } finally { await db.exec('drop trigger prova_ritiro_fallito on notifiche; drop function prova_ritiro_fallito()') }
    await db.query('update galleria_media_v2 set eliminato_il=now() where id=$1',[media])
    expect(await righe()).toEqual([])
  })
  it('una rettifica della fonte non perde le altre foto del batch né le altre giornate', async () => {
    await accoda()
    await accoda(altraFoto)
    await accoda(media,sede,[genitore],{ ...politica,giornoCompetenza:'2026-10-15' })
    await db.query('update galleria_media_v2 set politica_operazione=$1 where id=$2',[{ ...politica,sopprimiGenitori:true },media])
    expect(await righe()).toHaveLength(2)
    const originale = (await db.query<{ politica_operazione: { galleria: { mediaIds: string[] } } }>('select politica_operazione from notifiche where giorno_competenza=$1',[giorno])).rows[0]
    expect(originale.politica_operazione.galleria.mediaIds).toEqual([altraFoto])
  })
  it('un replay non rinvia la push né riaccende la campanella, una foto nuova sì', async () => {
    await accoda()
    await db.exec("update notifiche set letta_il='2026-10-14T15:00:00Z',invio_programmato_il='2026-10-14T16:00:00Z'")
    const lettura = () => db.query<{ letta: string | null; programmata: string }>('select letta_il::text as letta,invio_programmato_il::text as programmata from notifiche')
    const prima = (await lettura()).rows[0]
    await accoda()
    const replay = (await lettura()).rows[0]
    expect(replay).toEqual(prima)
    expect(replay.letta).not.toBeNull()
    await accoda(altraFoto)
    expect((await lettura()).rows[0].letta).toBeNull()
    expect((await lettura()).rows[0].programmata).not.toBe(replay.programmata)
  })
  it('un guasto del solo logging non perde l’annuncio né impedisce il ritiro', async () => {
    await db.exec('alter table app_log add constraint prova_logging check (false)')
    try {
      expect(await accoda()).toBe(1)
      expect(await ritira()).toBe(1)
      expect(await righe()).toEqual([])
    } finally { await db.exec('alter table app_log drop constraint prova_logging') }
  })
  it('un errore nella scrittura lascia intatti il batch e le sue origini precedenti', async () => {
    await accoda()
    await db.exec("alter table notifiche add constraint prova_origini check (jsonb_array_length(politica_operazione#>'{galleria,mediaIds}') <= 1)")
    try {
      await expect(accoda(altraFoto)).rejects.toMatchObject({ code: '23514' })
      expect((await righe())[0].politica_operazione.galleria?.mediaIds).toEqual([media])
    } finally { await db.exec('alter table notifiche drop constraint prova_origini') }
  })
  it('le RPC sono eseguibili soltanto dal servizio server', async () => {
    for (const ruolo of ['anon','authenticated']) {
      for (const funzione of ['notifiche_galleria_accoda(uuid,uuid,uuid,uuid[],jsonb,integer)','notifiche_galleria_ritira(uuid,uuid,uuid,date)']) {
        expect((await db.query<{ permesso: boolean }>('select has_function_privilege($1,$2,$3) as permesso',[ruolo,funzione,'EXECUTE'])).rows[0].permesso).toBe(false)
      }
    }
    expect((await db.query<{ permesso: boolean }>("select has_function_privilege('service_role','notifiche_galleria_accoda(uuid,uuid,uuid,uuid[],jsonb,integer)','EXECUTE') as permesso")).rows[0].permesso).toBe(true)
  })
})
