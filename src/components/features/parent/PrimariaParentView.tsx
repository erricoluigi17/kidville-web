'use client';

import { useState } from 'react';
import { Award, AlertTriangle, PenLine, CalendarOff, Hand, CalendarPlus, FileText, Download, Lock } from 'lucide-react';

interface Valutazione { id: string; materia: string; tipo: string; modalita: string; argomento: string | null; giudizio_sintetico: string | null; giudizio_testo: string | null; creato_il: string }
interface Nota { id: string; categoria: string; testo: string; richiede_firma: boolean; firmata_il: string | null; creato_il: string }
interface Assenza { id: string; data: string; stato: string; giustificata: boolean; giustificazione_testo: string | null; giust_vista_il: string | null }
interface Materia { id: string; nome: string }
interface Pagella { scrutinioId: string; periodo: string; anno: string; chiusoIl: string | null; firmato: boolean }
export interface ScrutinioView { firmato: boolean; periodo: string; anno: string; discipline: { materia: string; giudizio: string }[]; comportamento: string | null; giudizioGlobale: string | null }
type OtpParams = { code: string; expiry: number; ticket: string };

const CAT: Record<string, { label: string; cls: string }> = {
  disciplinare: { label: 'Nota disciplinare', cls: 'bg-kidville-error/10 text-kidville-error' },
  didattica: { label: 'Nota didattica', cls: 'bg-kidville-info-soft text-kidville-info' },
  compiti_non_svolti: { label: 'Compiti non svolti', cls: 'bg-kidville-warn-soft text-kidville-warn' },
};

const STATO_ASSENZA: Record<string, string> = {
  assente: 'Assenza', ritardo: 'Ritardo', uscita_anticipata: 'Uscita anticipata',
};

const oggiIso = () => new Date().toISOString().slice(0, 10);

export function PrimariaParentView({
  valutazioni, note, assenze, materie, pagelle, onSign, onGiustifica, onRequestGiustificaOtp, onImpreparato, onComunicaAssenza, onScaricaPagella, onRequestPagellaOtp, onFirmaPagella, onCaricaScrutinio, signing,
}: {
  valutazioni: Valutazione[]; note: Nota[]; assenze: Assenza[]; materie: Materia[]; pagelle: Pagella[];
  onSign: (id: string) => void;
  onGiustifica: (data: string, motivo: string, otp: OtpParams) => void | Promise<void>;
  onRequestGiustificaOtp: () => Promise<{ expiry: number; ticket: string; devCode?: string } | null>;
  onImpreparato: (data: string, motivo: string, materiaId?: string) => void | Promise<void>;
  onComunicaAssenza: (data: string, motivo: string) => void | Promise<void>;
  onScaricaPagella: (scrutinioId: string) => void;
  onRequestPagellaOtp: () => Promise<{ expiry: number; ticket: string; devCode?: string } | null>;
  onFirmaPagella: (scrutinioId: string, otp: OtpParams) => Promise<void>;
  onCaricaScrutinio: (scrutinioId: string) => Promise<ScrutinioView | null>;
  signing: string | null;
}) {
  return (
    <div className="space-y-5">
      {/* Pagelle (documento di valutazione) */}
      {pagelle.length > 0 && (
        <section className="rounded-card bg-white p-5 shadow-sm">
          <h3 className="font-barlow text-lg font-bold text-gray-800 flex items-center gap-2 mb-3">
            <FileText size={18} className="text-kidville-green" /> Pagelle
          </h3>
          <div className="space-y-3">
            {pagelle.map((p) => (
              <PagellaCard
                key={p.scrutinioId}
                pagella={p}
                onScarica={onScaricaPagella}
                onRequestOtp={onRequestPagellaOtp}
                onFirma={onFirmaPagella}
                onCaricaScrutinio={onCaricaScrutinio}
              />
            ))}
          </div>
        </section>
      )}

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

      {/* Giustifiche: assenze + impreparato a priori (solo primaria) */}
      <div className="grid gap-5 md:grid-cols-2">
        <AssenzeCard assenze={assenze} onGiustifica={onGiustifica} onRequestGiustificaOtp={onRequestGiustificaOtp} onComunicaAssenza={onComunicaAssenza} />
        <ImpreparatoForm materie={materie} onImpreparato={onImpreparato} />
      </div>

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
                {v.argomento && <p className="font-maven text-xs text-gray-500 mt-0.5">Argomento: {v.argomento}</p>}
                <p className="font-maven text-sm text-kidville-green mt-0.5">
                  {v.giudizio_sintetico || v.giudizio_testo || '—'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// Card pagella: prima della firma OTP mostra il flusso di presa visione; dopo
// la firma (una volta per pagella) mostra i giudizi a schermo + download PDF.
function PagellaCard({ pagella, onScarica, onRequestOtp, onFirma, onCaricaScrutinio }: {
  pagella: Pagella;
  onScarica: (scrutinioId: string) => void;
  onRequestOtp: () => Promise<{ expiry: number; ticket: string; devCode?: string } | null>;
  onFirma: (scrutinioId: string, otp: OtpParams) => Promise<void>;
  onCaricaScrutinio: (scrutinioId: string) => Promise<ScrutinioView | null>;
}) {
  const [firmato, setFirmato] = useState(pagella.firmato);
  const [view, setView] = useState<ScrutinioView | null>(null);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'idle' | 'otp'>('idle');
  const [code, setCode] = useState('');
  const [ticketData, setTicketData] = useState<{ expiry: number; ticket: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const caricaView = async () => {
    const v = await onCaricaScrutinio(pagella.scrutinioId);
    if (v && v.firmato) { setView(v); setOpen(true); }
  };

  const richiediCodice = async () => {
    setBusy(true); setErr('');
    const res = await onRequestOtp();
    setBusy(false);
    if (!res) { setErr('Invio codice non riuscito'); return; }
    setTicketData({ expiry: res.expiry, ticket: res.ticket });
    if (res.devCode) setCode(res.devCode);
    setStep('otp');
  };

  const conferma = async () => {
    if (!ticketData) return;
    setBusy(true); setErr('');
    try {
      await onFirma(pagella.scrutinioId, { code, expiry: ticketData.expiry, ticket: ticketData.ticket });
      setFirmato(true);
      setStep('idle');
      setCode('');
      await caricaView();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Errore');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-card border border-gray-100 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-maven text-sm font-semibold text-gray-800">{pagella.periodo}</p>
          <p className="font-maven text-xs text-gray-400">
            {pagella.anno}{pagella.chiusoIl ? ` · ${new Date(pagella.chiusoIl).toLocaleDateString('it-IT')}` : ''}
          </p>
        </div>
        {firmato ? (
          <div className="flex items-center gap-2">
            <button onClick={() => (open ? setOpen(false) : caricaView())} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green">
              {open ? 'Nascondi' : 'Vedi a schermo'}
            </button>
            <button onClick={() => onScarica(pagella.scrutinioId)} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-xs text-kidville-yellow">
              <Download size={13} /> Scarica PDF
            </button>
          </div>
        ) : step === 'idle' ? (
          <button onClick={richiediCodice} disabled={busy} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-xs text-kidville-yellow disabled:opacity-50">
            <Lock size={13} /> {busy ? '…' : 'Firma e visualizza'}
          </button>
        ) : null}
      </div>

      {!firmato && step === 'otp' && (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="font-maven text-[11px] text-gray-500">Ti abbiamo inviato un codice via email. Inseriscilo per confermare la ricezione e sbloccare la pagella.</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Codice"
              className="font-maven w-28 rounded-pill border border-gray-200 px-3 py-1.5 text-xs tracking-widest"
            />
            <button onClick={conferma} disabled={busy || code.length < 4} className="font-maven rounded-pill bg-kidville-green px-3 py-1.5 text-xs text-kidville-yellow disabled:opacity-50">
              {busy ? '…' : 'Conferma'}
            </button>
            <button onClick={() => { setStep('idle'); setCode(''); setErr(''); }} className="font-maven rounded-pill bg-gray-100 px-3 py-1.5 text-xs text-gray-500">
              Annulla
            </button>
          </div>
        </div>
      )}
      {err && <p className="font-maven text-[11px] text-kidville-error mt-1">{err}</p>}

      {firmato && open && view && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <ul className="divide-y divide-gray-100">
            {view.discipline.map((d) => (
              <li key={d.materia} className="flex items-center justify-between py-1.5">
                <span className="font-maven text-sm text-gray-700">{d.materia}</span>
                <span className="font-maven text-sm font-semibold text-kidville-green">{d.giudizio}</span>
              </li>
            ))}
          </ul>
          {view.comportamento && (
            <div className="mt-2">
              <p className="font-maven text-[11px] font-semibold text-gray-500">Comportamento</p>
              <p className="font-maven text-sm text-gray-700">{view.comportamento}</p>
            </div>
          )}
          {view.giudizioGlobale && (
            <div className="mt-2">
              <p className="font-maven text-[11px] font-semibold text-gray-500">Giudizio globale</p>
              <p className="font-maven text-sm text-gray-700">{view.giudizioGlobale}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Card "Assenze da giustificare" + pulsante "Comunica assenza in anticipo".
function AssenzeCard({ assenze, onGiustifica, onRequestGiustificaOtp, onComunicaAssenza }: {
  assenze: Assenza[];
  onGiustifica: (data: string, motivo: string, otp: OtpParams) => void | Promise<void>;
  onRequestGiustificaOtp: () => Promise<{ expiry: number; ticket: string; devCode?: string } | null>;
  onComunicaAssenza: (data: string, motivo: string) => void | Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [data, setData] = useState(oggiIso);
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const comunica = async () => {
    setBusy(true);
    await onComunicaAssenza(data, motivo);
    setBusy(false);
    setMotivo('');
    setShowForm(false);
    setMsg('Assenza comunicata ✓');
  };

  return (
    <section className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="font-barlow text-lg font-bold text-gray-800 flex items-center gap-2">
          <CalendarOff size={18} className="text-kidville-error" /> Assenze da giustificare
        </h3>
        <button onClick={() => setShowForm((v) => !v)} className="font-maven inline-flex items-center gap-1 rounded-pill bg-kidville-green px-3 py-1.5 text-xs text-kidville-yellow">
          <CalendarPlus size={13} /> Comunica assenza in anticipo
        </button>
      </div>

      {showForm && (
        <div className="mb-3 rounded-card bg-kidville-cream/50 p-3 flex flex-col gap-2">
          <p className="font-maven text-xs text-gray-500">Comunica un&apos;assenza, anche per una data futura.</p>
          <input type="date" value={data} min={oggiIso()} onChange={(e) => setData(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-1.5 text-sm" />
          <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Motivo (es. visita medica)" className="font-maven rounded-pill border border-gray-200 px-3 py-1.5 text-sm" />
          <button onClick={comunica} disabled={busy} className="font-maven self-start rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50">
            {busy ? 'Invio…' : 'Invia'}
          </button>
        </div>
      )}
      {msg && <p className="font-maven text-xs text-kidville-success mb-2">{msg}</p>}

      {assenze.length === 0 ? (
        <p className="font-maven text-sm text-gray-400">Nessuna assenza recente.</p>
      ) : (
        <ul className="space-y-2">
          {assenze.map((a) => (
            <AssenzaRow key={a.id} assenza={a} onGiustifica={onGiustifica} onRequestGiustificaOtp={onRequestGiustificaOtp} />
          ))}
        </ul>
      )}
    </section>
  );
}

// Riga assenza con giustificazione protetta da OTP (FES): motivo → invia codice → conferma.
function AssenzaRow({ assenza, onGiustifica, onRequestGiustificaOtp }: {
  assenza: Assenza;
  onGiustifica: (data: string, motivo: string, otp: OtpParams) => void | Promise<void>;
  onRequestGiustificaOtp: () => Promise<{ expiry: number; ticket: string; devCode?: string } | null>;
}) {
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'motivo' | 'otp'>('motivo');
  const [code, setCode] = useState('');
  const [ticketData, setTicketData] = useState<{ expiry: number; ticket: string } | null>(null);
  const [err, setErr] = useState('');
  const giorno = new Date(assenza.data).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });

  const richiediCodice = async () => {
    setBusy(true); setErr('');
    const res = await onRequestGiustificaOtp();
    setBusy(false);
    if (!res) { setErr('Invio codice non riuscito'); return; }
    setTicketData({ expiry: res.expiry, ticket: res.ticket });
    if (res.devCode) setCode(res.devCode); // dev: precompila
    setStep('otp');
  };

  const conferma = async () => {
    if (!ticketData) return;
    setBusy(true); setErr('');
    try {
      await onGiustifica(assenza.data, motivo, { code, expiry: ticketData.expiry, ticket: ticketData.ticket });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Errore');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-card bg-kidville-cream/40 p-3">
      <div className="flex items-center justify-between">
        <span className="font-maven text-sm text-gray-800">
          <b>{STATO_ASSENZA[assenza.stato] ?? assenza.stato}</b> · {giorno}
        </span>
        {assenza.giustificata ? (
          <span className={`text-[11px] font-maven ${assenza.giust_vista_il ? 'text-kidville-success' : 'text-kidville-warn'}`}>
            {assenza.giust_vista_il ? '✓ presa visione' : 'giustificata · in attesa'}
          </span>
        ) : (
          <span className="text-[11px] font-maven text-kidville-error">da giustificare</span>
        )}
      </div>
      {assenza.giustificata ? (
        assenza.giustificazione_testo && <p className="font-maven text-xs text-gray-500 mt-1">{assenza.giustificazione_testo}</p>
      ) : step === 'motivo' ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Motivazione (es. malattia)"
            className="font-maven flex-1 rounded-pill border border-gray-200 px-3 py-1.5 text-xs"
          />
          <button onClick={richiediCodice} disabled={busy} className="font-maven rounded-pill bg-kidville-green px-3 py-1.5 text-xs text-kidville-yellow disabled:opacity-50">
            {busy ? '…' : 'Giustifica'}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="font-maven text-[11px] text-gray-500">Ti abbiamo inviato un codice via email. Inseriscilo per confermare la giustifica.</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Codice"
              className="font-maven w-28 rounded-pill border border-gray-200 px-3 py-1.5 text-xs tracking-widest"
            />
            <button onClick={conferma} disabled={busy || code.length < 4} className="font-maven rounded-pill bg-kidville-green px-3 py-1.5 text-xs text-kidville-yellow disabled:opacity-50">
              {busy ? '…' : 'Conferma'}
            </button>
            <button onClick={() => { setStep('motivo'); setCode(''); setErr(''); }} className="font-maven rounded-pill bg-gray-100 px-3 py-1.5 text-xs text-gray-500">
              Annulla
            </button>
          </div>
        </div>
      )}
      {err && <p className="font-maven text-[11px] text-kidville-error mt-1">{err}</p>}
    </li>
  );
}

// Form per dichiarare l'alunno impreparato a priori (giustifica didattica), con materia.
function ImpreparatoForm({ materie, onImpreparato }: {
  materie: Materia[];
  onImpreparato: (data: string, motivo: string, materiaId?: string) => void | Promise<void>;
}) {
  const [data, setData] = useState(oggiIso);
  const [materiaId, setMateriaId] = useState('');
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const invia = async () => {
    setBusy(true);
    await onImpreparato(data, motivo, materiaId || undefined);
    setBusy(false);
    setMotivo('');
    setMsg('Dichiarazione inviata ✓');
  };

  return (
    <section className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-lg font-bold text-gray-800 flex items-center gap-2 mb-3">
        <Hand size={18} className="text-kidville-warn" /> Dichiara impreparato (a priori)
      </h3>
      <p className="font-maven text-xs text-gray-500 mb-3">
        Comunica in anticipo al docente che tuo figlio è impreparato per una determinata giornata/materia.
      </p>
      <div className="flex flex-col gap-2">
        <input
          type="date"
          value={data}
          onChange={(e) => setData(e.target.value)}
          className="font-maven rounded-pill border border-gray-200 px-3 py-1.5 text-sm"
        />
        <select value={materiaId} onChange={(e) => setMateriaId(e.target.value)} className="font-maven rounded-pill border border-gray-200 px-3 py-1.5 text-sm">
          <option value="">Materia (facoltativa)…</option>
          {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
        </select>
        <input
          type="text"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          placeholder="Motivo (facoltativo)"
          className="font-maven rounded-pill border border-gray-200 px-3 py-1.5 text-sm"
        />
        {msg && <p className="font-maven text-xs text-kidville-success">{msg}</p>}
        <button onClick={invia} disabled={busy} className="font-maven self-start rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow disabled:opacity-50">
          {busy ? 'Invio…' : 'Invia dichiarazione'}
        </button>
      </div>
    </section>
  );
}
