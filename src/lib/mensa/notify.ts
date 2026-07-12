import type { SupabaseClient } from '@supabase/supabase-js'
import { sendPush } from '@/lib/push/web-push'
import { allergeneLabel, type ConflittoAllergia } from '@/lib/mensa/allergeni'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import { isNotificaAbilitata } from '@/lib/notifiche/config'

const PORTATA_LABEL: Record<string, string> = { primo: 'primo', secondo: 'secondo', contorno: 'contorno', frutta: 'frutta' }

// Invia una notifica in-app a una lista di utenti e prova il push immediato.
// Best-effort: gli errori non bloccano il chiamante.
async function inviaNotifiche(
  supabase: SupabaseClient,
  utenti: string[],
  n: { tipo: string; titolo: string; corpo: string; link: string; entita_tipo?: string; entita_id?: string }
): Promise<void> {
  if (utenti.length === 0) return
  await supabase.from('notifiche').insert(
    utenti.map(u => ({
      utente_id: u, tipo: n.tipo, titolo: n.titolo, corpo: n.corpo, link: n.link,
      entita_tipo: n.entita_tipo ?? null, entita_id: n.entita_id ?? null,
    }))
  )
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
async function destinatariAllerta(supabase: SupabaseClient, scuolaId: string, sectionId?: string | null): Promise<string[]> {
  const ruoliSegreteriaCuoca = new Set(['admin', 'coordinator', 'cuoca'])
  const ruoliInsegnanti = new Set(['educator', 'maestra'])
  const { data } = await supabase
    .from('utenti')
    .select('id, role, ruolo, scuola_id')
    .eq('scuola_id', scuolaId)

  const out = new Set<string>()
  const insegnantiScuola = new Set<string>()
  for (const u of data ?? []) {
    const r = String((u.role as string) || (u.ruolo as string) || '')
    if (ruoliSegreteriaCuoca.has(r)) out.add(u.id as string)
    if (ruoliInsegnanti.has(r)) insegnantiScuola.add(u.id as string)
  }

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
    const dataLeggibile = new Date(`${opts.data}T00:00:00Z`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })
    const sez = opts.classeSezione ? ` (${opts.classeSezione})` : ''
    const titolo = '⚠️ Allergia nel menu mensa'
    const corpo = `${opts.nomeAlunno}${sez}: il menu di ${dataLeggibile} contiene allergeni a cui è sensibile → ${dettaglio}. Verificare in cucina.`

    const utenti = await destinatariAllerta(supabase, opts.scuolaId, opts.sezioneId)
    await inviaNotifiche(supabase, utenti, {
      tipo: 'mensa_allergia', titolo, corpo, link, entita_tipo: 'alunno', entita_id: opts.alunnoId,
    })
    return { inviata: true }
  } catch (err) {
    console.error('notificaAllergie (best-effort) fallita:', err)
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

    // genitori legati all'alunno
    const { data: legami } = await supabase
      .from('legame_genitori_alunni')
      .select('genitore_id')
      .eq('alunno_id', opts.alunnoId)
    const genitori = (legami ?? []).map(l => l.genitore_id as string)
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
    console.error('notificaSaldoBasso (best-effort) fallita:', err)
  }
}
