'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Baby, RefreshCw } from 'lucide-react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { PrimariaParentView, type ScrutinioView } from '@/components/features/parent/PrimariaParentView';

interface PrimariaData {
  schoolType: string | null;
  child: { nome: string; cognome: string } | null;
  lezioni: never[];
  valutazioni: never[];
  note: { id: string; richiede_firma: boolean; firmata_il: string | null }[];
  assenze: never[];
  materie: never[];
}

interface PagellaItem { scrutinioId: string; periodo: string; anno: string; chiusoIl: string | null; firmato: boolean }

function RegisterInner() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [data, setData] = useState<PrimariaData | null>(null);
  const [pagelle, setPagelle] = useState<PagellaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ready || !studentId) return;
    setLoading(true);
    try {
      const [r, rp] = await Promise.all([
        fetch(`/api/parent/primaria?studentId=${studentId}&userId=${parentId}`, { headers: { 'x-user-id': parentId } }),
        fetch(`/api/parent/primaria/pagella?studentId=${studentId}&userId=${parentId}`, { headers: { 'x-user-id': parentId } }),
      ]);
      const d = await r.json();
      if (d.success) setData(d.data);
      const dp = await rp.json();
      if (dp.success) setPagelle(dp.data);
    } finally {
      setLoading(false);
    }
  }, [ready, studentId, parentId]);

  useEffect(() => { load(); }, [load]);

  const onSign = async (notaId: string) => {
    setSigning(notaId);
    await fetch('/api/notes/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ notaId }),
    });
    setSigning(null);
    load();
  };

  // Richiede l'OTP email per confermare una giustifica (FES).
  const onRequestGiustificaOtp = async () => {
    const r = await fetch(`/api/parent/presenze/giustifica/otp?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
    });
    const d = await r.json();
    if (!r.ok) return null;
    return d.data as { expiry: number; ticket: string; devCode?: string };
  };

  // Giustifica un'assenza/ritardo/uscita del figlio (solo primaria), con conferma OTP.
  const onGiustifica = async (
    dataAssenza: string,
    motivo: string,
    otp: { code: string; expiry: number; ticket: string },
  ) => {
    const r = await fetch(`/api/parent/presenze/giustifica?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ studentId, data: dataAssenza, motivo, ...otp }),
    });
    const d = await r.json();
    load();
    if (!r.ok) throw new Error(d.error || 'Errore');
  };

  // Apre la pagella PDF del periodo (scrutinio chiuso, firmato).
  const onScaricaPagella = (scrutinioId: string) => {
    if (!studentId) return;
    window.open(`/api/primaria/pagella?scrutinioId=${scrutinioId}&alunnoId=${studentId}&userId=${parentId}`, '_blank');
  };

  // Richiede l'OTP email per firmare la ricezione della pagella (FES).
  const onRequestPagellaOtp = async () => {
    const r = await fetch(`/api/parent/primaria/pagella/firma/otp?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
    });
    const d = await r.json();
    if (!r.ok) return null;
    return d.data as { expiry: number; ticket: string; devCode?: string };
  };

  // Firma la ricezione della pagella con conferma OTP, poi ricarica.
  const onFirmaPagella = async (scrutinioId: string, otp: { code: string; expiry: number; ticket: string }) => {
    const r = await fetch(`/api/parent/primaria/pagella/firma?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ scrutinioId, studentId, ...otp }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Errore');
    load();
  };

  // Carica i giudizi di scrutinio a schermo (solo dopo la firma).
  const onCaricaScrutinio = async (scrutinioId: string): Promise<ScrutinioView | null> => {
    if (!studentId) return null;
    const r = await fetch(`/api/parent/primaria/scrutinio?scrutinioId=${scrutinioId}&studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    });
    const d = await r.json();
    if (!r.ok || !d.success) return null;
    return d.data as ScrutinioView;
  };

  // Dichiara il figlio impreparato a priori (giustifica didattica), con materia opzionale.
  const onImpreparato = async (dataGiust: string, motivo: string, materiaId?: string) => {
    await fetch(`/api/parent/giustifiche-didattiche?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ studentId, data: dataGiust, motivo, materiaId }),
    });
    load();
  };

  // Comunica un'assenza in anticipo (anche per date future).
  const onComunicaAssenza = async (dataAssenza: string, motivo: string) => {
    await fetch(`/api/parent/presenze/comunica-assenza?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ studentId, data: dataAssenza, motivo }),
    });
    load();
  };

  if (!ready || loading) {
    return <div className="p-8 font-maven text-gray-400 flex items-center gap-2"><RefreshCw className="animate-spin" size={16} /> Caricamento…</div>;
  }

  // Vista adattiva: se il figlio non è in primaria, rimanda al Diario 0-6.
  if (data && data.schoolType !== 'primaria') {
    return (
      <div className="min-h-screen bg-kidville-cream/40 p-6">
        <div className="max-w-md mx-auto rounded-card bg-white p-8 text-center shadow-sm">
          <Baby className="mx-auto mb-3 text-kidville-green" size={40} />
          <h2 className="font-barlow text-xl font-bold text-gray-800">Diario 0-6</h2>
          <p className="font-maven text-sm text-gray-500 mt-1 mb-4">
            Per {data.child?.nome} è attivo il Diario di Nido/Infanzia.
          </p>
          <Link href="/parent/diary" className="font-maven inline-block rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow">
            Vai al Diario
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-kidville-cream/40 p-4 md:p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-5">
          <h1 className="font-barlow text-3xl font-bold text-kidville-green uppercase tracking-wide">Registro</h1>
          {data?.child && <p className="font-maven text-gray-500 text-sm">{data.child.nome} {data.child.cognome}</p>}
        </header>
        {data && (
          <PrimariaParentView
            valutazioni={data.valutazioni}
            note={data.note as never[]}
            assenze={data.assenze}
            materie={data.materie}
            pagelle={pagelle}
            onSign={onSign}
            onGiustifica={onGiustifica}
            onRequestGiustificaOtp={onRequestGiustificaOtp}
            onImpreparato={onImpreparato}
            onComunicaAssenza={onComunicaAssenza}
            onScaricaPagella={onScaricaPagella}
            onRequestPagellaOtp={onRequestPagellaOtp}
            onFirmaPagella={onFirmaPagella}
            onCaricaScrutinio={onCaricaScrutinio}
            signing={signing}
          />
        )}
      </div>
    </div>
  );
}

export default function ParentRegisterPage() {
  return (
    <Suspense fallback={<div className="p-8 font-maven text-gray-400">Caricamento…</div>}>
      <RegisterInner />
    </Suspense>
  );
}
