'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check, Info } from 'lucide-react';
import { logClient } from '@/lib/logging/client';
import { formatEuro } from '@/lib/format/valuta';

// CTA primaria AA della feature: BIANCO su verde (≈6,5:1) invece del giallo-su-verde
// del `Btn` primary dell'app (~4:1, sotto AA). Locale alla feature per non toccare
// il `Btn` globale — ESPORTATA perché la usa anche il bottone «Copia l'IBAN» di
// `ComePagare`, che vive dentro questa stessa card: due copie della stessa costante
// sarebbero due CTA che divergono al primo ritocco.
//
// Tre scelte che NON sono decorative (2026-09-05, dopo le misure sulle schermate):
//  · `min-h-[44px]` — era `h-9`, cioè 36px: sotto il bersaglio minimo del dito.
//  · `min-w-[6.5rem]` — «Copia» è largo 82px, «Copiato» 96px. Senza un minimo
//    comune il bottone si allargava PREMENDOLO, e nel riquadro dell'IBAN questo
//    faceva andare a capo l'IBAN in un punto diverso: il testo si muoveva sotto
//    il dito che l'aveva appena toccato.
//  · `motion-safe:` su transizione E pressione — con `prefers-reduced-motion` il
//    `@media` di `globals.css` azzera già le transizioni, ma NON un `active:scale`,
//    che è un cambio di stato istantaneo e resterebbe l'unico movimento in pagina.
export const BTN_COPIA_AA =
    'inline-flex min-h-[44px] min-w-[6.5rem] items-center justify-center gap-2 whitespace-nowrap rounded-pill px-4 font-barlow text-[13px] font-extrabold uppercase tracking-[0.05em] motion-safe:transition-transform motion-safe:active:scale-95 disabled:opacity-45 disabled:pointer-events-none bg-kidville-green text-kidville-white hover:bg-kidville-green-dark';

export interface VoceCausale {
    id: string;
    /** Sede a cui la voce appartiene: decide SU QUALE CONTO va pagata (`ComePagare`). */
    scuola_id: string;
    /** Causale già COMPOSTA dal server col modello per-categoria (admin_settings.causali_config). */
    causale: string;
    /**
     * Come il genitore chiama questa voce («Retta Settembre 2026»). È il TITOLO della
     * riga: la causale è lunga, quasi identica fra una voce e l'altra, e serve a
     * essere copiata — non a essere letta per capire di che si tratta.
     */
    descrizione: string;
    /**
     * Quanto RESTA da versare per questa voce (residuo, non importo pieno): è la cifra
     * che il genitore digita nel bonifico. Per una voce parziale i due numeri
     * divergono, ed è esattamente il caso in cui sbagliare costa una telefonata.
     */
    importo: number;
    nome: string;
    cognome: string;
    /** Il CF del proprio figlio è presente: quando manca, mostra la nota di ripiego. */
    hasCf: boolean;
}

// Card «Causale consigliata per il bonifico»: UNA causale per voce ancora aperta,
// COMPOSTA DAL SERVER col modello per-categoria (personalizzabile dalla segreteria),
// pronta da copiare. Scrivere questa causale rende univoco l'abbinamento del bonifico
// (riconciliazione). Se il CF del bambino manca, il server lo omette dalla causale e
// una nota invita a indicare comunque il nome. Il CF è del PROPRIO figlio: dato del
// genitore, lecito da mostrargli.
//
// GERARCHIA DELLA RIGA (rifatta il 2026-09-05). Prima la causale era il testo più
// forte della card — verde, grassetto, 14px, quattro righe — e vinceva sull'IBAN, che
// è il dato per cui la card esiste. Ma la causale non si legge: si copia. Quindi la
// riga oggi si presenta con ciò che la fa riconoscere in un colpo d'occhio (la voce e
// quanto resta) e tiene la causale sotto, in un campo chiaro che dice «questo testo va
// incollato lì»: quieto, integrale, senza tagli.
//
// `incorporata`: la stessa lista dentro un'altra card (il pannello «Bonifico» di
// `ComePagare`). Toglie SOLO il guscio — bordo, fondo, padding — e l'occhiello:
// due card annidate darebbero due bordi e due titoli per una cosa sola.
export function CausaleBonifico({ voci, incorporata = false }: { voci: VoceCausale[]; incorporata?: boolean }) {
    const t = useTranslations('pagamenti');
    const [copiato, setCopiato] = useState<string | null>(null);
    if (voci.length === 0) return null;

    const copia = async (id: string, testo: string) => {
        try {
            await navigator.clipboard.writeText(testo);
            setCopiato(id);
            setTimeout(() => setCopiato(null), 2000);
        } catch {
            // `navigator.clipboard` negato (contesto non sicuro / permesso rifiutato):
            // non è un guasto del prodotto ma non si ingoia in silenzio (AGENTS: niente
            // catch muto). Nessun dato personale nel messaggio.
            logClient({
                livello: 'warn',
                evento: 'js',
                messaggio: 'copia causale bonifico negli appunti non riuscita',
                route: '/parent/pagamenti',
            });
        }
    };

    return (
        <div className={incorporata ? '' : 'rounded-card border border-kidville-line bg-kidville-white p-4'}>
            {!incorporata && (
                <p className="mb-1 font-barlow text-xs font-bold uppercase tracking-wide text-kidville-green">
                    {t('causaleTitolo')}
                </p>
            )}
            {/* `text-pretty` (text-wrap: pretty) e non un a-capo a mano: impedisce la
                riga orfana — «giusta.» da sola in fondo — senza congelare dove cade
                l'a-capo, che dipende dalla larghezza dello schermo e dalla lingua. */}
            <p className="font-maven text-xs leading-relaxed text-pretty text-kidville-sub">
                {t('causaleIntro')}
            </p>
            <ul className="mt-3 space-y-2">
                {voci.map((v) => {
                    const causale = v.causale;
                    const done = copiato === v.id;
                    const nome = [v.nome, v.cognome].filter(Boolean).join(' ') || t('questoPagamento');
                    return (
                        <li key={v.id} className="rounded-input bg-kidville-cream p-3">
                            <div className="flex items-baseline justify-between gap-3">
                                {/* Tondo, non maiuscolo: è CONTENUTO, non un'etichetta. Nella
                                    card il maiuscolo è già il linguaggio dell'occhiello, dei
                                    passi, dei tab e dei bottoni — un quinto livello lo avrebbe
                                    reso rumore, e «Retta Settembre 2026» qui si legge come si
                                    legge nell'elenco dei pagamenti più sotto. */}
                                <p className="min-w-0 break-words font-barlow text-[15px] font-bold leading-snug text-kidville-ink">
                                    {v.descrizione}
                                </p>
                                <p className="shrink-0 font-barlow text-[15px] font-black text-kidville-green">
                                    {formatEuro(v.importo)}
                                </p>
                            </div>
                            {/* Il campo del testo da copiare. `break-words` e non `break-all`:
                                la causale va a capo fra le parole, non dentro il codice fiscale. */}
                            <p className="mt-2 break-words rounded-[8px] bg-kidville-white px-3 py-2 font-maven text-xs leading-relaxed text-kidville-ink">
                                {causale}
                            </p>
                            {!v.hasCf && (
                                <p className="mt-2 flex items-start gap-2 font-maven text-[11px] leading-relaxed text-pretty text-kidville-sub">
                                    <Info size={14} className="mt-[2px] shrink-0" aria-hidden="true" />
                                    <span>{t('cfNonDisponibile')}</span>
                                </p>
                            )}
                            <div className="mt-2 flex justify-end">
                                <button
                                    type="button"
                                    className={BTN_COPIA_AA}
                                    onClick={() => copia(v.id, causale)}
                                    // Il nome accessibile segue il testo visibile: quando la
                                    // scritta diventa «Copiato», il nome deve contenerlo
                                    // (WCAG 2.5.3) e dire ancora DI QUALE voce si parla, perché
                                    // i bottoni della lista sono altrimenti identici.
                                    aria-label={done ? t('ariaCopiatoCausale', { nome }) : t('ariaCopiaCausale', { nome })}
                                >
                                    {done
                                        ? <><Check size={14} aria-hidden="true" /> {t('copiato')}</>
                                        : <><Copy size={14} aria-hidden="true" /> {t('copia')}</>}
                                </button>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
