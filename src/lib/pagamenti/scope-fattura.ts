import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { agisceComeGenitore, eFamiglia, haUnRuolo, type AppRole, type AppUser } from '@/lib/auth/predicati-ruolo'
import { verificaLegameGenitore } from '@/lib/anagrafiche/legami'
import { assertPagamentoInScope } from '@/lib/auth/scope'
import { logErrore, logEvento } from '@/lib/logging/logger'

/* ════════════════════════════════════════════════════════════════════════════
 * CHI PUÒ SCARICARE LA FATTURA DI UN PAGAMENTO — e perché al GENITORE la sede
 * non si applica affatto.
 *
 * ─── IL DIFETTO CHE QUESTO FILE CHIUDE ──────────────────────────────────────
 *
 * Fino a oggi `GET /api/pagamenti/fattura` e `GET /api/pagamenti/fattura/list`
 * chiamavano `assertPagamentoInScope` **a tutti**, PRIMA del controllo di
 * famiglia. Quella funzione confronta `pagamenti.scuola_id` con
 * `scuoleDiUtente(...)`, che per un NON-admin (`src/lib/auth/scope.ts:57-59`)
 * ritorna la sola sede primaria — `utenti.scuola_id`.
 *
 * Un genitore con due figli in due plessi ha UNA sede primaria e basta: la
 * fattura del figlio iscritto nell'ALTRA sede gli usciva **403 «Pagamento fuori
 * dal tuo plesso»**, sul documento fiscale della propria famiglia. E non è un
 * caso di scuola: dal 2026-07-29 le sedi di produzione sono tre.
 *
 * ─── LA DOTTRINA È GIÀ SCRITTA NEL REPO, E NON È NUOVA ──────────────────────
 *
 * `src/lib/auth/require-parent.ts:90` la dice per venti rotte:
 *
 *     «E al genitore la sede non si applica affatto — due fratelli possono
 *      essere iscritti in due plessi diversi, il suo scope è la famiglia.»
 *
 * Lo stesso vale per `assertParentInScope` (`scope.ts`), che su `parents` non
 * cerca una sede perché un genitore non ne ha una: la deriva dai FIGLI.
 *
 * Qui la regola è la stessa, applicata al pagamento: per chi è famiglia il
 * perimetro è il LEGAME col bambino, per chi lavora è il PLESSO.
 *
 * ─── PERCHÉ UN FILE NUOVO E NON `src/lib/auth/scope.ts` ─────────────────────
 *
 * Perché quasi 200 file di test fanno `vi.mock('@/lib/auth/scope', () => ({ … }))`
 * elencando gli export uno per uno: un export in più là dentro li renderebbe
 * rossi in massa, con l'errore «No "assertFatturaInScope" export is defined on
 * the mock» su file che di fatture non parlano. È la stessa lezione che ha fatto
 * nascere `@/lib/auth/predicati-ruolo`.
 *
 * ⚠️ IL NOME NON È COSMETICO. Il lock `isolamento-sede-coverage` riconosce come
 * gate la forma `assert…InScope(` (`GATE_OGGETTO`, e la stessa forma dice al lock
 * QUALI identità sono state verificate). Rinominarlo `puoScaricareFattura` non
 * cambierebbe una riga di comportamento e renderebbe cieco il lock su due rotte
 * che leggono `fatture_emesse` — tabella con `scuola_id` — sul client
 * service-role, cioè dove la RLS è scavalcata per costruzione.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * I codici dei due rifiuti che nascono qui.
 *
 * Costanti LOCALI e letterali, non un accesso a una mappa: il lock
 * `errori-con-codice` risolve `codice: X` solo se `X` è una stringa nel corpo
 * oppure un `const X = '…'` di QUESTO file. Un valore che il lock non sa leggere
 * è un valore che nessuno controlla — e in un file NUOVO una risposta senza
 * codice non è nemmeno ammessa: l'allowlist del debito può solo rimpicciolirsi.
 */
const CODICE_NON_VERIFICATO = 'FATTURA_ACCESSO_NON_VERIFICATO'
const CODICE_NEGATO = 'FATTURA_ACCESSO_NEGATO'

/**
 * Chi tiene la contabilità: per loro il perimetro è il PLESSO, e lo decide
 * `assertPagamentoInScope` come per incassi, storni e quote.
 *
 * Si chiede ai ruoli REALI (`haUnRuolo`) e non al ruolo attivo: è
 * AUTORIZZAZIONE. Una segretaria che stia guardando l'app nella veste di
 * genitore non smette di essere una segretaria — semplicemente, se il bambino è
 * suo figlio esce già dal ramo della famiglia qui sopra.
 */
const RUOLI_CONTABILITA: readonly AppRole[] = ['admin', 'coordinator', 'segreteria']

/**
 * Il gate di una FATTURA: famiglia per legame, staff per plesso, tutti gli altri
 * fuori.
 *
 * Ritorna `null` se si può proseguire, oppure la `NextResponse` di rifiuto già
 * pronta — stessa forma di tutte le `assert…InScope` del repo.
 *
 * L'ordine dei cinque rami non è estetico:
 *
 *  1. FAMIGLIA con legame CERTO → passa, e la sede non si guarda nemmeno. È il
 *     ramo che chiude il difetto multi-sede.
 *  2. LEGAME NON DECIDIBILE → 500. «Non l'ho potuto leggere» non è «non è tuo
 *     figlio»: PostgREST non lancia (AGENTS.md, regola 7) e fino a che il legame
 *     era un `boolean` una lettura fallita usciva come 403 addosso al genitore
 *     titolare — più una riga nel contatore dei tentativi a suo nome. È il
 *     rilievo T13, già pagato in `require-parent.ts`: qui non si ripete.
 *  3. AGISCE DA GENITORE e il legame dice no → 403 + `warn` persistito. Questo è
 *     il tentativo vero, ed è l'unico che il contatore deve contare.
 *  4. STAFF → `assertPagamentoInScope`, e il suo esito È il verdetto (404 se il
 *     pagamento non c'è, 403 se è di un altro plesso, 500 se la verifica non si
 *     è potuta fare). Non lo si riscrive: una regola in due posti diverge.
 *  5. Chiunque altro (educator, cuoca, e il docente-genitore su un bambino che
 *     non è suo figlio) → 403. Un documento fiscale non è materiale didattico.
 *
 * ⚠️ I RAMI 1 E 4 NON SI ESCLUDONO, ed è voluto: chi è famiglia prova prima il
 * legame e, se quel bambino non è suo figlio, ricade sul proprio scope di
 * lavoro. Così una segretaria che è anche mamma resta una segretaria su tutte le
 * altre fatture del proprio plesso.
 *
 * @param pagamentoId l'uuid del pagamento. NON è nullabile, ed è una scelta:
 *   entrambe le rotte lo validano con `zUuid` prima di arrivare qui, quindi un
 *   ramo «parametro mancante» sarebbe irraggiungibile — e per dirlo dovrebbe
 *   scegliere un codice d'errore. `assertPagamentoInScope` accetta il nullable e
 *   risponde 400 «pagamento_id obbligatorio»; qui il 400 sarebbe uscito con
 *   `FATTURA_ACCESSO_NEGATO`, cioè col catalogo che dice «questa fattura non è
 *   disponibile per il tuo profilo»: a un parametro mancante l'utente avrebbe
 *   letto un'affermazione FALSA sui propri permessi. Un ramo morto che mente è
 *   peggio di un ramo che non c'è: il tipo lo rende irrappresentabile.
 * @param alunnoId l'alunno del pagamento, GIÀ letto dal chiamante. Si passa
 *   invece di rileggerlo qui perché le due rotte quella riga la leggono comunque
 *   (una per lo stato della fattura, l'altra per il 404), e una seconda lettura
 *   sarebbe solo un modo più lento di ottenere lo stesso valore. Resta nullabile
 *   perché `pagamenti.alunno_id` lo è davvero: un pagamento senza bambino non ha
 *   nessuna famiglia, e il ramo 1 lo tratta come «legame no».
 */
export async function assertFatturaInScope(
  supabase: SupabaseClient,
  user: AppUser,
  pagamentoId: string,
  alunnoId: string | null | undefined,
): Promise<NextResponse | null> {
  if (eFamiglia(user)) {
    const esito = await verificaLegameGenitore(supabase, user.id, alunnoId ?? '')

    if (esito === 'non-deciso') {
      // 500 e `logErrore`, non 403 e `warn`: è un guasto del server e va contato
      // fra i guasti del server. Il contatore dei tentativi (ramo 3) deve restare
      // quello dei soli tentativi VERI, altrimenti non serve a niente.
      logErrore(
        { operazione: 'assertFatturaInScope', stato: 500, evento: 'auth' },
        new Error('legame-genitore-non-deciso: lettura dei legami non riuscita'),
      )
      return NextResponse.json(
        { error: 'Verifica di accesso non riuscita', codice: CODICE_NON_VERIFICATO },
        { status: 500 },
      )
    }

    if (esito === 'si') return null

    if (agisceComeGenitore(user)) {
      // `warn` → persistito. SOLO UUID ED ENUMERATI: `tipo`, `azione` e `ruolo`
      // sono in lista bianca di `redact`; `utente`, `alunno_id` e `pagamento_id`
      // passano per FORMA (uuid). Nessun nome, nessun importo, nessun numero di
      // documento: sono dati di minori e delle loro famiglie.
      //
      // `distingui` perché `app_log` deduplica per `(fingerprint, giorno)` e
      // l'impronta NON contiene il contesto: senza, venti tentativi su venti
      // pagamenti diversi lascerebbero UNA riga con il primo `pagamento_id` —
      // cioè proprio il segnale che si vuole poter distinguere.
      //
      // `stato: 403` non è ornamento: `logEvento` popola la colonna `stato_http`
      // solo se `stato` è un numero, e senza «dammi tutti i 403 di ieri» non
      // troverebbe questi rifiuti.
      logEvento('auth', 'warn', {
        tipo: 'fattura-non-della-famiglia',
        azione: 'assertFatturaInScope',
        utente: user.id,
        ruolo: user.role,
        pagamento_id: pagamentoId,
        alunno_id: alunnoId ?? null,
        stato: 403,
      }, undefined, { distingui: ['pagamento_id'] })
      return NextResponse.json({ error: 'Accesso negato', codice: CODICE_NEGATO }, { status: 403 })
    }
    // Legame `no` senza la veste di genitore (il docente-genitore in veste di
    // lavoro): non è un tentativo di IDOR, è il suo mestiere. Si prosegue e si
    // cade sullo scope di lavoro qui sotto, come chiunque altro.
  }

  if (haUnRuolo(user, RUOLI_CONTABILITA)) {
    return await assertPagamentoInScope(supabase, user, pagamentoId)
  }

  // ─── RAMO 5: né famiglia di questo bambino, né contabilità ────────────────
  //
  // `warn` e non `info`: qui non c'è nessun percorso legittimo che finisca in
  // questo ramo. Un educator o una cuoca che chiedono la fattura di una retta
  // hanno seguito un collegamento che l'app non mostra loro, oppure hanno
  // provato un uuid. Vale la pena saperlo.
  logEvento('auth', 'warn', {
    tipo: 'fattura-ruolo-non-ammesso',
    azione: 'assertFatturaInScope',
    utente: user.id,
    ruolo: user.role,
    pagamento_id: pagamentoId,
    stato: 403,
  }, undefined, { distingui: ['pagamento_id'] })
  return NextResponse.json({ error: 'Accesso negato', codice: CODICE_NEGATO }, { status: 403 })
}
