import type { DBFinto, OpzioniFinto, Riga, Scrittura } from './finto-supabase'

/** Emulazione esplicita delle mutazioni per i test HTTP; transazioni/trigger veri sono provati con PGlite. */
export function rettificaStoricaFinta(db: DBFinto, args: Riga, opzioni: OpzioniFinto = {}) {
  const scritture: Scrittura[] = []
  const copia: DBFinto = structuredClone(db)
  const contesto = args.contesto as Riga
  const uguale = (r: Riga, filtro: Riga) => Object.entries(filtro).every(([k,v]) => {
    const actual = k === 'giorno_competenza' && r.orario_inizio ? new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Rome',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(String(r.orario_inizio))) : r[k]
    return (actual ?? null) === (v ?? null)
  })
  for (const a of args.attese as Array<{tabella:string;filtro:Riga;versione:number|null}>) {
    const r = (copia[a.tabella] ?? []).find(r => uguale(r,a.filtro))
    if (r && r.storico_versione === undefined) return {data:null,error:{code:'42703',message:'token non disponibile'}}
    if (a.versione == null ? Boolean(r) : !r || Number(r.storico_versione) !== Number(a.versione)) return {data:null,error:{code:'40001',message:'fonte cambiata'}}
  }
  const revisioni = copia.storici_revisioni ??= []
  const conserva = (tabella: string, riga: Riga) => {
    const errore = opzioni.errori?.['storici_revisioni:insert'] ?? opzioni.errori?.storici_revisioni
    if (errore) throw errore
    revisioni.push({scuola_id:riga.scuola_id ?? contesto.scuola_id,alunno_id:riga.alunno_id ?? contesto.alunno_id,section_id:riga.section_id ?? contesto.section_id,attore_id:contesto.attore_id,modulo:contesto.modulo,entita_id:riga.id,giorno_competenza:contesto.giorno_competenza,contenuto:{tabella,riga:structuredClone(riga)}})
  }
  const incrementaAggregato = (tabella:string, r:Riga) => {
    const legami:Record<string,[string,string]>={firme_docenti:['registro_orario','registro_id'],registro_destinatari:['firme_docenti','firma_id'],nota_ricezioni:['note_disciplinari','nota_id'],valutazione_obiettivi:['valutazioni','valutazione_id'],allegati_registro:['registro_orario','registro_id']}
    const legame=legami[tabella]
    if (!legame) return
    const padre=copia[legame[0]]?.find(p=>p.id===r[legame[1]])
    if(padre) { conserva(legame[0],padre); padre.storico_versione=Number(padre.storico_versione ?? 0)+1; incrementaAggregato(legame[0],padre) }
  }
  const elimina = (tabella:string,r:Riga) => {
    conserva(tabella,r)
    const cascata:Record<string,Array<[string,string]>>={registro_orario:[['firme_docenti','registro_id'],['registro_destinatari','registro_id']],firme_docenti:[['registro_destinatari','firma_id']],note_disciplinari:[['nota_ricezioni','nota_id']],valutazioni:[['valutazione_obiettivi','valutazione_id']]}
    copia[tabella]=copia[tabella].filter(x=>x!==r)
    for(const [figlio,colonna] of cascata[tabella] ?? []) for(const f of [...(copia[figlio] ?? [])]) if(f[colonna]===r.id) elimina(figlio,f)
    incrementaAggregato(tabella,r)
  }
  const esiti:Array<{tabella:string;righe:Riga[]}>=[]
  try {
    for(const a of args.azioni as Array<{tabella:string;operazione:string;filtro:Riga;valori:Riga}>) {
      const errore = opzioni.errori?.[`${a.tabella}:${a.operazione}`] ?? opzioni.errori?.[a.tabella]
      if(errore) return {data:null,error:errore}
      const tabella = copia[a.tabella] ??= []
      let righe:Riga[]
      if(a.operazione==='insert') {
        const r={id:`rpc-${esiti.length}-${tabella.length}`,storico_versione:0,...a.valori}
        if(tabella.some(x=>x.id===r.id)) return {data:null,error:{code:'23505',message:'duplicato'}}
        tabella.push(r); incrementaAggregato(a.tabella,r); righe=[structuredClone(r)]
      } else {
        const bersagli=tabella.filter(r=>uguale(r,a.filtro))
        righe=bersagli.map(r=>structuredClone(r))
        for(const r of bersagli) {
          if(a.operazione==='delete') elimina(a.tabella,r)
          else {conserva(a.tabella,r); Object.assign(r,a.valori,{storico_versione:Number(r.storico_versione ?? 0)+1}); incrementaAggregato(a.tabella,r)}
        }
        if(a.operazione==='update') righe=bersagli.map(r=>structuredClone(r))
      }
      if (!['insert','update','delete'].includes(a.operazione)) throw new Error('RPC finta: operazione non supportata')
      scritture.push({tabella:a.tabella,operazione:a.operazione as 'insert'|'update'|'delete',valori:a.valori?[a.valori]:[],colpite:righe})
      esiti.push({tabella:a.tabella,righe})
    }
  } catch(error) {return {data:null,error}}
  for(const k of Object.keys(db)) delete db[k]
  Object.assign(db,copia)
  opzioni.scritture?.push(...scritture)
  return {data:esiti,error:null}
}
