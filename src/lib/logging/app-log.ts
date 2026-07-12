/**
 * Riga destinata alla TABELLA `app_log` (non a Vercel).
 *
 * Sono due canali con budget e vita diversi: su Vercel finisce una riga corta e
 * cercabile (marker + logfmt), qui finisce la riga strutturata e interrogabile in SQL.
 * Chi scrive qui dentro ha già fatto passare tutto da `redact`/`sanificaMessaggio`:
 * questa interfaccia non redige nulla per conto proprio.
 */
export interface RigaLog {
    livello: 'info' | 'warn' | 'error';
    evento: string;
    messaggio: string;
    stack?: string;
    codice?: string;
    statoHttp?: number;
    sorgente?: 'server' | 'client';
    piattaforma?: 'web' | 'ios' | 'android';
    contestoExtra?: Record<string, unknown>;
}

/**
 * Sostituito nel Task 8 dalla scrittura reale su Supabase.
 *
 * Fino ad allora è un no-op: il logger è già cablato sul canale di persistenza, ma
 * nessuna riga arriva a destinazione. Il chiamante (`persisti`, in `logger.ts`) la
 * invoca fire-and-forget e ne cattura la rejection: qui dentro si può fallire.
 */
export async function appLog(riga: RigaLog): Promise<void> {
    // `void riga` e non `_riga`: in questo repo `@typescript-eslint/no-unused-vars` non ha
    // `argsIgnorePattern`, quindi un parametro con l'underscore resta un warning — e
    // `--max-warnings 0` non perdona.
    void riga;
}
