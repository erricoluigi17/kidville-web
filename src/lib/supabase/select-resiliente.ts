import { logEvento, type Livello } from '@/lib/logging/logger';

/**
 * UNA SELECT CHE SOPRAVVIVE A UNA COLONNA CHE QUESTO DATABASE NON HA.
 *
 * ─── Perché esiste ──────────────────────────────────────────────────────────
 * `select('*')` non falliva mai; una proiezione ESPLICITA sì. E le proiezioni
 * esplicite sono arrivate per una buona ragione (l'elenco genitori restituiva il
 * fascicolo completo di ogni adulto a ogni apertura della tab), quindi non si
 * torna indietro. Solo che il progetto E2E della CI **non è migrato**: lì
 * `intestatario_default`, `codice_belfiore_nascita` e chiunque arrivi dopo non
 * esistono, e PostgREST risponde `42703`. Senza questo, l'unica differenza fra
 * «la colonna non c'è ancora» e «il server è rotto» sarebbe un 500.
 *
 * Si toglie la colonna che il messaggio d'errore NOMINA — non tutte, non a
 * caso — e si riprova. Il tetto di sei giri esiste perché un ciclo che non
 * termina è peggio di un 500: quello almeno si vede.
 *
 * ─── Perché sta in `src/lib` e non dentro una route ─────────────────────────
 * Perché è la TERZA copia che avrebbe cominciato a divergere. Il pattern era
 * scritto a mano in cinque punti, ognuno con la sua regex e il suo tetto di
 * tentativi. Una regola valida per più strade deve vivere in un posto solo: è la
 * lezione che questo repo ha già pagato.
 *
 * ⚠️ MA LA CONSOLIDAZIONE NON È AVVENUTA, ED È SCRITTO QUI PERCHÉ IL DEBITO
 * RESTI VISIBILE. Fino al 2026-08-10 questo stesso paragrafo elencava i cinque
 * punti e chiudeva con la massima, lasciando credere che fossero stati
 * convertiti tutti: non lo erano. Un commento che descrive uno stato che il
 * codice non ha è precisamente la trappola che `CLAUDE.md` documenta — e che
 * questo file ha ripetuto nel suo primo giorno di vita.
 *
 *   CONVERTITI
 *     · `src/app/api/admin/parents/route.ts`  → `admin/parents:GET` (due call-site)
 *     · `src/app/api/admin/anagrafiche/codici-fiscali/route.ts` → alunni e genitori
 *
 * ⚠️⚠️ E POI CI SIAMO RICASCATI, NELLA STESSA GIORNATA. La prima stesura di
 * questo blocco proseguiva con un elenco di QUATTRO copie «ancora a mano»
 * presentato come inventario chiuso («chi ne tocca una: la porti qui e tolga la
 * riga da questo elenco»). Le copie vive erano molte di più: l'elenco non
 * nominava né `candidature-insegnanti`, né `gdpr/retention-candidature`, né
 * `iscrizione/insegnanti`, né `lib/auth/staff-identity`.
 *
 * ⚠️⚠️⚠️ E LA CORREZIONE HA RIFATTO L'ERRORE UNA TERZA VOLTA. Questo capoverso
 * proseguiva con «sono OTTO, in sette file, con quattro grafie diverse»,
 * attribuendo quel numero a `grep -rn "colonna-assente" src`, cioè spacciando il
 * conteggio delle RIGHE DI GREP per il conteggio di ciò che quelle righe
 * significano — che è la stessa confusione che il blocco denuncia. Le due cose
 * non coincidono, e si è misurato in che modo:
 *
 *   · una di quelle righe NON è un'emissione: in `src/lib/chat/delivered.ts` la
 *     stringa sta dentro un COMMENTO;
 *   · e lo stesso file, alla riga sotto, EMETTE davvero un log di degrado che la
 *     grep non vede: `esito: 'colonna-delivered_at-assente'`.
 *
 * Cioè il numero era giusto per caso, contando due insiemi diversi che si
 * somigliano nel totale. E la grep è più cieca di quanto ammettesse: le grafie
 * che INFILANO il nome della colonna in mezzo — `colonna-delivered_at-assente`,
 * `colonna-consenso-assente`, `colonna-sede-assente-degrado` — non contengono
 * mai la sottostringa cercata. Perciò nessun numero, qui: solo le grep, con la
 * terza aggiunta apposta per la famiglia che le prime due si perdono.
 *
 * Quindi qui NON c'è più un inventario. C'è il modo di ricostruirlo, che è
 * l'unica forma che non invecchia:
 *
 *     grep -rn "colonna-assente" src              # la grafia canonica
 *     grep -rn "esito:.*\(colonna\|assente\)" src # anche il nome INFILATO in mezzo
 *     grep -rn "42703\|PGRST204" src              # tutte, comprese quelle mute
 *
 * ⚠️ Nessuna delle tre è esaustiva e tutte vanno lette a mano: la prima perde le
 * grafie col nome infilato in mezzo (è l'errore appena descritto), la seconda
 * pesca anche `tabella-assente` e `schema-assente`, che sono un'altra cosa, e
 * nessuna vede le forme multiriga (`while (\n  esito.error &&\n
 * COLONNA_ASSENTE.has(…)`, come in `src/lib/auth/staff-identity.ts`). Il numero
 * che verrebbe voglia di scrivere qui non è mai il numero che si cerca: si
 * eseguano le grep e si guardi cosa fanno le righe, invece di leggere questo
 * paragrafo.
 *
 * Non sono state convertite qui perché sono altre corsie e la conversione va
 * fatta col loro collaudo accanto, non di straforo. Chi ne tocca una la porti
 * qui: è così che l'elenco si accorcia davvero, invece che sulla carta.
 *
 * ─── Il log NOMINA la colonna, e lo fa dove la redazione non la cancella ────
 * `redact()` è a lista bianca PER CHIAVE: un `campo: 'codice_belfiore_nascita'`
 * finisce in `app_log` come `[redatto:str/23]`, cioè la riga dice che una
 * colonna è caduta e non dice QUALE — che è l'unica cosa che serve sapere. Il
 * nome viaggia quindi dentro `esito`, che è in lista bianca e ha la forma di un
 * enumerato: `esito=colonna-assente:codice_belfiore_nascita`. Non è un dato
 * personale e non arriva dall'esterno — è uno dei nomi che il CHIAMANTE ha
 * chiesto, e viene emesso solo dopo essere stato ritrovato in quell'elenco.
 */

/** La forma minima di una risposta PostgREST: quel che serve per decidere se riprovare. */
export interface EsitoPostgrest {
    data: unknown;
    error: { code?: string; message: string } | null;
}

export interface OpzioniSelectResiliente {
    /**
     * Livello del log di degrado. Default `info`: su `admin/parents` è una nota
     * tecnica di una lettura che è comunque riuscita. Chi legge una colonna
     * NUOVA, appena migrata in produzione, passa `warn`: lì il degrado significa
     * «questo ambiente non ha ancora la migrazione», ed è un fatto da ritrovare
     * in `app_log` fra un mese, non una riga di console che evapora in un giorno.
     */
    livello?: Livello;
    /**
     * Numero massimo di colonne che si accetta di togliere. Default 6.
     *
     * ⚠️ Il DEFAULT è inchiodato da `__tests__/lib/select-resiliente.test.ts` da
     * entrambi i lati (sei colonne devono ancora riuscire, sette devono fallire).
     * Prima del 2026-08-10 non lo era: l'unico test sul tetto passava
     * `tentativiMassimi: 2` esplicito, quindi il 6 si poteva portare a 100 con la
     * suite tutta verde — e «un ciclo che non termina è peggio di un 500» restava
     * una frase nel commento invece che una proprietà del codice.
     */
    tentativiMassimi?: number;
}

/**
 * I codici che significano «questa COLONNA non esiste»: `42703` (Postgres, sulle
 * SELECT) e `PGRST204` (PostgREST non la trova nella schema cache, tipicamente su
 * INSERT/UPDATE). NON ci sono i codici di TABELLA assente (`42P01`, `PGRST205`):
 * lì non c'è nessuna colonna da togliere, e insistere sarebbe un ciclo cieco.
 */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204']);

/**
 * Il nome della colonna, letto dal messaggio del fornitore. Due forme, perché i
 * due codici parlano due lingue diverse:
 *   42703    → `column alunni.codice_belfiore_nascita does not exist`
 *   PGRST204 → `Could not find the 'codice_belfiore_nascita' column of 'alunni' …`
 */
export function nomeColonnaAssente(messaggio: string): string | null {
    const daPostgres = /column\s+(?:\w+\.)?"?(\w+)"?\s+does not exist/i.exec(messaggio)?.[1];
    if (daPostgres) return daPostgres;
    return /could not find the '([\w.]+)' column/i.exec(messaggio)?.[1]?.split('.').pop() ?? null;
}

/**
 * Esegue una SELECT togliendo le colonne che questo database non ha e riprovando.
 *
 * `esegui` riceve l'elenco delle colonne SUPERSTITI e deve ricostruire la query da
 * capo: un builder PostgREST già consumato non si riusa.
 */
export async function selectResiliente<R extends EsitoPostgrest>(
    colonne: readonly string[],
    esegui: (colonne: string[]) => PromiseLike<R>,
    operazione: string,
    opzioni: OpzioniSelectResiliente = {},
): Promise<R> {
    const livello: Livello = opzioni.livello ?? 'info';
    const tentativiMassimi = opzioni.tentativiMassimi ?? 6;

    let superstiti = [...colonne];
    let esito = await esegui(superstiti);
    let tentativi = 0;

    while (esito.error && COLONNA_ASSENTE.has(esito.error.code ?? '') && tentativi < tentativiMassimi) {
        const colonna = nomeColonnaAssente(esito.error.message);
        // Una colonna che NON avevamo chiesto non è una colonna che possiamo
        // togliere: insistere toglierebbe qualcos'altro o non toglierebbe niente,
        // e in entrambi i casi il giro dopo sarebbe identico a questo.
        if (!colonna || !superstiti.includes(colonna)) break;
        logEvento('db', livello, { operazione, esito: `colonna-assente:${colonna}` });
        superstiti = superstiti.filter((c) => c !== colonna);
        esito = await esegui(superstiti);
        tentativi++;
    }

    return esito;
}
