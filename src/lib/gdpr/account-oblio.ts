import type { SupabaseClient } from '@supabase/supabase-js'
import { placeholderFor } from '@/lib/gdpr/anonimizza'
import { schemaAssente } from '@/lib/news/schema-assente'
import { normalizzaRuolo, RUOLO_GENITORE } from '@/lib/auth/staff-identity'
import { logEvento, type Livello, type Valore } from '@/lib/logging/logger'

// =============================================================================
// L'ACCOUNT DI UN GENITORE DOPO L'OBLIO DELLA SUA SCHEDA.
//
// IL DIFETTO, misurato in produzione il 2026-09-02. Un oblio ha anonimizzato una
// scheda `parents` — nome a `CANCELLATO-…`, `auth_user_id` a NULL, domanda
// d'iscrizione svuotata — e si è fermato lì: `anonimizzaParent` non toccava né
// `utenti` né `auth.users`. Sono sopravvissuti l'email, il nome, `ruolo =
// 'genitore'` e il legame in `legame_genitori_alunni` verso il bambino già
// anonimizzato. Due danni, e il secondo non era nemmeno di privacy:
//  1. l'«oblio» ha lasciato l'identità della persona;
//  2. quella stessa email era di una dipendente, e approvare la sua pratica del
//     personale rispondeva 409 `email_gia_genitore` (`staff-identity.ts`): la
//     scuola trovava in `utenti` un «genitore» con quell'indirizzo, cioè una
//     persona che per l'oblio non esisteva più.
//
// ─── QUANDO SI TOCCA, E QUANDO NO ───────────────────────────────────────────
//
// L'account è un oggetto DIVERSO dalla scheda: può servire ad altro. Si libera
// soltanto se tutte e tre queste cose sono vere, e verificate con una lettura
// riuscita — non sapere è motivo per fermarsi:
//  · `utenti.ruolo`, normalizzato come in `staff-identity`, è `genitore`. Un
//    account del PERSONALE che è anche genitore (quattro insegnanti in produzione
//    hanno insieme il ruolo di staff e il ponte `parents.auth_user_id`) resta;
//  · nessun legame runtime verso un alunno NON anonimizzato: quell'account è
//    ancora l'accesso di una famiglia a un bambino che c'è;
//  · nessun'altra scheda `parents` viva con lo stesso `auth_user_id`.
//
// ─── COME SI LIBERA ─────────────────────────────────────────────────────────
//
// Prima si tolgono i legami residui (verso alunni tutti anonimizzati: la FK di
// `legame_genitori_alunni.genitore_id` è NO ACTION e bloccherebbe la cascata),
// poi `auth.admin.deleteUser`, e la riga `utenti` se ne va in CASCADE.
//
// Se la cancellazione non si può fare — un riferimento NO ACTION verso `utenti`
// (`firme_documenti`, `presenze.utente_id`, `pagamenti_quote.adult_id`,
// `mensa_prenotazioni.prenotato_da`…) la fa rifiutare a Postgres — si ANONIMIZZA:
// email non instradabile e unica, nome e cognome col segnaposto della scheda,
// account disattivato e bandito, metadati svuotati. L'email della persona esce
// da entrambe le tabelle, ed è ciò che serve a tutti e due i danni.
//
// ⚠️ UNA CANCELLAZIONE CHE NON SI TENTA NEMMENO: L'ACCOUNT CHE HA CONVERSAZIONI.
// `chat_threads.parent_id` e `chat_messages.sender_id` sono ON DELETE CASCADE
// verso `utenti`: cancellare l'account porterebbe via l'intera conversazione,
// COMPRESI i messaggi dell'insegnante. `obliaAllegatiChat` (`esegui.ts`) dice il
// contrario per iscritto — «Il messaggio resta: una conversazione è di due
// persone» — e c'è una seconda ragione, più dura: gli allegati che non sono
// usciti dal bucket perderebbero l'unica riga che li nomina, cioè il guasto
// INVISIBILE che quel file esiste per evitare. Con thread presenti, o non letti,
// si anonimizza. È la scelta reversibile: se il titolare decide che la
// conversazione va cancellata, basta togliere questa condizione.
// La stessa regola vale per `avvisi_risposte.parent_id`, anch'essa CASCADE: le
// risposte agli avvisi (autorizzazioni, prese visione) l'oblio non le tocca, e
// una cancellazione dell'account non deve distruggerle di nascosto.
//
// ─── E SE FALLISCE? ─────────────────────────────────────────────────────────
//
// Non si lancia e non si ferma l'oblio: come ogni altro passo di `anonimizzaParent`
// si logga e si prosegue — la scheda è già anonimizzata, e interrompere a metà
// non la rimetterebbe in chiaro. Ma il fallimento NON è silenzioso: l'esito torna
// al chiamante (`non-deciso` / `non-riuscito`), e le due route dell'oblio lo
// contano in `account_non_liberati` facendo scattare `oblio-parziale`. Un oblio
// che lascia email e nome di una persona non si può chiamare «eseguito».
//
// Nei log solo uuid: né l'email vecchia né quella anonima, né il nome.
// =============================================================================

/**
 * Che ne è stato dell'account di accesso (`utenti` + `auth.users`) del genitore.
 *
 *  · `assente`                   — la scheda non aveva un account;
 *  · `rimosso`                   — `deleteUser` riuscito, `utenti` via in cascata;
 *  · `anonimizzato`              — cancellazione non fatta o rifiutata, ripiego riuscito;
 *  · `non-toccato-personale`     — l'account ha un ruolo del personale;
 *  · `non-toccato-figli-vivi`    — legame con un alunno vivo, o altra scheda viva;
 *  · `non-toccato-senza-profilo` — nessuna riga `utenti`: il ruolo non si può verificare;
 *  · `non-deciso`                — una lettura della decisione è fallita;
 *  · `non-riuscito`              — né cancellazione né ripiego sono riusciti.
 *
 * Gli ultimi due sono gli unici che rendono PARZIALE l'oblio: gli altri sono
 * decisioni prese su dati letti.
 */
export type EsitoAccountOblio =
  | 'assente'
  | 'rimosso'
  | 'anonimizzato'
  | 'non-toccato-personale'
  | 'non-toccato-figli-vivi'
  | 'non-toccato-senza-profilo'
  | 'non-deciso'
  | 'non-riuscito'

/**
 * Cento anni, nel formato che GoTrue accetta (`time.ParseDuration` di Go: le ore
 * sono l'unità più grande, i giorni non esistono).
 */
export const BAN_ACCOUNT_OBLIO = '876000h'

/**
 * L'email di un account anonimizzato: unica (porta l'uuid, e `utenti.email` è
 * UNIQUE come `auth.users.email`) e non instradabile — `.invalid` è riservato
 * dall'RFC 2606, nessuna posta partirà mai verso quell'indirizzo.
 */
export function emailAccountOblio(authUserId: string): string {
  return `oblio-${authUserId}@invalid.invalid`
}

export interface ContestoAccountOblio {
  parentId: string
  /** L'`auth_user_id` letto PRIMA di `patchParent`, che lo azzera. */
  authUserId: string | null
  /** `false` quando la patch della scheda non è passata: la persona è ancora in chiaro. */
  schedaAnonimizzata: boolean
  /** Quanti thread di chat ha l'account (`chat_threads.parent_id`); `null` = non letti. */
  threadChat: number | null
}

/** Gli esiti delle righe di log: scritti per esteso, così si ritrovano con una ricerca. */
type EsitoLog =
  | 'account-rimosso'
  | 'account-anonimizzato'
  | 'account-cancellazione-rifiutata'
  | 'account-legami-non-sciolti'
  | 'account-risposte-avvisi-non-lette'
  | 'account-non-toccato-personale'
  | 'account-non-toccato-figli-vivi'
  | 'account-non-toccato-senza-profilo'
  | 'account-non-deciso'
  | 'account-non-riuscito'

/**
 * Una riga per account: `distingui` mette l'uuid nell'impronta, altrimenti due
 * genitori dello stesso oblio finirebbero sommati in UNA riga di `app_log` col
 * contesto del primo. Il volume è quello dell'oblio, cioè poche righe l'anno.
 */
function registra(
  op: string,
  livello: Livello,
  esito: EsitoLog,
  utente: string,
  extra: Record<string, Valore> = {},
  errore?: unknown,
): void {
  logEvento(
    'gdpr',
    livello,
    { operazione: op, esito, entita_tipo: 'utenti', utente, ...extra },
    errore,
    { distingui: ['utente'] },
  )
}

/** Una lettura della decisione non è riuscita: non si tocca niente, e si dice. */
function nonDeciso(op: string, utente: string, tipo: string, errore: unknown): EsitoAccountOblio {
  // Lo schema assente (DB E2E della CI non migrato) non è un guasto: là l'account
  // resta com'è per la stessa ragione, ma la riga non deve sporcare il canale degli errori.
  registra(op, schemaAssente(errore) ? 'info' : 'error', 'account-non-deciso', utente, { tipo }, errore)
  return 'non-deciso'
}

/**
 * Libera l'account del genitore la cui scheda è appena stata anonimizzata.
 *
 * Non lancia MAI: ogni esito è un valore, e ogni ramo — il successo compreso —
 * lascia la sua riga di log.
 */
export async function liberaAccountGenitore(
  supabase: SupabaseClient,
  contesto: ContestoAccountOblio,
  op: string,
): Promise<EsitoAccountOblio> {
  const { parentId, authUserId } = contesto
  if (!authUserId) {
    // Anche «niente da liberare» si scrive: senza, «nessuna riga» non distingue
    // una scheda senza account da un passo che non è mai partito.
    logEvento(
      'gdpr',
      'info',
      { operazione: op, esito: 'account-assente', entita_tipo: 'parents', entita_id: parentId },
      undefined,
      { distingui: ['entita_id'] },
    )
    return 'assente'
  }
  try {
    return await decidiELibera(supabase, contesto, authUserId, op)
  } catch (e) {
    registra(op, 'error', 'account-non-riuscito', authUserId, { tipo: 'eccezione' }, e)
    return 'non-riuscito'
  }
}

async function decidiELibera(
  supabase: SupabaseClient,
  contesto: ContestoAccountOblio,
  authUserId: string,
  op: string,
): Promise<EsitoAccountOblio> {
  // 0. LA SCHEDA DEV'ESSERE ANONIMIZZATA DAVVERO. Se la patch non è passata la
  //    persona è ancora in chiaro in anagrafica, e l'account è ancora il suo
  //    accesso: toglierlo ora vorrebbe dire staccare il ponte (`parents.auth_user_id`
  //    è ON DELETE SET NULL) a una scheda che nessuno ha ripulito. L'errore della
  //    patch l'ha già scritto `anonimizzaParent`; qui si dichiara la conseguenza.
  if (!contesto.schedaAnonimizzata) {
    registra(op, 'error', 'account-non-riuscito', authUserId, { tipo: 'scheda-non-anonimizzata' })
    return 'non-riuscito'
  }

  // 1. IL RUOLO. PostgREST non lancia: l'errore torna nel valore.
  const { data: profilo, error: errProfilo } = await supabase
    .from('utenti')
    .select('id, ruolo')
    .eq('id', authUserId)
    .maybeSingle()
  if (errProfilo) return nonDeciso(op, authUserId, 'profilo-non-letto', errProfilo)
  if (!profilo) {
    // Un account senza profilo applicativo non ha un ruolo leggibile: potrebbe non
    // essere di un genitore, e non lo si indovina. `warn` perché in `auth.users`
    // può essere rimasta l'email, e qualcuno deve poterlo ritrovare.
    registra(op, 'warn', 'account-non-toccato-senza-profilo', authUserId)
    return 'non-toccato-senza-profilo'
  }
  const ruolo = normalizzaRuolo((profilo as { ruolo?: unknown }).ruolo)
  if (ruolo !== RUOLO_GENITORE) {
    registra(op, 'info', 'account-non-toccato-personale', authUserId, { ruolo: ruolo || null })
    return 'non-toccato-personale'
  }

  // 2. I FIGLI VIVI SULL'ACCOUNT. «Vivo» è tutto ciò che non risulta anonimizzato:
  //    un alunno che la lettura non restituisce resta vivo, non si presume sparito.
  const { data: legami, error: errLegami } = await supabase
    .from('legame_genitori_alunni')
    .select('alunno_id')
    .eq('genitore_id', authUserId)
  if (errLegami) return nonDeciso(op, authUserId, 'legami-non-letti', errLegami)
  const alunnoIds = [
    ...new Set(
      ((legami ?? []) as { alunno_id?: unknown }[])
        .map((l) => l.alunno_id)
        .filter((v): v is string => typeof v === 'string' && v !== ''),
    ),
  ]
  if (alunnoIds.length > 0) {
    const { data: figli, error: errFigli } = await supabase
      .from('alunni')
      .select('id, anonimizzato_il')
      .in('id', alunnoIds)
    if (errFigli) return nonDeciso(op, authUserId, 'figli-non-letti', errFigli)
    const anonimizzati = new Set(
      ((figli ?? []) as { id?: unknown; anonimizzato_il?: unknown }[])
        .filter((f) => typeof f.id === 'string' && Boolean(f.anonimizzato_il))
        .map((f) => f.id as string),
    )
    const vivi = alunnoIds.filter((id) => !anonimizzati.has(id))
    if (vivi.length > 0) {
      registra(op, 'info', 'account-non-toccato-figli-vivi', authUserId, {
        tipo: 'legame-alunno-vivo',
        n: vivi.length,
      })
      return 'non-toccato-figli-vivi'
    }
  }

  // 3. UN'ALTRA SCHEDA VIVA SULLO STESSO ACCOUNT. La scheda appena anonimizzata ha
  //    già `auth_user_id` a NULL; l'esclusione per id resta come difesa.
  const { data: schede, error: errSchede } = await supabase
    .from('parents')
    .select('id')
    .eq('auth_user_id', authUserId)
    .is('anonimizzato_il', null)
  if (errSchede) return nonDeciso(op, authUserId, 'schede-non-lette', errSchede)
  const altre = ((schede ?? []) as { id?: unknown }[]).filter((s) => s.id !== contesto.parentId)
  if (altre.length > 0) {
    registra(op, 'info', 'account-non-toccato-figli-vivi', authUserId, {
      tipo: 'altra-scheda-viva',
      n: altre.length,
    })
    return 'non-toccato-figli-vivi'
  }

  // 4. I LEGAMI RESIDUI, verso alunni tutti anonimizzati: non servono a nessuno e,
  //    finché ci sono, la FK NO ACTION fa rifiutare la cascata. Si tolgono SOLO
  //    quelli verificati qui sopra, non «tutti quelli dell'account».
  let motivo: string | null = null
  // Quanti ne sono stati sciolti davvero: finisce nella riga d'esito, perché il
  // legame verso il bambino anonimizzato era uno dei resti dell'incidente.
  let legamiSciolti = 0
  if (alunnoIds.length > 0) {
    const { error: errSciogli } = await supabase
      .from('legame_genitori_alunni')
      .delete()
      .eq('genitore_id', authUserId)
      .in('alunno_id', alunnoIds)
    if (errSciogli) {
      // Con i legami in piedi la cancellazione fallirebbe di sicuro: non la si
      // tenta, si anonimizza. I legami puntano a bambini già anonimizzati.
      registra(op, 'warn', 'account-legami-non-sciolti', authUserId, { n: alunnoIds.length }, errSciogli)
      motivo = 'legami-non-rimossi'
    } else {
      legamiSciolti = alunnoIds.length
    }
  }

  // 5. LE CONVERSAZIONI: vedi il ⚠️ in testa al file.
  if (!motivo && contesto.threadChat === null) motivo = 'conversazioni-non-lette'
  if (!motivo && (contesto.threadChat ?? 0) > 0) motivo = 'conversazioni-da-conservare'

  // 5-bis. LE RISPOSTE AGLI AVVISI. `avvisi_risposte.parent_id` è ON DELETE CASCADE
  //    verso `utenti`, e l'oblio quelle righe NON le tocca: sono atti del genitore
  //    (autorizzazioni, prese visione) che il resto del modello conserva. Stessa
  //    regola delle conversazioni: presenti, o non lette, → si anonimizza.
  if (!motivo) {
    const { data: risposte, error: errRisposte } = await supabase
      .from('avvisi_risposte')
      .select('id')
      .eq('parent_id', authUserId)
      .limit(1)
    if (errRisposte) {
      registra(op, 'warn', 'account-risposte-avvisi-non-lette', authUserId, {}, errRisposte)
      motivo = 'risposte-avvisi-non-lette'
    } else if ((risposte ?? []).length > 0) {
      motivo = 'risposte-avvisi-da-conservare'
    }
  }

  // 6. LA CANCELLAZIONE.
  if (!motivo) {
    let rifiuto: unknown = null
    try {
      const { error } = await supabase.auth.admin.deleteUser(authUserId)
      rifiuto = error ?? null
    } catch (e) {
      rifiuto = e ?? new Error('deleteUser: eccezione senza dettaglio')
    }
    if (!rifiuto) {
      registra(op, 'info', 'account-rimosso', authUserId, { n_legami: legamiSciolti })
      return 'rimosso'
    }
    // Il corpo del rifiuto è ciò che dice QUALE riferimento ha bloccato la cascata:
    // `500` da solo non direbbe niente. `info` e non `error`: per un genitore che ha
    // firmato, prenotato o pagato è l'esito normale, e il ripiego c'è apposta.
    registra(op, 'info', 'account-cancellazione-rifiutata', authUserId, {}, rifiuto)
    motivo = 'cancellazione-rifiutata'
  }

  // 7. IL RIPIEGO.
  return anonimizzaAccount(supabase, contesto, authUserId, op, motivo, legamiSciolti)
}

/**
 * Anonimizza l'account che non si è potuto (o voluto) cancellare. Ogni scrittura
 * si tenta anche se la precedente è fallita: meno dati restano, meglio è. Ma basta
 * un fallimento perché l'esito sia `non-riuscito`.
 */
async function anonimizzaAccount(
  supabase: SupabaseClient,
  contesto: ContestoAccountOblio,
  authUserId: string,
  op: string,
  motivo: string,
  legamiSciolti: number,
): Promise<EsitoAccountOblio> {
  const email = emailAccountOblio(authUserId)
  // Lo stesso segnaposto della scheda (`patchParent`): chi rilegge una chat con
  // quell'account vede lo stesso `CANCELLATO-…` che trova in anagrafica.
  const segnaposto = placeholderFor(contesto.parentId)
  let riuscito = true

  // 7a. I METADATI. GoTrue li FONDE: `{}` non toglie niente, e per cancellare una
  //     chiave va scritta a `null`. Quali chiavi ci siano si sa solo leggendo —
  //     GoTrue ci mette da sé `email`, cioè l'indirizzo che si sta togliendo.
  const metadati: Record<string, null> = {}
  try {
    const letto = await supabase.auth.admin.getUserById(authUserId)
    if (letto.error || !letto.data?.user) {
      riuscito = false
      registra(op, 'error', 'account-non-riuscito', authUserId, { tipo: 'metadati-non-letti' },
        letto.error ?? new Error('getUserById: nessun utente restituito'))
    } else {
      for (const chiave of Object.keys(letto.data.user.user_metadata ?? {})) metadati[chiave] = null
    }
  } catch (e) {
    riuscito = false
    registra(op, 'error', 'account-non-riuscito', authUserId, { tipo: 'metadati-non-letti' }, e)
  }

  // 7b. L'ACCESSO, prima del profilo: `auth.users` è la fonte del login, e un guasto
  //     a metà deve lasciare chiusa la porta, non una riga ripulita davanti a una
  //     porta aperta. `email_confirm` insieme all'indirizzo: senza, GoTrue mette il
  //     nuovo in attesa di conferma e TIENE il vecchio.
  try {
    const { error } = await supabase.auth.admin.updateUserById(authUserId, {
      email,
      email_confirm: true,
      ban_duration: BAN_ACCOUNT_OBLIO,
      ...(Object.keys(metadati).length > 0 ? { user_metadata: metadati } : {}),
    })
    if (error) {
      riuscito = false
      registra(op, 'error', 'account-non-riuscito', authUserId, { tipo: 'accesso-non-anonimizzato' }, error)
    }
  } catch (e) {
    riuscito = false
    registra(op, 'error', 'account-non-riuscito', authUserId, { tipo: 'accesso-non-anonimizzato' }, e)
  }

  // 7c. IL PROFILO APPLICATIVO. Mai `role`/`first_name`/`last_name`: sono colonne
  //     GENERATE, e `ruolo` non si tocca — resta scritto chi era, non chi è.
  const { error: errProfilo } = await supabase
    .from('utenti')
    .update({ email, nome: segnaposto, cognome: segnaposto, cellulare: null, attivo: false })
    .eq('id', authUserId)
  if (errProfilo) {
    riuscito = false
    registra(op, 'error', 'account-non-riuscito', authUserId, { tipo: 'profilo-non-anonimizzato' }, errProfilo)
  }

  if (!riuscito) return 'non-riuscito'
  registra(op, 'info', 'account-anonimizzato', authUserId, { tipo: motivo, n_legami: legamiSciolti })
  return 'anonimizzato'
}

/**
 * Il riepilogo che le route dell'oblio mettono nella risposta e nell'audit.
 *
 * Conta solo ciò che è SUCCESSO all'account: le scelte deliberate (personale,
 * figli vivi, profilo assente) e l'assenza di un account non sono né liberazioni
 * né fallimenti. Un esito mancante — un chiamante che non lo conosce ancora — non
 * conta niente.
 */
export function contaAccountOblio(
  esiti: readonly (EsitoAccountOblio | null | undefined)[],
): { rimossi: number; anonimizzati: number; nonLiberati: number } {
  let rimossi = 0
  let anonimizzati = 0
  let nonLiberati = 0
  for (const esito of esiti) {
    if (esito === 'rimosso') rimossi++
    else if (esito === 'anonimizzato') anonimizzati++
    else if (esito === 'non-deciso' || esito === 'non-riuscito') nonLiberati++
  }
  return { rimossi, anonimizzati, nonLiberati }
}
