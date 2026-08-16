/**
 * UN GENITORE, UNA CASELLA — la regola, scritta una volta sola.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * Decisione del titolare, 2026-08-16: ogni genitore deve avere il suo account, e
 * l'account nasce dall'email. Due genitori che indicano la stessa casella non
 * possono averne due — non per una scelta di prodotto, ma perché `utenti.email`
 * è UNIQUE e GoTrue rifiuta un indirizzo già registrato. E anche potendo,
 * sarebbe inutile: l'email È l'identità con cui si entra, quindi due account
 * sulla stessa casella vorrebbero dire che chi la apre entra come l'uno **o**
 * come l'altro, mai come sé.
 *
 * Misurato sulle 390 domande già arrivate: 11 portano la stessa casella per
 * entrambi i genitori (3 a Giugliano, 8 a Cesa). Per quelle la segreteria dovrà
 * chiedere il secondo indirizzo; nel frattempo quella coppia condivide un
 * accesso. Da qui in avanti il modulo non ne accetta di nuove.
 *
 * 🚫 Quello che NON si fa: gli alias tipo `mario+padre@…`. Sarebbero due account
 * veri e zero beneficio — le due password finirebbero comunque nella stessa
 * casella, che è esattamente il problema che si voleva togliere.
 *
 * ─── PERCHÉ È UN MODULO E NON DUE CONTROLLI ─────────────────────────────────
 * La stessa domanda («queste due caselle sono la stessa?») va posta due volte:
 * nel wizard, perché l'utente se ne accorga mentre scrive, e sul server, perché
 * il modulo è ANONIMO e chiunque può spedirgli un corpo a mano. Due copie
 * divergerebbero sulla normalizzazione al primo ritocco, e la divergenza si
 * vedrebbe come un modulo che accetta ciò che poi rifiuta — o peggio, il
 * contrario. In questo repository quella lezione è già scritta in
 * `parent-identity.ts:112` e `staff-identity.ts:336`, e ogni volta è costata un
 * guasto silenzioso.
 */

/**
 * La frase che legge il genitore. Dice il PERCHÉ, non solo il divieto: senza,
 * la richiesta sembra un capriccio del modulo e la reazione naturale è inventare
 * un indirizzo pur di andare avanti.
 */
export const EMAIL_RIPETUTA_FRA_GENITORI =
  'Questo indirizzo è già stato indicato da un altro genitore. Ogni genitore riceve il suo accesso personale all’app, quindi serve una casella diversa per ciascuno.'

/**
 * Riduce una casella alla sua forma confrontabile: `Mario@Gmail.com ` e
 * `mario@gmail.com` sono la stessa casella, e confrontarle alla lettera direbbe
 * di no.
 *
 * ⚠️ NON è *identica* a `lower(btrim(email))`, la colonna generata `email_norm`
 * di `iscrizioni_inviti_credenziali`, ed è meglio scriverlo che lasciarlo
 * credere: `btrim` senza secondo argomento toglie SOLO lo spazio ASCII, mentre
 * `String.prototype.trim()` toglie tutto lo spazio Unicode — la tabulazione, l'a
 * capo, e lo spazio unificatore che iOS incolla in coda a un indirizzo copiato.
 * Quindi questa funzione è più generosa, mai più severa.
 *
 * La divergenza non morde, e il motivo è che il valore scritto in tabella è già
 * passato di qui: `firstEmail` (`parent-identity.ts`) fa `.trim()` in JavaScript
 * prima che l'indirizzo arrivi al database, quindi `btrim` su quel valore non ha
 * più niente da togliere e le due forme coincidono. Se un giorno qualcuno
 * scrivesse in quella tabella per un'altra strada, senza passare da lì, la
 * lookup `.in('email_norm', …)` potrebbe non trovare una riga che c'è — e
 * l'anti-doppio-invito lascerebbe partire una seconda password.
 */
export function normalizzaEmailModulo(valore: unknown): string {
  return typeof valore === 'string' ? valore.trim().toLowerCase() : ''
}

/**
 * Gli indici degli adulti che RIPETONO una casella già indicata prima di loro.
 *
 * Si segnala il secondo e i successivi, mai il primo: l'errore va messo sul
 * campo che l'utente deve cambiare, non su quello che ha compilato per primo e
 * che con ogni probabilità è giusto.
 *
 * Le caselle vuote non contano: `email` è un campo FACOLTATIVO del modulo
 * (`src/lib/forms/enrollment-template.ts`), e due adulti che non ne indicano
 * nessuna non stanno ripetendo niente.
 */
export function indiciEmailRipetute(email: readonly unknown[]): number[] {
  const viste = new Set<string>()
  const ripetuti: number[] = []
  for (let i = 0; i < email.length; i++) {
    const e = normalizzaEmailModulo(email[i])
    if (!e) continue
    if (viste.has(e)) ripetuti.push(i)
    else viste.add(e)
  }
  return ripetuti
}
