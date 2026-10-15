import { describe,it,expect,vi } from 'vitest'
import {creaFintoSupabase,type DBFinto} from '../fixtures/finto-supabase'
vi.mock('@/lib/armadietto/soglie',()=>({soglieMateriali:async()=>({Pannolini:{allerta:5,emergenza:2}})}))
vi.mock('@/lib/logging/logger',()=>({logEvento:vi.fn(),logErrore:vi.fn()}))
import {riconciliaRichieste} from '@/lib/armadietto/richieste'
const oggi={giornoCompetenza:'2026-10-15',giornoOperazioneRoma:'2026-10-15',sopprimiGenitori:false}
const passato={giornoCompetenza:'2020-01-01',giornoOperazioneRoma:'2026-10-15',sopprimiGenitori:true}
describe('armadietto: la rettifica nella vecchia sede non cambia la richiesta odierna della nuova',()=>{
 it('riconcilia stock e politica soltanto nel plesso dell’operazione, anche alla successiva passata cron',async()=>{
  const db:DBFinto={alunni:[{id:'alunno',scuola_id:'nuova',section_id:'classe-nuova'}],armadietto:[
   {id:'carico-vecchio',alunno_id:'alunno',scuola_id:'vecchia',materiale:'Pannolini',quantita:10,portato:true,created_at:'2020-01-01'},
   {id:'carico-nuovo',alunno_id:'alunno',scuola_id:'nuova',materiale:'Pannolini',quantita:5,portato:true,created_at:'2026-10-15T08:00:00Z',politica_operazione:oggi},
   {id:'rettifica',alunno_id:'alunno',scuola_id:'vecchia',materiale:'Pannolini',quantita:9,portato:false,created_at:'2026-10-15T09:00:00Z',politica_operazione:passato},
  ],armadietto_richieste:[{id:'oggi',alunno_id:'alunno',scuola_id:'nuova',materiale:'Pannolini',livello:'giallo',stato:'aperta',quantita_residua:5,politica_operazione:oggi}]}
  const originale=structuredClone(db.armadietto_richieste[0])
  await riconciliaRichieste(creaFintoSupabase(db),{alunnoId:'alunno',operazione:passato,materiale:'Pannolini',sedeStorica:{scuolaId:'vecchia',sectionId:'classe-vecchia'}})
  expect(db.armadietto_richieste.find(r=>r.id==='oggi')).toEqual(originale)
  expect(db.armadietto_richieste.find(r=>r.scuola_id==='vecchia')).toMatchObject({quantita_residua:1,politica_operazione:passato})
  await riconciliaRichieste(creaFintoSupabase(db),{alunnoId:'alunno'})
  expect(db.armadietto_richieste.find(r=>r.id==='oggi')).toMatchObject({quantita_residua:5,politica_operazione:oggi})
 })
})
