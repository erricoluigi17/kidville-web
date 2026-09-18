'use client';

import { useTranslations } from 'next-intl';
import { Film, RotateCw, Trash2, Upload } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * V11 · LA SCHEDA DI UN VIDEO CHE NON È ANCORA IN GALLERIA.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PERCHÉ ESISTE, DETTO CON LA MISURA ACCANTO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Una foto si carica e c'è. Un video no: dopo che i byte sono arrivati comincia
 * una conversione che gira su una macchina lontana e **dura minuti** — nel
 * campione misurato il 2026-09-17, 180 secondi a 1080p sono costati 709 secondi
 * di wall su due vCPU, e il piano dimensiona il caso tipico fra 212 e 653.
 *
 * In quei minuti l'interfaccia deve dire la verità, e la verità cambia tre volte:
 *
 *  · **caricamento** — i byte partono dal telefono. Qui una percentuale esiste
 *    davvero, perché i byte si contano;
 *  · **preparazione** (in coda, poi conversione) — il telefono ha finito e non
 *    sta facendo niente. Una barra che avanza qui sarebbe inventata: l'unica cosa
 *    vera da dire è *quanto può durare* e *che si può chiudere l'app*;
 *  · **pronto** — il video esiste, convertito e verificato, e NON è pubblicato.
 *    Manca un gesto, e si vede.
 *
 * ⚠️ Perché tre e non «caricamento» per tutti: **se l'interfaccia dice
 * “caricamento” per otto minuti, qualcuno ricarica la pagina e carica due volte.**
 * Due conversioni, due video in galleria, due notifiche alle famiglie — e nessun
 * errore da nessuna parte, perché tecnicamente non è andato storto niente.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * E SE CHIUDE L'APP?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * I byte riprendono da soli: lo fa il protocollo TUS, che conserva l'URL della
 * sessione e riparte dall'offset che il server ha contato (`@/lib/media/video/upload`).
 * I TAG no: i bambini scelti al passo 2 vivono nella memoria della pagina, e una
 * pagina chiusa li perde. Non si possono nemmeno mettere su disco «per comodità» —
 * sono identificativi di minori, e l'archivio locale ha un elenco chiuso di chiavi
 * proprio per impedire che ci finisca dentro roba del genere.
 *
 * Quindi al rientro la scheda di un video pronto **richiede i bambini** invece di
 * pubblicare a vuoto (una galleria a cui manca il destinatario) o di buttare via
 * il video (minuti di conversione già pagati). È l'unica forma onesta delle tre,
 * ed è ciò che `chiedeTag` accende.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IL TAGGER ARRIVA DA FUORI, E NON È PIGRIZIA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `renderTagger` è una funzione del chiamante perché la scelta dei bambini ha già
 * un componente suo (`StudentTagger`), con dentro il Privacy Lock, la ricerca e la
 * regola della foto privata. Riscriverne mezzo qui vorrebbe dire due regole di
 * privacy che invecchiano separatamente — il difetto che questo repository ha già
 * pagato quando una copia del gate proteggeva la POST e lasciava scoperta la PATCH.
 */

export type FaseVideoUI =
    /** I byte stanno partendo: la percentuale è vera. */
    | 'caricamento'
    /** Una sessione di caricamento è aperta ma ferma: si riprende, non si ricomincia. */
    | 'interrotto'
    /** Il server ha il file e aspetta il proprio turno. Secondi, di solito. */
    | 'in-coda'
    /** La conversione è in corso. Minuti. */
    | 'conversione'
    /** Convertito e verificato: manca la pubblicazione. */
    | 'pronto'
    /** La riga di galleria si sta scrivendo. */
    | 'pubblicazione'
    /** Rifiutato o non riuscito: il messaggio dice che cosa fare. */
    | 'fallito'
    /** Ritirato da una persona. */
    | 'annullato';

export interface RigaVideoLavorazione {
    jobId: string;
    /**
     * Il nome scelto da chi ha caricato. Si mostra perché è l'unico modo di sapere
     * QUALE dei tre video è quello fermo — l'anteprima non c'è più, i byte sono
     * stati liberati appena il caricamento è finito.
     *
     * ⚠️ Resta sullo schermo di chi ha scelto il file e non entra in nessun log:
     * `recita-bambina-rossi.mov` è anagrafica di un minore, e in `app_log`
     * resterebbe trenta giorni interrogabile in SQL.
     */
    nome: string;
    fase: FaseVideoUI;
    /** 0–100, oppure `null` quando una percentuale non significherebbe niente. */
    percentuale: number | null;
    /** Già tradotto da chi chiama (catalogo, mai la prosa del server). */
    messaggio: string | null;
    /** I tag non ci sono più (app chiusa e riaperta): vanno richiesti. */
    chiedeTag: boolean;
    /** Quanti bambini sono stati scelti finora: sotto 1 non si pubblica. */
    tagScelti: number;
}

interface Props {
    righe: RigaVideoLavorazione[];
    onPubblica: (jobId: string) => void;
    onRiprendi: (jobId: string) => void;
    onRimuovi: (jobId: string) => void;
    renderTagger?: (jobId: string) => ReactNode;
}

export function VideoInLavorazione({ righe, onPubblica, onRiprendi, onRimuovi, renderTagger }: Props) {
    const t = useTranslations('teacherServizi');

    // Nessuna riga, nessun riquadro: un contenitore vuoto con un titolo dentro è
    // una promessa che non mantiene niente, e su una schermata che di norma non ha
    // video in lavorazione sarebbe lì per sempre.
    if (righe.length === 0) return null;

    const testoFase = (fase: FaseVideoUI): string => {
        switch (fase) {
            case 'caricamento': return t('galleryVideoFaseCaricamento');
            case 'interrotto': return t('galleryVideoFaseInterrotto');
            case 'in-coda': return t('galleryVideoFaseInCoda');
            case 'conversione': return t('galleryVideoFaseConversione');
            case 'pronto': return t('galleryVideoFasePronto');
            case 'pubblicazione': return t('galleryVideoFasePubblicazione');
            // Un fallimento NON ha una frase di fase: la sua frase è il messaggio
            // che arriva dal codice della pipeline (`codiceMessaggioVideo`), che dice
            // che cosa fare — «accorcialo», «aggiorna l'app», «riprova». Una riga di
            // fase generica sopra quella sarebbe rumore che fa scorrere l'occhio.
            case 'fallito': return t('galleryErrCaricamentoGenerico');
            case 'annullato': return t('galleryVideoFaseAnnullato');
        }
    };

    return (
        <section className="mb-4 rounded-3xl border border-kidville-line bg-white p-4 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 font-barlow text-sm font-bold uppercase tracking-wide text-kidville-green">
                <Film size={15} strokeWidth={1.75} aria-hidden="true" />
                {t('galleryVideoLavorazioneTitolo')}
            </h2>

            <ul className="space-y-3">
                {righe.map((r) => {
                    // Il gesto resta spento finché non c'è almeno un bambino: è la stessa
                    // regola del passo 2, dove «Pubblica» è disabilitato finché ogni file
                    // non ha i suoi tag. Un video pubblicato senza destinatari non lo vede
                    // nessuno, e chi l'ha caricato non ha modo di accorgersene.
                    const pubblicabile = r.fase === 'pronto' && (!r.chiedeTag || r.tagScelti > 0);
                    return (
                        <li key={r.jobId} className="rounded-2xl border border-kidville-green/10 bg-kidville-cream/35 p-3">
                            <p className="truncate font-maven text-xs font-semibold text-kidville-green" title={r.nome}>
                                {r.nome}
                            </p>

                            {/*
                              LA FASE VA ANNUNCIATA, non solo dipinta: cambia da sola, minuti
                              dopo, senza che nessuno abbia toccato niente. Senza `aria-live`
                              chi usa uno screen reader resta sull'ultima cosa che ha sentito —
                              «caricamento» — e non ha modo di sapere che adesso è pronto.
                              `polite` e non `assertive`: non interrompe ciò che si sta facendo.
                            */}
                            <p
                                aria-live="polite"
                                className={`mt-1 font-maven text-[11px] leading-snug ${
                                    r.fase === 'fallito' ? 'text-kidville-error' : 'text-kidville-sub'
                                }`}
                            >
                                {r.fase === 'fallito' ? (r.messaggio ?? testoFase(r.fase)) : testoFase(r.fase)}
                            </p>

                            {/* Un messaggio su una fase che NON è un fallimento: il 401 di una
                                sessione scaduta mentre i byte partivano, per esempio. Dice che
                                cosa toglie di mezzo l'ostacolo, e non è un errore rosso. */}
                            {r.messaggio && r.fase !== 'fallito' && (
                                <p className="mt-1 font-maven text-[11px] leading-snug text-kidville-sub">
                                    {r.messaggio}
                                </p>
                            )}

                            {/*
                              LA BARRA ESISTE SOLO DOVE LA PERCENTUALE È VERA.
                              Su un fallimento una barra piena sarebbe una bugia e una barra
                              ferma al 60% lascerebbe credere che qualcosa stia ancora
                              succedendo: quando l'avanzamento non significa più niente si
                              toglie, e parla il messaggio. È la stessa regola che
                              `avanzamentoDaStatoVideo` applica lato contratto.
                            */}
                            {r.percentuale !== null && (
                                <div
                                    role="progressbar"
                                    aria-valuenow={r.percentuale}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-label={t('galleryVideoAvanzamento')}
                                    className="mt-2 h-1.5 w-full overflow-hidden rounded-pill bg-kidville-green/15"
                                >
                                    <div
                                        className="h-full rounded-pill bg-kidville-green transition-all"
                                        style={{ width: `${Math.max(0, Math.min(100, r.percentuale))}%` }}
                                    />
                                </div>
                            )}

                            {r.fase === 'pronto' && r.chiedeTag && renderTagger && (
                                <div className="mt-3">
                                    <p className="mb-2 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-green">
                                        {t('galleryVideoChiediTag')}
                                    </p>
                                    {renderTagger(r.jobId)}
                                </div>
                            )}

                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                {r.fase === 'pronto' && (
                                    <button
                                        type="button"
                                        onClick={() => onPubblica(r.jobId)}
                                        disabled={!pubblicabile}
                                        className="flex items-center gap-1.5 rounded-pill bg-kidville-green px-3.5 py-1.5 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-yellow transition-opacity disabled:opacity-50"
                                    >
                                        <Upload size={13} strokeWidth={2} aria-hidden="true" />
                                        {t('galleryVideoPubblica')}
                                    </button>
                                )}

                                {r.fase === 'interrotto' && (
                                    <button
                                        type="button"
                                        onClick={() => onRiprendi(r.jobId)}
                                        className="flex items-center gap-1.5 rounded-pill bg-kidville-green px-3.5 py-1.5 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-yellow"
                                    >
                                        <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
                                        {t('galleryVideoRiprendi')}
                                    </button>
                                )}

                                {/*
                                  «Rimuovi» c'è anche mentre il video è in preparazione, ed è
                                  deliberato: chi ha caricato il filmato sbagliato deve poterlo
                                  ritirare PRIMA che finisca in galleria, non dopo — e il ritiro
                                  dell'intento è anche ciò che libera l'originale dal bucket
                                  privato invece di lasciarlo scadere in sette giorni.
                                */}
                                {r.fase !== 'pubblicazione' ? (
                                    <button
                                        type="button"
                                        onClick={() => onRimuovi(r.jobId)}
                                        className="flex items-center gap-1.5 rounded-pill border border-kidville-line px-3.5 py-1.5 font-barlow text-[11px] font-bold uppercase tracking-wide text-kidville-green"
                                    >
                                        <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                                        {t('galleryVideoRimuovi')}
                                    </button>
                                ) : null}
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
