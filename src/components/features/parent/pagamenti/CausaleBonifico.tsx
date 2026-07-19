'use client';

import { useState } from 'react';
import { Copy, Check, Info } from 'lucide-react';
import { causaleBonifico, haCodiceFiscale } from '@/lib/pagamenti/causale';
import { logClient } from '@/lib/logging/client';

// CTA primaria AA della feature: BIANCO su verde (≈6,5:1) invece del giallo-su-verde
// del `Btn` primary dell'app (~4:1, sotto AA). Locale al componente per non toccare
// il `Btn` globale. Stessa forma del `btnClass('primary','sm')`, solo testo bianco.
const BTN_COPIA_AA =
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill font-barlow font-extrabold uppercase tracking-[0.05em] transition-transform active:scale-95 disabled:opacity-45 disabled:pointer-events-none h-9 px-4 text-[13px] bg-kidville-green text-kidville-white hover:bg-kidville-green-dark';

export interface FiglioCausale {
    alunno_id: string;
    nome: string;
    cognome: string;
    codiceFiscale: string | null;
}

// Card «Causale consigliata per il bonifico»: per ciascun figlio mostra la stringa
// «Nome Cognome CODICE_FISCALE» pronta da copiare. Scrivere il CF in causale rende
// univoco l'abbinamento del bonifico (riconciliazione). Se il CF manca, mostra solo
// «Nome Cognome» con una nota discreta.
export function CausaleBonifico({ figli }: { figli: FiglioCausale[] }) {
    const [copiato, setCopiato] = useState<string | null>(null);
    if (figli.length === 0) return null;

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
        <div className="rounded-card border border-kidville-line bg-kidville-white p-4">
            <p className="font-barlow font-bold uppercase text-xs tracking-wide text-kidville-green mb-1">
                Causale consigliata per il bonifico
            </p>
            <p className="font-maven text-xs text-kidville-sub mb-3">
                Per abbinare più in fretta il pagamento, indica questa causale nel bonifico.
            </p>
            <div className="space-y-2">
                {figli.map((f) => {
                    const causale = causaleBonifico({ nome: f.nome, cognome: f.cognome, codiceFiscale: f.codiceFiscale });
                    const conCf = haCodiceFiscale(f.codiceFiscale);
                    const done = copiato === f.alunno_id;
                    return (
                        <div key={f.alunno_id} className="rounded-[14px] bg-kidville-cream px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                                <p className="min-w-0 flex-1 font-maven text-sm font-bold text-kidville-green break-words">
                                    {causale}
                                </p>
                                <button
                                    type="button"
                                    className={BTN_COPIA_AA}
                                    onClick={() => copia(f.alunno_id, causale)}
                                    aria-label={`Copia la causale di ${[f.nome, f.cognome].filter(Boolean).join(' ')}`}
                                >
                                    {done ? <><Check size={14} /> Copiato</> : <><Copy size={14} /> Copia</>}
                                </button>
                            </div>
                            {!conCf && (
                                <p className="mt-1.5 flex items-start gap-1 font-maven text-[11px] text-kidville-sub">
                                    <Info size={12} className="mt-0.5 shrink-0" />
                                    <span>Codice fiscale non disponibile: indica comunque il nome e cognome del bambino nella causale.</span>
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
