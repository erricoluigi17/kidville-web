// =============================================================================
// I CANCELLI DEI DESTINATARI DI UN CONTENUTO DI GALLERIA — in UN posto solo.
//
// PERCHÉ ESISTE (PR 2 video, 2026-10-02).
// Fino a oggi le quattro regole che decidono «a chi può andare questo contenuto»
// stavano scritte dentro l'handler `POST /api/gallery`:
//
//   1. il broadcast è riservato alla Direzione (admin/coordinatore);
//   2. un broadcast non può taggare bambini (vale a tutta la classe o a tutta la sede);
//   3. i bambini taggati devono essere della SEDE del contenuto (`./tag-scope`);
//   4. il Privacy Lock (DL-041): in un gruppo ogni bambino deve avere la liberatoria
//      fotografica (`./privacy`).
//
// Ora il video sceglie i bambini PRIMA dell'invio (`POST /api/video-uploads`) e deve
// attraversare gli stessi quattro cancelli, con lo stesso 422 che nomina i bambini.
// Una seconda copia delle quattro regole sarebbe la seconda occasione di correggerne
// una e dimenticare l'altra: il gate dei tag, scritto una volta dentro la POST,
// lasciò scoperto il PATCH per tre giorni (vedi la testata di `./tag-scope`). Quindi
// una funzione sola, chiamata dalle due strade che CREANO un contenuto con dei
// destinatari: la POST delle foto e la POST dei video.
//
// (Il PATCH di `/api/gallery` non passa di qui, e non per dimenticanza: valuta i tag e il
// broadcast EFFETTIVI — quelli già sul media più quelli del body — e ha frasi sue per il
// 403 e il 400 del broadcast. Lo scope dei tag e il Privacy Lock li condivide già, perché
// vivono nei loro moduli: `./tag-scope` e `./privacy`.)
//
// ─── DUE METÀ, E L'ORDINE È QUELLO STORICO DELLA ROTTA ──────────────────────────
// I primi due cancelli non toccano il database e non conoscono la sede: rifiutano
// PRIMA di qualunque lettura, ed è così che `POST /api/gallery` ha sempre risposto
// (un educatore che tenta un broadcast prende 403 anche se la sede è ambigua).
// Gli altri due hanno bisogno della sede già risolta. Per questo le due metà si
// esportano anche separatamente: la POST della galleria le chiama una prima e una
// dopo `resolveScuolaScrittura`; chi ha già la sede (la POST dei video) chiama
// `cancelliDestinatariGalleria`, che le concatena.
//
// ─── LE RISPOSTE SONO QUELLE DI SEMPRE, E NON PORTANO UN `codice` ────────────────
// Status, chiavi del corpo e testi sono identici a quelli che `POST /api/gallery`
// rispondeva prima di questo modulo: un client che le legge oggi le legge uguali.
// Un `codice` ce l'hanno solo i rifiuti dei tag nella sede (`TAG_FUORI_SEDE`,
// `TAG_ALUNNO_NON_ISCRITTO`, `VERIFICA_TAG_NON_RIUSCITA`), e li costruisce
// `assertTagStudentsInScope`: qui passano com'erano.
//
// ⚠️ DEBITO DICHIARATO, non pagato. Le tre risposte qui sotto (broadcast non
// consentito, broadcast con tag, liberatoria mancante) restano senza `codice`: darglielo
// vuol dire dichiararlo in `CODICI_ERRORE` e nei due cataloghi, ed è un cambio di
// contratto (nuove chiavi nel corpo) che non spetta a una funzione estratta. Il corpo è
// una costante e non un letterale dentro `NextResponse.json({...})`: il lock
// `errori-con-codice` conta solo i letterali, quindi lo spostamento ha fatto scendere
// il numero di `gallery/route.ts` senza che il debito sia stato pagato. Chi lo paga
// aggiunge qui il `codice` e toglie questo paragrafo.
//
// MAI i nomi dei bambini nei log: il 422 li porta al client dell'insegnante, e
// basta. Nel log passano solo conteggi.
// =============================================================================

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

import { RUOLI_DIREZIONE } from '@/lib/auth/predicati-ruolo'
import { logEvento } from '@/lib/logging/logger'

import { alunniSenzaConsenso } from './privacy'
import { assertTagStudentsInScope, type OperazioneGalleria } from './tag-scope'

/**
 * La route che sta chiedendo il cancello: finisce nei log, mai nella risposta.
 *
 * `OperazioneGalleria` (`./tag-scope`) elenca solo le due route della galleria. Il
 * valore serve soltanto a etichettare le righe di log: chi aggiunge una strada
 * nuova la aggiunge qui.
 */
export type OperazioneCancelli = OperazioneGalleria | 'video-uploads:POST'

/** Quale dei quattro cancelli ha rifiutato: serve a chi logga o prova, mai al client. */
export type CancelloGalleria =
  | 'broadcast-non-consentito'
  | 'broadcast-con-tag'
  | 'tag-in-sede'
  | 'liberatoria'

/** I destinatari come li hanno attraversati i cancelli: forma canonica. */
export interface DestinatariGalleria {
  /** I bambini ritratti: distinti, nell'ordine in cui sono arrivati. */
  tagAlunni: string[]
  /** `true` solo se chiesto esplicitamente: `null` e `undefined` valgono «no». */
  broadcast: boolean
  /** Le classi bersaglio, senza voci vuote né doppioni. */
  classi: string[]
}

export type EsitoCancelliGalleria =
  | { ok: true; destinatari: DestinatariGalleria }
  | { ok: false; response: NextResponse; cancello: CancelloGalleria }

export type EsitoCancelliInSede =
  | { ok: true }
  | { ok: false; response: NextResponse; cancello: CancelloGalleria }

// I tre testi che non hanno un catalogo: sono quelli di `POST /api/gallery`, parola per
// parola. Un test li inchioda (`gallery-cancelli-destinatari.test.ts`).
const MSG_BROADCAST_NON_CONSENTITO = 'Solo la Direzione (admin o coordinatore) può pubblicare in broadcast.'
const MSG_BROADCAST_CON_TAG =
  'Una foto in broadcast non può taggare bambini: va a tutta la classe o a tutta la sede. Pubblicala senza tag, oppure togli il broadcast e tagga solo chi ha la liberatoria foto.'
const MSG_LIBERATORIA_MANCANTE =
  'Foto di gruppo non pubblicabile: alcuni bambini taggati non hanno la liberatoria foto. Rimuovili dai tag oppure pubblica per ognuno una foto singola (visibile solo ai suoi genitori).'

/** Il rifiuto, con il corpo già pronto. Vedi il «DEBITO DICHIARATO» in testa al file. */
function rifiuto(stato: 400 | 403 | 422, corpo: Record<string, unknown>): NextResponse {
  return NextResponse.json(corpo, { status: stato })
}

/** Le classi bersaglio: niente voci vuote, niente doppioni. Non è un cancello, non rifiuta mai. */
function classiBersaglio(classi: readonly string[] | null | undefined): string[] {
  return Array.isArray(classi) ? [...new Set(classi.filter(Boolean))] : []
}

/**
 * PRIMA METÀ — i cancelli che non hanno bisogno né del database né della sede.
 *
 *  · `broadcast` solo se il ruolo ATTIVO è della Direzione (`RUOLI_DIREZIONE`): è la
 *    stessa lettura che la POST ha sempre fatto, e non va confusa con `eDirezione`,
 *    che guarda i ruoli REALI. 403 senza log (la UI lo nasconde già agli educatori);
 *  · `broadcast` con bambini taggati ⇒ 400, e il log `warn` dice solo QUANTI: la UI
 *    questa combinazione non la produce, quindi chi la manda chiama l'API a mano.
 *
 * @param input.ruolo il ruolo ATTIVO di chi chiama (`auth.user.role`).
 */
export function cancelliBroadcastGalleria(input: {
  ruolo: string
  tagAlunni: readonly string[] | null | undefined
  broadcast: boolean | null | undefined
  classi: readonly string[] | null | undefined
  operazione: OperazioneCancelli
}): EsitoCancelliGalleria {
  const tagAlunni = [...new Set(input.tagAlunni ?? [])]
  const broadcast = input.broadcast === true

  if (broadcast && !(RUOLI_DIREZIONE as readonly string[]).includes(input.ruolo)) {
    return {
      ok: false,
      cancello: 'broadcast-non-consentito',
      response: rifiuto(403, { error: MSG_BROADCAST_NON_CONSENTITO }),
    }
  }

  if (broadcast && tagAlunni.length > 0) {
    // `warn`: non è un guasto del sistema, è una richiesta respinta. Solo conteggi: gli
    // id sono di minori.
    logEvento('galleria', 'warn', {
      operazione: input.operazione,
      esito: 'broadcast-con-tag',
      tipo: 'broadcast-con-tag',
      taggati: tagAlunni.length,
    })
    return {
      ok: false,
      cancello: 'broadcast-con-tag',
      response: rifiuto(400, { error: MSG_BROADCAST_CON_TAG }),
    }
  }

  return { ok: true, destinatari: { tagAlunni, broadcast, classi: classiBersaglio(input.classi) } }
}

/**
 * SECONDA METÀ — i cancelli che hanno bisogno della sede del contenuto.
 *
 *  1. i bambini taggati sono della `sedeId` (`assertTagStudentsInScope`): 403
 *     `TAG_FUORI_SEDE`, o 403 «non più iscritto», o 500 se l'anagrafica non si legge;
 *  2. Privacy Lock (`alunniSenzaConsenso`): 422 con `nomi` e `ids` di chi manca.
 *
 * ⚠️ L'ORDINE È LA CORREZIONE, non una preferenza: il Privacy Lock pronuncia nomi di
 * minori e non deve pronunciarli su bambini che chi chiama non ha titolo di conoscere,
 * quindi la sede si guarda PRIMA. E la sede che si dichiara è quella DEL CONTENUTO
 * (`sedeId`), mai l'elenco dei plessi di chi opera: un admin di due plessi non deve
 * poter mettere l'uuid di un bambino di B nella galleria di A.
 */
export async function cancelliSedeGalleria(
  supabase: SupabaseClient,
  input: {
    sedeId: string
    tagAlunni: readonly string[] | null | undefined
    operazione: OperazioneCancelli
  },
): Promise<EsitoCancelliInSede> {
  const tagAlunni = [...new Set(input.tagAlunni ?? [])]
  const sedi = [input.sedeId]

  // `assertTagStudentsInScope` tipizza l'operazione sulle due route della galleria; il
  // valore serve solo al log, quindi il restringimento è sicuro. Quando quel tipo si
  // potrà allargare, il cast sparisce.
  const fuoriSede = await assertTagStudentsInScope(
    supabase,
    tagAlunni,
    sedi,
    input.operazione as OperazioneGalleria,
  )
  if (fuoriSede) return { ok: false, cancello: 'tag-in-sede', response: fuoriSede }

  const senza = await alunniSenzaConsenso(supabase, tagAlunni, sedi)
  if (senza.length > 0) {
    // Privacy Lock scattato: nel log SOLO conteggi (mai nomi o id dei bambini, che
    // restano nel corpo della risposta per la UI dell'insegnante).
    logEvento('galleria', 'info', {
      operazione: input.operazione,
      esito: 'liberatoria-mancante',
      taggati: tagAlunni.length,
      senzaConsenso: senza.length,
    })
    return {
      ok: false,
      cancello: 'liberatoria',
      response: rifiuto(422, {
        error: MSG_LIBERATORIA_MANCANTE,
        nomi: senza.map((s) => s.nome),
        ids: senza.map((s) => s.id),
      }),
    }
  }

  return { ok: true }
}

/**
 * I QUATTRO CANCELLI DI SEGUITO, per chi ha già la sede risolta (la POST dei video).
 *
 * Restituisce o i destinatari in forma canonica o il rifiuto già pronto, da
 * rispondere com'è. Non decide se i destinatari bastino: «almeno un bambino oppure il
 * broadcast» è una regola dei video, non della galleria (una foto senza tag e senza
 * classi va a tutta la sede, da sempre), e la applica chi chiama.
 *
 * @param input.ruolo il ruolo ATTIVO di chi chiama (`auth.user.role`).
 * @param input.sedeId la sede DEL CONTENUTO, già risolta e già autorizzata.
 */
export async function cancelliDestinatariGalleria(
  supabase: SupabaseClient,
  input: {
    ruolo: string
    sedeId: string
    tagAlunni: readonly string[] | null | undefined
    broadcast: boolean | null | undefined
    classi: readonly string[] | null | undefined
    operazione: OperazioneCancelli
  },
): Promise<EsitoCancelliGalleria> {
  const primaMeta = cancelliBroadcastGalleria(input)
  if (!primaMeta.ok) return primaMeta

  const secondaMeta = await cancelliSedeGalleria(supabase, {
    sedeId: input.sedeId,
    tagAlunni: primaMeta.destinatari.tagAlunni,
    operazione: input.operazione,
  })
  if (!secondaMeta.ok) return secondaMeta

  return primaMeta
}
