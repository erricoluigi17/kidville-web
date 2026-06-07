'use client';

import { BookOpen, Award, AlertTriangle, FileText, Image as ImageIcon, PenLine } from 'lucide-react';

interface Allegato { id: string; tipo: string; file_url: string; file_name: string | null }
interface Individualizzata { argomento: string | null; compiti: string | null }
interface Lezione {
  id: string; data: string; ora_lezione: number; materia: string | null;
  argomento: string | null; compiti: string | null; allegati: Allegato[]; individualizzate: Individualizzata[];
}
interface Valutazione { id: string; materia: string; tipo: string; modalita: string; giudizio_sintetico: string | null; giudizio_testo: string | null; creato_il: string }
interface Nota { id: string; categoria: string; testo: string; richiede_firma: boolean; firmata_il: string | null; creato_il: string }

const CAT: Record<string, { label: string; cls: string }> = {
  disciplinare: { label: 'Nota disciplinare', cls: 'bg-kidville-error/10 text-kidville-error' },
  didattica: { label: 'Nota didattica', cls: 'bg-blue-100 text-blue-700' },
  compiti_non_svolti: { label: 'Compiti non svolti', cls: 'bg-amber-100 text-amber-700' },
};

export function PrimariaParentView({
  lezioni, valutazioni, note, onSign, signing,
}: {
  lezioni: Lezione[]; valutazioni: Valutazione[]; note: Nota[];
  onSign: (id: string) => void; signing: string | null;
}) {
  const perGiorno = new Map<string, Lezione[]>();
  for (const l of lezioni) {
    const arr = perGiorno.get(l.data) ?? [];
    arr.push(l);
    perGiorno.set(l.data, arr);
  }

  return (
    <div className="space-y-5">
      {/* Note che richiedono firma — in evidenza */}
      {note.some((n) => n.richiede_firma && !n.firmata_il) && (
        <div className="rounded-card bg-kidville-error/5 border border-kidville-error/20 p-4">
          <h3 className="font-barlow font-bold text-kidville-error flex items-center gap-2 mb-2">
            <AlertTriangle size={18} /> Note da firmare
          </h3>
          {note.filter((n) => n.richiede_firma && !n.firmata_il).map((n) => (
            <div key={n.id} className="mb-2 flex items-center justify-between gap-3 rounded-card bg-white p-3">
              <div>
                <span className={`rounded-pill px-2 py-0.5 text-[11px] font-maven ${CAT[n.categoria]?.cls}`}>{CAT[n.categoria]?.label}</span>
                <p className="font-maven text-sm text-gray-700 mt-1">{n.testo}</p>
              </div>
              <button onClick={() => onSign(n.id)} disabled={signing === n.id} className="font-maven inline-flex items-center gap-1 rounded-pill bg-kidville-green px-3 py-1.5 text-xs text-kidville-yellow disabled:opacity-50">
                <PenLine size={12} /> {signing === n.id ? '…' : 'Firma'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {/* Diario delle lezioni / compiti */}
        <section className="rounded-card bg-white p-5 shadow-sm">
          <h3 className="font-barlow text-lg font-bold text-gray-800 flex items-center gap-2 mb-3">
            <BookOpen size={18} className="text-kidville-green" /> Lezioni e compiti
          </h3>
          {perGiorno.size === 0 ? (
            <p className="font-maven text-sm text-gray-400">Nessuna lezione registrata di recente.</p>
          ) : (
            <div className="space-y-4">
              {[...perGiorno.entries()].map(([giorno, lez]) => (
                <div key={giorno}>
                  <p className="font-maven text-xs font-semibold text-gray-400 mb-1">{new Date(giorno).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                  <ul className="space-y-1.5">
                    {lez.map((l) => (
                      <li key={l.id} className="rounded-card bg-kidville-cream/40 p-2.5">
                        <div className="font-maven text-sm text-gray-800">
                          <span className="font-semibold text-kidville-green">{l.materia || 'Lezione'}</span>
                          {l.argomento && <span className="text-gray-600"> — {l.argomento}</span>}
                        </div>
                        {l.compiti && <p className="mt-1 rounded bg-kidville-yellow/20 px-2 py-1 font-maven text-xs text-gray-700">Compiti: {l.compiti}</p>}
                        {l.individualizzate.map((i, idx) => (
                          <p key={idx} className="mt-1 rounded bg-purple-50 px-2 py-1 font-maven text-xs text-purple-700">
                            {i.argomento && <>Attività: {i.argomento} </>}
                            {i.compiti && <>· Compiti: {i.compiti}</>}
                          </p>
                        ))}
                        {l.allegati.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-2">
                            {l.allegati.map((a) => (
                              <a key={a.id} href={a.file_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-pill bg-white px-2 py-0.5 text-[11px] text-gray-600">
                                {a.tipo === 'pdf' ? <FileText size={11} /> : <ImageIcon size={11} />}
                                {a.file_name || 'allegato'}
                              </a>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Valutazioni (giudizi, no voti numerici) */}
        <section className="rounded-card bg-white p-5 shadow-sm">
          <h3 className="font-barlow text-lg font-bold text-gray-800 flex items-center gap-2 mb-3">
            <Award size={18} className="text-kidville-yellow" /> Valutazioni
          </h3>
          {valutazioni.length === 0 ? (
            <p className="font-maven text-sm text-gray-400">Nessuna valutazione pubblicata.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {valutazioni.map((v) => (
                <li key={v.id} className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-maven text-sm font-semibold text-gray-800">{v.materia}</span>
                    <span className="text-xs text-gray-400 capitalize">{v.tipo}</span>
                    <span className="text-xs text-gray-300">{new Date(v.creato_il).toLocaleDateString('it-IT')}</span>
                  </div>
                  <p className="font-maven text-sm text-kidville-green mt-0.5">
                    {v.giudizio_sintetico || v.giudizio_testo || '—'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
