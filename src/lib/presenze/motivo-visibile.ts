import { vedeTutteLeClassi } from '@/lib/auth/scope'
import type { AppUser } from '@/lib/auth/require-staff'

/**
 * CHI, FRA IL PERSONALE, PUÒ LEGGERE IL MOTIVO DELL'ASSENZA — la regola, in un posto solo.
 *
 * ─── LA FRASE CHE LA GENERA ─────────────────────────────────────────────────
 *
 * Sotto il campo «Motivo», nell'istante in cui il dato viene raccolto, il modulo del genitore
 * dichiara: «Il motivo lo leggono le insegnanti della sezione e viene cancellato dopo dodici
 * mesi». È l'informativa dell'art. 13 su un dato dell'art. 9 — la salute di un minore — e
 * quella frase è la base su cui la famiglia decide se scrivere «febbre» o non scrivere niente.
 *
 * ─── COSA SUCCEDEVA (rilievo Q1, quarto collaudo) ───────────────────────────
 *
 * Le due rotte che mostrano l'appello al personale (`attendance/daily:GET` e
 * `primaria/appello:GET`) sono protette da `requireDocente`, che ammette `educator, admin,
 * coordinator, segreteria`, e dai gate di scope — che restringono alla sezione SOLO chi non
 * passa da `vedeTutteLeClassi`. Misurato: con la sessione di un `coordinator` non assegnato
 * alla sezione, `giustificazione_testo` tornava per intero, con HTTP 200. Con un `educator`
 * non assegnato, la stessa chiamata risponde 403.
 *
 * Quindi il gate funzionava e la frase era falsa: il microtesto era stato scritto guardando
 * alla schermata («l'appello della maestra») invece che al gate della rotta.
 *
 * ─── PERCHÉ SI RESTRINGE L'ACCESSO INVECE DI ALLARGARE LA FRASE ─────────────
 *
 * Minimizzazione (art. 5 §1 lett. c). Il motivo serve a chi accoglie il bambino la mattina
 * dopo: nessuna mansione di segreteria o di direzione ha bisogno del sintomo di un minore di
 * una sezione che non le è assegnata. La schermata resta identica per tutti — cambia solo che
 * quella colonna non viaggia — e la frase mostrata alla famiglia torna vera senza doverla
 * riscrivere in una forma che nessun genitore vorrebbe leggere.
 *
 * ─── PERCHÉ QUI E NON NELLE DUE ROTTE ───────────────────────────────────────
 *
 * Perché il rilievo ne nominava una sola, e l'altra ha esattamente la stessa forma: è la terza
 * volta in questo ciclo che un rimedio viene applicato al file in cui il difetto è stato
 * MISURATO. Una regola valida per due strade deve vivere in un posto solo — e il lock
 * `__tests__/architecture/motivo-assenza-chi-lo-legge.test.ts` pretende che entrambe le rotte
 * passino di qui, e che la frase del catalogo non torni a dire altro.
 *
 * ⚠️ NON è un gate di autorizzazione e non lo sostituisce: chi può VEDERE l'appello lo
 * decidono `requireDocente` + `assertClasseNomeInScope`/`assertSezioneInScope`. Questa
 * funzione decide una cosa più piccola e più stretta: se in quella risposta ci va anche la
 * colonna del motivo.
 */
export function motivoVisibileA(user: AppUser): boolean {
    return !vedeTutteLeClassi(user)
}

/**
 * Le colonne di `presenze` da chiedere a PostgREST, con o senza il motivo.
 *
 * Sta qui e non nelle rotte perché il punto non è «aggiungere un `if`»: è che la colonna non
 * deve nemmeno essere letta da chi non può vederla. Filtrarla dopo la lettura funzionerebbe
 * uguale in risposta, ma il dato avrebbe già attraversato il processo — e sarebbe finito nel
 * log di una query fallita, in un messaggio d'errore di PostgREST, in un `console.log` di
 * domani. Ciò che non serve non viaggia.
 */
export function colonneConMotivo(colonne: readonly string[], user: AppUser): string {
    const senzaMotivo = colonne.filter((c) => c.trim() !== 'giustificazione_testo')
    return (motivoVisibileA(user) ? colonne : senzaMotivo).join(', ')
}
