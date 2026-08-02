import type { SupabaseClient } from '@supabase/supabase-js'
import { sendPush } from '@/lib/push/web-push'
import { getGenitoriDiAlunno } from '@/lib/anagrafiche/legami'
import { allergeneLabel, type ConflittoAllergia } from '@/lib/mensa/allergeni'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import { staffScuola } from '@/lib/notifiche/destinatari'
import { isNotificaAbilitata } from '@/lib/notifiche/config'
import { logEvento } from '@/lib/logging/logger'
import { formattaIstante } from '@/i18n/config'

const PORTATA_LABEL: Record<string, string> = { primo: 'primo', secondo: 'secondo', contorno: 'contorno', frutta: 'frutta' }

// Invia una notifica in-app a una lista di utenti e prova il push immediato.
// Best-effort: gli errori non bloccano il chiamante.
async function inviaNotifiche(
  supabase: SupabaseClient,
  utenti: string[],
  n: { tipo: string; titolo: string; corpo: string; link: string; entita_tipo?: string; entita_id?: string }
): Promise<void> {
  if (utenti.length === 0) return
  const { error } = await supabase.from('notifiche').insert(
    utenti.map(u => ({
      utente_id: u, tipo: n.tipo, titolo: n.titolo, corpo: n.corpo, link: n.link,
      entita_tipo: n.entita_tipo ?? null, entita_id: n.entita_id ?? null,
    }))
  )
  // PostgREST non lancia: ritorna `{ error }`. Senza questo controllo l'insert
  // poteva fallire e la funzione proseguiva verso il push come se nulla fosse —
  // e il chiamante rispondeva comunque «inviata».
  if (error) {
    logEvento('mensa', 'error', {
      operazione: 'mensa/notify:inviaNotifiche',
      esito: 'notifiche-non-inserite',
      tipo: n.tipo,
      n: utenti.length,
    }, error)
  }
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth, utente_id')
    .in('utente_id', utenti)
  for (const s of subs ?? []) {
    const res = await sendPush(
      { endpoint: s.endpoint as string, p256dh: s.p256dh as string, auth: s.auth as string },
      { title: n.titolo, body: n.corpo, url: n.link, tag: n.tipo }
    )
    if (res.gone) await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
  }
}

// Destinatari dell'alert allergie: segreteria (admin/coordinator) + cuoca della
// scuola SEMPRE, più gli insegnanti DELLA SEZIONE del bambino (via utenti_sezioni).
// Se la sezione non ha docenti mappati, fallback a tutti gli insegnanti della
// scuola (su un alert di sicurezza è preferibile sovra-notificare che mancare).
//
// L'APPARTENENZA A UNA SEDE NON È `utenti.scuola_id`: è l'unione fra quella
// colonna e il ponte `utenti_scuole` — la stessa definizione che usa
// `scuoleDiUtente` per decidere su quali plessi una persona può operare. Qui
// c'era una `.eq('scuola_id', …)` nuda, e per le sedi aperte il 2026-07-29
// (dove nessuno ha ancora quel plesso come primario) la lista usciva VUOTA:
// nessuno riceveva l'alert allergie. Da qui in poi passa da `staffScuola`, che
// il ponte lo guarda ed è l'unico posto del repo autorizzato a quella query.
export async function destinatariAllerta(supabase: SupabaseClient, scuolaId: string, sectionId?: string | null): Promise<string[]> {
  const ruoliSegreteriaCuoca = ['admin', 'coordinator', 'segreteria', 'cuoca']
  const ruoliInsegnanti = ['educator', 'maestra']

  const out = new Set<string>(await staffScuola(supabase, scuolaId, ruoliSegreteriaCuoca))
  const insegnantiScuola = new Set<string>(await staffScuola(supabase, scuolaId, ruoliInsegnanti))

  // insegnanti scoped alla sezione del bambino
  const docentiSezione = (await docentiDiSezione(supabase, sectionId)).filter(id => insegnantiScuola.has(id))
  if (docentiSezione.length > 0) {
    for (const id of docentiSezione) out.add(id)
  } else {
    // nessun docente mappato sulla sezione → notifica tutti gli insegnanti
    for (const id of insegnantiScuola) out.add(id)
  }
  return [...out]
}

// Alert ALLERGIA: il menu di `data` contiene allergeni dichiarati dall'alunno.
// Notifica segreteria + cuoca + insegnanti. Idempotente per (alunno, data):
// se l'alert per quella combinazione esiste già, non viene re-inviato.
export async function notificaAllergie(
  supabase: SupabaseClient,
  opts: { alunnoId: string; nomeAlunno: string; classeSezione?: string | null; sezioneId?: string | null; scuolaId: string; data: string; conflitti: ConflittoAllergia[] }
): Promise<{ inviata: boolean }> {
  try {
    if (opts.conflitti.length === 0) return { inviata: false }
    if (!(await isNotificaAbilitata(supabase, 'mensa_allergia', opts.scuolaId))) return { inviata: false }
    const link = `/admin/mensa/cucina?data=${opts.data}`

    // dedup: già notificato per questo alunno + questa data?
    const { data: gia } = await supabase
      .from('notifiche')
      .select('id')
      .eq('tipo', 'mensa_allergia')
      .eq('entita_id', opts.alunnoId)
      .eq('link', link)
      .limit(1)
    if (gia && gia.length > 0) return { inviata: false }

    const dettaglio = opts.conflitti
      .map(c => `${allergeneLabel(c.allergene)} (${c.portate.map(p => PORTATA_LABEL[p] ?? p).join(', ')})`)
      .join('; ')
    // `opts.data` è una colonna `date`: un GIORNO di calendario, non un istante.
    // Si àncora a UTC e si formatta in UTC — così non può slittare col fuso del
    // processo (Vercel gira in UTC, la cucina è a Giugliano). Il locale è `'it'`
    // di proposito: il corpo della notifica è un DATO, non interfaccia tradotta.
    const dataLeggibile = formattaIstante(new Date(`${opts.data}T00:00:00Z`), 'it', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    const sez = opts.classeSezione ? ` (${opts.classeSezione})` : ''
    const titolo = '⚠️ Allergia nel menu mensa'
    const corpo = `${opts.nomeAlunno}${sez}: il menu di ${dataLeggibile} contiene allergeni a cui è sensibile → ${dettaglio}. Verificare in cucina.`

    const utenti = await destinatariAllerta(supabase, opts.scuolaId, opts.sezioneId)
    if (utenti.length === 0) {
      // `error`, e non `warn`: questo è un alert di SICUREZZA (un allergene nel
      // piatto di un bambino). «Composto e mai recapitato» non può essere
      // indistinguibile da «recapitato»: il cron delle 07:00 contava l'alert fra
      // gli inviati e chiudeva il battito con «ok». Nessun nome nel log — il
      // corpo dell'alert contiene nome e allergeni del minore, i log no.
      logEvento('mensa', 'error', {
        operazione: 'notificaAllergie',
        esito: 'nessun-destinatario',
        sede_id: opts.scuolaId,
      })
      return { inviata: false }
    }
    await inviaNotifiche(supabase, utenti, {
      tipo: 'mensa_allergia', titolo, corpo, link, entita_tipo: 'alunno', entita_id: opts.alunnoId,
    })
    return { inviata: true }
  } catch (err) {
    // Best-effort: non blocca lo scalo ticket. Via logger (mai console.*): la
    // redazione a lista bianca protegge eventuali dati del minore nell'errore.
    logEvento('mensa', 'error', { operazione: 'notificaAllergie', esito: 'alert-allergie-non-inviato' }, err)
    return { inviata: false }
  }
}

// Notifica al genitore che il saldo ticket mensa è sceso sotto la soglia.
// Crea una riga in `notifiche` (feed in-app realtime) e prova l'invio push a
// tutte le subscription del genitore. Best-effort: errori non bloccano lo scalo.
export async function notificaSaldoBasso(
  supabase: SupabaseClient,
  opts: { alunnoId: string; saldo: number; nomeAlunno?: string | null }
): Promise<void> {
  try {
    // Gate toggle: scuola risolta dall'alunno (best-effort, fail-open).
    const { data: alunno } = await supabase.from('alunni').select('scuola_id').eq('id', opts.alunnoId).maybeSingle()
    if (!(await isNotificaAbilitata(supabase, 'mensa_saldo_basso', (alunno?.scuola_id as string | undefined) ?? null))) return

    // genitori legati all'alunno — unione runtime (`legame_genitori_alunni`) +
    // anagrafica (`student_parents` via ponte `parents.auth_user_id`): con la
    // sola runtime il tutore di un bambino importato dal form pubblico non
    // riceveva MAI l'avviso di saldo mensa in esaurimento.
    const genitori = await getGenitoriDiAlunno(supabase, opts.alunnoId)
    if (genitori.length === 0) return

    const titolo = 'Saldo mensa in esaurimento'
    const corpo = `Il saldo ticket mensa${opts.nomeAlunno ? ` di ${opts.nomeAlunno}` : ''} è sceso a ${opts.saldo}. Contatta la segreteria per ricaricare.`
    const link = '/parent/mensa'

    await supabase.from('notifiche').insert(
      genitori.map(g => ({
        utente_id: g,
        tipo: 'mensa_saldo_basso',
        titolo,
        corpo,
        link,
        entita_tipo: 'alunno',
        entita_id: opts.alunnoId,
      }))
    )

    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .in('utente_id', genitori)
    for (const s of subs ?? []) {
      const res = await sendPush(
        { endpoint: s.endpoint as string, p256dh: s.p256dh as string, auth: s.auth as string },
        { title: titolo, body: corpo, url: link, tag: 'mensa-saldo' }
      )
      if (res.gone) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
      }
    }
  } catch (err) {
    // Best-effort: non blocca lo scalo ticket. Via logger (mai console.*).
    logEvento('mensa', 'error', { operazione: 'notificaSaldoBasso', esito: 'notifica-saldo-basso-non-inviata' }, err)
  }
}
