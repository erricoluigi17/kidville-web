import { CODICI_ANNO } from '@/lib/anno/tipi';
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico';
import type { Valore } from './logger';
import type { ErroreDescritto } from './serialize';

// Il formato di un token non basta a renderlo un metadato: anche un nome o una chiave
// potrebbero rispettarlo. Nei contesti CRM protetti passano i soli valori tecnici noti.
const OPERAZIONI = new Set([
    'crm/ai/accesso:requireIntegrazioneAi', 'crm/ai/tetto-frequenza',
    'crm/agenda:notificaVisitaAssegnata', 'getModuleConfig', 'isNotificaAbilitata',
    'enqueueNotifiche', 'notificaEvento', 'security/rate-limit:degrado', 'app_log_registra',
    'resolveIdentity', 'resolveSessionAppId', 'requireSessioneAuth',
    'requireUserDaSessioneVerificata',
    'crm_integrazioni', 'crm_ai_richieste', 'crm_ai_token_attivo', 'crm_ai_persone',
    'crm_ai_scheda', 'crm_ai_bambini', 'crm_ai_registra_contatto', 'crm_ai_candidati',
    'crm_ai_prenota', 'crm_ai_annulla', 'crm_ai_richiamo',
    'sections', 'crm_appuntamenti', 'crm_indisponibilita', 'crm_settimane', 'crm_fasce',
    'utenti', 'utenti_scuole', '?',
    // Rotte dei contatti CRM AI e tabelle che leggono.
    'crm/ai/contatti', 'crm/ai/contatti/stato', 'crm/ai/contatti/nuovi', 'crm_schede', 'crm_bambini',
]);
const OPERAZIONE_AI = /^crm\/ai:(?:slot|prenota|annulla|contatto|contatto_stato|contatti_nuovi|richiamo)$/;
const LETTURA_AI = /^crm\/ai\/(?:slot|prenota)(?::(?:agenda|appuntamenti|indisponibilita|disponibilita|persone|sezioni))?$/;
const OPERAZIONE_CHIAVI = /^admin\/crm\/integrazioni(?::(?:GET|POST)|\/\[id\]:DELETE(?::(?:lettura|scrittura))?)$/;
// withRoute passa un nome tecnico anche quando completa una richiesta delegata a un
// wrapper protetto: in quel caso il nome del chiamante è diverso da contesto().route.
const NOME_ROTTA = /^(?=.{1,64}$)[a-zA-Z][a-zA-Z0-9_-]*(?:\/(?:[a-zA-Z0-9_-]+|\[[a-zA-Z0-9_-]+\]))*:(?:GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/;
const METODI = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', '?']);

const ESITI = new Set([
    'ai-rifiutata', 'ai-sedi-ammesse-vuote', 'ai-ultimo-uso-non-scritto',
    'ai-sede-diversa-dalla-chiave', 'ai-chiamata', 'ai-visita-fissata', 'ai-visita-annullata', 'schema-crm-assente',
    'ai-contatto-creato', 'ai-contatto-gia-presente',
    'integrazioni-non-admin', 'sede-filtro-fuori-scope', 'riga-fuori-sede', 'integrazioni-elencate',
    'integrazione-rifiutata', 'integrazione-creata', 'integrazione-revocata', 'integrazione-gia-revocata',
    'config-illeggibile-notifiche_config', 'fail-open', 'notifica-non-inviata', 'notifica-non-accodata',
    'insert-fallito', 'insert-non-eseguito', 'nessun-destinatario', 'rettifica-storica-silenziosa',
    'chiave-dedup-assente', 'metadati-storici-assenti', 'conteggio_locale',
    'archiviazione-non-verificabile', 'utenti-non-letti', 'parents-non-letti',
    'sessione-non-verificata', 'sessione-non-leggibile', 'lookup-identita-fallito', 'token-sessione-non-letto',
    'handler-senza-response', 'esito-illeggibile', 'max-rows-raggiunto',
    'schema-assente', 'fallito', 'eccezione', 'riga-illeggibile',
]);
const TIPI = new Set([
    'crm_visita_assegnata', 'crm_visita_annullata', 'crm-ai', 'sconosciuto', 'header-fallback',
    'non-autenticato', 'utente-sconosciuto', 'ruolo-negato', 'account-archiviato',
    'sedi-utente-ponte-assente', 'sedi-utente-non-risolte', 'sedi-attive-non-accessibili',
    'sede-scrittura-fuori-scope', 'sede-scrittura-cookie-fuori-scope', 'sede-scrittura-ambigua',
    'anno-scrittura-ingoiata', 'anno-protetto',
]);
const AZIONI = new Set([
    'client_assente', 'rpc_errore', 'rpc_scaduta', 'rpc_malformata', 'eccezione',
    'requireStaff', 'scuoleDiUtente', 'resolveScuoleAttive', 'resolveScuolaScrittura',
]);
const RUOLI = new Set(['admin', 'coordinator', 'segreteria', 'cuoca', 'educator', 'genitore']);
const CODICI = new Set<string>([
    ...CODICI_ANNO,
    'CRM_AI_SPENTO', 'TOKEN_NON_VALIDO', 'SEDE_NON_AMMESSA', 'SEDE_NON_ACCESSIBILE', 'TROPPE_RICHIESTE',
    'GIA_PRENOTATO', 'SLOT_OCCUPATO', 'FUORI_DISPONIBILITA', 'CHIAVE_RIUSATA', 'ETA_NON_COPERTA',
    'NESSUN_RESPONSABILE', 'CONTATTO_OBBLIGATORIO', 'SCHEDA_NON_TROVATA', 'ELEMENTO_NON_TROVATO',
    'STATO_NON_AMMESSO', 'INTEGRAZIONE_ESISTENTE', 'CRM_OPERAZIONE_NON_RIUSCITA',
    'rate_limit_crm_ai', 'supabase_http', 'timeout', 'abort', 'errore_rete',
    'auth_sessione_non_verificata', 'auth_sessione_non_leggibile', 'auth_lookup_identita_fallito',
]);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ID_TECNICI = ['scuola_id', 'sede_id', 'entita_id', 'integrazione_id'] as const;
const NUMERI = ['ms', 'attesa_ms', 'tentativo', 'n', 'n_alunni', 'righe', 'limite', 'selezionate', 'accessibili', 'attive'] as const;

export function leggiProprieta(oggetto: unknown, chiave: string): unknown {
    try {
        return typeof oggetto === 'object' && oggetto !== null
            ? Object.getOwnPropertyDescriptor(oggetto, chiave)?.value
            : undefined;
    } catch {
        // Un campo illeggibile non deve costare l'intera riga tecnica.
        return undefined;
    }
}

function ammesso(v: unknown, valori: ReadonlySet<string>): v is string {
    return typeof v === 'string' && valori.has(v);
}

function operazioneAmmessa(evento: string, v: unknown): v is string {
    return typeof v === 'string' && (
        OPERAZIONI.has(v) || OPERAZIONE_AI.test(v) || LETTURA_AI.test(v) || OPERAZIONE_CHIAVI.test(v)
        || (evento === 'route' && NOME_ROTTA.test(v))
    );
}

function codiceAmmesso(v: unknown): string | undefined {
    if (ammesso(v, CODICI)) return v;
    return erroreDbSoloCodice({ code: v }).code;
}

/** Proiezione chiusa, usata per entrambi i sink e anche per l'identità della riga. */
export function campiCrmAi(evento: string, grezzi: unknown): Record<string, Valore> {
    const campi: Record<string, Valore> = {};
    const operazione = leggiProprieta(grezzi, 'operazione');
    if (operazioneAmmessa(evento, operazione)) campi.operazione = operazione;
    for (const [chiave, ammessi] of [
        ['esito', ESITI], ['tipo', TIPI], ['azione', AZIONI], ['metodo', METODI], ['ruolo', RUOLI],
    ] as const) {
        const v = leggiProprieta(grezzi, chiave);
        if (ammesso(v, ammessi)) campi[chiave] = v;
    }
    for (const chiave of ID_TECNICI) {
        const v = leggiProprieta(grezzi, chiave);
        if (typeof v === 'string' && UUID.test(v)) campi[chiave] = v;
    }
    for (const chiave of NUMERI) {
        const v = leggiProprieta(grezzi, chiave);
        if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) campi[chiave] = v;
    }
    const stato = leggiProprieta(grezzi, 'stato');
    if (typeof stato === 'number' && Number.isInteger(stato) && stato >= 100 && stato <= 599) campi.stato = stato;
    const doppio = leggiProprieta(grezzi, 'doppio');
    if (typeof doppio === 'boolean') campi.doppio = doppio;
    const codice = codiceAmmesso(leggiProprieta(grezzi, 'error_code'));
    if (codice) campi.error_code = codice;
    return campi;
}

function codiceErrore(err: unknown): string | undefined {
    // Errori avvolti: risale solo il codice, con un limite anche per cause circolari.
    for (let profondita = 0; profondita < 4 && err != null; profondita++) {
        const codice = codiceAmmesso(leggiProprieta(err, 'code'));
        if (codice) return codice;
        err = leggiProprieta(err, 'cause');
    }
    return undefined;
}

export function erroreCrmAi(evento: string, campi: Record<string, Valore>, err: unknown): ErroreDescritto {
    const codice = codiceErrore(err);
    // Le diagnosi già prodotte dai confini tecnici restano interrogabili. Il valore
    // in uscita è sempre un letterale nostro, mai una stringa copiata dall'errore.
    let messaggio = 'Operazione CRM non riuscita';
    if (campi.operazione === 'security/rate-limit:degrado') {
        messaggio = 'Errore del limitatore CRM AI';
    } else if (['db', 'rpc', 'auth', 'storage', 'altro'].includes(evento) && leggiProprieta(err, 'message') === 'Errore HTTP Supabase') {
        messaggio = 'Errore HTTP Supabase';
    } else if (evento === 'route') {
        const fisso = leggiProprieta(err, 'message');
        if (fisso === 'Eccezione durante una richiesta CRM AI') messaggio = 'Eccezione durante una richiesta CRM AI';
        if (fisso === 'Eccezione durante la gestione delle chiavi CRM') messaggio = 'Eccezione durante la gestione delle chiavi CRM';
    }
    return { messaggio, codice };
}
