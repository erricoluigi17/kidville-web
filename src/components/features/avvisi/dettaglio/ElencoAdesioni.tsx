'use client';

import { useTranslations } from 'next-intl';
import { HelpCircle, Hourglass, Pencil, ThumbsDown, ThumbsUp } from 'lucide-react';

/**
 * ─── L'ELENCO DELLE ADESIONI, RIGA PER RIGA ─────────────────────────────────
 *
 * 🔴 LE DUE «ATTESE» DI QUESTA SCHERMATA NON SONO LA STESSA COSA, e confonderle
 * significa contare la cosa sbagliata:
 *  · **«Senza risposta»** — il genitore non ha ancora risposto. Non occupa niente,
 *    non è in coda per niente: manca solo la sua risposta.
 *  · **«In lista d'attesa»** — ha risposto di sì, ma i posti erano finiti. È una
 *    famiglia che aspetta una telefonata.
 * Su una gita quel conteggio diventa una telefonata a una famiglia: o a chi non
 * aspettava nulla, o — peggio — a nessuno, mentre qualcuno aspetta davvero.
 *
 * Perciò il chip della lista d'attesa porta **la parola scritta**, mai il solo
 * colore: un giallo accanto a un altro giallo non distingue niente, e per chi non
 * distingue i colori non distingue proprio nulla.
 *
 * ── 🔴 `permessiScrittura` È UN AFFORDANCE GATE, NON UNA DIFESA ─────────────
 *
 * Decide solo se i comandi ESISTONO nell'albero, e il ruolo da cui si calcola
 * arriva da `useSessionIdentity`, che lo legge dal **`localStorage`**: chiunque
 * abbia la console del browser può scriverci dentro `admin` e far comparire i
 * bottoni. Non è un buco, è il posto sbagliato dove cercare la difesa — la difesa
 * è il SERVER, che su `PATCH /api/avvisi/[id]/risposte/[rispostaId]` e sulla rotta
 * di esportazione risponde **403** a chi non è segreteria (`requireStaff`, non
 * `requireDocente`: i docenti restano in sola lettura sulle adesioni per decisione
 * del committente). Qui si decide cosa ha senso mostrare, non chi può scrivere.
 *
 * ── PERCHÉ «AMMETTI» È TESTO E «CORREGGI» UN'ICONA ──────────────────────────
 *
 * «Ammetti» fa partire una notifica a una famiglia: è un'azione conseguente, e
 * un'icona la si indovina — sbagliando. «Correggi il numero» è invece un gesto
 * reversibile e ripetuto su ogni riga, quindi può essere un'icona: ma il suo nome
 * accessibile porta **il nome dell'alunno**, perché trenta «Modifica» nudi in fila
 * sono, per chi naviga a elenco di controlli, trenta bottoni identici.
 */

export interface RigaElenco {
    studentId: string;
    /** `null` quando quella famiglia non ha MAI risposto: non c'è riga da correggere. */
    rispostaId: string | null;
    studentName: string;
    classe: string;
    parentName: string;
    /** `'si' | 'no' | 'attesa'` — `attesa` qui significa **senza risposta**. */
    risposta: string;
    /** `'ammessa' | 'in_attesa' | null` — `in_attesa` è la **lista d'attesa**. */
    statoAdesione: string | null;
    numeroPartecipanti: number | null;
}

interface Props {
    righe: readonly RigaElenco[];
    /** Affordance gate: vedi il riquadro in testa. Default `false` = sola lettura. */
    permessiScrittura?: boolean;
    onCorreggi?: (riga: RigaElenco) => void;
    onAmmetti?: (riga: RigaElenco) => void;
    /** Altezza massima dell'elenco: cambia fra il drawer del docente e il cockpit. */
    maxH: string;
}

/** Vale un posto (dentro o in coda): solo allora il numero di persone significa qualcosa. */
function contaPersone(stato: string | null): boolean {
    return stato === 'ammessa' || stato === 'in_attesa';
}

/**
 * Su quali righe ha senso il comando «Ammetti».
 *
 * Il caso principale è la LISTA D'ATTESA: c'è chi aspetta, si libera un posto,
 * qualcuno decide chi entra (nessuna promozione automatica — la decide la
 * segreteria).
 *
 * ⚠️ Ma ce n'è un secondo, e senza di lui una funzione intera resta irraggiungibile:
 * la famiglia che aveva risposto **no** e poi telefona per dire che viene. È
 * esattamente il caso per cui il server ha `RISPOSTA_CONTRARIA` — si ferma, chiede
 * conferma, e solo allora sostituisce quel «no». Se il comando comparisse solo
 * sulle righe in coda, quella domanda non si potrebbe mai innescare da qui e
 * l'unica strada per quella famiglia sarebbe il database.
 *
 * Chi è GIÀ dentro non si ammette due volta; chi non ha risposto affatto non si
 * ammette da qui: nessuno ha ancora deciso niente per lui, e un bottone su ogni
 * riga dell'elenco sarebbe rumore su tutte per servirne una.
 */
function puoEssereAmmesso(riga: RigaElenco): boolean {
    if (riga.statoAdesione === 'ammessa') return false;
    return riga.statoAdesione === 'in_attesa' || riga.risposta === 'no';
}

const CHIP = 'inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-maven text-[9px] font-bold';
const COMANDO_44 = 'inline-flex h-11 w-11 items-center justify-center rounded-xl transition-colors';

export function ElencoAdesioni({ righe, permessiScrittura = false, onCorreggi, onAmmetti, maxH }: Props) {
    const t = useTranslations('avvisi');

    if (righe.length === 0) {
        return <p className="font-maven py-8 text-center text-xs text-kidville-sub">{t('nessunaAdesione')}</p>;
    }

    return (
        <ul className={`space-y-2 ${maxH} overflow-y-auto pr-1`}>
            {righe.map((item) => {
                const inCoda = item.statoAdesione === 'in_attesa';
                const mostraPersone = contaPersone(item.statoAdesione);
                const ammissibile = puoEssereAmmesso(item);
                return (
                    <li
                        key={item.studentId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-kidville-line bg-white p-3 shadow-sm transition-colors hover:border-kidville-green/50"
                    >
                        <div className="min-w-0 flex-1">
                            <p className="font-barlow truncate text-xs font-bold uppercase text-kidville-green">
                                {item.studentName}
                            </p>
                            <p className="font-maven mt-0.5 truncate text-[10px] text-kidville-sub">
                                {t('genitoreClasse', { genitore: item.parentName, classe: item.classe })}
                            </p>
                        </div>

                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                            {/* 1. La RISPOSTA della famiglia. */}
                            <span
                                className={`${CHIP} ${
                                    item.risposta === 'si'
                                        ? 'border-kidville-success/30 bg-kidville-success-soft text-kidville-success-strong'
                                        : item.risposta === 'no'
                                            ? 'border-kidville-line bg-kidville-neutral-soft text-kidville-sub'
                                            : 'border-kidville-warn/30 bg-kidville-warn-soft text-kidville-warn-strong'
                                }`}
                            >
                                {item.risposta === 'si' && (
                                    <>
                                        <ThumbsUp size={10} aria-hidden="true" /> {t('badgeSiAderisco')}
                                    </>
                                )}
                                {item.risposta === 'no' && (
                                    <>
                                        <ThumbsDown size={10} aria-hidden="true" /> {t('no')}
                                    </>
                                )}
                                {item.risposta !== 'si' && item.risposta !== 'no' && (
                                    <>
                                        <HelpCircle size={10} aria-hidden="true" /> {t('optInAttesa')}
                                    </>
                                )}
                            </span>

                            {/* 2. La LISTA D'ATTESA, che è un'altra cosa: con la parola scritta. */}
                            {inCoda && (
                                <span className={`${CHIP} border-kidville-warn/40 bg-kidville-warn-soft text-kidville-warn-strong`}>
                                    <Hourglass size={10} aria-hidden="true" /> {t('badgeInAttesa')}
                                </span>
                            )}

                            {/* 3. Quante PERSONE porta questa riga. Su una riga ritirata
                                   il numero resta salvato nel database ma non significa
                                   più niente: mostrarlo direbbe che quella famiglia
                                   partecipa con quattro persone. */}
                            {mostraPersone && (
                                <span className={`${CHIP} border-kidville-info/30 bg-kidville-info-soft text-kidville-info-strong`}>
                                    {t('postiPersone', { count: item.numeroPartecipanti ?? 1 })}
                                </span>
                            )}

                            {/* 4. I comandi. Senza `permessiScrittura` non esistono
                                   nell'albero: non sono nascosti, non ci sono. */}
                            {permessiScrittura && item.rispostaId && (
                                <>
                                    {ammissibile && (
                                        <button
                                            type="button"
                                            onClick={() => onAmmetti?.(item)}
                                            /* 🔴 IL NOME DICE DA DOVE. Il bottone si chiama «Ammetti»
                                               su entrambe le righe ammissibili, ma le due non sono la
                                               stessa cosa: una aspetta un posto, l'altra aveva detto
                                               NO. Fino al 2026-09-19 l'`aria-label` diceva «dalla
                                               lista d'attesa» anche sulla seconda — falso, e per chi
                                               usa uno screen reader era l'UNICO nome che sentiva. */
                                            aria-label={
                                                inCoda
                                                    ? t('ammettiAria', { alunno: item.studentName })
                                                    : t('ammettiRispostaNoAria', { alunno: item.studentName })
                                            }
                                            className="inline-flex min-h-[44px] items-center rounded-xl bg-kidville-green px-3 font-maven text-xs font-bold text-white transition-colors"
                                        >
                                            {t('ammettiDallaAttesa')}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => onCorreggi?.(item)}
                                        aria-label={t('correggiNumeroAria', { alunno: item.studentName })}
                                        className={`${COMANDO_44} bg-kidville-cream text-kidville-green hover:bg-kidville-green-soft`}
                                    >
                                        <Pencil size={14} strokeWidth={1.8} aria-hidden="true" />
                                    </button>
                                </>
                            )}
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
