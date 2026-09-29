import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireUser } from '@/lib/auth/require-staff'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { leggiChatNonLetti } from '@/lib/chat/non-letti'

/**
 * Quante notifiche torna l'ELENCO. La campanella ne mostra 20; il tetto esiste
 * per non trasferire l'archivio intero a ogni poll (60 s).
 *
 * ⚠️ NON è il conteggio, e per un anno lo è stato. `non_lette` si ricavava
 * filtrando QUESTO array — cioè era il minimo fra le non lette vere e questo
 * numero. Su un account reale con 268 notifiche non lette il badge diceva 100 e
 * 168 restavano invisibili; peggio, il numero non si muoveva più leggendone una,
 * il che è indistinguibile da una campanella rotta. Un conteggio derivato da una
 * lista tagliata non è un conteggio: è la lunghezza della lista.
 *
 * Il conteggio ha ora una `head`-query sua (`count: 'exact'`, nessuna riga
 * trasferita) e vive per conto proprio: cambiare questo tetto non lo tocca.
 */
const LIMITE_ELENCO = 100

// Stringa vuota trattata come assente: preserva i default falsy pre-esistenti
// ('' !== 'true' → false in GET; `if (body.id)` truthy in PATCH).
const vuotoComeAssente = (v: unknown) => (v === '' ? undefined : v)

// Semantica storica preservata: il filtro si attiva SOLO con il literal 'true'
// (niente zBool: '1'/'si' non devono attivarlo, come prima dello sweep).
const getQuerySchema = z.object({
  solo_non_lette: z.string().optional(),
})

// Body: { userId?, id? } — solo `id` è usato dall'handler
// (id assente/null = segna tutte come lette).
const patchBodySchema = z.object({
  id: z.preprocess(vuotoComeAssente, zUuid.nullish()),
})

/**
 * GET /api/notifiche?solo_non_lette= — le notifiche di chi chiede, il loro conteggio, e
 * `chat_non_letti`: quanti MESSAGGI DI CHAT non letti ha (il numero per il badge su «Messaggi»).
 *
 * CONTRATTO di `chat_non_letti`:
 *  · `number | null`. `null` è «non lo so» — il client tiene l'ultimo valore noto, non 0;
 *  · ASSENTE nelle risposte d'errore (i due 500 qui sotto non lo portano);
 *  · questa GET non risponde MAI 500 per colpa della chat: è un contorno, le notifiche no;
 *  · calcolato in PARALLELO alle due query delle notifiche, atteso solo alla composizione
 *    della risposta: non aggiunge un round-trip a un poll che gira ogni 60 s.
 *
 * Il perché del numero, i filtri, gli indici e la storia stanno in `@/lib/chat/non-letti`.
 */
export const GET = withRoute('notifiche:GET', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const soloNonLette = q.data.solo_non_lette === 'true'

    const supabase = await createAdminClient()

    // IN PARALLELO, non in serie: la promise parte QUI — prima delle due query delle notifiche
    // — e si attende solo alla composizione della risposta. Spostarla più in basso la
    // rimetterebbe in serie: fino a quattro giri di database dove ne bastano due (tre, se
    // partisse appena dopo il controllo d'errore dell'elenco). Che sui due ritorni 500 il
    // conteggio venga fatto e buttato è lavoro sprecato su un percorso d'errore, e va bene così.
    //
    // L'identità è quella restituita dal GATE, `auth.user.id`: la sola che questa route usa
    // per leggere. Il modulo ne controlla la FORMA (rifiuta ciò che non è un uuid), non a chi
    // appartiene: che sia la persona giusta lo garantisce soltanto il fatto che venga dal gate.
    const chatNonLetti = leggiChatNonLetti(supabase, auth.user.id, 'notifiche:GET')

    let query = supabase
      .from('notifiche')
      .select('id, tipo, titolo, corpo, link, entita_tipo, entita_id, letta_il, creato_il')
      .eq('utente_id', auth.user.id)
      .order('creato_il', { ascending: false })
      .limit(LIMITE_ELENCO)
    if (soloNonLette) query = query.is('letta_il', null)

    const { data, error } = await query
    if (error) {
      // Il corpo dell'errore di PostgREST non si butta via: `error.message` da
      // solo non distingue una colonna mancante da un timeout da una RLS.
      logEvento('notifica', 'error', { operazione: 'notifiche:GET', esito: 'elenco-non-letto' }, error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // IL CONTEGGIO È UNA QUERY SUA. Vedi il blocco in testa al file.
    const { count, error: errConteggio } = await supabase
      .from('notifiche')
      .select('id', { count: 'exact', head: true })
      .eq('utente_id', auth.user.id)
      .is('letta_il', null)
    if (errConteggio) {
      // Meglio nessun numero che un numero falso: la campanella tiene l'ultimo
      // valore noto (`load()` scrive solo su `res.ok`), invece di mostrare 0 —
      // che è indistinguibile da «hai letto tutto» ed è la bugia peggiore.
      logEvento('notifica', 'error', { operazione: 'notifiche:GET', esito: 'conteggio-non-letto' }, errConteggio)
      // Il `message` di PostgREST resta nel LOG e non esce nella risposta: è prosa
      // inglese con dentro i nomi delle colonne del database, e chi la leggerebbe è
      // una segretaria. Al client va un codice, che il catalogo traduce.
      return NextResponse.json(
        { error: 'Conteggio delle notifiche non disponibile', codice: 'NOTIFICHE_CONTEGGIO_NON_LETTO' },
        { status: 500 },
      )
    }

    // Attesa QUI, dove la risposta si compone: la promise è in volo da prima delle due query
    // sopra, quindi non aggiunge attesa. Non lancia, quindi niente try/catch attorno.
    //
    // Del risultato la risposta prende solo il `totale`: i `threadIds` che il modulo riporta
    // servono a chi gira dentro questa stessa GET (la consegna «delivered»), non al client, e
    // la forma del JSON resta quella di prima. `?.totale ?? null` regge entrambi i casi —
    // `null` (non lo so) e `totale: 0` (letto tutto), che restano due cose diverse.
    const chat = await chatNonLetti
    return NextResponse.json({
      success: true,
      data,
      non_lette: count ?? 0,
      chat_non_letti: chat?.totale ?? null,
    })
  } catch (err) {
    logErrore({ operazione: 'notifiche:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

// PATCH /api/notifiche  — segna letta una notifica (o tutte)
// Body: { userId, id? }  (senza id = segna tutte come lette)
export const PATCH = withRoute('notifiche:PATCH', async (request: Request) => {
  try {
    const auth = await requireUser(request)
    if (auth.response) return auth.response
    // Body assente/malformato è tollerato come {} (= segna tutte): default
    // pre-esistente da preservare, quindi lettura tollerante + parseData.
    const raw = await request.json().catch(() => ({}))
    const b = parseData(patchBodySchema, raw)
    if ('response' in b) return b.response

    const supabase = await createAdminClient()
    let q = supabase.from('notifiche').update({ letta_il: new Date().toISOString() }).eq('utente_id', auth.user.id).is('letta_il', null)
    if (b.data.id) q = supabase.from('notifiche').update({ letta_il: new Date().toISOString() }).eq('id', b.data.id).eq('utente_id', auth.user.id)
    const { error } = await q
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    logErrore({ operazione: 'notifiche:PATCH', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
