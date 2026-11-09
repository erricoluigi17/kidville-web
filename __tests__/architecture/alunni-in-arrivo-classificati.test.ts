import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileSorgente, mascheraSorgente } from '../fixtures/sorgente'
import { contenitoreDi, lettureAlunni } from './elenchi-operativi-solo-iscritti.test'

/**
 * COMPITO 4.5.4 · CHI LEGGE `alunni`, E CHE COSA FA QUANDO C'È UN BAMBINO «IN ARRIVO».
 *
 * Un `alunni.stato = 'in_arrivo'` è il bambino la cui domanda è per l'anno dopo: ha una scheda, una sede, e nient'altro — niente
 * sezione, niente frequenza dell'anno attivo. Ogni punto del codice che legge `alunni` si comporta, davanti a lui, in uno di
 * tre modi, e questo lock li ha classificati TUTTI, uno per uno, invece di credere che «filtra già per stato».
 *
 *   `no`     oggi lo includerebbe e non deve: è un difetto, e sta nell'elenco DA_CORREGGERE.
 *   `no-già` resta fuori da solo, e la ragione è scritta (MOTIVI): filtra per sezione, per uno stato di tendina, o legge
 *            una scheda sola di cui qualcuno ha già l'id.
 *   `sì`     deve vederlo: la ricerca della segreteria, l'anagrafica, l'oblio, le ricevute. Se oggi lo ESCLUDE è un difetto
 *            anche questo, e sta in DA_CORREGGERE.
 *
 * ─── PERCHÉ LA LEVA È LA SEZIONE, E PERCHÉ NON BASTA ─────────────────────────
 * Un bambino esce dagli elenchi staccandosi dalla sezione (`section_id`/`classe_sezione` NULL): lo dice la testata di
 * `20260812194517_alunni_archiviazione`. L'`in_arrivo` ha la stessa impronta, quindi ogni elenco filtrato per sezione lo esclude
 * da solo (`sezione`). Gli elenchi che NON filtrano per sezione né per stato — l'elenco della segreteria, le sonde, i gate
 * costruiti sulla negazione «non è ritirato» — lo includono: sono i `no`. È anche l'impronta di un bambino ritirato, e di qui
 * il rischio più serio: «Non iscritti» = ritirato OPPURE senza sezione, quindi un bambino che ha appena fatto domanda
 * comparirebbe fra gli ex alunni, con il pulsante «Elimina definitivamente».
 *
 * ─── COME SI LEGGE ───────────────────────────────────────────────────────────
 * La chiave è `<percorso>::<contenitore>` (la stessa dell'allowlist di `elenchi-operativi-solo-iscritti`): niente numero di
 * riga, perché una voce che scade quando qualcuno aggiunge un `import` non è una decisione. Tre famiglie:
 *   · le LETTURE (e le scritture) `.from('alunni')`, trovate dallo stesso lettore di quel lock;
 *   · le letture INCORPORATE, `.select('…, alunni!inner(…)')`, chiave con `#incorporata`: la tabella di partenza decide
 *     quali bambini compaiono, e un `in_arrivo` non ha righe nelle tabelle operative (presenze, diario, armadietto…);
 *   · le funzioni SQL VIVE che toccano `alunni` (l'ultima definizione in `supabase/migrations/`), chiave `sql::<funzione>`.
 *
 * Una lettura NUOVA rende rosso: nessuno scrive un elenco di bambini senza aver deciso che cosa fa davanti a un `in_arrivo`.
 *
 * ─── CHE COSA NON È ──────────────────────────────────────────────────────────
 * Non corregge niente: i `no` sono la lista di lavoro del compito 4.5.4-bis. Le funzioni SQL che dicono `alunni` senza un
 * `FROM/JOIN/UPDATE/INTO` (un nome in una stringa generica, come `dati_prova_fuori_sede`) non si vedono; e un elenco di id che
 * arriva da un'altra tabella è classificato dall'origine dichiarata (`ids`), non rintracciata caso per caso.
 */

export type Esito = 'no' | 'no-già' | 'sì'

/** Le ragioni, scritte una volta sola. Ogni voce della classificazione ne cita una. */
export const MOTIVI = {
  // ─ no-già
  stato: 'filtra per uno stato di tendina (iscritto, sospeso, ritirato): `in_arrivo` non è nell’elenco chiuso',
  sezione: 'filtra per sezione o classe: l’`in_arrivo` non ne ha, quindi non entra',
  puntuale: 'legge UNA scheda di cui il chiamante ha già l’id: non produce elenchi né conteggi',
  ids: 'riceve un elenco di id da un’altra tabella (legami, thread, pagamenti, presenze): l’`in_arrivo` ci entra solo se quella tabella lo contiene',
  scrittura: 'scrive una scheda per id o ne crea una: non è un elenco',
  'stato-di-default': 'filtra per `stato = iscritto` quando non ha una richiesta esplicita della segreteria di includere chi non frequenta',
  'filtro-nel-codice': 'il filtro per stato e sezione è nel codice che usa le righe, subito dopo la lettura',
  sospensione: 'filtra sulla sospensione per morosità, che nasce da un pagamento scaduto e non da un’iscrizione futura',
  'incorporata-da-tabella-operativa': 'la tabella di partenza (presenze, diario, armadietto, chat, mensa) non ha righe per un bambino che non frequenta',
  'funzione-puntuale': 'funzione SQL che legge la sede o il nome di una scheda per id',
  'funzione-per-stato': 'funzione SQL che filtra per `stato` o per `alunno_uscita_consolidata`',
  'funzione-per-sezione': 'funzione SQL che agisce solo sulle schede che hanno una sezione',
  // ─ sì
  ricerca: 'la ricerca (nome, codice fiscale, doppioni, documenti citati) deve trovarlo, o creerebbe un doppione',
  anagrafica: 'l’anagrafica e le sue azioni (scheda, archivia, riattiva, elimina, legami, sanitari, modulistica) lo riguardano',
  oblio: 'l’oblio e il diritto all’accesso lo riguardano: una famiglia può chiederli prima che il bambino cominci',
  ricevute: 'le quote, le ricevute e le riconciliazioni di un bambino in arrivo esistono già (la quota di iscrizione)',
  diagnostica: 'strumento di diagnostica: deve mostrare quello che c’è nella tabella',
  'funzione-di-anno': 'funzione SQL dell’anno scolastico che deve conoscerlo (specchio, invarianti, riallineamento, voci della famiglia)',
  // ─ no
  'elenca-tutti': 'elenca o conta le schede della sede senza filtrare per stato né per sezione',
  'gate-negativo': 'è un gate costruito sulla negazione «non è ritirato» (`eNonPiuIscritto`): lo lascia passare',
  'sonda-stati': 'conta gli stati fuori dall’elenco della tendina e li registra come anomalia',
  'figli-collegati': 'parte da `getFigliDiGenitore` (tutti i legami), non da `getFigliAttiviDiGenitore`: la famiglia lo riceve',
  'riempimento-senza-stato': 'rilegge tutte le schede della sede e ne ricava una frequenza dell’anno attivo',
  'guardia-senza-sezione': 'tratta «senza sezione» come «non frequentante»',
  // ─ no-già, dopo il 4.5.4-bis
  'esclude-in-arrivo': 'esclude `in_arrivo` per nome (filtro per stato, o rifiuto con un codice proprio): lo ha deciso il 4.5.4-bis',
  'oblio-dopo-archiviazione': 'l’oblio tratta un bambino in arrivo da iscritto: lo si archivia prima (diventa «ritirato») e poi lo si anonimizza, come per chi frequenta',
  'funzione-tolta': 'la funzione non esiste più (un `DROP FUNCTION` successivo, che il censimento non vede): non c’è niente da correggere',
} as const
export type Motivo = keyof typeof MOTIVI

type Voce = readonly [Esito, Motivo]

/** Le letture e le scritture `.from('alunni')`. */
const LETTURE: Record<string, Voce> = {
  'src/app/api/admin/anagrafiche/codici-fiscali/route.ts::admin/anagrafiche/codici-fiscali:GET': ['sì', 'ricerca'],
  'src/app/api/admin/chat/contacts/route.ts::admin/chat/contacts:GET': ['no-già', 'stato'],
  'src/app/api/admin/chat/messages/route.ts::admin/chat/messages:GET': ['no-già', 'puntuale'],
  'src/app/api/admin/chat/messages/scarico/route.ts::admin/chat/messages/scarico:POST': ['no-già', 'puntuale'],
  'src/app/api/admin/chat/rettifica/route.ts::admin/chat/rettifica:PATCH': ['no-già', 'puntuale'],
  'src/app/api/admin/chat/threads/route.ts::admin/chat/threads:GET': ['no-già', 'ids'],
  'src/app/api/admin/chat/vigilanza/route.ts::admin/chat/vigilanza:GET': ['no-già', 'ids'],
  'src/app/api/admin/competenze/route.ts::admin/competenze:POST': ['no-già', 'sezione'],
  'src/app/api/admin/crm/alunni/route.ts::admin/crm/alunni:GET': ['sì', 'ricerca'],
  'src/app/api/admin/dashboard/route.ts::admin/dashboard:GET': ['no-già', 'stato'],
  'src/app/api/admin/debug-mensa-auth/route.ts::admin/debug-mensa-auth:GET': ['sì', 'diagnostica'],
  'src/app/api/admin/documents-merge/route.ts::admin/documents-merge:GET': ['no-già', 'sezione'],
  'src/app/api/admin/gdpr/candidates/route.ts::admin/gdpr/candidates:GET': ['no-già', 'esclude-in-arrivo'],
  'src/app/api/admin/gdpr/erase/route.ts::admin/gdpr/erase:POST': ['no-già', 'oblio-dopo-archiviazione'],
  'src/app/api/admin/gdpr/richieste/route.ts::admin/gdpr/richieste:GET': ['no-già', 'oblio-dopo-archiviazione'],
  'src/app/api/admin/gdpr/richieste/route.ts::admin/gdpr/richieste:POST': ['no-già', 'oblio-dopo-archiviazione'],
  'src/app/api/admin/import/anagrafiche/route.ts::admin/import/anagrafiche:POST': ['sì', 'ricerca'],
  'src/app/api/admin/iscrizioni/elenco/export/route.ts::admin/iscrizioni/elenco/export:GET': ['no-già', 'stato'],
  'src/app/api/admin/iscrizioni/route.ts::admin/iscrizioni:PATCH': ['sì', 'ricerca'],
  'src/app/api/admin/legami-familiari/route.ts::admin/legami-familiari:GET': ['sì', 'ricerca'],
  'src/app/api/admin/legami-familiari/route.ts::admin/legami-familiari:POST': ['sì', 'anagrafica'],
  'src/app/api/admin/merch/ordini/route.ts::admin/merch/ordini:POST': ['no-già', 'puntuale'],
  'src/app/api/admin/pagamenti/sospensione/route.ts::admin/pagamenti/sospensione:POST': ['no-già', 'ids'],
  'src/app/api/admin/pagamenti/sospensione/route.ts::applicaSospensione': ['no-già', 'scrittura'],
  'src/app/api/admin/parents/route.ts::admin/parents:GET': ['sì', 'ricerca'],
  'src/app/api/admin/presenze/realtime/route.ts::admin/presenze/realtime:GET': ['no-già', 'stato'],
  'src/app/api/admin/protocolli/da-documento/route.ts::caricaAlunno': ['sì', 'anagrafica'],
  'src/app/api/admin/protocolli/genera-documento/route.ts::admin/protocolli/genera-documento:POST': ['sì', 'anagrafica'],
  'src/app/api/admin/registro-presenze/pdf/route.ts::admin/registro-presenze/pdf:GET': ['no-già', 'sezione'],
  'src/app/api/admin/search/route.ts::admin/search:GET': ['sì', 'ricerca'],
  'src/app/api/admin/sidi/frequentanti/route.ts::admin/sidi/frequentanti:POST': ['no-già', 'filtro-nel-codice'],
  'src/app/api/admin/students/[id]/route.ts::admin/students/[id]:GET': ['sì', 'anagrafica'],
  'src/app/api/admin/students/archivia/route.ts::admin/students/archivia:POST': ['sì', 'anagrafica'],
  'src/app/api/admin/students/elimina/route.ts::admin/students/elimina:POST': ['no-già', 'esclude-in-arrivo'],
  'src/app/api/admin/students/export/route.ts::admin/students/export:GET': ['no-già', 'stato'],
  'src/app/api/admin/students/libera-spazio/route.ts::admin/students/libera-spazio:POST': ['sì', 'anagrafica'],
  'src/app/api/admin/students/riattiva/route.ts::admin/students/riattiva:POST': ['sì', 'anagrafica'],
  'src/app/api/admin/students/route.ts::admin/students:GET': ['no-già', 'esclude-in-arrivo'],
  'src/app/api/admin/students/route.ts::admin/students:PATCH': ['sì', 'anagrafica'],
  'src/app/api/admin/students/route.ts::admin/students:POST': ['no-già', 'scrittura'],
  'src/app/api/admin/students/route.ts::bersagliInScope': ['no-già', 'ids'],
  'src/app/api/admin/test-relations/route.ts::admin/test-relations:GET': ['no-già', 'ids'],
  'src/app/api/agenda/route.ts::agenda:GET': ['no-già', 'puntuale'],
  'src/app/api/agenda/route.ts::agenda:POST': ['no-già', 'stato'],
  'src/app/api/attendance/daily/route.ts::attendance/daily:POST': ['no-già', 'puntuale'],
  'src/app/api/attendance/monthly/route.ts::attendance/monthly:GET': ['no-già', 'sezione'],
  'src/app/api/avvisi/[id]/risposte/route.ts::avvisi/[id]/risposte:POST': ['no-già', 'puntuale'],
  'src/app/api/avvisi/route.ts::listaAvvisiGenitore': ['no-già', 'esclude-in-arrivo'],
  'src/app/api/chat/threads/route.ts::chat/threads:GET': ['no-già', 'puntuale'],
  'src/app/api/debug-supabase/route.ts::debug-supabase:GET': ['sì', 'diagnostica'],
  'src/app/api/debug/scrutini/route.ts::debug/scrutini:GET': ['no-già', 'ids'],
  'src/app/api/diary/entries/route.ts::diary/entries:DELETE': ['no-già', 'puntuale'],
  'src/app/api/diary/entries/route.ts::diary/entries:GET': ['no-già', 'sezione'],
  'src/app/api/diary/entries/route.ts::diary/entries:POST': ['no-già', 'ids'],
  'src/app/api/diary/route.ts::diary:POST': ['no-già', 'puntuale'],
  'src/app/api/diary/students/route.ts::diary/students:GET': ['no-già', 'sezione'],
  'src/app/api/documenti-firmati/route.ts::documenti-firmati:GET': ['no-già', 'stato-di-default'],
  'src/app/api/educator-sections/route.ts::sezioniDaiMediaTaggati': ['no-già', 'ids'],
  'src/app/api/gallery/route.ts::gallery:DELETE': ['no-già', 'ids'],
  'src/app/api/gallery/route.ts::gallery:GET': ['no-già', 'sezione'],
  'src/app/api/gallery/route.ts::gallery:PATCH': ['no-già', 'ids'],
  'src/app/api/locker/inventory/route.ts::locker/inventory:GET': ['no-già', 'stato'],
  'src/app/api/locker/inventory/route.ts::locker/inventory:PATCH': ['no-già', 'puntuale'],
  'src/app/api/locker/inventory/route.ts::locker/inventory:POST': ['no-già', 'puntuale'],
  'src/app/api/locker/notify/route.ts::locker/notify:POST': ['no-già', 'puntuale'],
  'src/app/api/locker/requests/route.ts::locker/requests:GET': ['no-già', 'stato'],
  'src/app/api/mensa/allergie-check/route.ts::mensa/allergie-check:POST': ['no-già', 'ids'],
  'src/app/api/mensa/alternative/route.ts::mensa/alternative:GET': ['no-già', 'ids'],
  'src/app/api/mensa/alternative/route.ts::sedeDiscordeDallAlunno': ['no-già', 'puntuale'],
  'src/app/api/mensa/menu/route.ts::mensa/menu:GET': ['no-già', 'puntuale'],
  'src/app/api/mensa/prenotazioni/route.ts::mensa/prenotazioni:DELETE': ['no-già', 'puntuale'],
  'src/app/api/mensa/prenotazioni/route.ts::mensa/prenotazioni:GET': ['no-già', 'puntuale'],
  'src/app/api/mensa/prenotazioni/route.ts::mensa/prenotazioni:POST': ['no-già', 'puntuale'],
  'src/app/api/mensa/report/route.ts::mensa/report:GET': ['no-già', 'ids'],
  'src/app/api/mensa/ticket-residui/route.ts::mensa/ticket-residui:GET': ['no-già', 'stato'],
  'src/app/api/notes/sign/route.ts::notes/sign:POST': ['no-già', 'puntuale'],
  'src/app/api/notifiche/promemoria/route.ts::notifiche/promemoria:POST': ['no-già', 'puntuale'],
  'src/app/api/pagamenti/attestazione/route.ts::pagamenti/attestazione:GET': ['sì', 'ricevute'],
  'src/app/api/pagamenti/export/route.ts::exportAde': ['no-già', 'ids'],
  'src/app/api/pagamenti/famiglia/route.ts::pagamenti/famiglia:GET': ['sì', 'ricevute'],
  'src/app/api/pagamenti/genera-rette/route.ts::pagamenti/genera-rette:GET': ['no-già', 'stato'],
  'src/app/api/pagamenti/genera/route.ts::pagamenti/genera:GET': ['no-già', 'stato'],
  'src/app/api/pagamenti/genera/route.ts::pagamenti/genera:POST': ['sì', 'ricevute'],
  'src/app/api/pagamenti/rate/route.ts::pagamenti/rate:POST': ['sì', 'ricevute'],
  'src/app/api/pagamenti/ricevute/route.ts::pagamenti/ricevute:GET': ['sì', 'ricevute'],
  'src/app/api/pagamenti/riconciliazione/[id]/contesto/route.ts::pagamenti/riconciliazione/[id]/contesto:GET': ['sì', 'ricevute'],
  'src/app/api/pagamenti/riconciliazione/alunni/route.ts::pagamenti/riconciliazione/alunni:GET': ['sì', 'ricerca'],
  'src/app/api/pagamenti/route.ts::pagamenti:POST': ['sì', 'ricevute'],
  'src/app/api/pagamenti/servizi/route.ts::pagamenti/servizi:POST': ['no-già', 'stato'],
  'src/app/api/pagamenti/solleciti/run/route.ts::pagamenti/solleciti/run:POST': ['no-già', 'sospensione'],
  'src/app/api/pagamenti/transazioni/route.ts::pagamenti/transazioni:POST': ['sì', 'ricevute'],
  'src/app/api/panic-alert/route.ts::panic-alert:POST': ['no-già', 'puntuale'],
  'src/app/api/parent/forms/route.ts::parent/forms:GET': ['no-già', 'esclude-in-arrivo'],
  'src/app/api/parent/giustifiche-didattiche/route.ts::parent/giustifiche-didattiche:PATCH': ['no-già', 'puntuale'],
  'src/app/api/parent/giustifiche-didattiche/route.ts::parent/giustifiche-didattiche:POST': ['no-già', 'puntuale'],
  'src/app/api/parent/mensa/allergie/route.ts::parent/mensa/allergie:GET': ['no-già', 'puntuale'],
  'src/app/api/parent/presenze/comunica-assenza/route.ts::parent/presenze/comunica-assenza:DELETE': ['no-già', 'puntuale'],
  'src/app/api/parent/presenze/comunica-assenza/route.ts::parent/presenze/comunica-assenza:POST': ['no-già', 'puntuale'],
  'src/app/api/parent/presenze/giustifica/route.ts::parent/presenze/giustifica:POST': ['no-già', 'puntuale'],
  'src/app/api/parent/presenze/route.ts::parent/presenze:GET': ['no-già', 'puntuale'],
  'src/app/api/parent/prestampati/firma/route.ts::parent/prestampati/firma:POST': ['no-già', 'puntuale'],
  'src/app/api/parent/primaria/note/firma/route.ts::parent/primaria/note/firma:POST': ['no-già', 'puntuale'],
  'src/app/api/parent/primaria/orario/route.ts::parent/primaria/orario:GET': ['no-già', 'puntuale'],
  'src/app/api/parent/primaria/pagella/firma/route.ts::parent/primaria/pagella/firma:POST': ['no-già', 'puntuale'],
  'src/app/api/parent/primaria/pagella/route.ts::parent/primaria/pagella:GET': ['no-già', 'puntuale'],
  'src/app/api/parent/primaria/route.ts::parent/primaria:GET': ['no-già', 'puntuale'],
  'src/app/api/parent/primaria/valutazioni/route.ts::parent/primaria/valutazioni:GET': ['no-già', 'puntuale'],
  'src/app/api/parent/submissions/route.ts::parent/submissions:GET': ['no-già', 'ids'],
  'src/app/api/prestampati/banco.ts::leggiAlunniDiSezione': ['no-già', 'stato'],
  'src/app/api/primaria/appello/route.ts::primaria/appello:GET': ['no-già', 'sezione'],
  'src/app/api/primaria/appello/route.ts::primaria/appello:POST': ['no-già', 'ids'],
  'src/app/api/primaria/classe/[sectionId]/route.ts::primaria/classe/[sectionId]:GET': ['no-già', 'stato'],
  'src/app/api/primaria/classi/route.ts::primaria/classi:GET': ['no-già', 'sezione'],
  'src/app/api/primaria/fascicolo/route.ts::primaria/fascicolo:POST': ['no-già', 'puntuale'],
  'src/app/api/primaria/fascicolo/sostituisci/route.ts::primaria/fascicolo/sostituisci:POST': ['no-già', 'puntuale'],
  'src/app/api/primaria/ore-assenza/route.ts::primaria/ore-assenza:GET': ['no-già', 'sezione'],
  'src/app/api/primaria/pagella/batch/route.ts::primaria/pagella/batch:POST': ['no-già', 'sezione'],
  'src/app/api/primaria/presenze/giust-vista/route.ts::primaria/presenze/giust-vista:POST': ['no-già', 'puntuale'],
  'src/app/api/primaria/prospetto/route.ts::primaria/prospetto:GET': ['no-già', 'puntuale'],
  'src/app/api/primaria/registro/route.ts::primaria/registro:POST': ['no-già', 'sezione'],
  'src/app/api/primaria/scrutinio/chiudi/route.ts::primaria/scrutinio/chiudi:POST': ['no-già', 'sezione'],
  'src/app/api/primaria/scrutinio/import/route.ts::primaria/scrutinio/import:POST': ['no-già', 'sezione'],
  'src/app/api/primaria/scrutinio/pubblica/route.ts::primaria/scrutinio/pubblica:POST': ['no-già', 'sezione'],
  'src/app/api/primaria/scrutinio/route.ts::primaria/scrutinio:GET': ['no-già', 'sezione'],
  'src/app/api/segnalazioni/route.ts::contattoLegittimo': ['no-già', 'ids'],
  'src/app/api/segnalazioni/route.ts::sedeDiAlunno': ['no-già', 'puntuale'],
  'src/app/api/segnalazioni/route.ts::sediDelSegnalante': ['no-già', 'ids'],
  'src/app/api/segnalazioni/route.ts::verificaAccesso': ['no-già', 'puntuale'],
  'src/app/api/tasks/meta/route.ts::tasks/meta:GET': ['no-già', 'stato'],
  'src/app/api/tasks/route.ts::enrichTask': ['no-già', 'puntuale'],
  'src/app/api/tasks/route.ts::tasks:GET': ['no-già', 'ids'],
  'src/app/api/teacher/alunni/[id]/route.ts::teacher/alunni/[id]:GET': ['no-già', 'stato'],
  'src/app/api/teacher/alunni/route.ts::teacher/alunni:GET': ['no-già', 'stato'],
  'src/app/api/teacher/modulistica/route.ts::teacher/modulistica:GET': ['no-già', 'sezione'],
  'src/app/api/teacher/uscite/route.ts::teacher/uscite:POST': ['no-già', 'stato'],
  'src/lib/alunni/attivo.ts::verificaAlunnoAttivo': ['no-già', 'puntuale'],
  'src/lib/alunni/codice-fiscale-doppione.ts::codiceFiscaleDiAltroAlunno': ['sì', 'ricerca'],
  'src/lib/alunni/elimina-definitivo.ts::cfCondivisoConFrequentante': ['no-già', 'sezione'],
  'src/lib/alunni/elimina-definitivo.ts::documentoCondiviso': ['sì', 'ricerca'],
  'src/lib/alunni/libera-spazio.ts::liberaSpazio': ['no-già', 'scrittura'],
  'src/lib/anagrafiche/docente/visibilita.ts::assertAlunnoAnagraficaInScope': ['no-già', 'puntuale'],
  'src/lib/anagrafiche/legami.ts::getFigliAttiviDiGenitore': ['no-già', 'ids'],
  'src/lib/anagrafiche/sedi.ts::sedeDiAlunno': ['no-già', 'puntuale'],
  'src/lib/anagrafiche/sedi.ts::sediDeiFigli': ['no-già', 'ids'],
  'src/lib/armadietto/richieste.ts::riconciliaRichieste': ['no-già', 'puntuale'],
  'src/lib/aruba/intestatario-pagamento.ts::leggiAlunnoEconomico': ['no-già', 'puntuale'],
  'src/lib/auth/scope.ts::assertAlunniInSezione': ['no-già', 'sezione'],
  'src/lib/auth/scope.ts::assertAlunnoInScope': ['no-già', 'puntuale'],
  'src/lib/avvisi/nomi-risposte.ts::alunniDelleRisposte': ['no-già', 'ids'],
  'src/lib/cassa/saldo.ts::caricaEntratoOggi': ['sì', 'ricevute'],
  'src/lib/cassa/saldo.ts::incassiPerSaldo': ['sì', 'ricevute'],
  'src/lib/chat/rubrica.ts::fattiAbbinamento': ['no-già', 'puntuale'],
  'src/lib/chat/rubrica.ts::rubricaDiFamiglia': ['no-già', 'stato'],
  'src/lib/chat/rubrica.ts::rubricaDiOperatore': ['no-già', 'stato'],
  'src/lib/competenze/certificato-store.ts::loadCertificatoData': ['no-già', 'puntuale'],
  'src/lib/crm/aggancio-alunno.ts::alunnoDaDomandaImportata': ['no-già', 'ids'],
  'src/lib/diary/routine-lotto.ts::applicaRoutineAlLotto': ['no-già', 'ids'],
  'src/lib/forms/persist-submission.ts::persistSignedSubmission': ['no-già', 'puntuale'],
  'src/lib/forms/signed-archive.ts::ensureSignedSubmissionPdf': ['no-già', 'puntuale'],
  'src/lib/gallery/privacy.ts::alunniSenzaConsenso': ['no-già', 'ids'],
  'src/lib/gallery/pubblicazione-video-automatica.ts::leggiPerimetro': ['no-già', 'esclude-in-arrivo'],
  'src/lib/gallery/tag-scope.ts::assertTagStudentsInScope': ['no-già', 'esclude-in-arrivo'],
  'src/lib/gallery/vista-sede.ts::alunniTaggatiDellaSede': ['no-già', 'ids'],
  'src/lib/gdpr/account-oblio.ts::decidiELibera': ['sì', 'oblio'],
  'src/lib/gdpr/esegui.ts::anonimizzaAlunno': ['sì', 'oblio'],
  'src/lib/gdpr/esegui.ts::documentoDiAltri': ['sì', 'oblio'],
  'src/lib/gdpr/orfano.ts::leggiAltriFigliIscritti': ['sì', 'oblio'],
  'src/lib/health/controlli.ts::controlloTestoClasse': ['no-già', 'stato'],
  'src/lib/iscrizioni/doppioni.ts::cercaGemelloAlunno': ['sì', 'ricerca'],
  'src/lib/iscrizioni/import/esegui.ts::alunnoDiRiferimento': ['no-già', 'puntuale'],
  'src/lib/iscrizioni/import/esegui.ts::eseguiDomanda': ['no-già', 'scrittura'],
  'src/lib/iscrizioni/import/esegui.ts::trovaFratelloPagante': ['no-già', 'stato'],
  'src/lib/iscrizioni/percorsi-citati.ts::SORGENTI': ['sì', 'ricerca'],
  'src/lib/iscrizioni/sanitari.ts::leggiSanitariScheda': ['sì', 'anagrafica'],
  'src/lib/mensa/allergie-check.ts::controllaAllergiePerId': ['no-già', 'puntuale'],
  'src/lib/mensa/notify.ts::notificaSaldoBasso': ['no-già', 'puntuale'],
  'src/lib/mensa/scope.ts::assertAlunnoInScopeCucina': ['no-già', 'puntuale'],
  'src/lib/merch/notify.ts::notifica': ['no-già', 'puntuale'],
  'src/lib/news/consenso-foto.ts::verificaConsensoSito': ['no-già', 'ids'],
  'src/lib/news/digest.ts::emailFamiglie': ['no-già', 'stato'],
  'src/lib/news/notifiche.ts::genitoriDiGrado': ['no-già', 'stato'],
  'src/lib/news/permanenza-consenso.ts::verificaPermanenzaConsenso': ['no-già', 'ids'],
  'src/lib/news/target.ts::caricaFigliConTarget': ['no-già', 'esclude-in-arrivo'],
  'src/lib/notifiche/destinatari.ts::genitoriDiClassi': ['no-già', 'stato'],
  'src/lib/notifiche/destinatari.ts::genitoriDiScuola': ['no-già', 'stato'],
  'src/lib/pagamenti/conciliazione-registra.ts::registraConciliazione': ['sì', 'ricevute'],
  'src/lib/pagamenti/intestatari.ts::ricordaIntestatarioSullaScheda': ['no-già', 'puntuale'],
  'src/lib/pagamenti/intestatari.ts::ricordaPersonaSullaScheda': ['no-già', 'puntuale'],
  'src/lib/pagamenti/rette-a-carico-server.ts::caricaLegamiRetta': ['no-già', 'stato'],
  'src/lib/pagamenti/scadenze.ts::riallineaScadenzeRetteFuture': ['no-già', 'puntuale'],
  'src/lib/pagamenti/sospensione.ts::alunnoSospeso': ['no-già', 'puntuale'],
  'src/lib/pagamenti/sospensione.ts::famigliaDiAlunno': ['no-già', 'ids'],
  'src/lib/pagamenti/sospensione.ts::qualcunoSospeso': ['no-già', 'ids'],
  'src/lib/pagamenti/sospensione.ts::verificaRevocaSospensioneMorosita': ['no-già', 'ids'],
  'src/lib/prestampati/prefill.ts::leggiAlunno': ['sì', 'anagrafica'],
  'src/lib/primaria/fascicolo-rbac.ts::puoAccedereFascicolo': ['no-già', 'puntuale'],
  'src/lib/primaria/notifica-voti-genitore.ts::nomeAlunnoPerNotifica': ['no-già', 'puntuale'],
  'src/lib/primaria/notifiche.ts::scuolaDiAlunno': ['no-già', 'puntuale'],
  'src/lib/primaria/pagella-store.ts::loadPagellaData': ['no-già', 'puntuale'],
  'src/lib/sidi/import-apply.ts::applySidiRecords': ['sì', 'ricerca'],
  'src/lib/storici/generazioni.ts::opzioniStorici': ['no-già', 'esclude-in-arrivo'],
  'src/lib/storici/scope.ts::preparaContestoStorico': ['no-già', 'ids'],
  'src/lib/votazioni/aventi-diritto.ts::calcolaGenitoriDelleClassi': ['no-già', 'stato'],
}

/** Le letture incorporate in un'altra select (`alunni!inner(…)`). */
const INCORPORATE: Record<string, Voce> = {
  'src/app/api/admin/chat/docenti-senza-push/route.ts::admin/chat/docenti-senza-push:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/admin/chat/threads/route.ts::admin/chat/threads:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/admin/competenze/route.ts::admin/competenze:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/admin/dashboard/route.ts::admin/dashboard:GET#incorporata': ['sì', 'ricevute'],
  'src/app/api/admin/iscrizioni/rinvia-credenziali/route.ts::admin/iscrizioni/rinvia-credenziali:POST#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/admin/legami-familiari/route.ts::admin/legami-familiari:GET#incorporata': ['sì', 'anagrafica'],
  'src/app/api/admin/merch/consegna/route.ts::admin/merch/consegna:POST#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/admin/merch/ordini-fornitore/checkin/route.ts::admin/merch/ordini-fornitore/checkin:POST#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/admin/parents/[id]/route.ts::admin/parents/[id]:GET#incorporata': ['sì', 'anagrafica'],
  'src/app/api/admin/presenze/realtime/route.ts::admin/presenze/realtime:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/admin/primaria/fascicolo-audit/route.ts::admin/primaria/fascicolo-audit:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/admin/sidi/legami/route.ts::admin/sidi/legami:GET#incorporata': ['no-già', 'esclude-in-arrivo'],
  'src/app/api/admin/sidi/piattaforma-unica/route.ts::admin/sidi/piattaforma-unica:POST#incorporata': ['no-già', 'esclude-in-arrivo'],
  'src/app/api/admin/students/[id]/route.ts::admin/students/[id]:GET#incorporata': ['sì', 'anagrafica'],
  'src/app/api/attendance/delegates/route.ts::attendance/delegates:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/debug/scrutini/route.ts::debug/scrutini:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/locker/requests/route.ts::locker/requests:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/mensa/ticket-residui/route.ts::mensa/ticket-residui:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/notes/route.ts::notes:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/notes/route.ts::notes:POST#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/pagamenti/riconciliazione/annulla-import/route.ts::pagamenti/riconciliazione/annulla-import:GET#incorporata': ['sì', 'ricevute'],
  'src/app/api/pagamenti/servizi/route.ts::pagamenti/servizi:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/pagamenti/ticket/morosi/route.ts::pagamenti/ticket/morosi:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/pagamenti/transazioni/[id]/route.ts::pagamenti/transazioni/[id]:GET#incorporata': ['sì', 'ricevute'],
  'src/app/api/parent/medical-certificates/route.ts::parent/medical-certificates:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/primaria/note/route.ts::primaria/note:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/app/api/teacher/medical-certificates/route.ts::teacher/medical-certificates:GET#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/lib/aruba/emissione.ts::emettiFatturaPagamento#incorporata': ['sì', 'ricevute'],
  'src/lib/auth/parent-identity.ts::sedeDelGenitore#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/lib/auth/scope.ts::assertParentInScope#incorporata': ['no-già', 'incorporata-da-tabella-operativa'],
  'src/lib/gdpr/sede-richiesta.ts::risolviSedeRichiestaCancellazione#incorporata': ['sì', 'oblio'],
  'src/lib/pagamenti/associazione-movimento.ts::leggiAssociazione#incorporata': ['sì', 'ricevute'],
  'src/lib/pagamenti/ricevute.ts::emettiORecuperaRicevutaTransazione#incorporata': ['sì', 'ricevute'],
}

/** Le funzioni SQL vive che toccano `alunni`. */
const FUNZIONI_SQL: Record<string, Voce> = {
  'sql::alunni_riallinea_da_frequenze': ['sì', 'funzione-di-anno'],
  'sql::anno_fotografa': ['no-già', 'esclude-in-arrivo'],
  'sql::anno_invarianti': ['sì', 'funzione-di-anno'],
  'sql::anno_riempi': ['no-già', 'funzione-tolta'],
  'sql::anno_sede_della_riga': ['no-già', 'funzione-puntuale'],
  'sql::anno_sede_sql': ['no-già', 'funzione-puntuale'],
  'sql::chat_riepilogo_conversazioni': ['no-già', 'incorporata-da-tabella-operativa'],
  'sql::chat_vigilanza_ricerca': ['no-già', 'incorporata-da-tabella-operativa'],
  'sql::crm_aggancia_alunno': ['sì', 'anagrafica'],
  'sql::crm_quota_passa': ['sì', 'ricevute'],
  'sql::elimina_alunno_definitivo': ['no-già', 'esclude-in-arrivo'],
  'sql::fn_scuola_id_da_alunno': ['no-già', 'funzione-puntuale'],
  'sql::frequenza_segue_classe_alunno': ['no-già', 'funzione-per-sezione'],
  'sql::frequenze_specchio_alunni': ['sì', 'funzione-di-anno'],
  'sql::genera_rette_mensili': ['no-già', 'funzione-per-stato'],
  'sql::iscrizioni_annulla': ['no-già', 'ids'],
  'sql::iscrizioni_rinvia': ['no-già', 'ids'],
  'sql::iscrizioni_sanitari_tick': ['sì', 'anagrafica'],
  'sql::presenze_giustificazioni_retention_tick': ['no-già', 'funzione-per-stato'],
  'sql::propaga_rinomina_sezione': ['no-già', 'funzione-per-sezione'],
  'sql::registra_transazione_contabile': ['sì', 'ricevute'],
  'sql::ricarica_ticket_mensa': ['no-già', 'funzione-puntuale'],
  'sql::servizi_da_generare': ['no-già', 'funzione-per-stato'],
  'sql::storici_collega_documento': ['no-già', 'funzione-puntuale'],
  'sql::storici_fonte_coperta': ['no-già', 'funzione-puntuale'],
  'sql::storici_salva_appartenenza': ['no-già', 'funzione-puntuale'],
  'sql::storici_tick': ['no-già', 'funzione-per-stato'],
  'sql::voci_visibili_genitore': ['sì', 'funzione-di-anno'],
}

/**
 * LA LISTA DI LAVORO DEL 4.5.4-bis: SVUOTATA. Ogni `no`, e ogni `sì` che escludeva, è stato corretto o riclassificato con la sua
 * ragione (`esclude-in-arrivo`, `oblio-dopo-archiviazione`, `funzione-tolta`); i due `sì` che escludevano (la ricerca del CRM e i
 * legami familiari) ora lo trovano. Una riga nuova qui è un difetto aperto: ogni `no` deve avere la sua, e il lock sotto lo verifica.
 */
export const DA_CORREGGERE: Record<string, { persone: string; correzione: string }> = {}

// ───────────────────────────── il lettore ─────────────────────────────

const RADICE = path.join(process.cwd(), 'src')
const MIGRAZIONI = path.join(process.cwd(), 'supabase', 'migrations')

/** `.select('… alunni!inner(…) …')`, anche con alias (`alunno:alunni(…)`, `alunni:section_id(…)`). */
const INCORPORA_ALUNNI = /\balunni(?:!inner)?\s*\(|\balunni:[A-Za-z_]+(?:!inner)?\s*\(|\b[A-Za-z_]+:alunni(?:!inner)?\s*\(/

/** Le chiavi delle letture di `alunni` incorporate in una `.select(…)` di un altro sorgente. */
export function lettureIncorporate(src: string, percorso = '<test>'): string[] {
  const { senzaCommenti, struttura } = mascheraSorgente(src)
  const chiavi = new Set<string>()
  for (const m of senzaCommenti.matchAll(/\.select\(\s*/g)) {
    const i = m.index + m[0].length
    const apertura = senzaCommenti[i]
    if (apertura !== "'" && apertura !== '"' && apertura !== '`') continue
    let j = i + 1
    while (j < senzaCommenti.length && senzaCommenti[j] !== apertura) {
      if (senzaCommenti[j] === '\\') j++
      j++
    }
    if (INCORPORA_ALUNNI.test(senzaCommenti.slice(i + 1, j))) {
      chiavi.add(`${percorso}::${contenitoreDi(senzaCommenti, struttura, m.index)}#incorporata`)
    }
  }
  return [...chiavi]
}

/** Le funzioni SQL con la loro ULTIMA definizione: `nome → { file, corpo senza commenti }`. */
export function funzioniSqlVive(cartella = MIGRAZIONI): Map<string, { file: string; corpo: string }> {
  const vive = new Map<string, { file: string; corpo: string }>()
  const intestazione = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(/gi
  for (const file of fs.readdirSync(cartella).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(cartella, file), 'utf8')
    for (const m of sql.matchAll(intestazione)) {
      const nome = m[1].replace(/"/g, '').replace(/^public\./, '')
      let i = m.index + m[0].length
      for (let profondita = 1; i < sql.length && profondita > 0; i++) {
        if (sql[i] === '(') profondita++
        else if (sql[i] === ')') profondita--
      }
      const apertura = /\$([A-Za-z_0-9]*)\$/.exec(sql.slice(i))
      if (!apertura) continue
      const da = i + apertura.index + apertura[0].length
      const a = sql.indexOf(apertura[0], da)
      if (a < 0) continue
      const corpo = sql
        .slice(da, a)
        .split('\n')
        .map((r) => r.replace(/--.*$/, ''))
        .join('\n')
      vive.set(nome, { file, corpo })
    }
  }
  return vive
}

const TOCCA_ALUNNI = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?alunni\b/i

export function funzioniSqlCheToccanoAlunni(cartella = MIGRAZIONI): string[] {
  return [...funzioniSqlVive(cartella)]
    .filter(([, f]) => TOCCA_ALUNNI.test(f.corpo))
    .map(([nome]) => `sql::${nome}`)
    .sort()
}

export interface Censimento {
  file: number
  letture: Map<string, { righe: number[]; scrittura: boolean }>
  incorporate: string[]
  sql: string[]
}

export function censisci(): Censimento {
  const file = fileSorgente(RADICE)
  const letture = new Map<string, { righe: number[]; scrittura: boolean }>()
  const incorporate = new Set<string>()
  for (const f of file) {
    const src = fs.readFileSync(f, 'utf8')
    const rel = path.relative(process.cwd(), f).split(path.sep).join('/')
    if (/\.from\(\s*['"]alunni['"]\s*\)/.test(src)) {
      for (const l of lettureAlunni(src, rel)) {
        const voce = letture.get(l.chiave) ?? { righe: [], scrittura: true }
        voce.righe.push(l.riga)
        voce.scrittura = voce.scrittura && l.scrittura
        letture.set(l.chiave, voce)
      }
    }
    if (INCORPORA_ALUNNI.test(src)) for (const k of lettureIncorporate(src, rel)) incorporate.add(k)
  }
  return { file: file.length, letture, incorporate: [...incorporate].sort(), sql: funzioniSqlCheToccanoAlunni() }
}

// ───────────────────────────── i controlli ─────────────────────────────

const ESITI: readonly Esito[] = ['no', 'no-già', 'sì']
const TUTTE: Record<string, Voce> = { ...LETTURE, ...INCORPORATE, ...FUNZIONI_SQL }
const CENSIMENTO = censisci()
const TROVATE = [...CENSIMENTO.letture.keys(), ...CENSIMENTO.incorporate, ...CENSIMENTO.sql]

describe('lock architettura · ogni lettura di `alunni` ha deciso che cosa fa davanti a un bambino «in arrivo»', () => {
  it('ha guardato i sorgenti, le letture incorporate e le funzioni SQL (la copertura è dichiarata, non supposta)', () => {
    expect(CENSIMENTO.file, 'file di src/ letti').toBeGreaterThan(1000)
    expect(CENSIMENTO.letture.size, 'contenitori che leggono o scrivono `.from(\'alunni\')`').toBeGreaterThan(150)
    expect(CENSIMENTO.incorporate.length, 'contenitori con `alunni` incorporata in una select').toBeGreaterThan(5)
    expect(CENSIMENTO.sql.length, 'funzioni SQL vive che toccano `alunni`').toBeGreaterThan(15)
    expect(Object.keys(LETTURE).length + Object.keys(INCORPORATE).length + Object.keys(FUNZIONI_SQL).length).toBe(TROVATE.length)
  })

  it('NESSUNA lettura nuova senza classificazione', () => {
    const nuove = TROVATE.filter((k) => !(k in TUTTE))
    expect(
      nuove,
      'Queste letture di `alunni` sono nuove e non dicono che cosa fanno con un bambino «in arrivo». Aggiungile in ' +
        'LETTURE / INCORPORATE / FUNZIONI_SQL come `no`, `no-già` (con la ragione) o `sì`: un elenco di bambini non si scrive ' +
        'senza aver deciso se ci compare chi non ha ancora cominciato.',
    ).toEqual([])
  })

  it('nessuna voce della classificazione è rimasta senza il suo sorgente', () => {
    const trovate = new Set(TROVATE)
    expect(Object.keys(TUTTE).filter((k) => !trovate.has(k)), 'voci orfane: il contenitore è stato rinominato o tolto').toEqual([])
  })

  it('ogni voce ha un esito e una ragione che esistono; la ragione è coerente con l’esito', () => {
    const SUFFISSO_NO = new Set<Motivo>(['elenca-tutti', 'gate-negativo', 'sonda-stati', 'figli-collegati', 'riempimento-senza-stato', 'guardia-senza-sezione'])
    const SUFFISSO_SI = new Set<Motivo>(['ricerca', 'anagrafica', 'oblio', 'ricevute', 'diagnostica', 'funzione-di-anno'])
    for (const [k, [esito, motivo]] of Object.entries(TUTTE)) {
      expect(ESITI, k).toContain(esito)
      expect(MOTIVI[motivo], `${k}: ragione «${motivo}» non definita`).toBeTruthy()
      if (esito === 'no') expect(SUFFISSO_NO.has(motivo), `${k}: un «no» deve citare la ragione per cui include`).toBe(true)
      if (esito === 'sì') expect(SUFFISSO_SI.has(motivo), `${k}: un «sì» deve citare perché deve vederlo`).toBe(true)
      if (esito === 'no-già') expect(SUFFISSO_NO.has(motivo) || SUFFISSO_SI.has(motivo), `${k}: «no-già» con una ragione da difetto o da sì`).toBe(false)
    }
  })

  it('ogni `no` è nella lista di lavoro del 4.5.4-bis, e ogni voce della lista è un `no` o un `sì` da correggere', () => {
    const no = Object.entries(TUTTE).filter(([, [e]]) => e === 'no').map(([k]) => k)
    expect(no.filter((k) => !(k in DA_CORREGGERE)), 'un `no` non dichiarato «da correggere»').toEqual([])
    for (const k of Object.keys(DA_CORREGGERE)) {
      expect(k in TUTTE, `${k}: voce di DA_CORREGGERE senza classificazione`).toBe(true)
      expect(['no', 'sì'], `${k}: un «no-già» non si corregge`).toContain(TUTTE[k][0])
      expect(DA_CORREGGERE[k].persone.length, `${k}: manca che cosa cambia per le persone`).toBeGreaterThan(10)
      expect(DA_CORREGGERE[k].correzione.length, `${k}: manca la correzione`).toBeGreaterThan(10)
    }
  })

  it('i numeri della classificazione (per chi la legge): quanti no, no-già, sì', () => {
    const conta = (e: Esito) => Object.values(TUTTE).filter(([x]) => x === e).length
    // Se cambiano, la classificazione è cambiata: va riletta, non solo aggiornata questa riga.
    expect({ no: conta('no'), 'no-già': conta('no-già'), sì: conta('sì'), daCorreggere: Object.keys(DA_CORREGGERE).length }).toEqual(
      { no: 0, 'no-già': 206, sì: 58, daCorreggere: 0 },
    )
  })

  it('CONTROLLO POSITIVO: il lettore vede una lettura nuova, una incorporata e una funzione SQL; un commento non conta', () => {
    const nuova = lettureAlunni("export const GET = withRoute('x/y:GET', async () => {\n  await db.from('alunni').select('id').in('scuola_id', s)\n})\n", 'src/x.ts')
    expect(nuova.map((l) => l.chiave)).toEqual(['src/x.ts::x/y:GET'])
    expect(lettureIncorporate("export const GET = withRoute('x/z:GET', async () => {\n  await db.from('presenze').select('id, alunni!inner ( nome )')\n})\n", 'src/z.ts')).toEqual(['src/z.ts::x/z:GET#incorporata'])
    expect(lettureIncorporate("export const GET = withRoute('x/z:GET', async () => {\n  // .select('alunni!inner ( nome )')\n  await db.from('presenze').select('id')\n})\n", 'src/z.ts')).toEqual([])
    expect(lettureIncorporate("export async function f() { log('lettura alunni (armadietto)') }\n", 'src/z.ts')).toEqual([])

    const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-in-arrivo-sql-'))
    try {
      fs.writeFileSync(path.join(cartella, '1.sql'), "CREATE OR REPLACE FUNCTION public.f_uno() RETURNS int LANGUAGE sql AS $$ SELECT count(*) FROM public.alunni $$;\nCREATE FUNCTION g_due(a int) RETURNS int AS $f$ BEGIN -- FROM alunni\n RETURN 1; END $f$;\n")
      fs.writeFileSync(path.join(cartella, '2.sql'), "CREATE OR REPLACE FUNCTION public.f_uno() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\n")
      // f_uno: l'ULTIMA definizione non tocca più `alunni`; g_due lo nomina solo in un commento.
      expect(funzioniSqlCheToccanoAlunni(cartella)).toEqual([])
      fs.writeFileSync(path.join(cartella, '3.sql'), "CREATE OR REPLACE FUNCTION public.f_uno() RETURNS int LANGUAGE sql AS $$ SELECT count(*) FROM public.alunni a JOIN x ON true $$;\n")
      expect(funzioniSqlCheToccanoAlunni(cartella)).toEqual(['sql::f_uno'])
    } finally {
      fs.rmSync(cartella, { recursive: true, force: true })
    }
  })
})
