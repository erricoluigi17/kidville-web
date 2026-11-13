import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';
import { conCorrezioneNelCorpo, type InviaConCorrezione } from '@/lib/ui/correzione-fetch';

/**
 * Una mutazione che RIPORTA il proprio esito, invece di ingoiarlo.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 *
 * AGENTS.md ha la regola giusta sui log del SERVER («un catch che non logga è un
 * bug») e `esito-fetch.ts` ha il messaggio da mostrare a schermo. Mancava la
 * terza cosa: il PEZZO DI CODICE che li mette insieme. Senza, ogni componente
 * riscrive a mano `if (!res.ok) { logga; mostra; ricarica }` — e chi lo riscrive
 * a mano lo dimentica, che è esattamente ciò che è successo in `OrarioManager`
 * (tre mutazioni, `await fetch(...)` nudo, nessun `res.ok`, nessun log) e in
 * `GiudiziManager` prima di lui (sei).
 *
 * Il corpo è copiato da `GiudiziManager.muta` (2026-09-08), che è il primo posto
 * in cui è stato scritto per intero; qui diventa una funzione di modulo perché
 * la seconda copia è il momento in cui una funzione smette di essere un dettaglio
 * di un componente.
 *
 * ─── PERCHÉ UNA FABBRICA E NON UNA FUNZIONE NUDA ────────────────────────────
 *
 * Nel componente `muta` chiudeva su quattro cose che a un modulo non si possono
 * passare da fuori a ogni chiamata senza rendere illeggibile il punto d'uso: la
 * rotta della pagina (per il log), il `load()` da rifare, il `setState`
 * dell'errore e la frase tradotta di ripiego (che viene da `useTranslations`, un
 * hook: qui non si può invocare). Si legano una volta sola, in cima al
 * componente, e la firma del punto d'uso resta quella di prima —
 * `muta(url, init, evento)` — così i chiamanti si leggono uguali nei due file.
 *
 * ─── COSA LOGGA, E COSA NO ──────────────────────────────────────────────────
 *
 * Sul rifiuto esce lo `stato` — è un numero, passa la lista bianca di `redact`,
 * ed è l'unica cosa che dai log distingue «sede non tua» (403) da «sede ambigua»
 * (400) da «già in uso» (409). Il CORPO non si logga mai: nelle route di questo
 * repo può contenere il nome di una classe, di una materia o di un bambino.
 *
 * Fuori dal log resta anche il `contesto` (il quarto argomento, vedi sotto): è il
 * nome di una RIGA, e una riga qui può essere una persona.
 *
 * ⚠️ E IL LOG NON È IL PRESIDIO. `logClient` filtra per livello PRIMA di spedire:
 * 401, 403 e 404 non lasciano il dispositivo affatto (`livelloFetch` in
 * `@/lib/logging/client`), perché sono risposte corrette a richieste sbagliate e
 * riempirebbero `app_log` di rumore. Il 403 di sede — con tre plessi, il rifiuto
 * più probabile di tutti — nei log non si vedrà MAI. L'unica cosa che resta fra
 * quel rifiuto e chi ha premuto il pulsante è l'AVVISO A SCHERMO: è quello la
 * parte che conta, ed è per questo che `setErrore` non è opzionale.
 */
export interface OpzioniMuta {
  /** La rotta della PAGINA (non della fetch): è il luogo dell'incidente. */
  route: string;
  /** Si ricarica dal server dopo la mutazione. Sul rifiuto è ciò che riporta lo schermo alla verità. */
  ricarica: () => void;
  /** Dove finisce il messaggio da mostrare. La stringa vuota significa «nessun errore». */
  setErrore: (messaggio: string) => void;
  /** La frase TRADOTTA di ripiego, per quando il server non dice niente di leggibile. */
  fallback: string;
  /**
   * PR 4.9: la pagina che sa registrare una CORREZIONE su un anno chiuso (`useCorrezioneAnno`). Se il server risponde 409
   * `ANNO_CHIUSO` con `correzione_possibile`, il dialogo chiede il motivo e la richiesta riparte con `correzione` nel corpo JSON.
   * Assente: la mutazione è quella di sempre.
   */
  inviaConCorrezione?: InviaConCorrezione;
  /**
   * Un successo che HA QUALCOSA DA DIRE: il server ha scritto, ma una parte del lavoro non è riuscita (es. `ricalcolo: 'non-riuscito'`
   * di `scrutinio-periodi`). Riceve il corpo JSON della risposta riuscita e torna la frase da mostrare (nello stesso posto degli
   * errori), o `null` se non c'è niente da dire. La mutazione resta `true`: il dato è salvato. Assente: il corpo non si legge.
   */
  avvisoDalSuccesso?: (corpo: unknown) => string | null;
}

/**
 * `true` = il server ha accettato. Il chiamante decide che farne (es. svuotare un campo).
 *
 * Il quarto argomento, `contesto`, è il NOME DELLA RIGA toccata — una materia, un
 * periodo, un docente — e viene anteposto al messaggio d'errore. In un elenco lungo
 * «salvataggio non riuscito» non dice a QUALE riga rifare il gesto, e un messaggio
 * che non lo dice non è azionabile. Omettendolo il comportamento è quello originale
 * di `GiudiziManager`, invariato.
 */
export type Muta = (url: string, init: RequestInit, evento: string, contesto?: string) => Promise<boolean>;

export function creaMuta({ route, ricarica, setErrore, fallback, inviaConCorrezione, avvisoDalSuccesso }: OpzioniMuta): Muta {
  return async (url, init, evento, contesto) => {
    // Il contesto vive SOLO a schermo: sotto non compare in nessuna delle due `logClient`.
    const conContesto = (messaggio: string) => (contesto ? `${contesto}: ${messaggio}` : messaggio);
    try {
      const res = inviaConCorrezione
        ? await inviaConCorrezione((correzione) => fetch(url, correzione ? conCorrezioneNelCorpo(init, correzione) : init))
        : await fetch(url, init);
      if (!res.ok) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: evento, route, stato: res.status });
        setErrore(conContesto(await messaggioErrore(res, fallback)));
        // Si ricarica ANCHE sul rifiuto: è il modo di togliere dallo schermo
        // ciò che il server non ha accettato.
        ricarica();
        return false;
      }
      setErrore(avvisoDalSuccesso ? await leggiAvviso(res, avvisoDalSuccesso, route, evento) : '');
      ricarica();
      return true;
    } catch (err) {
      // Rete giù o corpo illeggibile: qui non c'è nessuno `stato` da riportare,
      // e il messaggio del server non esiste. Resta la frase del componente.
      logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}: ${nomeErrore(err)}`, route });
      setErrore(conContesto(fallback));
      return false;
    }
  };
}

/** La frase di un successo che ha qualcosa da dire, o `''`. Un corpo illeggibile non rompe la mutazione (è già riuscita): `warn` col solo nome dell'errore. */
async function leggiAvviso(res: Response, avviso: (corpo: unknown) => string | null, route: string, evento: string): Promise<string> {
  try {
    return avviso(await res.json()) ?? '';
  } catch (err) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `${evento}: corpo del successo illeggibile (${nomeErrore(err)})`, route });
    return '';
  }
}
