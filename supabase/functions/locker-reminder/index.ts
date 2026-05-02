// @ts-ignore: Deno imports
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
// @ts-ignore: Deno imports
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.105.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      // @ts-ignore: Deno global is available in Supabase Edge Functions
      Deno.env.get('SUPABASE_URL') ?? '',
      // @ts-ignore: Deno global is available in Supabase Edge Functions
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    console.log('Inizio controllo richieste armadietto per reminder 07:00...')

    // 1. Cerca richieste pending che non hanno ancora ricevuto il reminder di oggi
    const { data: requests, error } = await supabaseClient
      .from('locker_requests')
      .select(`
        id,
        alunno_id,
        livello_alert,
        quantita_residua,
        alunni (nome, cognome, genitore_id),
        locker_catalog (nome, icona, unita)
      `)
      .eq('stato', 'pending')
      .is('reminder_inviato_il', null)

    if (error) throw error

    if (!requests || requests.length === 0) {
      return new Response(JSON.stringify({ message: 'Nessun reminder da inviare' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    console.log(`Trovate ${requests.length} richieste da ricordare ai genitori.`)

    const results = []

    for (const req of requests) {
      const { alunni, locker_catalog, livello_alert, quantita_residua } = req
      
      // Simula invio notifica push
      console.log(`[SIMULAZIONE NOTIFICA] Inviato reminder a genitore ${alunni.genitore_id} per ${alunni.nome}: ${locker_catalog.icona} ${locker_catalog.nome} in esaurimento (${quantita_residua} ${locker_catalog.unita} rimasti).`)
      
      // Aggiorna flag reminder inviato
      const { error: updateError } = await supabaseClient
        .from('locker_requests')
        .update({ reminder_inviato_il: new Date().toISOString() })
        .eq('id', req.id)

      results.push({
        id: req.id,
        success: !updateError,
        error: updateError ? updateError.message : null
      })
    }

    return new Response(JSON.stringify({ 
      message: 'Reminder processati', 
      processed: requests.length,
      results 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (err: any) {
    console.error('Errore locker-reminder:', err)
    return new Response(JSON.stringify({ error: err.message || 'Errore sconosciuto' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
