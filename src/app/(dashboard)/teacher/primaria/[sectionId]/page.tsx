'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { AlertTriangle, BookOpen } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';

interface Alunno { id: string; nome: string; cognome: string; allergies?: string | null; allergeni?: string[] }
interface Materia { id: string; nome: string }
interface PresenzaRow { id: string; stato: string | null }

// Tinte per i medaglioni alunno (ciclo, deterministico per indice).
const TINTS = ['#2A6FDB', '#C2487A', '#1F8A5B', '#E6720A', '#7A3FD0', '#2AA0C4', '#D14D8B', '#4E73C0'];

export default function ClasseOverviewPage() {
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [presenze, setPresenze] = useState<PresenzaRow[]>([]);

  const today = useMemo(() => new Date().toLocaleDateString('en-CA'), []);

  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setAlunni(d.data.alunni ?? []);
          setMaterie(d.data.materie ?? []);
        }
      })
      .catch(() => {});
  }, [sectionId, userId]);

  useEffect(() => {
    if (!sectionId) return;
    fetch(`/api/primaria/appello?sectionId=${sectionId}&data=${today}&userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success && Array.isArray(d.data)) setPresenze(d.data); })
      .catch(() => {});
  }, [sectionId, today, userId]);

  const presenti = presenze.filter((p) => p.stato === 'presente').length;
  const assenti = presenze.filter((p) => p.stato === 'assente').length;
  const ritardi = presenze.filter((p) => p.stato === 'ritardo').length;

  const allergiaOf = (a: Alunno) =>
    (a.allergeni && a.allergeni.length > 0) ? a.allergeni.join(', ') : (a.allergies || null);

  return (
    <div className="mx-auto flex max-w-[460px] flex-col gap-4">
      {/* Presenze di oggi (KPI) */}
      <div className="rounded-2xl bg-white p-4 shadow-sm">
        <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.1em] text-kidville-yellow-dark">Presenze di oggi</p>
        <div className="mt-2.5 flex gap-2.5">
          {[
            { l: 'Presenti', n: presenti, c: 'var(--color-kidville-success)', s: 'var(--color-kidville-success-soft)' },
            { l: 'Assenti', n: assenti, c: 'var(--color-kidville-error)', s: 'var(--color-kidville-error-soft)' },
            { l: 'Ritardi', n: ritardi, c: 'var(--color-kidville-yellow-dark)', s: 'var(--color-kidville-yellow-soft)' },
          ].map((b) => (
            <div key={b.l} className="flex-1 rounded-[13px] py-3 text-center" style={{ background: b.s }}>
              <div className="font-barlow text-2xl font-black leading-none" style={{ color: b.c }}>{b.n}</div>
              <div className="mt-1 font-barlow text-[9.5px] font-extrabold uppercase tracking-wide" style={{ color: b.c }}>{b.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Le mie materie */}
      <div>
        <p className="mb-2.5 px-0.5 font-barlow text-[11px] font-extrabold uppercase tracking-[0.06em] text-kidville-muted">Le mie materie</p>
        <div className="flex flex-wrap gap-2">
          {materie.map((m) => (
            <span key={m.id} className="inline-flex h-8 items-center gap-1.5 rounded-pill bg-kidville-green px-3.5 font-barlow text-[13px] font-extrabold uppercase tracking-wide text-kidville-yellow">
              <BookOpen size={13} /> {m.nome}
            </span>
          ))}
          {materie.length === 0 && <span className="font-maven text-sm text-kidville-muted">Nessuna materia assegnata.</span>}
        </div>
      </div>

      {/* Alunni */}
      <div>
        <div className="mb-2.5 flex items-center justify-between px-0.5">
          <span className="font-barlow text-[11px] font-extrabold uppercase tracking-[0.06em] text-kidville-muted">Alunni</span>
          <span className="rounded-pill bg-kidville-cream-dark px-2.5 py-0.5 font-barlow text-[10.5px] font-extrabold uppercase text-kidville-green">{alunni.length} in classe</span>
        </div>
        <div className="flex flex-col gap-2">
          {alunni.map((a, i) => {
            const allergia = allergiaOf(a);
            return (
              <div key={a.id} className="flex items-center gap-3 rounded-2xl bg-white p-3 shadow-sm">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl font-barlow text-sm font-extrabold text-white"
                  style={{ background: TINTS[i % TINTS.length] }}>
                  {(a.nome[0] || '') + (a.cognome[0] || '')}
                </div>
                <span className={`flex-1 font-barlow text-[15px] font-extrabold uppercase ${allergia ? 'text-kidville-error' : 'text-kidville-green'}`}>
                  {a.cognome} {a.nome}
                </span>
                {allergia && (
                  <span className="inline-flex items-center gap-1 rounded-pill bg-kidville-error-soft px-2 py-0.5 font-barlow text-[10px] font-extrabold uppercase text-kidville-error">
                    <AlertTriangle size={10} /> {allergia}
                  </span>
                )}
              </div>
            );
          })}
          {alunni.length === 0 && (
            <div className="rounded-2xl bg-white p-4 text-center font-maven text-sm text-kidville-muted shadow-sm">Nessun alunno.</div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 py-1 text-center">
        <span className="font-maven text-[10.5px] text-kidville-muted">Usa le schede in alto per registro, valutazioni, scrutinio e fascicolo.</span>
      </div>
    </div>
  );
}
