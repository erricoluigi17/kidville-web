'use client';

import { BookOpen, ClipboardList, FileText, Image as ImageIcon } from 'lucide-react';

export interface Allegato { id: string; tipo: string; file_url: string; file_name: string | null }
export interface Individualizzata { argomento: string | null; compiti: string | null }
export interface Lezione {
  id: string; data: string; ora_lezione: number; materia: string | null;
  argomento: string | null; compiti: string | null; data_consegna_compiti?: string | null;
  allegati: Allegato[]; individualizzate: Individualizzata[];
}

function perGiorno(lezioni: Lezione[]): [string, Lezione[]][] {
  const m = new Map<string, Lezione[]>();
  for (const l of lezioni) {
    const arr = m.get(l.data) ?? [];
    arr.push(l);
    m.set(l.data, arr);
  }
  return [...m.entries()];
}

const fmtGiorno = (g: string) =>
  new Date(g).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

// Sezione "Lezioni": materia + argomento + allegati (sola lettura).
export function LezioniList({ lezioni }: { lezioni: Lezione[] }) {
  const giorni = perGiorno(lezioni);
  return (
    <section className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-lg font-bold text-gray-800 flex items-center gap-2 mb-3">
        <BookOpen size={18} className="text-kidville-green" /> Lezioni
      </h3>
      {giorni.length === 0 ? (
        <p className="font-maven text-sm text-gray-400">Nessuna lezione registrata di recente.</p>
      ) : (
        <div className="space-y-4">
          {giorni.map(([giorno, lez]) => (
            <div key={giorno}>
              <p className="font-maven text-xs font-semibold text-gray-400 mb-1">{fmtGiorno(giorno)}</p>
              <ul className="space-y-1.5">
                {lez.map((l) => (
                  <li key={l.id} className="rounded-card bg-kidville-cream/40 p-2.5">
                    <div className="font-maven text-sm text-gray-800">
                      <span className="font-semibold text-kidville-green">{l.materia || 'Lezione'}</span>
                      {l.argomento && <span className="text-gray-600"> — {l.argomento}</span>}
                    </div>
                    {l.individualizzate.filter((i) => i.argomento).map((i, idx) => (
                      <p key={idx} className="mt-1 rounded bg-purple-50 px-2 py-1 font-maven text-xs text-purple-700">Attività: {i.argomento}</p>
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
  );
}

// Sezione "Compiti": compiti + scadenza (mostra solo le lezioni con compiti).
export function CompitiList({ lezioni }: { lezioni: Lezione[] }) {
  const conCompiti = lezioni.filter((l) => l.compiti || l.individualizzate.some((i) => i.compiti));
  const giorni = perGiorno(conCompiti);
  return (
    <section className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-lg font-bold text-gray-800 flex items-center gap-2 mb-3">
        <ClipboardList size={18} className="text-kidville-yellow" /> Compiti
      </h3>
      {giorni.length === 0 ? (
        <p className="font-maven text-sm text-gray-400">Nessun compito assegnato di recente.</p>
      ) : (
        <div className="space-y-4">
          {giorni.map(([giorno, lez]) => (
            <div key={giorno}>
              <p className="font-maven text-xs font-semibold text-gray-400 mb-1">{fmtGiorno(giorno)}</p>
              <ul className="space-y-1.5">
                {lez.map((l) => (
                  <li key={l.id} className="rounded-card bg-kidville-cream/40 p-2.5">
                    <div className="font-maven text-xs text-gray-500">{l.materia || 'Lezione'}</div>
                    {l.compiti && <p className="mt-1 rounded bg-kidville-yellow/20 px-2 py-1 font-maven text-sm text-gray-700">{l.compiti}</p>}
                    {l.individualizzate.filter((i) => i.compiti).map((i, idx) => (
                      <p key={idx} className="mt-1 rounded bg-purple-50 px-2 py-1 font-maven text-xs text-purple-700">Compiti: {i.compiti}</p>
                    ))}
                    {l.data_consegna_compiti && (
                      <p className="mt-1 font-maven text-[11px] text-kidville-error">Consegna: {new Date(l.data_consegna_compiti).toLocaleDateString('it-IT')}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
