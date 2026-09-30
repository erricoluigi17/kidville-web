'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * QUANTI MESSAGGI DI CHAT NON LETTI HA CHI STA GUARDANDO — il numero sulla barra in basso.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────────────────
 *
 * Segnalazione del 2026-09-29: «i messaggi dei genitori non arrivano alle maestre». Arrivano.
 * Quello che non arriva è l'ANNUNCIO: fuori dalla pagina «Messaggi» l'app non dice mai che c'è
 * qualcosa da leggere. Una maestra ha ricevuto due messaggi alle 10:52, ha usato l'app tre volte
 * e li ha visti alle 16:14.
 *
 * Il numero lo porta `GET /api/notifiche` (`chat_non_letti`), che la campanella interroga già
 * all'apertura e ogni 60 s: nessuna richiesta HTTP in più, nessun orologio nuovo. Ma chi lo
 * riceve — la campanella, nell'AppBar — non è chi lo mostra (le barre in basso di maestre e
 * genitori) né chi lo corregge (la pagina chat: le letture registrate e i messaggi in arrivo).
 * Tre punti che non si vedono fra loro, quindi il numero sta in un MODULO, come le bozze della
 * chat (`bozze-chat.ts`), e chi lo mostra lo ascolta.
 *
 * NIENTE `localStorage`: è un conteggio di conversazioni fra famiglie e maestre, vive quanto la
 * pagina. Nessun fetch da qui: questo file non parla con la rete, la barra in basso nemmeno —
 * due lock contano le chiamate che le barre fanno (`teacher-nav-gradi-una-chiamata`,
 * `parent-figli-una-chiamata`).
 *
 * ─── `null` È «NON LO SO», E NON È LA STESSA COSA DI ZERO ───────────────────────────────
 *
 * Uno 0 di ripiego dice «hai letto tutto»: è la bugia esatta che questo lavoro esiste per
 * togliere di mezzo, e a schermo è indistinguibile dal caso vero. Quindi:
 *
 *  · si parte da `null` e il badge non compare;
 *  · il server risponde `chat_non_letti: null` quando non ha potuto contare, e chi legge quella
 *    risposta NON scrive niente: il valore noto di prima resta (vedi `NotificationsPanel`);
 *  · una VARIAZIONE (+1, −n) su `null` resta `null`: senza la base, «uno in meno» non è un
 *    numero. Non si inventa un totale partendo da una differenza.
 *
 * ─── LO SNAPSHOT DEL SERVER È `null`, SEMPRE ────────────────────────────────────────────
 *
 * `useSyncExternalStore` chiede un terzo argomento per il prerender e la prima idratazione:
 * qui è `null` per costruzione, così l'HTML servito e il primo render del client coincidono e
 * nessun badge nasce da un valore che il server non può conoscere. Il lock
 * `__tests__/ui/idratazione-identita-docente.test.tsx` misura proprio quel mismatch sulla barra
 * docente, e non perdona: React NON ripara gli attributi.
 *
 * ─── LA GUARDIA A SEQUENZA, E IL DIFETTO CHE TOGLIE ─────────────────────────────────────
 *
 * La campanella ricarica ogni 60 s. Se una lettura avviene MENTRE una di quelle richieste è in
 * volo, la risposta porta il numero di prima e rimetterebbe in piedi i messaggi appena letti —
 * cioè il contatore gonfio, che è il guasto di partenza. Ogni variazione locale incrementa una
 * SEQUENZA; chi parte con una richiesta si porta dietro la sequenza di quel momento e la
 * restituisce all'arrivo: se non è più quella, il numero è vecchio e si scarta.
 *
 * Una sequenza e non un istante (`Date.now()`) di proposito: due eventi nello stesso
 * millisecondo sono indistinguibili con un orologio, e qui i due eventi — la lettura registrata
 * dalla PATCH e la partenza del poll — possono arrivare davvero vicini.
 *
 * ⚠️ COSA COSTA LA GUARDIA, detto invece che nascosto: scartare una risposta significa restare
 * col valore noto (o con `null`) fino al giro successivo, cioè al più 60 s. È il verso giusto in
 * cui sbagliare: un numero un po' vecchio è sopportabile, un numero che risale dopo una lettura
 * no — è come si è imparato a ignorare la campanella.
 */

/** Il totale dei messaggi non letti dell'ALTRA parte, o `null` se non lo si sa. */
let valore: number | null = null;

/** Quante variazioni locali sono avvenute. Cresce, non torna indietro. */
let sequenza = 0;

const ascoltatori = new Set<() => void>();

function avvisa(): void {
    // Una copia dell'elenco: chi viene avvisato può smettere di ascoltare mentre si avvisano gli altri.
    for (const avviso of [...ascoltatori]) avviso();
}

/** Il totale conosciuto adesso, o `null`. */
export function chatNonLetti(): number | null {
    return valore;
}

/**
 * Quello che vede il prerender del server e la prima idratazione: `null`, sempre. Vedi la testata.
 */
export function chatNonLettiPrerender(): null {
    return null;
}

/** La sequenza di ADESSO: chi parte con una richiesta se la porta dietro. Vedi la testata. */
export function sequenzaChatNonLetti(): number {
    return sequenza;
}

/**
 * Il totale che arriva dal server. `sequenzaAllaPartenza` è la sequenza letta PRIMA di far partire
 * la richiesta: se nel frattempo è cambiata, questo numero è vecchio e viene ignorato.
 *
 * Accetta solo un conteggio: un `NaN` non entra (sarebbe un badge «NaN»), un negativo vale 0, un
 * decimale si tronca. Non sono difese teoriche: il valore arriva da un JSON di rete.
 */
export function impostaChatNonLettiDalServer(prossimo: number, sequenzaAllaPartenza: number): void {
    if (typeof prossimo !== 'number' || !Number.isFinite(prossimo)) return;
    if (sequenzaAllaPartenza !== sequenza) return;
    const pulito = Math.max(0, Math.trunc(prossimo));
    if (pulito === valore) return;
    valore = pulito;
    avvisa();
}

/**
 * Una variazione LOCALE del totale: `−n` per i messaggi appena letti, `+1` per quello appena
 * arrivato da qualcun altro. Il valore non scende sotto zero, e su `null` non cambia niente —
 * ma la sequenza avanza comunque, perché una richiesta già in volo non sa di questa lettura.
 *
 * Una variazione di ZERO non è una variazione: non consuma la sequenza, così non invalida un poll
 * per niente.
 */
export function variaChatNonLetti(delta: number): void {
    if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) return;
    sequenza++;
    if (valore === null) return;
    const pulito = Math.max(0, valore + Math.trunc(delta));
    if (pulito === valore) return;
    valore = pulito;
    avvisa();
}

/**
 * DIMENTICA IL TOTALE: torna a «non lo so». Da chiamare quando cambia la PERSONA.
 *
 * ─── PERCHÉ SERVE, e non è un caso di laboratorio ───────────────────────────────────────
 *
 * Questo è stato di MODULO: sopravvive a ogni navigazione che non ricarica la pagina. Il logout a
 * mano una ricarica dura la fa (`doLogout` → `window.location.href`), quindi lì lo store muore da
 * sé. Ma una sessione SCADUTA porta al login con una navigazione morbida, e da lì si entra come
 * un'altra persona senza che il contesto JavaScript sia mai stato buttato: il numero del genitore
 * di prima resterebbe sulla barra del genitore dopo, finché il server non ne manda uno nuovo — e se
 * risponde `null` («non lo so»), per sempre.
 *
 * Non è un dato innocuo da mostrare alla persona sbagliata: dice quante conversazioni con la scuola
 * ha in sospeso qualcun altro. Un numero solo, ma è il numero di un'altra famiglia.
 *
 * La sequenza avanza comunque: una richiesta partita con l'identità di PRIMA e ancora in volo
 * porterebbe indietro il totale di quella persona, e va scartata all'arrivo.
 */
export function azzeraChatNonLetti(): void {
    sequenza++;
    if (valore === null) return;
    valore = null;
    avvisa();
}

/** Avvisa a ogni cambiamento del totale. Restituisce la funzione per smettere. */
export function ascoltaChatNonLetti(avviso: () => void): () => void {
    ascoltatori.add(avviso);
    return () => {
        ascoltatori.delete(avviso);
    };
}

/** Il totale per chi lo mostra: `null` finché non si sa. Nessuna richiesta di rete da qui. */
export function useChatNonLetti(): number | null {
    return useSyncExternalStore(ascoltaChatNonLetti, chatNonLetti, chatNonLettiPrerender);
}

/**
 * «UNA CONVERSAZIONE È STATA LETTA, E LA CAMPANELLA NON LO SA ANCORA.»
 *
 * Leggere una conversazione spegne anche le sue NOTIFICHE (`segnaLetteNotificheChat`):
 * il numero sulla campanella scende in tabella, ma il pannello che lo mostra lo ha in mano dal suo
 * ultimo giro e non se ne accorge fino al successivo — fino a 60 s dopo. L'evento avvisa i
 * pannelli montati, che ricaricano; se nessuno ascolta, non succede niente e il giro normale
 * arriverà comunque.
 *
 * Un evento `window` e non una chiamata diretta perché chi legge (la pagina chat, la pagina della
 * segreteria) e chi mostra la campanella (l'AppBar, la TopBar) non si conoscono. Stesso schema di
 * `@/lib/notifiche/pagina-aperta-da-notifica`.
 *
 * Nel dettaglio non viaggia NIENTE: non l'uuid del thread, non quante notifiche si sono spente.
 * Chi ascolta non deve decidere, deve rileggere — e un evento `window` è visibile a tutto ciò che
 * gira nella pagina.
 */
export const EVENTO_CHAT_LETTA = 'kv:chat-letta';

/** Una conversazione è stata letta: i pannelli della campanella montati lo sentono. */
export function segnalaChatLetta(): void {
    window.dispatchEvent(new CustomEvent(EVENTO_CHAT_LETTA));
}

/**
 * Ascolta le letture di conversazione. Restituisce la funzione che smette di ascoltare, da
 * chiamare allo smontaggio.
 */
export function ascoltaChatLetta(gestore: () => void): () => void {
    const suEvento = () => gestore();
    window.addEventListener(EVENTO_CHAT_LETTA, suEvento);
    return () => window.removeEventListener(EVENTO_CHAT_LETTA, suEvento);
}

/**
 * Quanto si aspetta prima di ricaricare la campanella, dopo che una conversazione è stata letta.
 *
 * Non zero: l'IntersectionObserver della pagina chat manda più PATCH ravvicinate mentre le bolle
 * entrano nel viewport, e ognuna spegne le notifiche del thread. Una ricarica per PATCH sarebbe
 * volume inutile su una route che gira già ogni 60 s; con un rimando la raffica costa UN giro.
 */
export const RICARICA_DOPO_CHAT_LETTA_MS = 600;

/**
 * Ricarica `ricarica` circa 600 ms dopo una lettura di conversazione, UNA volta per raffica.
 *
 * Sta qui e non dentro i due pannelli della campanella perché era scritto identico in entrambi, e in
 * questo repo una regola valida per più strade vive in un posto solo: due copie del rimando sono due
 * posti in cui domani un timer resta appeso allo smontaggio.
 *
 * `attivo`: serve a `AdminNotificationsPanel`, che è montato DUE volte (topbar desktop e mobile) e
 * tiene acceso solo quello che si vede davvero. Senza il gate una lettura costerebbe due richieste —
 * lo stesso difetto che quel pannello già evita sul suo polling. Un pannello non attivo non ascolta
 * nemmeno: non basta non ricaricare, perché a `false` il timer di prima va comunque cancellato.
 *
 * Un timer solo, cancellato allo smontaggio e a ogni cambio di `ricarica`/`attivo`: nessun orologio
 * nuovo, e niente che sopravviva al componente.
 */
export function useRicaricaSuChatLetta(ricarica: () => void, attivo = true): void {
    useEffect(() => {
        if (!attivo) return;
        let rimando: ReturnType<typeof setTimeout> | null = null;
        const smetti = ascoltaChatLetta(() => {
            if (rimando !== null) clearTimeout(rimando);
            rimando = setTimeout(() => {
                rimando = null;
                ricarica();
            }, RICARICA_DOPO_CHAT_LETTA_MS);
        });
        return () => {
            smetti();
            if (rimando !== null) clearTimeout(rimando);
        };
    }, [ricarica, attivo]);
}
