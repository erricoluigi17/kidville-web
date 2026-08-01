import it from '../../../messages/it/shared.json';
import en from '../../../messages/en/shared.json';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/config';

/**
 * Il messaggio d'errore di una risposta del server, per l'interfaccia.
 *
 * PERCHÉ ESISTE. Il repo ha la regola giusta sui log del SERVER («un catch che
 * non logga è un bug») ma non ne aveva l'equivalente a schermo: decine di
 * mutazioni del cockpit erano scritte `if (res.ok) { … }` senza `else`. Quando
 * il server rifiutava — un 403 di scope, il 400 «Specificare la sede» nato con
 * il multi-sede — la pagina si comportava esattamente come dopo un successo:
 * modale chiuso, elenco ricaricato, nessun segnale. È ciò che ha reso invisibili
 * gli errori di sede per mesi: l'unico modo di accorgersene sarebbe stato
 * l'errore, e l'errore non arrivava mai.
 *
 * COSA FA. Legge il corpo (`{ error: '…', codice?: '…' }`, la forma di tutte le
 * route: il wrapper `withRoute` restituisce la Response invariata) e ne ricava il
 * testo da mostrare. Se c'è un `codice` DICHIARATO qui sotto, il testo viene dal
 * catalogo nella lingua dell'interfaccia; altrimenti resta la prosa del server;
 * se manca anche quella, il `fallback` — mai la stringa vuota, che a schermo è
 * indistinguibile dal silenzio di prima.
 *
 * NON LANCIA e non logga: il log lo fa il chiamante, che è l'unico a sapere
 * quale operazione è stata rifiutata (`stato` compreso: è un numero, passa la
 * lista bianca di `redact`, ed è l'unica cosa che distingue un 400 da un 403).
 * Il corpo NON si logga: può contenere il nome di una classe o di un bambino.
 *
 * ─── PERCHÉ IL CODICE, E NON UNA TRADUZIONE DELLA FRASE ─────────────────────
 *
 * Collaudo del 2026-07-31, categoria localizzazione, fallimenti F1 e F2: con
 * `<html lang="en">` la modale «New notice» mostrava «Sede non accessibile» e
 * «Specificare la sede (scuola_id) per questa operazione». Italiano dentro
 * un'interfaccia inglese — e il secondo messaggio, scritto per chi legge i log,
 * mostrava a una segretaria il nome di una colonna del database.
 *
 * Non è una traduzione dimenticata: quel testo NASCE sul server, dentro
 * `resolveScuolaScrittura`, dove non esistono né il locale né il catalogo.
 * Tradurre le due frasi avrebbe chiuso i due sintomi e lasciato in piedi la
 * causa: la frase successiva sarebbe nata italiana come le altre 1498.
 *
 * Perciò il server manda un CODICE stabile accanto alla prosa, e la traduzione
 * avviene qui, dove la lingua c'è. Il codice non si traduce e non si mostra: è
 * un identificatore, come `PGRST204`.
 *
 * ─── PERCHÉ NON `useTranslations` ───────────────────────────────────────────
 *
 * Questa non è una funzione di React: la chiamano gestori di eventi e funzioni
 * asincrone, dove gli hook non si possono invocare. E cambiarne la firma per
 * farsi passare il traduttore vorrebbe dire toccare i 14 punti che la usano, cioè
 * far dipendere la correzione dalla disciplina di chi la adotta — che è
 * esattamente il motivo per cui gli errori italiani sono 1498.
 *
 * Quindi i due cataloghi si importano diretti e la lingua si legge da
 * `document.documentElement.lang`, che `RootLayout` scrive da `getLocale()` (la
 * stessa fonte di next-intl: il cookie `KV_LOCALE`, già validato). Stesso
 * espediente, stesso motivo, di `src/app/offline/page.tsx`, che importa entrambe
 * le lingue perché è servita da una cache dove il provider non arriva.
 */

/**
 * I codici che il server può mandare, e la chiave di catalogo di ciascuno
 * (namespace `shared`, presente in `messages/it` e `messages/en`).
 *
 * È l'UNICO elenco: il lock `__tests__/architecture/errori-con-codice.test.ts`
 * pretende che ogni `codice:` scritto in `src/` sia qui dentro e che la sua
 * chiave esista in entrambi i cataloghi. Un codice inventato in una route e mai
 * dichiarato qui non è un mezzo fix: a schermo sarebbe indistinguibile dal
 * difetto di partenza, perché ricadrebbe sulla prosa italiana.
 */
export const CODICI_ERRORE = {
    /** 403 — la sede indicata (nel corpo o nel cookie) non è fra le proprie. */
    SEDE_NON_ACCESSIBILE: 'erroreSedeNonAccessibile',
    /** 400 — più sedi accessibili e nessuna indicata: l'operatore deve scegliere. */
    SEDE_DA_SPECIFICARE: 'erroreSedeDaSpecificare',
    /** 415 — il tipo dell'allegato non è fra quelli ammessi (`src/lib/allegati/mime.ts`). */
    ALLEGATO_TIPO_NON_AMMESSO: 'erroreAllegatoTipoNonAmmesso',
    /** 413 — l'allegato supera il limite del bucket (10 MB). */
    ALLEGATO_TROPPO_GRANDE: 'erroreAllegatoTroppoGrande',
    /** 400 — l'indirizzo dell'allegato non è del nostro bucket (`src/lib/chat/allegati.ts`). */
    ALLEGATO_NON_VALIDO: 'erroreAllegatoNonValido',
    /**
     * 500 — lo Storage ha rifiutato il caricamento per un motivo IMPREVISTO
     * (`src/lib/allegati/risposte.ts`). Il messaggio del fornitore resta nel log: fino al
     * 2026-08-01 usciva invece di qui, in inglese e col nome di un vincolo interno.
     */
    ALLEGATO_NON_CARICATO: 'erroreAllegatoNonCaricato',
    /** 403/500 — il file appena caricato non si può togliere dal bucket (`src/lib/allegati/risposte.ts`). */
    ALLEGATO_NON_RIMOSSO: 'erroreAllegatoNonRimosso',
    /** 429 — tetto di frequenza raggiunto (`src/lib/security/otp-rate-limit.ts`). */
    TROPPE_RICHIESTE: 'erroreTroppeRichieste',
    /**
     * 400 — un avviso «di classe» senza nessuna classe destinataria. Non degrada a
     * globale in silenzio: notifica e bacheca devono sempre dire la stessa cosa.
     */
    CLASSE_DESTINATARIA_MANCANTE: 'erroreClasseDestinatariaMancante',
    /**
     * 400 — una classe destinataria non esiste nella sede dell'avviso
     * (`src/lib/avvisi/classi-sede.ts`). Il `error` accanto elenca QUALI: il codice
     * dà la frase tradotta, la prosa il dettaglio che solo il server conosce.
     */
    CLASSI_FUORI_SEDE: 'erroreClassiFuoriSede',
    /**
     * 500 — non è stato possibile leggere le sezioni per validare i destinatari.
     * È un guasto NOSTRO, e va detto come tale: prima del 2026-08-01 un errore di
     * lettura sarebbe uscito come «nessuna classe trovata», cioè un 400 che accusa
     * l'operatore di uno sbaglio che non ha commesso.
     */
    VERIFICA_CLASSI_NON_RIUSCITA: 'erroreVerificaClassiNonRiuscita',
} as const;

export type CodiceErrore = keyof typeof CODICI_ERRORE;

const CATALOGHI: Record<Locale, Record<string, string>> = {
    it: it as Record<string, string>,
    en: en as Record<string, string>,
};

/**
 * La lingua dell'interfaccia, letta dal documento. Fuori dal browser (test in
 * ambiente `node`, render sul server) e per qualunque valore non previsto:
 * italiano, che è il default dichiarato dell'app.
 *
 * Si guarda il SOTTOTAG di base perché `lang` potrebbe un giorno diventare
 * BCP47 completo (`en-GB`: la regione è già decisa in `@/i18n/config`, e la
 * distanza fra le due cose è una riga di `RootLayout`). Oggi vale `en` —
 * verificato sul server di sviluppo, `Cookie: KV_LOCALE=en` → `<html lang="en">`
 * — ma un giorno in cui quella riga cambia e questa no sarebbe un giorno in cui
 * tutti gli errori tornano italiani senza che nulla diventi rosso.
 */
function linguaCorrente(): Locale {
    if (typeof document === 'undefined') return DEFAULT_LOCALE;
    const lang = document.documentElement.getAttribute('lang');
    const base = (lang ?? '').split('-')[0];
    return isLocale(base) ? base : DEFAULT_LOCALE;
}

/** Il testo di catalogo di un codice, o `null` se il codice non è dichiarato. */
function testoDelCodice(codice: unknown): string | null {
    if (typeof codice !== 'string') return null;
    const chiave = (CODICI_ERRORE as Record<string, string>)[codice];
    if (!chiave) return null;
    // Se la chiave manca dal catalogo si torna `null` e si ricade sulla prosa:
    // mostrare `erroreSedeNonAccessibile` all'utente sarebbe peggio dell'italiano.
    const testo = CATALOGHI[linguaCorrente()][chiave];
    return typeof testo === 'string' && testo.trim() !== '' ? testo : null;
}

export async function messaggioErrore(res: Response, fallback: string): Promise<string> {
    try {
        const j: unknown = await res.json();
        const corpo = j as { error?: unknown; codice?: unknown } | null;
        const tradotto = testoDelCodice(corpo?.codice);
        if (tradotto) return tradotto;
        const msg = corpo?.error;
        return typeof msg === 'string' && msg.trim() !== '' ? msg : fallback;
    } catch {
        return fallback;
    }
}
