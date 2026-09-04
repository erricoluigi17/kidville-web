'use client';

import { useCallback, useEffect, useState } from 'react';
import { logClient, nomeErrore } from '@/lib/logging/client';

/* ═══════════════════════════════════════════════════════════════════════════
 * LE SEDI VERSO CUI SI PUÒ SPOSTARE QUALCUNO, LETTE UNA VOLTA SOLA.
 *
 * ─── PERCHÉ NON `GET /api/admin/sedi` ──────────────────────────────────────
 *
 * `admin/sedi` risponde «le sedi in cui LAVORI» ed è la fonte del `SedeSelector`.
 * Qui la domanda è un'altra — «dove posso PORTARE questa persona» — e per la
 * Direzione la risposta è più larga delle proprie sedi: il trasferimento fra
 * plessi è esattamente il caso in cui la destinazione NON è ancora fra le tue.
 * Riempire una tendina di trasferimento con `admin/sedi` darebbe a una direttrice
 * due sedi su tre, **senza nessun errore da nessuna parte**.
 *
 * ─── PERCHÉ UN MODULO E NON DUE COPIE ──────────────────────────────────────
 *
 * Le schede che spostano sono due (bambino e personale) e la regola dei tre
 * esiti è una sola. «Una regola valida per due strade vive in un posto solo» è
 * la lezione che questo repo ha già pagato più volte; qui vale doppio, perché la
 * regola che si duplicherebbe è proprio quella che distingue un DIVIETO da un
 * GUASTO — cioè la sola cosa che questo modulo esiste per non far sbagliare.
 *
 * ─── I TRE ESITI, E IL TERZO NON SOMIGLIA AL SECONDO ───────────────────────
 *
 *   · `ok`      — ci sono destinazioni.
 *   · `nessuna` — il ruolo o il perimetro non ne danno nessuna. È una RISPOSTA.
 *   · `guasto`  — l'elenco non si è potuto leggere (500 `LETTURA_FALLITA`, rete
 *                 caduta, corpo illeggibile). ⚠️ NON è «non ci sono sedi»: senza
 *                 questa distinzione l'interfaccia scriverebbe «nessuna sede
 *                 disponibile» davanti a un permesso negato dal database — una
 *                 bugia con l'aria di un fatto, e la ragione per cui la rotta
 *                 restituisce `motivo` accanto a `data` invece di un array e
 *                 basta (vedi la testata di `src/lib/sedi/trasferimento.ts`).
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Una sede come la manda `GET /api/admin/sedi/destinazioni`: id canonico e nome. */
export interface SedeDestinazione {
    id: string;
    nome: string;
}

export type StatoDestinazioni = 'caricamento' | 'ok' | 'nessuna' | 'guasto';

export interface EsitoDestinazioniSede {
    stato: StatoDestinazioni;
    /** Le destinazioni consentite, nell'ordine deciso dal server (alfabetico). */
    sedi: readonly SedeDestinazione[];
    /** Rilegge l'elenco. Ha senso solo dopo un `guasto`: un divieto non cambia riprovando. */
    ricarica: () => void;
}

/**
 * Due uuid sono la stessa sede?
 *
 * ⚠️ IL CONFRONTO PASSA DALLE MINUSCOLE, e non è pedanteria: in Postgres `uuid` è
 * un TIPO e `'AAAA…'` è lo stesso valore di `'aaaa…'`, mentre in JavaScript sono
 * due stringhe diverse. Questo repo ha già pagato quel difetto con un 403 sulla
 * PROPRIA sede; qui costerebbe una tendina che offre come destinazione il plesso
 * in cui la persona già si trova, cioè un comando che non può fare niente.
 * (È la stessa regola di `formaConfronto` in `src/lib/auth/scope.ts`, che qui non
 * si può importare: quel modulo tira dentro il client Supabase lato server.)
 */
export function stessaSede(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Le destinazioni DIVERSE da quella attuale.
 *
 * Senza questo filtro la tendina di una segreteria conterrebbe una voce sola — la
 * sua sede, che è dove la persona già sta — cioè un menù che esiste, occupa
 * spazio e non può cambiare niente. Chi lo trova lo preme tre volte prima di
 * concludere che l'applicazione è rotta; è invece un fatto da SPIEGARE, e chi
 * chiama lo riconosce da `sedi.length > 0 && altreSedi(...).length === 0`.
 */
export function altreSedi(
    sedi: readonly SedeDestinazione[],
    attuale: string | null | undefined,
): readonly SedeDestinazione[] {
    return sedi.filter((s) => !stessaSede(s.id, attuale));
}

/** Il nome di una sede, o `null` se quell'uuid non è fra le destinazioni note. */
export function nomeSede(sedi: readonly SedeDestinazione[], id: string | null | undefined): string | null {
    if (!id) return null;
    return sedi.find((s) => stessaSede(s.id, id))?.nome ?? null;
}

export interface OpzioniDestinazioniSede {
    /**
     * Intestazioni da mandare con la lettura. Esiste per le schede che risolvono
     * l'identità di sessione e mandano `x-user-id` (la scheda del personale lo fa
     * su ogni sua chiamata): ometterlo dove serve significherebbe leggere le
     * destinazioni di nessuno.
     */
    intestazioni?: Record<string, string>;
    /**
     * `false` ⇒ non si legge niente e lo stato resta `caricamento`.
     *
     * Serve alle schede che sanno solo DOPO se le destinazioni gli servono: quella
     * del genitore ha bisogno dei nomi delle sedi solo se ha figli da mostrare,
     * quella del bambino non offre lo spostamento a un archiviato. Una lettura in
     * più non romperebbe niente, ma sarebbe una richiesta di rete per ogni scheda
     * aperta e una riga di log per ogni suo fallimento — rumore su un canale che
     * serve a vedere i guasti veri.
     */
    abilitato?: boolean;
}

/**
 * Legge le destinazioni consentite a CHI GUARDA.
 *
 * ⚠️ NESSUNO `setState` PRIMA DEL PRIMO `await` dentro l'effetto: la regola
 * `react-hooks/set-state-in-effect` è un ERRORE nel gate di questo repo. Lo stato
 * iniziale è già `caricamento`, quindi non c'è niente da scrivere all'ingresso;
 * la ricarica lo riporta a `caricamento` da un GESTORE, dove è consentito.
 */
export function useDestinazioniSede(opzioni?: OpzioniDestinazioniSede): EsitoDestinazioniSede {
    const [stato, setStato] = useState<StatoDestinazioni>('caricamento');
    const [sedi, setSedi] = useState<readonly SedeDestinazione[]>([]);
    const [giro, setGiro] = useState(0);

    const abilitato = opzioni?.abilitato ?? true;
    // `JSON.stringify` e non l'oggetto: un letterale ricreato a ogni render
    // rifarebbe la fetch a ogni disegno, e la scheda del personale passa proprio
    // un letterale (`{ 'x-user-id': userId }`).
    const chiaveIntestazioni = JSON.stringify(opzioni?.intestazioni ?? {});

    useEffect(() => {
        if (!abilitato) return;
        let annullato = false;
        const leggi = async () => {
            const headers = JSON.parse(chiaveIntestazioni) as Record<string, string>;
            const res = await fetch('/api/admin/sedi/destinazioni', {
                headers: Object.keys(headers).length > 0 ? headers : undefined,
            }).catch((err: unknown) => {
                // Un `catch` che non logga è un bug (AGENTS.md §6). Qui non si
                // può nemmeno degradare in silenzio: la differenza fra «non
                // puoi» e «non ho potuto leggere» è tutto il punto di questo
                // modulo, e la rete caduta appartiene al secondo caso.
                logClient({
                    livello: 'error',
                    evento: 'fetch',
                    messaggio: `destinazioni-sede-non-lette: ${nomeErrore(err)}`,
                });
                return null;
            });
            if (annullato) return;
            if (!res || !res.ok) {
                if (res) {
                    logClient({
                        livello: 'error',
                        evento: 'fetch',
                        messaggio: 'destinazioni-sede-non-lette',
                        stato: res.status,
                    });
                }
                setStato('guasto');
                setSedi([]);
                return;
            }
            const corpo = (await res.json().catch(() => null)) as
                | { data?: unknown; motivo?: unknown }
                | null;
            if (annullato) return;
            // ⚠️ Corpo illeggibile = GUASTO, non «nessuna sede». Un `?? []` qui
            // trasformerebbe una risposta rotta in un divieto convincente.
            if (!corpo || !Array.isArray(corpo.data)) {
                logClient({ livello: 'error', evento: 'fetch', messaggio: 'destinazioni-sede-corpo-illeggibile' });
                setStato('guasto');
                setSedi([]);
                return;
            }
            const elenco = (corpo.data as SedeDestinazione[]).filter(
                (s) => s && typeof s.id === 'string' && typeof s.nome === 'string',
            );
            setSedi(elenco);
            setStato(elenco.length > 0 ? 'ok' : 'nessuna');
        };
        void leggi();
        return () => {
            annullato = true;
        };
    }, [abilitato, chiaveIntestazioni, giro]);

    const ricarica = useCallback(() => {
        setStato('caricamento');
        setGiro((g) => g + 1);
    }, []);

    return { stato, sedi, ricarica };
}
