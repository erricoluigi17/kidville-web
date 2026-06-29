'use client';

import { useState, useCallback } from 'react';
import { CalendarClock, RefreshCw, CheckCircle2 } from 'lucide-react';

interface Candidato { id: string; nome: string; cognome: string; classe_sezione?: string; importo_previsto?: number; importo_retta_mensile?: number; genitori_separati?: boolean }
interface MesePreview { periodo: string; candidati: number; gia_generati: number; importo: number }
interface Props { userId: string; scuolaId: string }
const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

function currentPeriod(): string {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}
function annoScolasticoCorrente(): number {
    const n = new Date();
    return n.getMonth() + 1 >= 9 ? n.getFullYear() : n.getFullYear() - 1;
}

type Mode = 'mese' | 'anno';

export function GeneratoreRette({ userId, scuolaId }: Props) {
    const [mode, setMode] = useState<Mode>('anno');
    const [periodo, setPeriodo] = useState(currentPeriod());
    const [anno, setAnno] = useState(annoScolasticoCorrente());
    const [previewMese, setPreviewMese] = useState<{ candidati: Candidato[]; gia_generati: number; totale_previsto: number; retta_default?: number } | null>(null);
    const [previewAnno, setPreviewAnno] = useState<{ mesi: MesePreview[]; alunni_attivi: number; totale_candidati: number; totale_previsto: number; retta_default?: number } | null>(null);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState<string | null>(null);

    const reset = () => { setPreviewMese(null); setPreviewAnno(null); setDone(null); };

    const loadPreview = useCallback(async () => {
        setLoading(true); setDone(null);
        try {
            const qs = mode === 'anno' ? `anno=${anno}` : `periodo=${periodo}`;
            const res = await fetch(`/api/pagamenti/genera-rette?userId=${userId}&${qs}&scuola_id=${scuolaId}`, { headers: hdr(userId) });
            const j = await res.json();
            if (j.success) {
                if (mode === 'anno') { setPreviewAnno(j.data); setPreviewMese(null); }
                else { setPreviewMese(j.data); setPreviewAnno(null); }
            }
        } finally { setLoading(false); }
    }, [userId, mode, anno, periodo, scuolaId]);

    const conferma = async () => {
        setLoading(true);
        try {
            const body = mode === 'anno' ? { anno } : { periodo };
            const res = await fetch('/api/pagamenti/genera-rette', { method: 'POST', headers: hdr(userId), body: JSON.stringify(body) });
            const j = await res.json();
            if (j.success) {
                setDone(mode === 'anno'
                    ? `Generate ${j.data.generati} rette per l'A.S. ${anno}/${anno + 1}.`
                    : `Generate ${j.data.generati} rette per ${periodo}.`);
                reset();
            } else alert(j.error);
        } finally { setLoading(false); }
    };

    const totCandidati = mode === 'anno' ? (previewAnno?.totale_candidati ?? 0) : (previewMese?.candidati.length ?? 0);
    const hasPreview = mode === 'anno' ? !!previewAnno : !!previewMese;

    return (
        <div>
            {/* Switch modalità */}
            <div className="inline-flex bg-gray-100 rounded-full p-1 mb-5">
                {([['anno', 'Anno scolastico'], ['mese', 'Mese singolo']] as [Mode, string][]).map(([m, l]) => (
                    <button key={m} onClick={() => { setMode(m); reset(); }}
                        className={`px-4 py-1.5 rounded-full font-maven text-sm font-bold ${mode === m ? 'bg-white text-kidville-green shadow-sm' : 'text-gray-500'}`}>
                        {l}
                    </button>
                ))}
            </div>

            <div className="flex flex-wrap items-end gap-3 mb-5">
                {mode === 'anno' ? (
                    <div>
                        <label className="font-maven text-xs text-gray-500 mb-1 block">Anno scolastico (set → giu)</label>
                        <select value={anno} onChange={e => { setAnno(Number(e.target.value)); reset(); }}
                            className="border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green bg-white focus:outline-none focus:border-kidville-green">
                            {[annoScolasticoCorrente() - 1, annoScolasticoCorrente(), annoScolasticoCorrente() + 1].map(y => (
                                <option key={y} value={y}>{y}/{y + 1}</option>
                            ))}
                        </select>
                    </div>
                ) : (
                    <div>
                        <label className="font-maven text-xs text-gray-500 mb-1 block">Mese di competenza</label>
                        <input type="month" value={periodo} onChange={e => { setPeriodo(e.target.value); reset(); }}
                            className="border-2 border-gray-200 rounded-xl px-3 py-2 font-maven text-sm text-kidville-green focus:outline-none focus:border-kidville-green" />
                    </div>
                )}
                <button onClick={loadPreview} disabled={loading}
                    className="px-4 py-2 rounded-full border-2 border-kidville-green text-kidville-green font-maven font-bold text-sm flex items-center gap-1 disabled:opacity-50">
                    <RefreshCw size={14} /> Anteprima
                </button>
            </div>

            {done !== null && (
                <div className="bg-green-50 text-green-700 rounded-xl p-4 font-maven text-sm flex items-center gap-2">
                    <CheckCircle2 size={18} /> {done}
                </div>
            )}

            {/* Anteprima ANNO */}
            {mode === 'anno' && previewAnno && (
                <div>
                    <div className="flex flex-wrap gap-4 mb-3 font-maven text-sm">
                        <span className="text-kidville-green font-bold">{previewAnno.alunni_attivi} alunni attivi</span>
                        <span className="text-gray-500">Retta default: € {Number(previewAnno.retta_default ?? 150).toFixed(2)}</span>
                        <span className="text-kidville-green font-bold">Totale previsto: € {Number(previewAnno.totale_previsto).toFixed(2)}</span>
                    </div>
                    <div className="max-h-80 overflow-y-auto border border-gray-100 rounded-xl mb-4">
                        <table className="w-full text-left">
                            <thead className="sticky top-0 bg-white"><tr className="font-maven text-xs text-gray-400 uppercase">
                                <th className="py-2 px-3">Mese</th><th className="py-2 px-3 text-right">Da generare</th>
                                <th className="py-2 px-3 text-right">Già generati</th><th className="py-2 px-3 text-right">Importo</th>
                            </tr></thead>
                            <tbody>
                                {previewAnno.mesi.map(m => (
                                    <tr key={m.periodo} className="border-t border-gray-100 font-maven text-sm">
                                        <td className="py-2 px-3 text-kidville-green font-semibold">{m.periodo.slice(0, 7)}</td>
                                        <td className="py-2 px-3 text-right text-kidville-green">{m.candidati}</td>
                                        <td className="py-2 px-3 text-right text-gray-400">{m.gia_generati}</td>
                                        <td className="py-2 px-3 text-right text-gray-500">€ {Number(m.importo).toFixed(2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Anteprima MESE */}
            {mode === 'mese' && previewMese && (
                <div>
                    <div className="flex flex-wrap gap-4 mb-3 font-maven text-sm">
                        <span className="text-kidville-green font-bold">{previewMese.candidati.length} alunni candidati</span>
                        <span className="text-gray-500">Già generati: {previewMese.gia_generati}</span>
                        <span className="text-kidville-green font-bold">Totale previsto: € {Number(previewMese.totale_previsto).toFixed(2)}</span>
                    </div>
                    {previewMese.candidati.length === 0 ? (
                        <p className="font-maven text-sm text-gray-400 py-6 text-center">Nessun alunno da generare per questo mese (rette già create).</p>
                    ) : (
                        <div className="max-h-80 overflow-y-auto border border-gray-100 rounded-xl mb-4">
                            <table className="w-full text-left">
                                <thead className="sticky top-0 bg-white"><tr className="font-maven text-xs text-gray-400 uppercase">
                                    <th className="py-2 px-3">Alunno</th><th className="py-2 px-3">Classe</th>
                                    <th className="py-2 px-3 text-right">Retta</th><th className="py-2 px-3">Tipo</th>
                                </tr></thead>
                                <tbody>
                                    {previewMese.candidati.map(c => (
                                        <tr key={c.id} className="border-t border-gray-100 font-maven text-sm">
                                            <td className="py-2 px-3 text-kidville-green font-semibold">{c.nome} {c.cognome}</td>
                                            <td className="py-2 px-3 text-gray-500">{c.classe_sezione ?? '—'}</td>
                                            <td className="py-2 px-3 text-right text-kidville-green">€ {Number(c.importo_previsto ?? c.importo_retta_mensile ?? 0).toFixed(2)}</td>
                                            <td className="py-2 px-3 text-xs">{c.genitori_separati ? <span className="text-kidville-warn">split</span> : 'singolo'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}

            {hasPreview && totCandidati > 0 && (
                <button onClick={conferma} disabled={loading}
                    className="px-5 py-2.5 rounded-full bg-kidville-green text-white font-maven font-bold text-sm flex items-center gap-1 disabled:opacity-50">
                    <CalendarClock size={15} /> Genera {totCandidati} rette
                </button>
            )}
        </div>
    );
}
