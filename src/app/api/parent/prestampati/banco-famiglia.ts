/**
 * IL BANCO DELLA FAMIGLIA — ciò che le due rotte del genitore devono dire allo stesso modo.
 *
 * Non è una route: è un modulo COLLOCATO accanto a `route.ts` e a `firma/route.ts`, che in
 * App Router non produce nessun endpoint — solo `route.ts` lo fa. Sta qui e non in
 * `src/lib/prestampati/` per la ragione che la rotta gemella della segreteria dichiara in
 * testa a `src/app/api/prestampati/banco.ts`: quel pacchetto lo stanno scrivendo altre mani
 * nello stesso momento, e un file condiviso riscritto da tre parti si perde a vicenda. Sotto
 * questa cartella l'ownership è chiara, e il precedente esiste già.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────
 *
 * «Questo foglio la famiglia lo può firmare adesso?» se la chiedono in tre: il GET, per
 * accendere o spegnere la voce dell'elenco (`firmabileOra`); il POST, prima di spedire il
 * codice via email; il PATCH, prima di comporre il documento. Una regola valida per tre
 * strade deve vivere in un posto solo, e se i tre rispondessero in modo diverso il conto lo
 * pagherebbe la famiglia: un modulo acceso nell'elenco e rifiutato dal PATCH costa un invio
 * del budget OTP — **5 per finestra di dieci minuti**, CONDIVISO fra tutte le porte
 * (`otp-rate-limit.ts`) — cioè cinque tentativi a vuoto su una gita lascerebbero il genitore
 * senza modo di firmare l'autorizzazione a un farmaco.
 *
 * Quello che oggi non si firma, con la misura che lo dice:
 *
 *  · **n. 08, delega al ritiro**: `richiedeDueFirme()` è vera quando in anagrafica ci sono due
 *    tutori (o l'alunno ha `genitori_separati`), il modello pretende due `sottoscrizioni` e
 *    questa rotta ne raccoglie una sola. Misurato in sola lettura sul database di produzione
 *    il 2026-08-14: **10 bambini su 33 hanno due tutori**, più uno con `genitori_separati`.
 *
 * ─── COSA QUESTO FILE DECIDE, E COSA NO ─────────────────────────────────────────
 *
 * Decide **che cosa la famiglia può firmare oggi** e **con quali parole si dice di no**. NON
 * decide chi può: l'identità è `requireUser`, la portata sulla famiglia è
 * `requireParentOfStudent` (che `caricaPrefillAlunno` rifà per conto suo), e il tetto di
 * frequenza è `limitaInvioOtp`/`limitaVerificaOtp`. Quattro difese che esistono già, nessuna
 * riscritta qui.
 *
 * ⚠️ E DA QUI PASSA ANCHE LA LOGICA PURA DELLA FIRMA — i riferimenti degli allegati, il
 * perimetro del bambino, la scadenza dell'archivio, l'elenco dei moduli che la morosità non
 * blocca. Non è un ripostiglio: è la regola per cui una funzione che non tocca Supabase non
 * ha ragione di stare dentro l'handler. Ciò che invece **deve** restare là sono le QUERY
 * ancorate ad `alunnoId`, perché il lock `isolamento-sede-coverage` riconosce i presidi dai
 * nomi delle funzioni chiamate NELL'handler: spostando una lettura di `delegates` o di
 * `certificati_medici` in un helper di file, quell'handler diventa «handler-senza-scope»
 * (misurato).
 *
 * ⚠️ IL CRITERIO, dal 2026-08-16, NON È PIÙ «qui non entra Supabase» — che era la formula
 * precedente, e diceva una regola più stretta di quella vera. È: **qui non entra nessuna
 * query ancorata a un bambino.** L'unica funzione che tocca il client è
 * `garantisciBucketFascicolo`, che non legge dati di nessuno: chiede allo storage se il
 * magazzino dichiarato in questo stesso file esiste, e se non c'è lo crea. Stava scritta
 * due volte — privata dentro `firma/route.ts` e assente dall'altra porta — e la porta senza
 * copia caricava in un bucket che in produzione non esisteva: 201 all'apparenza, zero righe
 * in `student_documents`, e un numero di protocollo bruciato a ogni «Scarica».
 *
 * Il resto del file non fa I/O, ed è il motivo per cui il verdetto si può interrogare tre
 * volte in tre punti diversi senza pagare una query.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { bloccoFirma, prestampatiPerRuolo, type VocePrestampato } from '@/lib/prestampati/registro'
import {
  autorizzazioneNidoCompleta,
  richiedeDueFirme,
  type CampoModulo,
  type DatiPrestampato,
  type DatiUscita,
  type ErroreCampo,
  type MezzoTrasporto,
  type TipoUscita,
} from '@/lib/prestampati/modelli/genitore'
import type { EsitoRender } from '@/lib/prestampati/render'
// Il giorno civile ITALIANO di un istante: il runtime gira in UTC, e sul confine fra due
// anni scolastici (1° agosto) due ore decidono a quale anno appartiene un certificato.
import { dataCivile } from '@/i18n/config'
import { logEvento } from '@/lib/logging/logger'

// ─── Il cancello dello slug ─────────────────────────────────────────────────────

/**
 * La forma dello slug in ingresso, uguale su tutte e tre le porte.
 *
 * `max(64)` è la larghezza dei nomi del registro, non un numero scelto: il cancello vero è
 * `voceDelGenitore` qui sotto, che respinge tutto ciò che non è fra i diciassette. Sta qui
 * perché il GET e le due porte della firma devono dire la stessa cosa, e uno schema
 * ricopiato in tre punti diverge al primo che qualcuno allarga.
 */
export const zSlug = z.string().trim().min(1).max(64)

/**
 * La voce di registro del modello, se il banco «genitore» ce l'ha davvero.
 *
 * È il cancello, e vale per tutte e tre le porte: `document_type` finisce dentro
 * `student_documents`, dentro il nome del file nel bucket e dentro la riga di
 * `firme_documenti`. Uno slug scelto da chi chiama sarebbe una riga d'archivio che nessun
 * elenco della segreteria saprà più mostrare.
 */
export function voceDelGenitore(slug: string): VocePrestampato | null {
  return prestampatiPerRuolo('genitore').find((v) => v.slug === slug) ?? null
}

// ─── Chi, fra i diciassette, ha a che fare con i delegati al ritiro ─────────────

/**
 * La parte del campo che le due domande qui sotto guardano, e nient'altro.
 *
 * Non è `CampoModulo` e non è `CampoPrestampato`: sono due descrizioni dello STESSO modulo —
 * il registro converte la prima nella seconda (`daCampoGenitore`, `registro.ts`) e
 * differiscono sul solo `tipo` — e le due porte ne hanno in mano una ciascuna, il GET la voce
 * di registro, il PATCH il modello. Chiedere una conversione per porre una domanda su tre
 * chiavi vorrebbe dire far dipendere il predicato da quale delle due forme si ha sottomano,
 * che è il contrario del motivo per cui vive qui.
 *
 * ⚠️ E perciò il parametro NON può essere `CampoModulo`, che è la forma del solo genitore:
 * il GET arriva dal registro con `tipo: 'mese'` fra le mani — un valore che la forma del
 * genitore non conosce — e il compilatore lo rifiuta. Il tipo qui sotto è il minimo che le
 * due domande leggono davvero, ed è ciò che rende vera la frase del capoverso precedente.
 */
interface CampoConDelegati {
  nome: string
  precompilatoDa?: string
  opzioniDaApp?: 'delegati_attivi'
}

/**
 * Il campo con cui il modello fa SCEGLIERE una persona fra i delegati dell'app, o `null`.
 *
 * Oggi risponde per il solo n. 09 (`accompagnatore`), ed è la domanda che le due porte
 * devono porsi allo stesso modo: il GET per sapere se l'elenco va caricato, il PATCH per
 * sapere se la scelta arrivata nelle risposte va risolta in un nome. Finché la risposta è
 * vissuta in due posti, il PATCH leggeva `accompagnatore` dal corpo per tutti e otto i
 * modelli — cioè interrogava `delegates` anche per una scheda sanitaria, e un guasto su
 * quella tabella rendeva infirmabile un modulo che i delegati non li nomina nemmeno.
 *
 * Restituisce il NOME del campo e non un booleano: così il PATCH legge la scelta dalla
 * chiave che il modello dichiara invece che da una stringa scritta a mano nella rotta.
 * `opzioniDaApp` è dichiarato solo al primo livello (`modelli/genitore.ts`), e non si
 * scende nelle `colonne`: una scelta fra i delegati dentro una tabella `righe` oggi non
 * esiste, e fingere di gestirla vorrebbe dire un ramo che nessuna richiesta percorre.
 */
export function campoSceltaDelegato(campi: readonly CampoConDelegati[]): string | null {
  return campi.find((c) => c.opzioniDaApp === 'delegati_attivi')?.nome ?? null
}

/**
 * L'elenco dei delegati serve a questo modello?
 *
 * Due modi di averci a che fare, e tutti e due vogliono l'elenco a schermo: il n. 09 ci fa
 * SCEGLIERE chi ritira il bambino, il n. 08 ci PRECOMPILA le righe della delega. Su quindici
 * modelli su diciassette quell'elenco non c'entra niente — «ciò che non si legge non si può
 * perdere», e qui si tratta dell'anagrafica di terzi.
 */
export function serveElencoDelegati(campi: readonly CampoConDelegati[]): boolean {
  return campoSceltaDelegato(campi) !== null || campi.some((c) => c.precompilatoDa === 'delegates')
}

// ─── Che cosa la famiglia può firmare OGGI ──────────────────────────────────────

/**
 * I quattro motivi per cui uno degli otto non si firma da questa porta. Tenerli distinti
 * serve a chi guarda la schermata: il primo dice «lo firma un altro», gli altri tre dicono
 * «non si fa ancora», e sono tre lacune diverse con tre rimedi diversi.
 *
 * I valori sono in kebab perché escono nel JSON di queste due rotte, dove gli altri
 * enumerati (`motivo: 'gia-usato'`, `motivoMancatoArchivio: 'tipo-documento-non-ammesso'`)
 * hanno già quella forma: due convenzioni nella stessa risposta si leggono come due cose.
 */
export type MotivoNonFirmabile =
  | 'firma-della-scuola'
  | 'seconda-firma-mancante'
  | 'allegato-non-caricabile'

/**
 * I modelli che pretendono un ALLEGATO che la famiglia non ha nessun modo di depositare.
 *
 * ─── PERCHÉ È UNO SOLO, E NON TRE ───────────────────────────────────────────────
 *
 * Il campo `tipo: 'file'` obbligatorio è su tre modelli — il n. 06 (`prescrizionePath`), il
 * n. 07 quando il motivo è sanitario (`certificatoPath`) e il n. 08 per ogni delegato
 * (`documentoPath`) — ma la domanda che conta non è «il modello lo chiede?»: è **«esiste una
 * porta da cui la famiglia possa caricarlo?»**. Per due dei tre esiste, ed è quella che la
 * specifica nomina: `docs/prestampati/06-autorizzazione-farmaci.md:75` dice «la prescrizione
 * allegata segue lo stesso bucket con oblio del certificato medico», cioè
 * `POST /api/parent/medical-certificates` → bucket `certificati-medici`, gate
 * `genitoreHasFiglio`, percorso `<alunnoId>/<uuid>.<est>`. La firma verifica lì l'allegato
 * (vedi `riferimentiAllegati` in `firma/route.ts`), quindi il n. 06 e il n. 07 restano accesi
 * e non sprecano nessun invio.
 *
 * Per il n. 08 no: la scansione è il documento d'identità di un TERZO (la nonna, la vicina),
 * non un certificato sanitario del bambino, e non ha una porta sua. L'unica del repo che
 * scrive sotto `<alunnoId>/` nel bucket del fascicolo è `primaria/fascicolo:POST`, che passa
 * da `puoAccedereFascicolo`: per il ruolo `genitore` quella funzione cade in
 * `{ consentito: false, motivo: 'negato' }` (`src/lib/primaria/fascicolo-rbac.ts:70`).
 * Lasciarlo acceso significa un 422 sistematico DOPO aver speso uno dei 5 invii per finestra
 * di dieci minuti — budget condiviso fra tutte le porte OTP — cioè il danno esatto che questo
 * file esiste per chiudere e che per il n. 10 evita già.
 *
 * ⚠️ E LA PORTA DEI CERTIFICATI MEDICI NON VALE COME RIPIEGO, che è la domanda ovvia:
 * `certificati-medici` non è un deposito generico — quel bucket e la riga di
 * `certificati_medici` sono l'archivio dei certificati sanitari DEL BAMBINO, e l'oblio li
 * tratta come tali (`obliaCertificatiMediciAlunno`). Depositarci il documento d'identità di un
 * terzo vorrebbe dire due cose sbagliate insieme: catalogare come dato sanitario di un minore
 * un dato che non lo è, e far cancellare il documento di un terzo dalla richiesta di oblio di
 * una famiglia. `magazziniAmmessi()` qui sotto rende la decisione vera CAMPO PER CAMPO —
 * `documentoPath` può nominare soltanto il bucket del fascicolo, dove la famiglia non scrive —
 * perché un divieto dichiarato e non applicato è una dichiarazione senza effetto.
 *
 * ⚠️ UN INSIEME, E NON UNA REGOLA DEDOTTA DAL MODELLO, per la stessa ragione di
 * `CONTESTO_NON_DISPONIBILE`: «esiste una porta di caricamento» non è una proprietà del
 * modulo — è una proprietà del prodotto — e dedurla dalla presenza di un campo `file`
 * spegnerebbe anche i due che oggi funzionano. Il giorno in cui la scansione del delegato
 * avrà la sua porta, questa riga sparisce insieme alla riga di `magazziniAmmessi`.
 */
const ALLEGATO_SENZA_PORTA: ReadonlySet<string> = new Set(['delega_ritiro'])

/**
 * Vero quando il verdetto NON si può dare senza il precompilato della famiglia.
 *
 * Oggi è il solo n. 08: quante firme servono lo dice l'anagrafica (`richiedeDueFirme`), non
 * il modello. Serve al POST, che così legge le otto query del precompilato **solo** per il
 * modulo che ne ha bisogno invece che a ogni richiesta di codice: ciò che non si legge non
 * si può perdere, e qui si tratta dell'anagrafica di un minore.
 */
export function serveIlPrecompilato(voce: VocePrestampato): boolean {
  return voce.firma === 'otp_due_genitori'
}

/**
 * Il verdetto che non ha bisogno di leggere NIENTE, o `null` se finora si può.
 *
 * Va chiamato per primo, prima del gate e prima di qualunque query: è ciò che permette al
 * POST di rifiutare i due certificati senza aver toccato il database e senza aver speso un
 * invio del budget OTP.
 */
export function motivoNonFirmabileSubito(voce: VocePrestampato): MotivoNonFirmabile | null {
  // `bloccoFirma()` e non `firma === 'otp_genitore' || firma === 'otp_due_genitori'`: quella
  // funzione mappa i tre requisiti sui tre blocchi del motore, e «blocco del genitore» è vera
  // esattamente sui due requisiti OTP. Enumerarli a mano qui sarebbe la quarta copia.
  if (bloccoFirma(voce.firma) !== 'genitore') return 'firma-della-scuola'
  // ⚠️ IL N. 10 NON HA PIÙ UN MOTIVO, e non perché il problema sia sparito: perché la
  // risposta è cambiata di natura. Fino al 2026-08-15 qui c'era
  // `CONTESTO_NON_DISPONIBILE.has(voce.slug) → 'uscita-non-creata'`, cioè una voce SPENTA
  // con un lucchetto accanto — e restava spenta anche quando la gita esisteva davvero,
  // perché le uscite vivono in `eventi_agenda` e nessuno costruiva `DatiUscita`. Ora
  // l'uscita si legge (`datiUscitaDaEvento`, qui sotto) e la regola è un'altra: **senza
  // uscita pubblicata il modulo non compare affatto** nell'elenco della famiglia. Un
  // lucchetto su una gita che non esiste è una promessa a chi non ha niente da firmare.
  // La decisione è del GET, che l'elenco lo compone; qui non c'è più niente da dire.
  // ⚠️ `allegato-non-caricabile` NON sta qui, e non è una svista: sul n. 08 vale insieme a
  // `seconda-firma-mancante`, e dandolo subito — prima di aver guardato l'anagrafica —
  // renderebbe il verdetto della doppia firma irraggiungibile per sempre. Sta in
  // `motivoNonFirmabile`, dopo. Il costo è una lettura di anagrafica sul solo n. 08, che il
  // precompilato caricava comunque per contare i tutori.
  return null
}

/**
 * Il verdetto completo: quello immediato più ciò che dipende dall'anagrafica della famiglia.
 *
 * ⚠️ `dati === null` vale **«non lo so», e «non lo so» rifiuta**. Il chiamante che non ha
 * caricato il precompilato per un modello che lo pretende ottiene `seconda-firma-mancante`,
 * non un verde: su un atto che autorizza un terzo a portare via un bambino, un verdetto dato
 * senza guardare l'anagrafica è esattamente il difetto che questo file esiste per chiudere.
 */
export function motivoNonFirmabile(
  voce: VocePrestampato,
  dati: DatiPrestampato | null,
): MotivoNonFirmabile | null {
  const subito = motivoNonFirmabileSubito(voce)
  if (subito) return subito
  // ⚠️ L'ORDINE È LA PARTE CHE CONTA. Sul n. 08 valgono tutti e due i verdetti — la seconda
  // firma non si raccoglie E la scansione del delegato non si può caricare — e sono due
  // lacune diverse con due rimedi diversi. La doppia firma va guardata per PRIMA perché
  // dipende dall'anagrafica di QUESTA famiglia (dieci bambini su trentatré hanno due tutori)
  // e sarebbe l'unico dei due a non poter più comparire da nessuna parte; l'allegato è
  // uguale per tutti e resta vero anche quando i tutori sono uno solo.
  if (serveIlPrecompilato(voce) && (dati === null || richiedeDueFirme(dati))) {
    return 'seconda-firma-mancante'
  }
  if (ALLEGATO_SENZA_PORTA.has(voce.slug)) return 'allegato-non-caricabile'
  return null
}

// ─── I certificati: quelli che la Scuola emette, e per chi ──────────────────────

/**
 * I tre motivi per cui un CERTIFICATO non si emette, e sono cose diverse dal non-firmabile.
 *
 * `MotivoNonFirmabile` risponde a «questa famiglia può sottoscrivere questo foglio?»; questo
 * risponde a «la Scuola può emetterlo, per QUESTO bambino, adesso?». Due su tre sono lacune
 * della SEDE (si segnalano alla segreteria e si sistemano in Impostazioni), il terzo è una
 * proprietà del bambino e non si sistema affatto: il Bonus Asilo Nido spetta a chi il nido lo
 * frequenta, e per gli altri esiste il certificato di iscrizione e frequenza.
 *
 * In kebab come tutti gli altri enumerati di queste risposte, e con gli stessi valori che il
 * POST già restituiva in `motivo`: il client ha una mappa sola verso il catalogo bilingue.
 */
export type MotivoNonGenerabile =
  | 'legale-rappresentante-assente'
  | 'livello-non-nido'
  | 'autorizzazione-nido-mancante'

/**
 * Il verdetto sull'emissione, o `null` se quel certificato per quel bambino si può fare.
 *
 * ─── PERCHÉ ESISTE, E PERCHÉ NON STA DENTRO LA ROTTA ────────────────────────────
 *
 * 🔴 Misurato su una finestra 430×900 — la misura di un telefono, che è come questa app si
 * usa. Il Bonus Nido offriva a chiunque un pulsante `primary`, si premeva, e il rifiuto
 * («si rilascia solo a chi frequenta il nido») veniva disegnato **777 px sopra la finestra**:
 * gli screenshot prima e dopo il clic erano identici, e al genitore sembrava che il pulsante
 * non rispondesse. Sulla sede di Giugliano la maggioranza dei bambini non è al nido, quindi
 * quel pulsante era acceso e destinato a fallire per la maggioranza di chi lo vedeva.
 *
 * Il rifiuto però era prevedibile **senza chiedere niente al server**: il GET carica già il
 * precompilato e conosce livello, sede e legale rappresentante. Quindi la stessa regola serve
 * a due strade — il GET, per far arrivare la scheda spenta con il suo motivo scritto sopra, e
 * il POST, per rifiutare con un 422 chi ci prova lo stesso — e una regola valida per due
 * strade vive in un posto solo. Se le due divergessero, il pannello accenderebbe un pulsante
 * che la rotta rifiuta: cioè esattamente il difetto di partenza, con un giro di rete in più.
 *
 * ⚠️ Vale SOLO sui certificati (`firma === 'legale_rappresentante'`). Sugli altri sei
 * risponde `null` — «niente da dire» — e non `'firma-della-scuola'`: quella è la risposta di
 * `motivoNonFirmabile`, e ripeterla qui vorrebbe dire due campi che dicono la stessa cosa in
 * modo leggermente diverso nello stesso oggetto JSON.
 */
export function motivoNonGenerabile(
  voce: VocePrestampato,
  dati: DatiPrestampato,
  legaleRappresentante: string | null | undefined,
): MotivoNonGenerabile | null {
  if (voce.firma !== 'legale_rappresentante') return null
  // Chi firma per la Scuola non c'è: nessuno dei due certificati esce, e non è colpa del
  // bambino. Si guarda per PRIMO perché vale su tutti e due e non dipende dal modello.
  if (!legaleRappresentante?.trim()) return 'legale-rappresentante-assente'
  if (voce.slug === 'certificato_bonus_nido') {
    if (dati.alunno.livello !== 'nido') return 'livello-non-nido'
    if (!autorizzazioneNidoCompleta(dati.sede)) return 'autorizzazione-nido-mancante'
  }
  return null
}

// ─── Il numero di protocollo dentro la riga d'archivio ──────────────────────────

/**
 * La descrizione con cui un documento PROTOCOLLATO entra nel fascicolo.
 *
 * ⚠️ È UN FORMATO, non una frase, ed è l'unico posto in cui il numero di protocollo può
 * viaggiare: `student_documents` non ha una colonna per il protocollo — misurato sullo
 * schema di produzione il 2026-08-16, undici colonne e nessuna è quella — e aggiungerne una
 * è una migrazione che il DB E2E della CI non ha. Chi scrive e chi rilegge devono quindi
 * usare le stesse parole, ed è lo stesso patto che tiene insieme l'uscita in agenda
 * (`componiDescrizioneUscita` → `datiUscitaDaEvento`), per la stessa ragione e con lo stesso
 * lock: senza round-trip verificato, il riscarico torna a non sapere quale foglio sta
 * riconsegnando **e niente diventa rosso**.
 *
 * Nessun dato personale: c'è già il PDF. Etichetta del modello e numero, nient'altro.
 */
export function descrizioneArchivioProtocollata(
  etichetta: string,
  numeroFormattato: string | null,
): string {
  return numeroFormattato ? `${etichetta} — Prot. n. ${numeroFormattato}` : etichetta
}

/**
 * Il numero di protocollo riletto da una descrizione d'archivio, o `null` se non ce n'è uno.
 *
 * ⚠️ LA FORMA È QUELLA DEL REGISTRO, e il rigore è la parte utile: sette cifre, barra, quattro
 * dell'anno (`formatNumeroProtocollo`). Un'espressione più larga (`\d+/\d+`) accetterebbe
 * qualunque frazione capitata in una descrizione scritta a mano e la mostrerebbe al genitore
 * come «il numero del tuo certificato», che è peggio del campo vuoto: un numero sbagliato lo
 * si trascrive su un modulo INPS senza dubitarne.
 *
 * Regge anche il formato dello SPORTELLO, che dopo il numero può aggiungere una coda propria
 * (`— modulo consegnato su carta`): il numero si cerca dov'è, non si pretende che la
 * descrizione finisca lì.
 */
export function numeroProtocolloDaDescrizione(descrizione: string | null | undefined): string | null {
  if (!descrizione) return null
  return /Prot\. n\. (\d{7}\/\d{4})/.exec(descrizione)?.[1] ?? null
}

// ─── L'USCITA: come si scrive in agenda e come si rilegge sul modulo n. 10 ──────
//
// ⚠️ PERCHÉ IL CODICE CHE SCRIVE STA NEL FILE DI CHI LEGGE, che è la domanda giusta da
// fare a questa sezione. `eventi_agenda` non ha una colonna `jsonb` (baseline, righe
// 1427-1441: `titolo`, `descrizione`, `tipo`, `data`, `orario_inizio`, `orario_fine`,
// `visibile_genitori`), e aggiungerne una è una migrazione. L'unico posto in cui i dati
// dell'uscita possono viaggiare è quindi il TESTO della descrizione, e un testo è un
// formato: chi lo scrive (`teacher/uscite:POST`) e chi lo rilegge (le due porte della
// famiglia) devono usare le stesse etichette, o il n. 10 smette di stampare la
// destinazione **senza che niente diventi rosso** — il foglio esce lo stesso, con una riga
// in meno che nessuno sa di dover cercare.
//
// Due copie delle etichette in due file divergono al primo ritocco. Perciò stanno qui, che
// è il file di chi si ROMPE se divergono, e la route dell'insegnante le importa. Il
// round-trip (`componiDescrizioneUscita` → `datiUscitaDaEvento`) è verificato dal test, che
// è la sola prova che il formato regge.
//
// ⚠️ E IL FORMATO NON SI PUÒ RISCRIVERE A PIACERE: in produzione esistono già uscite
// pubblicate con queste righe. Un'etichetta cambiata rende illeggibili quelle, cioè spegne
// il modulo per le gite già annunciate alle famiglie.

/** Le cinque voci del cartaceo, nell'ordine in cui il prestampato le elenca. */
export const TIPI_ATTIVITA_USCITA = [
  'uscita_didattica',
  'gita',
  'laboratorio_esterno',
  'corso_piscina',
  'altro',
] as const
export type TipoAttivitaUscita = (typeof TIPI_ATTIVITA_USCITA)[number]

export const ETICHETTA_ATTIVITA_USCITA: Record<TipoAttivitaUscita, string> = {
  uscita_didattica: 'Uscita didattica',
  gita: 'Gita',
  laboratorio_esterno: 'Laboratorio esterno',
  corso_piscina: 'Corso di piscina/nuoto',
  altro: 'Altra attività esterna',
}

/**
 * Il tipo dell'agenda → il tipo del MODELLO, che ha un nome diverso per la stessa cosa.
 *
 * `corso_piscina` di qua e `piscina` di là (`TIPI_USCITA`, `modelli/genitore.ts`): due
 * elenchi scritti da due mani, con le stesse cinque voci e un nome che non coincide.
 * Tradurre qui è meno pericoloso che allineare i due enumerati — l'agenda ha già righe
 * scritte con `corso_piscina`, e rinominarle sarebbe una migrazione di dati per un refuso.
 */
const TIPO_USCITA_DEL_MODELLO: Record<TipoAttivitaUscita, TipoUscita> = {
  uscita_didattica: 'uscita_didattica',
  gita: 'gita',
  laboratorio_esterno: 'laboratorio_esterno',
  corso_piscina: 'piscina',
  altro: 'altro',
}

/** Le quattro voci del cartaceo per il mezzo di trasporto. */
export const MEZZI_USCITA = ['scuolabus', 'pullman_privato', 'a_piedi', 'altro'] as const
export type MezzoUscita = (typeof MEZZI_USCITA)[number]

export const ETICHETTA_MEZZO_USCITA: Record<MezzoUscita, string> = {
  scuolabus: 'Scuolabus',
  pullman_privato: 'Pullman privato',
  a_piedi: 'A piedi',
  altro: 'Altro',
}

/** Le etichette che fanno da chiave nella descrizione. Cambiarne una rompe il passato. */
const RIGA_TIPO = 'Tipo di attività'
const RIGA_DESTINAZIONE = 'Destinazione'
const RIGA_MEZZO = 'Mezzo di trasporto'
const RIGA_ACQUA = 'Attività in acqua'

/** `2026-09-12` → `12/09/2026`, senza costruire una `Date`: nessun fuso di mezzo. */
export function dataItalianaUscita(ymd: string): string {
  const [anno, mese, giorno] = ymd.split('-')
  return `${giorno}/${mese}/${anno}`
}

/** Il titolo dell'evento in agenda, e la prima metà della chiave naturale della gita. */
export function titoloUscita(tipo: TipoAttivitaUscita, destinazione: string): string {
  return `${ETICHETTA_ATTIVITA_USCITA[tipo]}: ${destinazione}`
}

/** Ciò che serve a comporre la descrizione dell'uscita: è il corpo della richiesta. */
export interface DescrizioneUscitaInput {
  tipo_attivita: TipoAttivitaUscita
  destinazione: string
  data: string
  ora_partenza: string
  ora_rientro: string
  mezzo: MezzoUscita
  attivita_in_acqua?: boolean
  accompagnatori?: string | null
  /** Già formattata in euro dal chiamante: qui non entra `formatEuro`. */
  quota?: string | null
}

/**
 * La «DESCRIZIONE DELL'ATTIVITÀ», tutta precompilata dall'evento.
 *
 * Le righe di cui la gita non porta il dato NON compaiono: è la disciplina dei prestampati
 * («mai una riga vuota che sembri un valore»), e su un foglio che autorizza l'uscita di un
 * minore un «Quota: —» si legge come una quota decisa.
 *
 * ⚠️ `Attività in acqua` compare SOLO quando è vera, ed è la riga aggiunta il 2026-08-16:
 * senza, il dato non sopravviveva alla scrittura e il modulo non avrebbe mai chiesto «sa
 * nuotare». Le uscite pubblicate PRIMA di oggi non ce l'hanno e rileggono `false`: è il
 * degrado onesto — la domanda non viene posta — e non si può fare di meglio, perché quel
 * dato in quelle righe non c'è mai stato.
 */
export function componiDescrizioneUscita(u: DescrizioneUscitaInput): string {
  const righe = [
    `${RIGA_TIPO}: ${ETICHETTA_ATTIVITA_USCITA[u.tipo_attivita]}`,
    `${RIGA_DESTINAZIONE}: ${u.destinazione}`,
    `Data: ${dataItalianaUscita(u.data)} · Partenza: ${u.ora_partenza} · Rientro previsto: ${u.ora_rientro}`,
    `${RIGA_MEZZO}: ${ETICHETTA_MEZZO_USCITA[u.mezzo]}`,
  ]
  if (u.attivita_in_acqua) righe.push(`${RIGA_ACQUA}: Sì`)
  if (u.accompagnatori) righe.push(`Accompagnatori: ${u.accompagnatori}`)
  if (u.quota) righe.push(`Quota di partecipazione: ${u.quota}`)
  righe.push(
    'Si ricorda di segnalare eventuali informazioni sanitarie rilevanti già indicate nella scheda sanitaria dell’alunno/a.',
  )
  return righe.join('\n')
}

/** La riga di `eventi_agenda` come arriva da PostgREST, con i soli campi che servono. */
export interface EventoUscita {
  titolo?: string | null
  descrizione?: string | null
  data?: string | null
  orario_inizio?: string | null
  orario_fine?: string | null
}

/** Il valore di una riga «Etichetta: valore» della descrizione, o `null`. */
function valoreRiga(descrizione: string, etichetta: string): string | null {
  for (const riga of descrizione.split('\n')) {
    const t = riga.trim()
    if (t.startsWith(`${etichetta}:`)) return t.slice(etichetta.length + 1).trim() || null
  }
  return null
}

/** Il valore di un enumerato a partire dalla sua etichetta stampata, o `null`. */
function valoreDaEtichetta<T extends string>(
  etichette: Record<T, string>,
  testo: string | null,
): T | null {
  if (!testo) return null
  for (const [valore, etichetta] of Object.entries(etichette) as [T, string][]) {
    if (etichetta === testo) return valore
  }
  return null
}

/** `09:00:00` → `09:00`. Una `time` di Postgres porta i secondi, il foglio no. */
function oraBreve(ora: string | null | undefined): string | null {
  const t = ora?.trim()
  if (!t) return null
  const m = /^([01]\d|2[0-3]):([0-5]\d)/.exec(t)
  return m ? `${m[1]}:${m[2]}` : null
}

/**
 * L'uscita di `eventi_agenda` → i dati che il n. 10 stampa sul foglio, o `null`.
 *
 * ⚠️ `null` VUOL DIRE «QUESTA RIGA NON AUTORIZZA NIENTE», e il chiamante deve trattarlo
 * come «uscita assente»: `verificaContesto` del n. 10 rifiuta senza `dati.uscita`, ma un
 * rifiuto del render arriva DOPO che il genitore ha compilato e speso un codice OTP.
 *
 * ─── LE DUE CONDIZIONI SONO DUE, E FINO AL 2026-08-16 ERANO QUATTRO ─────────────
 *
 * 🔴 Questa funzione pretendeva anche i DUE ORARI, e quella riga spegneva la funzione
 * intera. Misurato, non dedotto: `grep -rn "orario_inizio" src/components src/app` non
 * trova **nessuno** che li scriva su `eventi_agenda` fuori da `agenda:POST`, che li
 * accetta opzionali e li salva `null` (`route.ts:338-339`); l'unica schermata che crea
 * uscite è `TeacherAgendaCard`, e il corpo che manda è
 * `{section_id, titolo, data, tipo, visibile_genitori}` — senza orari. `teacher/uscite:POST`
 * li scrive, ma `grep -rn "api/teacher/uscite" src/` dà **zero** chiamanti. Esito: la
 * segreteria apriva l'agenda, sceglieva «Uscita», salvava, e il n. 10 non compariva **mai**
 * a nessuna famiglia — per costruzione, senza che niente diventasse rosso. La prova in
 * produzione: l'uscita `Gita al museo E2E` ha `orario_fine = NULL`.
 *
 * Le condizioni che restano sono quelle che un ente leggerebbe e che il foglio DICHIARA:
 * **dove si va** e **quando**. Gli orari sono una riga in più quando ci sono, e quando non
 * ci sono il modello non la stampa affatto (`campo()` in `modelli/genitore.ts` salta i
 * valori vuoti, e `blocchiCampi` fa sparire il blocco intero): è la disciplina dei
 * prestampati — «mai una riga vuota che sembri un valore» — che qui vale al contrario, cioè
 * un dato mancante toglie una riga, non un documento.
 *
 * La data e i due orari si prendono dalle COLONNE, non dalla riga «Data: … · Partenza: …»
 * della descrizione: quella riga è la stessa informazione scritta per gli occhi, e leggere
 * un dato dalla sua copia formattata è il modo di ritrovarsi con due verità.
 *
 * `tipo` e `destinazione` degradano sul TITOLO perché un'uscita nasce quasi sempre
 * dall'agenda generica, dove la descrizione è testo libero: là il titolo è l'unica cosa che
 * ha una forma. `Gita: Napoli` porta tipo e destinazione; un titolo senza due punti —
 * `Gita al museo`, che è come una maestra lo scrive — vale **per intero** come
 * destinazione, perché è la frase con cui la scuola quell'uscita l'ha annunciata alle
 * famiglie, e non è un'invenzione di questa funzione. `tipo` sconosciuto vale `altro`, che
 * è una delle cinque voci del cartaceo. Un evento **senza titolo e senza destinazione**
 * resta `null`: lì non c'è niente da scrivere sul foglio.
 */
export function datiUscitaDaEvento(evento: EventoUscita | null | undefined): DatiUscita | null {
  if (!evento) return null

  const data = (evento.data ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return null

  // Opzionali entrambi, e indipendenti: un'uscita che dichiara l'ora di partenza e non
  // quella di rientro stampa la prima. Prima bastava che ne mancasse uno per far sparire
  // il modulo.
  const oraPartenza = oraBreve(evento.orario_inizio)
  const oraRientro = oraBreve(evento.orario_fine)

  const descrizione = evento.descrizione ?? ''
  const titolo = (evento.titolo ?? '').trim()
  const taglio = titolo.indexOf(':')
  const etichettaDalTitolo = taglio > 0 ? titolo.slice(0, taglio).trim() : null
  const codaDelTitolo = taglio > 0 ? titolo.slice(taglio + 1).trim() : titolo

  const destinazione = valoreRiga(descrizione, RIGA_DESTINAZIONE) ?? codaDelTitolo
  if (!destinazione) return null

  const tipoAgenda =
    valoreDaEtichetta(ETICHETTA_ATTIVITA_USCITA, valoreRiga(descrizione, RIGA_TIPO)) ??
    valoreDaEtichetta(ETICHETTA_ATTIVITA_USCITA, etichettaDalTitolo)

  return {
    tipo: tipoAgenda ? TIPO_USCITA_DEL_MODELLO[tipoAgenda] : 'altro',
    destinazione,
    data,
    oraPartenza,
    oraRientro,
    // Nessun `as`: `MezzoUscita` deve restare assegnabile a `MezzoTrasporto`, e se i due
    // elenchi divergono è `tsc` a dirlo — un cast lo terrebbe verde stampando un mezzo che
    // il modello non sa disegnare.
    mezzo: valoreDaEtichetta<MezzoTrasporto>(ETICHETTA_MEZZO_USCITA, valoreRiga(descrizione, RIGA_MEZZO)),
    attivitaInAcqua: valoreRiga(descrizione, RIGA_ACQUA) === 'Sì',
  }
}

/**
 * Questo modello si accende solo se c'è un'uscita pubblicata per la sezione del bambino?
 *
 * Una funzione e non un insieme perché la risposta è una sola e non cambia con la sede: il
 * n. 10 è l'unico dei diciassette il cui contenuto arriva da un evento di calendario.
 */
export function dipendeDallUscita(slug: string): boolean {
  return slug === 'autorizzazione_uscita'
}

// ─── I magazzini, e chi può nominarli ───────────────────────────────────────────

/**
 * Il bucket privato del fascicolo, lo STESSO che serve `student_documents`.
 *
 * Non è una scelta libera: `GET /api/documenti-firmati/dettaglio` firma l'URL di un
 * documento di fonte `fascicolo` leggendo da `sensitive_documents`. Metterlo altrove
 * vorrebbe dire archiviare un PDF che l'Archivio firmati elenca e non riesce ad aprire.
 *
 * ─── ✅ LA REGOLA 6 ORA È RISPETTATA — e prima di questo blocco leggi la data ────
 *
 * `docs/prestampati/README.md` chiede per 05, 06, 07 e 42 — dati sanitari di minori,
 * art. 9 GDPR — un **«bucket con oblio»**. Fino al 2026-08-15 questo non lo era, e non lo
 * diventava scegliendolo: la copertura non è una proprietà del bucket, è una riga di
 * registro più una chiamata. Le due cose ora ci sono, e questo blocco le cita perché la
 * versione precedente dichiarava per iscritto, con tre numeri, il contrario — numeri veri
 * il 14/08 e falsi il giorno dopo. **Rimisurato il 2026-08-16:**
 *
 *  · `grep -c sensitive_documents src/lib/gdpr/esegui.ts` → **6** (era 0);
 *  · `REGISTRO_BUCKET_OBLIO` (`esegui.ts:296`) elenca **quindici** magazzini e questo è uno
 *    di quelli: `stato: 'coperto'`, canale `alunno`;
 *  · `grep -rn student_documents src/lib/gdpr/` → **12 righe** (era nessuna), fra cui
 *    `obliaFascicoloAlunno` e la sua chiamata dentro `anonimizzaAlunno` (`esegui.ts:1821`).
 *
 * Che cosa fa, per non doverlo dedurre: l'aggancio è `student_documents.student_id`, esce il
 * PDF (percorso letto da `storage_path` **oppure** da `file_url`, nell'ordine dei lettori del
 * fascicolo) e sparisce la riga che lo indicizza; il canale GENITORE non lo tocca, ed è una
 * decisione scritta — il fascicolo è del BAMBINO, e la richiesta di un adulto non cancella i
 * dati sanitari di un minore che resta iscritto. Le prove stanno in
 * `__tests__/lib/gdpr-bucket-sensitive.test.ts`, su un archivio finto che toglie davvero.
 *
 * ⚠️ IL LIMITE CHE RESTA, ed è la parte da non dimenticare: **la copertura passa
 * dall'INDICE**. Un PDF che finisce nel bucket senza una riga in `student_documents` non
 * viene raggiunto da nessun oblio — nessuna query lo nomina. Non è teorico: è ciò che
 * produce `ilFileRestaNelBucket` quando l'archiviazione non riesce, ed è il motivo per cui
 * quella regola («il file si toglie solo quando ritentare ha senso») va letta come una
 * decisione di privacy e non solo di robustezza. Chi carica in questo bucket scriva sempre
 * anche la riga, o accetti di lasciare un orfano dell'art. 9.
 */
export const BUCKET_FASCICOLO = 'sensitive_documents'

/**
 * I parametri con cui il bucket CONDIVISO nasce — e il motivo per cui un magazzino che
 * riceve solo PDF dichiara anche tre tipi di immagine.
 *
 * `sensitive_documents` lo usano in cinque (le due porte della famiglia, lo sportello, il
 * fascicolo della primaria e il suo lettore), e lo crea **chi arriva primo**: i parametri di
 * quel primo restano per tutti. Se a crearlo fosse una rotta che carica solo certificati con
 * `['application/pdf']`, il fascicolo della primaria — che carica documenti d'identità in
 * JPEG/PNG/WebP con `contentType: file.type` — comincerebbe a prendere un rifiuto dallo
 * storage per una scelta fatta altrove.
 *
 * Un bucket condiviso è una risorsa di tutti: o si dichiara in un posto solo, o chi lo crea
 * lo crea per il caso di tutti. Questo è il posto solo.
 */
export const BUCKET_FASCICOLO_MIME: readonly string[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]
export const BUCKET_FASCICOLO_MAX = 15 * 1024 * 1024

/**
 * Il magazzino del fascicolo esiste, o si crea — e la risposta dice se ci si può contare.
 *
 * ─── PERCHÉ NON È PIÙ PRIVATA DI UNA ROTTA SOLA ─────────────────────────────────
 *
 * 🔴 Misurato in produzione il 2026-08-16, non dedotto. `storage.buckets` aveva quattordici
 * righe e nessuna era `sensitive_documents`. La rotta della FIRMA garantiva il bucket; quella
 * del CERTIFICATO no, e caricava lo stesso: due POST identici hanno risposto **201** con
 * `documentoId: null`, non hanno lasciato nessuna riga in `student_documents` e hanno
 * consumato **due numeri di protocollo** sullo stesso oggetto e sullo stesso bambino. Il
 * registro è WORM: quei due numeri non tornano indietro. Il certificato ha ricominciato a
 * entrare in archivio solo quando la firma di un altro modulo ha creato il bucket per caso.
 *
 * Una porta che funziona per l'effetto collaterale di un'altra non funziona: funziona finché
 * l'altra viene usata per prima. Da qui la funzione condivisa.
 *
 * ─── L'ESITO SI CONTROLLA, E ORA SI RESTITUISCE ─────────────────────────────────
 *
 * `listBuckets()` e `createBucket()` **ritornano `{ data, error }`** e non lanciano — stessa
 * forma di PostgREST, AGENTS.md regola 7. Un `try/catch` da solo non scatterebbe mai su quel
 * caso, e il corpo dell'errore del provider — la sola cosa che spieghi *perché* i
 * caricamenti falliscono — andrebbe perso (AGENTS.md §3). Il `try/catch` resta per ciò che
 * un'eccezione la solleva davvero (rete, fetch interrotta).
 *
 * ⚠️ IL VALORE DI RITORNO NON OBBLIGA I DUE CHIAMANTI ALLA STESSA REAZIONE, ed è deliberato:
 *
 *  · la porta del **certificato** si ferma, perché il passo successivo consumerebbe un numero
 *    di protocollo che nessuno può restituire — e senza magazzino quel numero servirebbe solo
 *    a bruciarne un altro al clic dopo;
 *  · la porta della **firma** prosegue, perché lì non c'è nessuna numerazione da proteggere e
 *    il foglio firmato ha valore anche non archiviato: la risposta lo consegna alla famiglia
 *    dicendo che è l'unica copia rimasta (`mancatoArchivio*`). Fermarsi butterebbe via una
 *    firma valida per un guasto dell'archivio.
 */
export async function garantisciBucketFascicolo(
  supabase: SupabaseClient,
  operazione: string,
): Promise<boolean> {
  try {
    const { data: elenco, error: erroreElenco } = await supabase.storage.listBuckets()
    if (erroreElenco) {
      logEvento(
        'storage',
        'error',
        { operazione, bucket: BUCKET_FASCICOLO, esito: 'bucket-non-elencato' },
        erroreElenco,
      )
      return false
    }
    if (elenco?.some((b) => b.name === BUCKET_FASCICOLO)) return true

    const { error: erroreCreazione } = await supabase.storage.createBucket(BUCKET_FASCICOLO, {
      public: false,
      allowedMimeTypes: [...BUCKET_FASCICOLO_MIME],
      fileSizeLimit: BUCKET_FASCICOLO_MAX,
    })
    if (erroreCreazione) {
      logEvento(
        'storage',
        'error',
        { operazione, bucket: BUCKET_FASCICOLO, esito: 'bucket-non-creato' },
        erroreCreazione,
      )
      return false
    }
    return true
  } catch (e) {
    logEvento(
      'storage',
      'warn',
      { operazione, bucket: BUCKET_FASCICOLO, esito: 'bucket-non-verificato' },
      e,
    )
    return false
  }
}

/**
 * Il magazzino CON OBLIO in cui la famiglia sa già depositare un allegato, ed è quello che
 * la specifica nomina.
 *
 * `docs/prestampati/06-autorizzazione-farmaci.md:75`: «la prescrizione allegata segue lo
 * stesso bucket con oblio del certificato medico». Quel bucket è questo
 * (`src/app/api/parent/medical-certificates/route.ts:13`), e la porta esiste ed è del
 * genitore: `POST /api/parent/medical-certificates` — multipart, gate `genitoreHasFiglio`,
 * percorso `<alunnoId>/<uuid>.<est>`, riga in `certificati_medici`. È anche fra le quattordici
 * voci di `REGISTRO_BUCKET_OBLIO`: `obliaCertificatiMediciAlunno` ne porta via file e riga
 * quando la famiglia chiede l'oblio — cioè l'esatto contrario del bucket qui sopra.
 */
export const BUCKET_CERTIFICATI = 'certificati-medici'

/**
 * I campi il cui contenuto **è** un certificato sanitario del bambino, e sono i soli che
 * possono nominare l'archivio dei certificati sanitari del bambino.
 *
 * Due nomi, e vengono dai modelli: `prescrizionePath` è la prescrizione del pediatra del
 * n. 06, `certificatoPath` è il certificato medico che il n. 07 pretende quando la dieta è di
 * natura sanitaria. Il terzo campo `file` degli otto modelli — `documentoPath`, la scansione
 * del documento di un delegato del n. 08 — non è di questo genere, ed è il motivo per cui
 * questo insieme esiste (vedi `ALLEGATO_SENZA_PORTA`).
 */
const CAMPI_CERTIFICATO_SANITARIO: ReadonlySet<string> = new Set([
  'prescrizionePath',
  'certificatoPath',
])

/**
 * I magazzini da cui l'allegato di QUEL campo può venire, e nessun altro.
 *
 * ⚠️ PER CAMPO E NON PER ROTTA: un elenco unico `[certificati-medici, fascicolo]` valido per
 * ogni campo `file` renderebbe l'archivio dei certificati sanitari del bambino un deposito
 * generico, buono anche per la carta d'identità della nonna. La regola che decide è una
 * domanda sul CONTENUTO — «questo file è un certificato sanitario di questo bambino?» — e la
 * risposta la dà il nome del campo, che è l'unica cosa che il modello dichiara.
 *
 * Il nome che arriva è quello della FOGLIA (`documentoPath`), non il percorso composto della
 * riga di tabella (`delegati.0.documentoPath`): il campo è lo stesso, l'indice è solo il modo
 * di dire a quale riga del modulo appartiene.
 */
export function magazziniAmmessi(campoFoglia: string): readonly string[] {
  return CAMPI_CERTIFICATO_SANITARIO.has(campoFoglia)
    ? [BUCKET_CERTIFICATI, BUCKET_FASCICOLO]
    : [BUCKET_FASCICOLO]
}

// ─── Gli allegati: una casella spuntata deve corrispondere a un file che esiste ──

/** Un allegato come il modulo lo dichiara: il campo, la sua foglia e la stringa del client. */
export interface AllegatoDichiarato {
  /** Il percorso nel modulo: `prescrizionePath`, oppure `delegati.0.documentoPath`. */
  campo: string
  /** Il nome del campo nel modello, senza l'indice di riga: è ciò che dice CHE COSA è. */
  foglia: string
  valore: string
}

/**
 * Lo stesso allegato dopo la scomposizione: dove sta, e con che chiave si nomina.
 *
 * La stringa grezza non viaggia oltre — chi verifica ha bisogno del magazzino e della chiave:
 * tenersela accanto vorrebbe dire due valori per la stessa cosa, e prima o poi qualcuno
 * userebbe quello sbagliato.
 */
export interface RiferimentoAllegato {
  campo: string
  foglia: string
  bucket: string
  chiave: string
}

/**
 * I valori dichiarati nei campi `file` del modello, letti dalle risposte GIÀ VALIDATE.
 *
 * ─── PERCHÉ NON BASTA CHE LA STRINGA CI SIA ─────────────────────────────────────
 *
 * `zAllegato` (`modelli/genitore.ts`) è `z.string().min(1).max(400)` e la sua doc dice
 * «l'upload lo fa la route, qui arriva la chiave». Senza un controllo, qualunque stringa di
 * un carattere accendeva la casella «Si allega prescrizione medica / piano terapeutico del
 * pediatra» del n. 06 — che il modello spunta per il solo fatto che la stringa non è vuota —
 * e nel fascicolo restava un'autorizzazione firmata a somministrare un farmaco a un minore,
 * che dichiara allegata una prescrizione che nessuno può più recuperare. Stessa forma per il
 * certificato medico del n. 07.
 *
 * ─── DOVE SI GUARDA ─────────────────────────────────────────────────────────────
 *
 * L'allegato porta con sé il proprio magazzino, nella forma qualificata `bucket:chiave`, e
 * una stringa senza `:` vale come chiave del bucket del fascicolo — che è la forma che scrive
 * `primaria/fascicolo:POST`. Chi verifica va a guardare dove il riferimento dice, purché quel
 * magazzino sia fra quelli che `magazziniAmmessi` concede a QUEL campo.
 *
 * ─── PERCHÉ SI CAMMINA SUL MODELLO E NON SU UN ELENCO DI NOMI ───────────────────
 *
 * `prescrizionePath`, `certificatoPath`, `documentoPath` sarebbero tre nomi da tenere
 * allineati a mano con `modelli/genitore.ts`: la seconda descrizione dello stesso modulo,
 * che diverge al primo campo aggiunto. Qui si legge la sola descrizione che esiste — i
 * `campi` del modello, dove `tipo: 'file'` è dichiarato — comprese le colonne delle tabelle
 * `righe` (è lì che vive `documentoPath`).
 *
 * Le risposte arrivano validate dal render: i valori sono stringhe o non ci sono.
 */
export function percorsiAllegati(
  campi: readonly CampoModulo[],
  risposte: unknown,
): AllegatoDichiarato[] {
  if (!risposte || typeof risposte !== 'object') return []
  const r = risposte as Record<string, unknown>
  const trovati: AllegatoDichiarato[] = []

  for (const campo of campi) {
    const valore = r[campo.nome]
    if (campo.tipo === 'file') {
      if (typeof valore === 'string' && valore.trim()) {
        trovati.push({ campo: campo.nome, foglia: campo.nome, valore: valore.trim() })
      }
      continue
    }
    // Le tabelle `righe`: il campo `file` sta in una colonna, e il nome dell'errore deve
    // dire QUALE riga — `delegati.0.documentoPath` — o il form non saprebbe dove metterlo.
    // La `foglia` invece non cambia: è il campo del modello, ed è ciò su cui si decide da
    // quale magazzino quel file può venire.
    if (!campo.colonne || !Array.isArray(valore)) continue
    valore.forEach((riga, i) => {
      for (const dentro of percorsiAllegati(campo.colonne ?? [], riga)) {
        trovati.push({ ...dentro, campo: `${campo.nome}.${i}.${dentro.campo}` })
      }
    })
  }
  return trovati
}

/**
 * Il riferimento scomposto nelle sue due parti.
 *
 * `indexOf` e non `split`: la chiave di un oggetto può contenere altri `:`, e solo il primo
 * separa il magazzino dal resto. Una stringa senza `:` — o che comincia con uno — è una
 * chiave nuda e vale per il bucket del fascicolo, che è la forma storica e quella che
 * `primaria/fascicolo:POST` scrive.
 */
function scomponiRiferimento(valore: string): { bucket: string; chiave: string } {
  const taglio = valore.indexOf(':')
  if (taglio <= 0) return { bucket: BUCKET_FASCICOLO, chiave: valore }
  return { bucket: valore.slice(0, taglio), chiave: valore.slice(taglio + 1) }
}

/** Gli allegati dichiarati, ciascuno col proprio magazzino: è la forma su cui si verifica. */
export function riferimentiAllegati(
  allegati: readonly AllegatoDichiarato[],
): RiferimentoAllegato[] {
  return allegati.map(({ campo, foglia, valore }) => ({
    campo,
    foglia,
    ...scomponiRiferimento(valore),
  }))
}

/**
 * Gli allegati che NON appartengono a questo bambino — il perimetro, prima dell'esistenza.
 *
 * ⚠️ LA STRINGA LA SCEGLIE IL CLIENT, QUINDI IL PERIMETRO È DEL SERVER. `zAllegato`
 * (`modelli/genitore.ts`) è `z.string().min(1).max(400)`: una stringa qualunque, che fino a
 * questo controllo veniva verificata solo per ESISTENZA. Un genitore poteva quindi dichiarare
 * come propria scansione un oggetto qualsiasi — per esempio
 * `<altro-alunno>/prestampati/scheda_sanitaria-<uuid>.pdf` — e la verifica lo trovava.
 *
 * L'exploit pretende di indovinare un percorso che contiene due uuid, quindi oggi non è
 * praticabile; il controllo però è una riga, e vale anche come **oracolo di esistenza**: senza,
 * la differenza fra 422 «non risulta caricato» e 201 dice a chi prova se quel percorso esiste.
 *
 * Due condizioni, e sono tutt'e due di perimetro:
 *
 *  · il **magazzino** dev'essere fra quelli ammessi PER QUEL CAMPO (`magazziniAmmessi`). Un
 *    bucket scelto dal client sarebbe una lettura fatta fare al service-role dove dice lui;
 *  · la **chiave** deve cominciare per `${alunnoId}/`, che è la forma di tutti e tre gli
 *    scrittori: questa rotta (`<alunnoId>/prestampati/…`), `primaria/fascicolo` e la porta dei
 *    certificati medici (`<alunnoId>/<uuid>.<est>`). Un percorso fuori da lì non è «di un
 *    altro bambino» per certo — potrebbe essere spazzatura — ma di sicuro non è di questo, ed
 *    è tutto ciò che serve per rifiutarlo.
 */
export function allegatiFuoriPerimetro(
  allegati: readonly RiferimentoAllegato[],
  alunnoId: string,
): ErroreCampo[] {
  const prefisso = `${alunnoId}/`
  return allegati
    .filter(
      ({ foglia, bucket, chiave }) =>
        !magazziniAmmessi(foglia).includes(bucket) || !chiave.startsWith(prefisso),
    )
    .map(({ campo }) => ({
      campo,
      messaggio:
        'Il file allegato non risulta fra quelli caricati per questo bambino: caricalo di nuovo e riprova.',
    }))
}

// ─── Due letture minute, che non hanno bisogno di nessuna query ─────────────────

/** Il valore testuale di una chiave di primo livello delle risposte, o `null`. */
export function campoTesto(risposte: unknown, chiave: string): string | null {
  if (!risposte || typeof risposte !== 'object') return null
  const v = (risposte as Record<string, unknown>)[chiave]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * Il codice è scaduto: la stessa soglia che `verifyTicket` confronta (`Date.now() >
 * expiry`), letta dal corpo invece che dedotta dalla frase che quella funzione restituisce.
 *
 * Zero, vuoto e non-numero NON sono «scaduto»: per la dipendenza sono «parametri mancanti»,
 * e sono ciò che manda un client rotto — dirgli «richiedine uno nuovo» lo manderebbe a
 * ripetere l'unica cosa che non serve.
 */
export function scaduto(expiry: unknown): boolean {
  const t = Number(expiry)
  return Number.isFinite(t) && t > 0 && Date.now() > t
}

// ─── Che cosa succede al PDF quando l'archivio non lo accetta ───────────────────

/**
 * I codici con cui Postgres/PostgREST dicono «lo SCHEMA non regge», distinti da quelli con
 * cui dicono «adesso non si può».
 *
 * ⚠️ QUESTO INSIEME È LA COPIA DI UN INSIEME CHE VIVE ALTROVE, e va detto perché la copia è
 * proprio il difetto da cui questo file nasce. Il verdetto lo dichiara anche la rotta gemella
 * della segreteria — `SCHEMA_NON_PRONTO` in `src/app/api/prestampati/genera/route.ts:899`,
 * con gli stessi cinque codici — e i due archiviano **lo stesso documento**, con lo stesso
 * `document_type`, nello stesso bucket. Due elenchi che divergono vorrebbero dire due sorti
 * opposte per lo stesso foglio a seconda di chi lo genera, sul 100% del traffico finché
 * `document_type_enum` non è allargato.
 *
 * La casa giusta è una sola ed è `src/app/api/prestampati/banco.ts`, che è già il posto da
 * cui questa strada importa `scadenzaDaRisposte`: là quel modulo è di un'altra mano e si sta
 * scrivendo in parallelo, quindi qui resta la copia — con il lock che la tiene ferma
 * (`__tests__/api/prestampati-genitore.test.ts` confronta l'export della gemella, o in
 * mancanza il suo sorgente). Spostarla è dichiarato all'orchestratore fra le modifiche da
 * fare in file non miei: è **una riga di `export`**, non un lavoro.
 *
 * Perché proprio questi cinque: `22P02` è il valore fuori dall'enumerato, `PGRST204`
 * (colonna non trovata all'INSERT), `42703` (colonna inesistente in SELECT), `42P01`
 * (relazione inesistente) e `PGRST205` (tabella non nel catalogo di PostgREST) sono lo
 * schema di QUELL'AMBIENTE che non è arrivato al livello del codice — il degrado noto del
 * database E2E della CI, non un guasto. `PGRST205` è lo stesso codice che `consumeTicket`
 * (`src/lib/auth/otp-ticket.ts:98`) tratta già come «schema non pronto».
 */
export const SCHEMA_NON_PRONTO: ReadonlySet<string> = new Set([
  '22P02',
  'PGRST204',
  '42703',
  '42P01',
  'PGRST205',
])

/**
 * Perché il foglio firmato non è entrato in archivio. Enumerato: il client non legge prosa.
 *
 * `tipo-documento-non-ammesso` è ciò che accade OGGI sul 100% delle firme
 * (`document_type_enum` non contiene i diciassette slug); `schema-non-pronto` è il DB della
 * CI non migrato; `archivio-non-scritto` è tutto il resto — ed è l'unico dei tre che può
 * andare diversamente al tentativo dopo.
 */
export type MotivoMancatoArchivio =
  | 'tipo-documento-non-ammesso'
  | 'schema-non-pronto'
  | 'archivio-non-scritto'

/**
 * L'enumerato ricavato dal CODICE dell'errore, che è il fatto — non dall'ipotesi su quale
 * sia la causa più probabile.
 *
 * Si legge DALL'INSIEME e non da un `if` parallelo, così «quale motivo» e «il file resta»
 * non possono divergere: sono la stessa domanda posta due volte, ed è precisamente
 * dividendole che si erano invertite.
 *
 * ⚠️ `23514` (violazione di un `check`) NON è più un «tipo di documento non ammesso»: non è
 * fra i cinque della gemella, e chiamarlo così direbbe a chi legge di aspettare una
 * migrazione dell'enumerato per un vincolo che potrebbe essere tutt'altro. Cade fra gli
 * ignoti, che è il gruppo che non promette niente.
 *
 * `null` (nessun codice: il ramo `archiviazione` diverso da `student_documents`, oggi
 * irraggiungibile) cade anch'esso fra gli ignoti.
 */
export function motivoMancatoArchivioDa(code: string | null): MotivoMancatoArchivio {
  if (!SCHEMA_NON_PRONTO.has(code ?? '')) return 'archivio-non-scritto'
  return code === '22P02' ? 'tipo-documento-non-ammesso' : 'schema-non-pronto'
}

/**
 * Il PDF già caricato resta nel bucket, o si toglie?
 *
 * ⚠️ LA REGOLA È QUELLA DELLA GEMELLA (`prestampati/genera:1012`): **il file si toglie solo
 * quando ritentare ha senso**. Se è lo schema a non reggere, riprovare darà lo stesso errore
 * domani e il PDF nel bucket è l'unica copia recuperabile il giorno in cui l'enumerato si
 * allarga; se invece è un singhiozzo — la connessione caduta, il timeout, un vincolo che non
 * conosciamo — il tentativo successivo caricherà un file nuovo, e questo resterebbe orfano
 * per niente. Le due porte archiviano lo stesso documento, con lo stesso `document_type`,
 * nello stesso bucket: due regole diverse vorrebbero dire due sorti per lo stesso foglio a
 * seconda di chi lo genera.
 *
 * 🔴 IL COSTO DEL RAMO «RESTA», detto invece che sottinteso: un PDF nel bucket che nessuna
 * riga nomina è un documento invisibile — `firme_documenti` non ha una colonna di percorso —
 * e `sensitive_documents` non è fra i bucket che l'oblio raggiunge (vedi la testata di
 * `BUCKET_FASCICOLO`, qui sopra). Su questa strada quel file contiene una scheda sanitaria,
 * una terapia o una dieta di un minore. È la ragione per cui la voce mancante in
 * `REGISTRO_BUCKET_OBLIO` è dichiarata **bloccante** e non «da fare»: con questa regola —
 * che è quella giusta — l'orfano dell'art. 9 non è più il caso raro, è il caso normale.
 */
export function ilFileRestaNelBucket(motivo: MotivoMancatoArchivio): boolean {
  return motivo !== 'archivio-non-scritto'
}

// ─── Ciò che la firma del genitore NON rende ancora valido ──────────────────────

/**
 * I modelli che la sola firma della famiglia **non** attiva: manca l'accettazione della
 * Direzione, e finché non c'è il documento non autorizza nessuno a fare niente.
 *
 * Oggi è il n. 06. Non è un'inferenza: `docs/prestampati/README.md:27` dichiara la firma del
 * modello come «OTP + accettazione direzione», e `06-autorizzazione-farmaci.md:69-72` è
 * testuale — «lo stato è `in_attesa_accettazione` finché la Direzione non accetta: un
 * autorizzazione firmata dal solo genitore non abilita nessuno a somministrare niente.
 * All'accettazione → PDF in `student_documents`, `expiry_date = AL`». Il modello stesso
 * lascia il riquadro «Per accettazione — La Direzione» vuoto sul foglio.
 *
 * ⚠️ COME LA ROTTA LO ONORA. Lo stato `in_attesa_accettazione` non esiste:
 * `student_documents` ha `id, student_id, document_type, file_url, expiry_date, created_at,
 * section_id, caricato_da, descrizione, file_name, storage_path` e **nessuna colonna di
 * stato** (baseline, riga 2668) — aggiungerla è una migrazione, vietata in questo lavoro. La
 * `descrizione` non è un ripiego: è testo libero, e nessun consumatore di
 * `student_documents` — elenchi del fascicolo, esportazioni, il cron
 * `notifiche/scadenze-documenti` — può distinguere un'autorizzazione valida da una che non
 * autorizza niente analizzando una frase italiana. Perciò finché lo stato non esiste il n. 06
 * **non entra affatto in `student_documents`**.
 *
 * ⚠️ E NON SALE NEMMENO NEL BUCKET. Non c'è dove scrivere il percorso: `student_documents`
 * non si scrive per scelta, e `firme_documenti` una colonna di percorso non ce l'ha —
 * misurato: `id, utente_id, tipo_documento, impronta_digitale, indirizzo_ip, user_agent,
 * firmato_il`. L'unica traccia sarebbe la riga di `app_log`, che dopo trenta giorni non c'è
 * più: dopo, quel file — farmaco, dosaggio e riferimento alla prescrizione di un minore,
 * art. 9 — resterebbe irraggiungibile **e** incancellabile in un bucket che l'oblio non
 * raggiunge (testata di `BUCKET_FASCICOLO`), sul 100% delle firme del n. 06.
 *
 * Ciò che rende la firma non persa resta: la riga di `firme_documenti` con l'impronta
 * SHA-256, e il foglio consegnato alla famiglia dentro la risposta (`pdfBase64`) con
 * `inAttesaAccettazione: true` — che è comunque l'unica copia che la famiglia riceve con
 * certezza, perché nessun elenco nominerebbe quel documento.
 *
 * 🔴 IL PREZZO, dichiarato: l'autorizzazione firmata non compare nell'«Archivio firmati»
 * della famiglia, e la Direzione non ha una copia sua da cui lavorare. Torneranno insieme,
 * il giorno in cui esisterà il passo di accettazione — che **non esiste** ed è dichiarato
 * all'orchestratore fra le funzioni mancanti, con questa evidenza: la sorte del PDF si decide
 * lì, insieme alla schermata che lo accetta e alla riga durevole che lo nomina.
 */
export function attesaAccettazioneDirezione(slug: string): boolean {
  return slug === 'autorizzazione_farmaci'
}

// ─── Quando scade il documento archiviato ───────────────────────────────────────

/**
 * I modelli la cui scadenza NON sta nelle risposte ma nel calendario scolastico.
 *
 * Oggi è il solo n. 05. `docs/prestampati/05-scheda-sanitaria.md:78-79` è testuale: «PDF in
 * `student_documents` con `document_type = 'scheda_sanitaria'`, `expiry_date` = fine anno
 * scolastico (va riconfermata ogni anno)».
 *
 * ⚠️ ESISTE PERCHÉ LA REGOLA CONDIVISA NON POTEVA SAPERLO. `scadenzaDaRisposte`
 * (`src/app/api/prestampati/banco.ts`) legge `al`, `ricorrenzaFino` e `giorno`, e nello schema
 * della scheda sanitaria non c'è nessuno dei tre: il risultato era `null` SEMPRE, cioè una
 * scheda sanitaria archiviata come se non scadesse mai. Non era una deviazione dichiarata come
 * quella del n. 07 — era un valore che nessuno aveva calcolato, e il cron
 * `notifiche/scadenze-documenti` non avrebbe mai chiesto la riconferma annuale su cui la
 * regola 3 del README si appoggia.
 */
export function scadeAFineAnnoScolastico(slug: string): boolean {
  return slug === 'scheda_sanitaria'
}

/**
 * L'ultimo giorno dell'anno scolastico indicato, in `YYYY-MM-DD`, o `null`.
 *
 * ⚠️ IL 31 LUGLIO, E NON IL 30 GIUGNO O IL 31 AGOSTO: il confine lo fissa già
 * `annoScolasticoCorrente()` (`src/lib/anno-scolastico.ts`), che passa all'anno nuovo il **1°
 * agosto** — «agosto fa già da ponte verso il nuovo anno». Prendere una data diversa
 * significherebbe che per qualche settimana `annoScolastico` dice un anno e `expiry_date` ne
 * dichiara un altro, sullo stesso foglio.
 *
 * Il formato in ingresso è quello che il precompilato compone (`2026/2027`); qualunque altra
 * forma dà `null`, che è ciò che vale sempre: meglio un documento senza scadenza di un
 * documento con una scadenza inventata da una stringa non riconosciuta.
 */
export function fineAnnoScolastico(annoScolastico: string | null | undefined): string | null {
  const m = /^(\d{4})\/(\d{4})$/.exec((annoScolastico ?? '').trim())
  if (!m) return null
  const inizio = Number(m[1])
  const fine = Number(m[2])
  // `2026/2027` e non `2026/2029`: due anni consecutivi, o la stringa non descrive un anno
  // scolastico e la scadenza sarebbe una data scelta a caso.
  if (fine !== inizio + 1) return null
  return `${fine}-07-31`
}

// ─── Il riscarico e l'anno scolastico ───────────────────────────────────────────

/**
 * L'anno scolastico di un giorno civile `YYYY-MM-DD`, o `null` se non è una data.
 *
 * Stessa regola di `annoScolasticoCorrente()` (`src/lib/anno-scolastico.ts`): il confine è
 * il **1° agosto**, «agosto fa già da ponte verso il nuovo anno». Qui però si parte da una
 * data invece che da `new Date()`, perché la domanda è su un documento del passato.
 */
export function annoScolasticoDelGiorno(giorno: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec((giorno ?? '').trim())
  if (!m) return null
  const anno = Number(m[1])
  const mese = Number(m[2])
  return mese >= 8 ? `${anno}/${anno + 1}` : `${anno - 1}/${anno}`
}

/**
 * Il riscarico di questo modello è legato all'anno scolastico?
 *
 * 🔴 IL DIFETTO CHE QUESTA FUNZIONE CHIUDE, ed è un difetto che si vede solo fra un anno.
 * Il riuso cercava il documento archiviato **col solo `document_type`**, sulla riga più
 * recente di sempre. Ma il certificato di iscrizione e frequenza DICE l'anno: «risulta
 * regolarmente iscritto/a … per l'anno scolastico 2026/2027» — letto sul PDF vero
 * `certificato_iscrizione_frequenza` archiviato in produzione, prot. 0000006/2026. A
 * settembre 2027 lo stesso genitore avrebbe premuto «Scarica il certificato», il pulsante
 * primario, e ottenuto quel foglio: una dichiarazione falsa sull'anno in corso, diretta a
 * un datore di lavoro o all'INPS. Il testo d'aiuto scaricava la responsabilità sul genitore
 * («generane uno nuovo se un ente lo vuole recente»), cioè affidava a una scelta umana un
 * fatto che il server conosce già.
 *
 * ⚠️ VALE SOLO SUI CERTIFICATI, e la distinzione è la parte importante: i sei moduli che
 * firma la FAMIGLIA (05 scheda sanitaria, 07 dieta, 09 permesso…) restano riscaricabili
 * **sempre**, perché sono il fatto di quel giorno — una scheda sanitaria firmata a marzo
 * resta la scheda sanitaria firmata a marzo, e toglierla dall'archivio l'anno dopo sarebbe
 * il difetto opposto (W4.4: «riscaricabili SEMPRE dall'elenco»). Il criterio è chi
 * sottoscrive: se firma il legale rappresentante, la Scuola sta CERTIFICANDO qualcosa
 * dell'anno in corso.
 */
export function riusoLegatoAllAnnoScolastico(voce: VocePrestampato): boolean {
  return voce.firma === 'legale_rappresentante'
}

/**
 * Il documento archiviato appartiene all'anno scolastico indicato?
 *
 * `student_documents` non ha una colonna per l'anno — undici colonne, misurate sullo schema
 * di produzione il 2026-08-16 — quindi si passa da `created_at`, che è l'istante in cui il
 * certificato è stato emesso e stampato in calce sul foglio stesso.
 *
 * ⚠️ IL GIORNO È QUELLO CIVILE ITALIANO (`dataCivile`, `Europe/Rome`), non `iso.slice(0,10)`:
 * il runtime su Vercel gira in UTC, e fra mezzanotte e le due sono due giorni diversi. Sul
 * 1° agosto — cioè esattamente il confine fra due anni scolastici — quelle due ore
 * deciderebbero se un certificato è di quest'anno o dell'anno scorso. È la stessa misura già
 * pagata in questo repo il 2026-08-01 alle 01:08 (un incasso vero sparito da un KPI perché
 * il server contava in UTC).
 *
 * Un istante illeggibile risponde `false`, cioè «non è di quest'anno»: il verso in cui si
 * sbaglia si sceglie, e fra riemettere un certificato e consegnarne uno che dichiara l'anno
 * sbagliato a un ente pubblico, il costo del primo è un numero di protocollo.
 */
export function documentoDellAnnoScolastico(
  creatoIl: string | null | undefined,
  annoScolastico: string | null | undefined,
): boolean {
  const atteso = (annoScolastico ?? '').trim()
  if (!atteso) return false
  if (typeof creatoIl !== 'string' || creatoIl.trim() === '') return false
  const istante = new Date(creatoIl)
  if (Number.isNaN(istante.getTime())) return false
  return annoScolasticoDelGiorno(dataCivile(istante)) === atteso
}

// ─── I moduli che la morosità non blocca ────────────────────────────────────────

/**
 * L'elenco PREDEFINITO dei moduli che restano firmabili anche da un genitore SOSPESO.
 *
 * ⚠️ È UN VALORE DI PARTENZA, NON LA REGOLA. La regola è di credito, non di codice: quali
 * moduli la scuola non blocca mai lo decide il titolare, e finché non lo dice questo elenco è
 * ciò che si applica. Perché non resti una decisione presa dentro una rotta, si legge da
 * `admin_settings.modulistica_config.prestampati_sempre_firmabili` — la stessa colonna jsonb
 * per sede da cui la modulistica legge già `promemoria_giorni` (`sempreFirmabiliDa` qui sotto).
 *
 * DOVE SI CAMBIA, detto con precisione invece che promesso: la chiave si scrive nel jsonb —
 * `PATCH /api/admin/settings` la accetta, perché `modulistica_config` è fra le colonne
 * ammesse — e **non si perde** passando dal pannello, perché `ModulisticaSettings.tsx`
 * ricompone il draft a partire dall'oggetto intero (`{ ...cfg, ...patch }`). Ciò che oggi NON
 * c'è è un controllo visibile con cui la Direzione la modifichi da sé: è un campo da
 * aggiungere a quel componente, che è file di un'altra mano ed è segnalato
 * all'orchestratore. Cambiarla, comunque, non è un rilascio.
 *
 * Il criterio con cui questi tre sono stati scelti, e chi l'ha scelto: per ANALOGIA con
 * `forms_templates.sempre_firmabile` — il flag che in `@/lib/forms/sempre-firmabile.ts`
 * protegge «i consensi che non si possono bloccare: autorizzazioni mediche, sicurezza». Non si
 * legge da lì e non si può: quel flag vive su una riga di `forms_templates`, e un prestampato
 * una riga in quella tabella non ce l'ha. La regola 6 di `docs/prestampati/README.md` dice
 * un'altra cosa — che 05, 06 e 07 portano dati sanitari di minori — e non nomina né la
 * morosità né la firmabilità: presentare l'inferenza come una riga del README manderebbe chi
 * rilegge a cercare una frase che non c'è.
 *
 * Il merito, comunque: bloccare a una famiglia in ritardo con la retta l'autorizzazione a
 * somministrare un farmaco al proprio figlio non è una leva di recupero crediti, è un rischio
 * che ricade sul bambino.
 */
export const SEMPRE_FIRMABILI_PREDEFINITI: readonly string[] = [
  'scheda_sanitaria',
  'autorizzazione_farmaci',
  'dieta_speciale',
]

/** La chiave, dentro `admin_settings.modulistica_config`, con cui la sede riscrive l'elenco. */
export const CHIAVE_SEMPRE_FIRMABILI = 'prestampati_sempre_firmabili'

/**
 * L'elenco effettivo per questa sede: quello configurato, o il predefinito.
 *
 * ⚠️ SI ACCETTA ANCHE L'ELENCO VUOTO, ed è il punto: `[]` scritto in configurazione vuol dire
 * «questa sede non fa eccezioni», ed è una risposta legittima del titolare. Solo l'ASSENZA
 * della chiave — o un valore che non è un elenco di stringhe — ricade sul predefinito.
 *
 * Una configurazione ILLEGGIBILE arriva qui come assenza (`getModuleConfig` restituisce `{}` e
 * logga il proprio `warn` con la colonna e la sede), quindi ricade sul predefinito: è una
 * scelta, e la ragione è la stessa del merito qui sopra — un singhiozzo nella lettura delle
 * impostazioni non può impedire a un genitore di autorizzare un farmaco per suo figlio.
 */
export function sempreFirmabiliDa(config: unknown): ReadonlySet<string> {
  const valore = (config as Record<string, unknown> | null | undefined)?.[CHIAVE_SEMPRE_FIRMABILI]
  if (!Array.isArray(valore) || valore.some((v) => typeof v !== 'string')) {
    return new Set(SEMPRE_FIRMABILI_PREDEFINITI)
  }
  return new Set((valore as string[]).map((s) => s.trim()).filter(Boolean))
}

/**
 * La frase che accompagna il rifiuto: dice che cosa manca e a chi tocca, non solo che qui
 * non si fa.
 *
 * ⚠️ NON è esportata, a differenza della gemella `SPIEGAZIONE_NON_GENERABILE` di
 * `banco.ts`, che il pannello della segreteria riceve dentro l'elenco. La differenza è la
 * platea: quel pannello è dello sportello e parla italiano, questa risposta arriva a
 * un'app BILINGUE, e mandare prosa del server dentro una schermata inglese è il difetto F1
 * del collaudo del 2026-07-31. Di qui esce `motivoNonFirmabile`, che è un enumerato e si
 * traduce nel client; la frase resta nel corpo del 409, dove il campo `error` è già la
 * prosa di servizio che il client sostituisce con la voce di catalogo del `codice`.
 *
 * Le voci di catalogo ci sono, in `it` e in `en`: `nonFirmabile*` per `MotivoNonFirmabile`,
 * `mancatoArchivio*` per `MotivoMancatoArchivio`. Finché ci sono, la prosa qui sotto non
 * arriva mai a schermo: è la rete di sicurezza del `codice`, non il testo che l'utente legge.
 *
 * ⚠️ Qui c'era un conteggio di chiavi — «61 voci, nessuna comincia per `nonFirmabile`» — e in
 * un giorno era già falso. Non rimettercelo. Un numero dentro un commento non si aggiorna da
 * sé, e quando smette di essere vero non diventa muto: continua ad affermare, e chi legge gli
 * crede. La misura che conta la fa il lock i18n a ogni esecuzione della suite, che è il posto
 * dove una verifica resta vera da sola.
 */
const SPIEGAZIONE_NON_FIRMABILE: Record<MotivoNonFirmabile, string> = {
  'firma-della-scuola':
    'Questo documento non si firma con il codice del genitore: lo sottoscrive il legale rappresentante della Scuola.',
  'seconda-firma-mancante':
    'La delega al ritiro va sottoscritta da entrambi i genitori/tutori e la raccolta della seconda firma non è ancora attiva: per ora la delega si consegna in segreteria.',
  /**
   * ⚠️ LA FRASE DICE DUE COSE, e la seconda è la deviazione del n. 08 dal testo della
   * specifica («i delegati diventano attivi in `delegates` — non prima», punto 2 di
   * `08-delega-ritiro.md`): oggi una delega a TERMINE non attiverebbe nessuno nemmeno da
   * firmata, perché `delegates` non ha la colonna `valido_al` e una delega a scadenza
   * scritta lì dentro diventerebbe permanente in silenzio. Chi legge deve saperlo **prima**
   * di compilare il modulo, non dopo averlo firmato — ed è per questo che sta nel rifiuto
   * che spegne il pulsante e non in un avviso a fondo pagina.
   */
  'allegato-non-caricabile':
    'La delega al ritiro richiede la scansione del documento di ogni persona delegata, e oggi non c’è ancora un modo per caricarla dall’app: la delega si consegna in segreteria. Una delega a termine, per lo stesso motivo, non attiverebbe comunque nessuno.',
}

// ─── I rifiuti ──────────────────────────────────────────────────────────────────

/**
 * ⚠️ DUE CODICI RIUSATI PER SETTE SITUAZIONI, dichiarato qui una volta per tutte — ed è il
 * motivo per cui tutti i rifiuti delle due porte stanno in questo file e non nelle rotte.
 *
 * `CODICI_ERRORE` (`src/lib/ui/esito-fetch.ts`) non ha ancora un nome per: «l'uscita non
 * esiste», «manca la seconda firma», «l'allegato non si può caricare», «non sei tu a
 * firmare», «il codice è sbagliato o scaduto», «quel codice l'hai già speso», «non abbiamo un
 * indirizzo a cui mandartelo». Le prime sei escono con `PRESTAMPATO_FIRMA_NON_VALIDA`,
 * l'ultima con `PRESTAMPATO_DATI_MANCANTI`. I codici loro —
 * `PRESTAMPATO_USCITA_NON_CREATA`, `PRESTAMPATO_SECONDA_FIRMA_MANCANTE`,
 * `PRESTAMPATO_ALLEGATO_NON_CARICABILE`, `PRESTAMPATO_FIRMA_SOLO_GENITORE`,
 * `PRESTAMPATO_OTP_NON_VALIDO`, `PRESTAMPATO_OTP_GIA_USATO`, `PRESTAMPATO_EMAIL_MANCANTE` —
 * vanno dichiarati in quel file e tradotti nei due cataloghi, che sono di altre mani e si
 * stanno modificando in parallelo (segnalato all'orchestratore).
 *
 * Fino ad allora si riusano codici ESISTENTI la cui frase di catalogo è VERA nel caso in cui
 * la si manda, mai una risposta senza codice: senza codice il client ricade sulla prosa
 * italiana del server, ed è il difetto F1 del collaudo del 2026-07-31 riaperto in una
 * schermata nuova.
 *
 * La differenza fine viaggia in enumerati — `motivoNonFirmabile`, `motivo` — che non hanno
 * bisogno di essere tradotti. E il primo non si chiama `motivo`: quella chiave in queste
 * rotte dice già un'altra cosa (perché l'OTP è stato rifiutato), e due significati sotto lo
 * stesso nome si leggono sbagliati una volta e non si rileggono mai più.
 */
export function nonFirmabileOra(motivo: MotivoNonFirmabile): NextResponse {
  return NextResponse.json(
    {
      error: SPIEGAZIONE_NON_FIRMABILE[motivo],
      codice: 'PRESTAMPATO_FIRMA_NON_VALIDA',
      motivoNonFirmabile: motivo,
    },
    { status: 409 },
  )
}

/**
 * Il rifiuto a chi non è un genitore, uguale su tutte e tre le porte.
 *
 * 🔴 IL CODICE È RIUSATO E SUL GET È FALSO. Non è una scelta difendibile fino in fondo, e
 * dirla per intero è l'unica cosa che questo commento può fare: `PRESTAMPATO_FIRMA_NON_VALIDA`
 * ha come frase di catalogo «la firma non risulta raccolta o non è valida: il documento non si
 * genera prima della firma» (`messages/it/shared.json`). Sulle due porte della FIRMA è vera —
 * da una sessione che non è quella del genitore la firma della famiglia non è raccoglibile. Sul
 * GET dell'ELENCO no: lì non si firma niente, e a chi ha chiesto un elenco si risponde
 * parlandogli di una firma che in quella richiesta non c'entra.
 *
 * PERCHÉ NON È RIPARATO QUI. Il codice suo — `PRESTAMPATO_FIRMA_SOLO_GENITORE`, «questi moduli
 * li firma e li consulta il genitore: dallo sportello si usa il pannello della segreteria» —
 * si dichiara in `src/lib/ui/esito-fetch.ts` e si traduce in `messages/it/shared.json` e
 * `messages/en/shared.json`: **tre file di altre mani**, e il lock
 * `__tests__/architecture/errori-con-codice.test.ts` pretende che un codice nuovo sia
 * dichiarato E tradotto in tutte e due le lingue nello stesso colpo — usarne uno non
 * dichiarato renderebbe rosso il gate, e rispondere senza codice è vietato in un file nuovo
 * dalla regola 4 dello stesso lock. Le tre righe da aggiungere sono scritte qui sopra alla
 * lettera: dichiarato all'orchestratore, e da usare **su tutte e tre le porte** insieme.
 *
 * Sta qui e non nelle due rotte perché era scritto due volte alla lettera, commento compreso:
 * una copia dentro lo stesso lavoro, che è la forma di difetto meno difendibile.
 */
export function soloFamiglia(): NextResponse {
  return NextResponse.json(
    {
      error:
        'Questi moduli li firma il genitore con il proprio codice OTP: dallo sportello si usa il pannello della segreteria.',
      codice: 'PRESTAMPATO_FIRMA_NON_VALIDA',
    },
    { status: 403 },
  )
}

/** Lo slug che il banco della famiglia non ha: un 404, non un elenco filtrato male. */
export function sconosciuto(): NextResponse {
  return NextResponse.json(
    {
      error: 'Questo modulo non è fra i prestampati disponibili alla famiglia.',
      codice: 'PRESTAMPATO_SCONOSCIUTO',
    },
    { status: 404 },
  )
}

/** Non c'è un indirizzo a cui mandare il codice: è l'anagrafica da correggere, non la firma. */
export function emailMancante(): NextResponse {
  return NextResponse.json(
    {
      error:
        'Nell’anagrafica non c’è un indirizzo email a cui mandare il codice di firma: scrivi alla segreteria per aggiungerlo.',
      codice: 'PRESTAMPATO_DATI_MANCANTI',
    },
    { status: 422 },
  )
}

/**
 * Il 422 «correggi questi campi», in un posto solo.
 *
 * Lo usano il rifiuto del render e il controllo degli allegati: sono due sorgenti diverse
 * per la stessa risposta — un modulo che va corretto prima di poter essere firmato — e
 * scriverne due copie voleva dire due `codice` da tenere d'accordo a mano.
 */
export function campiDaCorreggere(errori: readonly ErroreCampo[]): NextResponse {
  return NextResponse.json(
    {
      error: 'Il modulo non è completo: correggi i campi segnalati e riprova.',
      codice: 'PRESTAMPATO_DATI_MANCANTI',
      errori,
    },
    { status: 422 },
  )
}

/**
 * Il rifiuto del render, tradotto in una risposta HTTP con un `codice` LETTERALE.
 *
 * Il `codice` non si inoltra come variabile (`codice: esito.codice`) di proposito: il lock
 * `__tests__/architecture/errori-con-codice.test.ts` non saprebbe leggerlo, e un valore che
 * il lock non legge è un valore che nessuno confronta più né con `CODICI_ERRORE` né con i
 * cataloghi. Uno `switch` con quattro rami costa quattro righe e resta verificabile.
 *
 * Gli errori di CAMPO (`campo` valorizzato) non hanno un codice loro — non c'è una frase
 * sola da tradurre, ce n'è una per campo — e viaggiano in `errori`, che il form mostra
 * accanto al campo sbagliato.
 */
export function rifiutoDelRender(
  esito: Extract<EsitoRender<unknown>, { ok: false }>,
): NextResponse {
  const errori = esito.errori
  switch (esito.codice) {
    case 'PRESTAMPATO_FIRMA_NON_VALIDA':
      return NextResponse.json(
        { error: errori[0]?.messaggio ?? 'Firma non valida', codice: 'PRESTAMPATO_FIRMA_NON_VALIDA', errori },
        { status: 409 },
      )
    case 'PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE':
      return NextResponse.json(
        {
          error: errori[0]?.messaggio ?? 'Protocollo da dichiarare',
          codice: 'PRESTAMPATO_PROTOCOLLO_DA_DICHIARARE',
          errori,
        },
        { status: 409 },
      )
    case 'PRESTAMPATO_SCONOSCIUTO':
      return sconosciuto()
    case 'PRESTAMPATO_NON_GENERATO':
      return NextResponse.json(
        { error: errori[0]?.messaggio ?? 'Documento non generato', codice: 'PRESTAMPATO_NON_GENERATO', errori },
        { status: 500 },
      )
    default:
      // Errori di campo: il modulo va corretto, non il contesto. `PRESTAMPATO_DATI_MANCANTI`
      // dice esattamente questo — «mancano dei dati che il documento deve riportare» — e
      // l'elenco puntuale sta in `errori`.
      return campiDaCorreggere(errori)
  }
}
