// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sede = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const altraSede = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const alunno = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const classe = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const altraClasse = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
const attore = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
const giaArchiviato = '66666666-6666-4666-8666-666666666666'
let db: PGlite
beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.schools(id uuid primary key);
    create table public.utenti(id uuid primary key);
    create table public.sections(id uuid primary key,scuola_id uuid,name text);
    create table public.alunni(id uuid primary key,scuola_id uuid,section_id uuid,anonimizzato_il timestamptz,archiviato_il timestamptz,stato text default 'iscritto');
    create table public.presenze(id uuid primary key default gen_random_uuid(),alunno_id uuid,scuola_id uuid,section_id uuid,data date,deleted_at timestamptz);
    create table public.notifiche(id uuid primary key);
    create table public.armadietto(id uuid primary key);
    create table public.armadietto_richieste(id uuid primary key);
    create table public.news_posts(id uuid primary key);
    create table public.video_intents(id uuid primary key);
    create table public.galleria_media_v2(id uuid primary key,file_type text,upload_id uuid,eliminato_il timestamptz,
      scuola_id uuid,uploaded_by uuid,created_at timestamptz default now());
    create table public.avvisi(id uuid primary key);
    create table public.chat_messages(id uuid primary key,content text);
    create table public.valutazioni(id uuid primary key,section_id uuid,creato_il timestamptz);
    create table public.note_disciplinari(id uuid primary key,section_id uuid,creato_il timestamptz);
    create table public.app_log(livello text,evento text,sorgente text,messaggio text,fingerprint text,contesto jsonb);
    create function public.cron_config(text) returns text language sql as 'select null::text';
    create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
    insert into public.schools values('${sede}'),('${altraSede}');
    insert into public.utenti values('${attore}');
    insert into public.sections values('${classe}','${sede}','Classe A'),('${altraClasse}','${altraSede}','Classe B');
    insert into public.alunni(id,scuola_id,section_id,anonimizzato_il,archiviato_il) values('${alunno}','${sede}','${classe}',null,null);
    insert into public.alunni values('${giaArchiviato}','${sede}','${classe}',null,now()-interval '1 month');
    insert into public.presenze(alunno_id,scuola_id,section_id,data) values('${alunno}','${sede}','${classe}','2025-09-15');
  `)
  await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations/20261015183000_storici_stampe_rettifiche.sql'), 'utf8'))
}, 30000)
afterAll(async () => { await db?.close() })
describe('migrazione degli storici sul vero motore PostgreSQL', () => {
  it('accetta tutte le impronte canoniche dei ruoli reali di lavoro, senza il ruolo genitore', async () => {
    await db.exec('begin')
    try {
      const firme = ['admin', 'coordinator', 'segreteria', 'admin,coordinator', 'admin,segreteria', 'coordinator,segreteria', 'admin,coordinator,segreteria']
      for (const firma of firme) {
        await db.query('insert into storici_generazioni(scuola_id,richiesto_da,ruolo_richiedente,richiesta) values($1,$2,$3,$4)', [sede, attore, firma, {}])
      }
      expect((await db.query('select ruolo_richiedente from storici_generazioni order by ruolo_richiedente')).rows).toEqual([...firme].sort().map(ruolo_richiedente => ({ ruolo_richiedente })))
      for (const firma of ['genitore', 'admin,genitore', 'coordinator,admin', 'admin,admin', '']) {
        await db.exec('savepoint ruolo_invalido')
        await expect(db.query('insert into storici_generazioni(scuola_id,richiesto_da,ruolo_richiedente,richiesta) values($1,$2,$3,$4)', [sede, attore, firma, {}])).rejects.toMatchObject({ code: '23514' })
        await db.exec('rollback to savepoint ruolo_invalido')
      }
    } finally { await db.exec('rollback') }
  })
  it('la cancellazione dell’account scade i file ma conserva il lavoro e il lease per la pulizia', async () => {
    await db.exec('begin')
    try {
      const lavoro = '99999999-9999-4999-8999-999999999999'
      const file = `${sede}/${lavoro}/storico.pdf`
      await db.query("insert into storici_generazioni(id,scuola_id,richiesto_da,ruolo_richiedente,richiesta,stato,file_path,preso_il) values($1,$2,$3,'admin',$4,'in_corso',$5,now())", [lavoro, sede, attore, { categorie: ['diario_note'], formato: 'pdf' }, file])
      const prima = (await db.query<{ preso_il: Date }>('select preso_il from storici_generazioni where id=$1', [lavoro])).rows[0]
      await db.query('delete from utenti where id=$1', [attore])
      const dopo = await db.query('select richiesto_da,file_path,stato,scade_il<=now() as scaduto,preso_il from storici_generazioni where id=$1', [lavoro])
      expect(dopo.rows).toEqual([{ richiesto_da: null, file_path: file, stato: 'errore', scaduto: true, preso_il: prima.preso_il }])
    } finally { await db.exec('rollback') }
  })
  it('la RPC dei collegamenti usa il vincolo vero e impedisce assegnazioni concorrenti', async () => {
    await db.exec('begin')
    try {
      const entita = '44444444-4444-4444-8444-444444444444'
      const args = [sede, alunno, 'iscrizione', entita, attore, 0, [0], 'impronta-iniziale', 0]
      const query = 'select public.storici_collega_documento($1,$2,$3,$4,$5,$6,$7,$8,$9) as id'
      const primo = await db.query<{ id: string }>(query, args)
      await db.exec('savepoint creazione_concorrente')
      await expect(db.query(query, [...args.slice(0, 7), 'impronta-da-altro-operatore', 0])).rejects.toMatchObject({ code: '40001' })
      await db.exec('rollback to savepoint creazione_concorrente')
      const secondo = await db.query<{ id: string }>(query, [...args.slice(0, 7), 'impronta-corretta', 1])
      expect(secondo.rows[0].id).toBe(primo.rows[0].id)
      await db.exec('savepoint stale')
      await expect(db.query(query, args)).rejects.toMatchObject({ code: '40001' })
      await db.exec('rollback to savepoint stale')
      expect((await db.query('select contenuto_impronta,versione from storici_collegamenti where id=$1', [primo.rows[0].id])).rows).toEqual([{ contenuto_impronta: 'impronta-corretta', versione: 2 }])
    } finally { await db.exec('rollback') }
  })
  it('ricostruisce soltanto la giornata comprovata, non un intervallo inventato', async () => {
    const r = await db.query<{ dal: string; al: string; section_nome: string }>("select dal::text,al::text,section_nome from alunni_classi_storico where fonte='presenza'")
    expect(r.rows).toEqual([{ dal: '2025-09-15', al: '2025-09-16', section_nome: 'Classe A' }])
  })
  it('registra il trasferimento senza perdere l’identità della vecchia classe', async () => {
    await db.exec(`update alunni set scuola_id='${altraSede}',section_id='${altraClasse}' where id='${alunno}'`)
    const r = await db.query<{ scuola_id: string; section_nome: string }>('select scuola_id,section_nome from alunni_classi_storico where al is null')
    expect(r.rows).toEqual([{ scuola_id: altraSede, section_nome: 'Classe B' }])
    expect((await db.query("select section_nome from alunni_classi_storico where fonte='presenza'")).rows).toEqual([{ section_nome: 'Classe A' }])
  })
  it('impedisce appartenenze manuali sovrapposte in classi diverse', async () => {
    await db.query('select public.storici_salva_appartenenza($1,$2,$3,$4,$5,$6)', [alunno, sede, classe, '2025-09-01', '2025-10-01', attore])
    await expect(db.query('select public.storici_salva_appartenenza($1,$2,$3,$4,$5,$6)', [alunno, altraSede, altraClasse, '2025-09-15', '2025-10-15', attore])).rejects.toMatchObject({ code: '23P01' })
  })
  it('non assegna una frequenza corrente agli alunni già archiviati al momento della migrazione', async () => {
    expect((await db.query('select 1 from alunni_classi_storico where alunno_id=$1', [giaArchiviato])).rows).toEqual([])
  })
  it('chiude la frequenza corrente anche quando cambia soltanto la data di archiviazione', async () => {
    const daArchiviare = '77777777-7777-4777-8777-777777777777'
    await db.exec('begin')
    try {
      await db.exec(`insert into alunni(id,scuola_id,section_id) values('${daArchiviare}','${sede}','${classe}')`)
      expect((await db.query('select 1 from alunni_classi_storico where alunno_id=$1 and al is null', [daArchiviare])).rows).toHaveLength(1)
      await db.exec(`update alunni set archiviato_il=now() where id='${daArchiviare}'`)
      expect((await db.query('select 1 from alunni_classi_storico where alunno_id=$1 and al is null', [daArchiviare])).rows).toEqual([])
      expect((await db.query('select 1 from alunni_classi_storico where alunno_id=$1 and al is not null', [daArchiviare])).rows).toHaveLength(1)
    } finally { await db.exec('rollback') }
  })
  it('nega ai ruoli client tabelle private e funzioni di scrittura', async () => {
    for (const ruolo of ['anon', 'authenticated']) {
      const r = await db.query<{ permesso: boolean }>('select has_table_privilege($1,$2,$3) as permesso', [ruolo, 'public.storici_revisioni', 'SELECT'])
      expect(r.rows[0].permesso).toBe(false)
      const f = await db.query<{ permesso: boolean }>("select has_function_privilege($1,'public.storici_salva_appartenenza(uuid,uuid,uuid,date,date,uuid)','EXECUTE') as permesso", [ruolo])
      expect(f.rows[0].permesso).toBe(false)
    }
    expect((await db.query<{ pubblico: boolean }>('select public as pubblico from storage.buckets where id=$1', ['storici-stampe'])).rows[0].pubblico).toBe(false)
  })

  it('l’oblio via UPDATE elimina gli originali copiati e i collegamenti, e scade anche i dossier di classe', async () => {
    const cancellato = '11111111-1111-4111-8111-111111111111'
    const altro = '22222222-2222-4222-8222-222222222222'
    await db.exec('begin')
    try {
      await db.exec(`
        insert into alunni(id,scuola_id,section_id) values('${cancellato}','${sede}','${classe}'),('${altro}','${sede}','${classe}');
        insert into storici_revisioni(scuola_id,alunno_id,modulo,entita_id,giorno_competenza,contenuto)
          values('${sede}','${cancellato}','diario',gen_random_uuid(),current_date,'{"nota_bambino":"Nota fittizia del cancellato"}'),
                ('${sede}','${altro}','diario',gen_random_uuid(),current_date,'{"nota_bambino":"Nota fittizia da conservare"}');
        insert into storici_collegamenti(scuola_id,alunno_id,tipo,entita_id)
          values('${sede}','${cancellato}','modulo',gen_random_uuid()),('${sede}','${altro}','modulo',gen_random_uuid());
        insert into storici_generazioni(scuola_id,richiesto_da,ruolo_richiedente,alunni_ids,richiesta,titolo)
          values('${sede}','${attore}','admin',array['${cancellato}']::uuid[],'{}','individuale'),
                ('${sede}','${attore}','admin',array['${cancellato}','${altro}']::uuid[],'{}','classe'),
                ('${sede}','${attore}','admin',array['${altro}']::uuid[],'{}','estraneo');
        update alunni set anonimizzato_il=now() where id='${cancellato}';
      `)
      expect((await db.query('select 1 from storici_revisioni where alunno_id=$1', [cancellato])).rows).toEqual([])
      expect((await db.query('select 1 from storici_collegamenti where alunno_id=$1', [cancellato])).rows).toEqual([])
      expect((await db.query('select 1 from storici_revisioni where alunno_id=$1', [altro])).rows).toHaveLength(1)
      expect((await db.query('select 1 from storici_collegamenti where alunno_id=$1', [altro])).rows).toHaveLength(1)
      const lavori = await db.query<{ titolo: string; scaduto: boolean }>('select titolo,scade_il<=now() as scaduto from storici_generazioni order by titolo')
      expect(lavori.rows).toEqual([{ titolo: 'classe', scaduto: true }, { titolo: 'estraneo', scaduto: false }, { titolo: 'individuale', scaduto: true }])
      // L'oblio conserva la riga anagrafica: ON DELETE CASCADE non coprirebbe questo caso.
      expect((await db.query('select 1 from alunni where id=$1 and anonimizzato_il is not null', [cancellato])).rows).toHaveLength(1)
    } finally { await db.exec('rollback') }
  })

  it('la bonifica del testo chat rimuove anche la rettifica e la copia della versione precedente', async () => {
    const messaggio = '33333333-3333-4333-8333-333333333333'
    await db.exec('begin')
    try {
      await db.exec(`
        insert into chat_messages(id,content,rettifica_staff,rettifica_staff_il,rettifica_staff_da,rettifica_versione)
          values('${messaggio}','Testo originale fittizio','Rettifica fittizia',now(),'${attore}',3);
        insert into storici_revisioni(scuola_id,alunno_id,modulo,entita_id,giorno_competenza,contenuto)
          values('${sede}','${alunno}','chat','${messaggio}',current_date,'{"content":"Testo originale fittizio"}');
        update chat_messages set content='' where id='${messaggio}';
      `)
      const r = await db.query<{ rettifica_staff: string | null; rettifica_staff_il: string | null; rettifica_staff_da: string | null; rettifica_versione: number }>(
        'select rettifica_staff,rettifica_staff_il::text,rettifica_staff_da,rettifica_versione from chat_messages where id=$1', [messaggio])
      expect(r.rows).toEqual([{ rettifica_staff: null, rettifica_staff_il: null, rettifica_staff_da: null, rettifica_versione: 4 }])
      expect((await db.query('select 1 from storici_revisioni where entita_id=$1', [messaggio])).rows).toEqual([])
    } finally { await db.exec('rollback') }
  })

  it('la retention della fonte azzera i soli testi scaduti e conserva firme e originali didattici', async () => {
    await db.exec('begin')
    try {
      await db.exec(`insert into storici_revisioni(scuola_id,alunno_id,modulo,entita_id,giorno_competenza,contenuto)
        values('${sede}','${alunno}','presenze',gen_random_uuid(),current_date-interval '13 months','{"giustificazione_testo":"Motivo fittizio","giustificazione_firma":{"prova":true},"stato":"assente"}'),
        ('${sede}','${alunno}','giustifiche-presenza',gen_random_uuid(),current_date-interval '13 months','{"tabella":"presenze","riga":{"note_appello":"Nota fittizia","giustificazione_firma":{"prova":true}}}'),
        ('${sede}','${alunno}','presenze',gen_random_uuid(),current_date-interval '11 months','{"note_appello":"Nota recente"}'),
        ('${sede}','${alunno}','valutazioni',gen_random_uuid(),current_date-interval '25 months','{"valutazione":"Originale da conservare"}');
        select public.storici_tick();`)
      const righe = await db.query<{modulo:string;contenuto:Record<string,unknown>}>('select modulo,contenuto from storici_revisioni order by giorno_competenza')
      expect(righe.rows).toHaveLength(4)
      expect(righe.rows[0].contenuto).toEqual({valutazione:'Originale da conservare'})
      expect(righe.rows[1].contenuto).toMatchObject({giustificazione_testo:null,giustificazione_firma:{prova:true},stato:'assente'})
      expect(righe.rows[2].contenuto).toMatchObject({riga:{note_appello:null,giustificazione_firma:{prova:true}}})
      expect(righe.rows[3].contenuto.note_appello).toBe('Nota recente')
    } finally { await db.exec('rollback') }
  })
  it('le due migrazioni applicate insieme conservano uuid reali delle fonti e firme in cascata', async () => {
    await db.exec(`
      create table if not exists eventi_diario(id uuid primary key,orario_inizio timestamptz);
      create table if not exists giustifiche_didattiche(id uuid primary key);
      create table if not exists registro_orario(id uuid primary key,scuola_id uuid,section_id uuid,data date,argomento text);
      create table if not exists firme_docenti(id uuid primary key,registro_id uuid references registro_orario(id) on delete cascade,firmato_il timestamptz);
      create table if not exists registro_destinatari(id uuid primary key,registro_id uuid references registro_orario(id) on delete cascade,firma_id uuid references firme_docenti(id) on delete cascade);
      create table if not exists nota_ricezioni(id uuid primary key,nota_id uuid references note_disciplinari(id) on delete cascade);
      create table if not exists valutazione_obiettivi(id uuid primary key,valutazione_id uuid references valutazioni(id) on delete cascade);
      create table if not exists allegati_registro(id uuid primary key,registro_id uuid references registro_orario(id) on delete set null);
    `)
    await db.exec(readFileSync(join(process.cwd(),'supabase/migrations/20261015183200_storici_versioni.sql'),'utf8'))
    const registro='44444444-4444-4444-8444-444444444444'
    const firma='55555555-5555-4555-8555-555555555555'
    await db.query('insert into registro_orario(id,scuola_id,section_id,data,argomento) values($1,$2,$3,$4,$5)',[registro,sede,classe,'2020-01-01','Originale didattico fittizio'])
    await db.query('insert into firme_docenti(id,registro_id,firmato_il) values($1,$2,$3)',[firma,registro,'2020-01-01T10:00:00Z'])
    await db.query('select storici_applica_rettifica($1,$2,$3)',[{attore_id:attore,scuola_id:sede,section_id:classe,giorno_competenza:'2020-01-01',modulo:'registro'},[{tabella:'registro_orario',filtro:{id:registro},versione:1}],[{tabella:'registro_orario',operazione:'delete',filtro:{id:registro}}]])
    const conservate=await db.query<{entita_id:string}>('select entita_id::text from storici_revisioni where entita_id=any($1::uuid[]) order by entita_id',[[registro,firma]])
    expect(conservate.rows).toEqual([{entita_id:registro},{entita_id:firma}])
  })

})
