// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
let db: PGlite
const id = '11111111-1111-4111-8111-111111111111'
const firma = '22222222-2222-4222-8222-222222222222'
const contesto = { attore_id: id, scuola_id: id, section_id: id, giorno_competenza: '2020-01-01', modulo: 'registro' }
const applica = (versione: number, azioni: unknown[]) => db.query('select storici_applica_rettifica($1,$2,$3) as risultato', [contesto, [{ tabella: 'registro_orario', filtro: { id }, versione }], azioni])
beforeAll(async () => {
 db = new PGlite()
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create table sections(id uuid primary key, scuola_id uuid); create table alunni(id uuid primary key,scuola_id uuid); create table alunni_classi_storico(alunno_id uuid,scuola_id uuid,dal date,al date);
 create table storici_revisioni(id uuid default gen_random_uuid(), scuola_id uuid, alunno_id uuid, section_id uuid, attore_id uuid, modulo text, entita_id uuid, giorno_competenza date, contenuto jsonb);
 create table registro_orario(id uuid primary key, scuola_id uuid default '11111111-1111-4111-8111-111111111111', argomento text);
 create table firme_docenti(id uuid primary key, registro_id uuid references registro_orario on delete cascade, argomento_proprio text);
 create table registro_destinatari(id uuid primary key, registro_id uuid references registro_orario on delete cascade, firma_id uuid references firme_docenti on delete cascade);
 create table note_disciplinari(id uuid primary key);
 create table nota_ricezioni(id uuid primary key, nota_id uuid references note_disciplinari on delete cascade, firma jsonb);
 create table valutazioni(id uuid primary key);
 create table valutazione_obiettivi(id uuid primary key, valutazione_id uuid references valutazioni on delete cascade);
 create table allegati_registro(id uuid primary key,registro_id uuid references registro_orario on delete set null);
 create table eventi_diario(id uuid primary key default gen_random_uuid(),alunno_id uuid,tipo_evento text,orario_inizio timestamptz); create table presenze(id uuid primary key); create table giustifiche_didattiche(id uuid primary key);`)
 await db.exec(readFileSync(join(process.cwd(),'supabase/migrations/20261015183200_storici_versioni.sql'),'utf8'))
},30000)
beforeEach(async () => {
 await db.exec('truncate registro_orario,firme_docenti,registro_destinatari,note_disciplinari,nota_ricezioni,valutazioni,valutazione_obiettivi,allegati_registro,storici_revisioni,eventi_diario,alunni,alunni_classi_storico cascade')
 await db.query('insert into registro_orario(id,argomento) values($1,$2)',[id,'Originale fittizio'])
 await db.query('insert into firme_docenti(id,registro_id,argomento_proprio) values($1,$2,$3)',[firma,id,'Firma originale fittizia'])
})
afterAll(async () => { await db?.close() })
describe('rettifiche atomiche su PostgreSQL', () => {
 it('aggiorna il token del consolidato anche per una cofirma successiva alla lettura del form', async () => {
  expect((await db.query('select storico_versione from registro_orario')).rows).toEqual([{storico_versione:1}])
  await db.query('update firme_docenti set argomento_proprio=$1 where id=$2',['Nuova firma fittizia',firma])
  await expect(applica(1,[{tabella:'registro_orario',operazione:'delete',filtro:{id}}])).rejects.toMatchObject({code:'40001'})
  expect((await db.query('select count(*)::int as n from firme_docenti')).rows).toEqual([{n:1}])
  expect((await db.query('select count(*)::int as n from storici_revisioni')).rows).toEqual([{n:0}])
 })
 it('la cancellazione conserva atomicamente lezione e firma originale prima della cascata', async () => {
  await applica(1,[{tabella:'registro_orario',operazione:'delete',filtro:{id}}])
  const r=await db.query<{contenuto:{tabella:string;riga:Record<string,unknown>}}>('select contenuto from storici_revisioni')
  expect(r.rows).toEqual(expect.arrayContaining([{contenuto:expect.objectContaining({tabella:'registro_orario',riga:expect.objectContaining({argomento:'Originale fittizio'})})},{contenuto:expect.objectContaining({tabella:'firme_docenti',riga:expect.objectContaining({argomento_proprio:'Firma originale fittizia'})})}]))
 })
 it('rollback dell’intero lotto se una mutazione seguente fallisce', async () => {
  await expect(applica(1,[{tabella:'registro_orario',operazione:'update',filtro:{id},valori:{argomento:'Corretto fittizio'}},{tabella:'firme_docenti',operazione:'insert',valori:{id:firma,registro_id:id}}])).rejects.toMatchObject({code:'23505'})
  expect((await db.query('select argomento,storico_versione from registro_orario')).rows).toEqual([{argomento:'Originale fittizio',storico_versione:1}])
  expect((await db.query('select count(*)::int as n from storici_revisioni')).rows).toEqual([{n:0}])
 })
 it.each([true,false])('non muta B senza attesa, anche quando è nella stessa sede (%s)', async altraSede => {
  const b='33333333-3333-4333-8333-333333333333'
  await db.query('insert into registro_orario(id,scuola_id,argomento) values($1,$2,$3)',[b,altraSede?b:id,'B originale fittizio'])
  await expect(applica(1,[{tabella:'registro_orario',operazione:'update',filtro:{id:b},valori:{argomento:'B indebito fittizio'}}])).rejects.toMatchObject({code:'42501'})
  expect((await db.query('select argomento from registro_orario where id=$1',[b])).rows).toEqual([{argomento:'B originale fittizio'}])
  expect((await db.query('select count(*)::int as n from storici_revisioni')).rows).toEqual([{n:0}])
 })
 it('consente mutazione figlia solo sotto l’aggregato controllato e conserva la vecchia firma', async () => {
  await applica(1,[{tabella:'firme_docenti',operazione:'update',filtro:{id:firma},valori:{argomento_proprio:'Firma corretta fittizia'}}])
  expect((await db.query('select argomento_proprio from firme_docenti')).rows).toEqual([{argomento_proprio:'Firma corretta fittizia'}])
  expect((await db.query("select 1 from storici_revisioni where contenuto->>'tabella'='firme_docenti'")).rows).toHaveLength(1)
 })
 it('non sposta una firma sotto un consolidato privo di attesa', async () => {
  const b='33333333-3333-4333-8333-333333333333'
  await db.query('insert into registro_orario(id,argomento) values($1,$2)',[b,'B fittizio'])
  await expect(applica(1,[{tabella:'firme_docenti',operazione:'update',filtro:{id:firma},valori:{registro_id:b}}])).rejects.toMatchObject({code:'42501'})
  expect((await db.query('select registro_id from firme_docenti where id=$1',[firma])).rows).toEqual([{registro_id:id}])
 })
 it.each(['insert','update'])('rifiuta destinatari con registro A e firma di B, su FK indipendenti (%s)', async operazione => {
  const b='33333333-3333-4333-8333-333333333333', fb='44444444-4444-4444-8444-444444444444', d='55555555-5555-4555-8555-555555555555'
  await db.query('insert into registro_orario(id,scuola_id,argomento) values($1,$1,$2)',[b,'B fittizio'])
  await db.query('insert into firme_docenti(id,registro_id) values($1,$2)',[fb,b])
  if(operazione==='update') await db.query('insert into registro_destinatari(id,registro_id,firma_id) values($1,$2,$3)',[d,id,firma])
  const attesa=operazione==='update'?2:1
  await expect(applica(attesa,[{tabella:'registro_destinatari',operazione,...(operazione==='update'?{filtro:{id:d}}:{}),valori:{id:d,registro_id:id,firma_id:fb}}])).rejects.toMatchObject({code:'42501'})
  expect((await db.query('select storico_versione from registro_orario where id=$1',[b])).rows).toEqual([{storico_versione:1}])
  expect((await db.query('select count(*)::int as n from storici_revisioni')).rows).toEqual([{n:0}])
 })
 it('le assegnazioni storiche senza firma aggiornano il token del consolidato', async () => {
  const d='55555555-5555-4555-8555-555555555555'
  await db.query('insert into registro_destinatari(id,registro_id) values($1,$2)',[d,id])
  await expect(applica(1,[{tabella:'registro_orario',operazione:'delete',filtro:{id}}])).rejects.toMatchObject({code:'40001'})
  expect((await db.query('select storico_versione from registro_orario where id=$1',[id])).rows).toEqual([{storico_versione:2}])
 })
 it('inserisce il diario nuovo con attesa di assenza sul giorno Roma generato e impedisce il secondo inserimento', async () => {
  await db.query('insert into alunni_classi_storico(alunno_id,scuola_id,dal,al) values($1,$1,$2,$3)',[id,'2019-01-01','2021-01-01'])
  const attese=[{tabella:'eventi_diario',filtro:{alunno_id:id,tipo_evento:'umore',giorno_competenza:'2020-01-01'},versione:null}]
  const azioni=[{tabella:'eventi_diario',operazione:'insert',valori:{alunno_id:id,tipo_evento:'umore',orario_inizio:'2019-12-31T23:30:00Z'}}]
  await db.query('select storici_applica_rettifica($1,$2,$3)',[contesto,attese,azioni])
  expect((await db.query('select giorno_competenza::text,storico_versione from eventi_diario')).rows).toEqual([{giorno_competenza:'2020-01-01',storico_versione:0}])
  await expect(db.query('select storici_applica_rettifica($1,$2,$3)',[contesto,attese,azioni])).rejects.toMatchObject({code:'40001'})
 })
 it('il ruolo browser non può chiamare la RPC di servizio', async () => {
  await db.exec('set role authenticated')
  try { await expect(applica(1,[])).rejects.toMatchObject({code:'42501'}) } finally { await db.exec('reset role') }
 })
})
