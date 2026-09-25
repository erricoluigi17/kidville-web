'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { Download, Check, Award, ShieldCheck } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn, btnClass } from '@/components/ui/Btn';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { apriDocumento } from '@/lib/native/scarica';
import { avvisoDocumento, suNativo } from '@/lib/native/documento-genitore';

interface PagellaItem { scrutinioId: string; periodo: string; anno: string; chiusoIl: string | null; firmato: boolean }
interface CertItem { id: string; anno: string; stato: string; downloadUrl: string | null }
interface ScrutinioView {
  materie: { nome: string; giudizio: string | null }[];
  comportamento: string | null;
  giudizioGlobale: string | null;
}

function PagelleGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const t = useTranslations('parentPrimaria');
  const ts = useTranslations('shared');
  const [pagelle, setPagelle] = useState<PagellaItem[]>([]);
  const [certificati, setCertificati] = useState<CertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dettaglio, setDettaglio] = useState<Record<string, ScrutinioView | null>>({});
  const [firmando, setFirmando] = useState<string | null>(null);
  const [otpState, setOtpState] = useState<{ ticket: string; expiry: number; devCode?: string } | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [otpTarget, setOtpTarget] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  // L'esito del certificato ha un posto suo: `msg` vive dentro l'elenco delle pagelle, che
  // può essere vuoto mentre il certificato c'è.
  const [msgCertificati, setMsgCertificati] = useState('');

  const carica = useCallback(async () => {
    if (!ready || !parentId || !studentId) return;
    try {
      const r = await fetch(`/api/parent/primaria/pagella?studentId=${studentId}&userId=${parentId}`, {
        headers: { 'x-user-id': parentId },
      });
      const d = await r.json();
      if (d.success) setPagelle(d.data);
      try {
        const rc = await fetch(`/api/parent/competenze?studentId=${studentId}&userId=${parentId}`, { headers: { 'x-user-id': parentId } });
        const dc = await rc.json();
        if (dc.success) setCertificati(dc.data ?? []);
      } catch { /* no-op */ }
    } finally {
      setLoading(false);
    }
  }, [ready, studentId, parentId]);

  useEffect(() => { carica(); }, [carica]);

  /**
   * La pagella è da CONSULTARE (spec 2026-09-24, NAT3c): passa da `apriDocumento`.
   * Sul web è lo stesso `window.open` di prima, aperto dentro il gesto (l'helper non
   * attende niente prima della scheda); nell'app 1.1 è l'anteprima di sistema DENTRO
   * l'app — il `window.open` nella WebView non apriva niente. La route è della stessa
   * origine: nell'app i byte si leggono con la `fetch` della WebView, che ha i cookie di
   * sessione. L'esito lo registra l'helper, successo compreso.
   */
  const apriPDF = (scrutinioId: string) => {
    if (!studentId) return;
    void apriDocumento({
      sorgente: `/api/primaria/pagella?scrutinioId=${scrutinioId}&alunnoId=${studentId}&userId=${parentId}`,
      nomeFile: `pagella-${scrutinioId.slice(0, 8)}.pdf`,
      mime: 'application/pdf',
      etichetta: 'pagella',
    }).then((esito) => {
      // Un'apertura riuscita toglie l'avviso di un tentativo precedente fallito — e SOLO
      // quello: un messaggio della firma (OTP, «pagella firmata») resta dov'è. Sul binario
      // 1.0 (plugin della 1.1 assenti) il testo dice di aggiornare l'app: lì riprovare non
      // riuscirà mai.
      const avvisiApertura = [ts('documentoNonAperto'), ts('documentoAppDaAggiornare')];
      const avviso = avvisoDocumento(esito);
      setMsg((m) =>
        avviso === 'aggiorna'
          ? avvisiApertura[1]
          : avviso === 'riprova'
            ? avvisiApertura[0]
            : avvisiApertura.includes(m)
              ? ''
              : m,
      );
    });
  };

  const caricaDettaglio = async (scrutinioId: string) => {
    if (!parentId) return;
    if (dettaglio[scrutinioId] !== undefined) { setDettaglio((p) => ({ ...p, [scrutinioId]: dettaglio[scrutinioId] === null ? undefined as unknown as null : null })); return; }
    const r = await fetch(`/api/parent/primaria/scrutinio?scrutinioId=${scrutinioId}&studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    });
    const d = await r.json();
    setDettaglio((p) => ({ ...p, [scrutinioId]: d.success ? d.data : null }));
  };

  const avviaFirma = async (scrutinioId: string) => {
    if (!parentId) return;
    setMsg(''); setOtpTarget(scrutinioId);
    const r = await fetch(`/api/parent/primaria/pagella/firma/otp?userId=${parentId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
    });
    const d = await r.json();
    // Niente prosa del server: è italiana per costruzione (T10-F1).
    if (!r.ok) { setMsg(soloCatalogoDaCorpo(d, t('pagelleErroreOtp'))); return; }
    setOtpState(d.data);
  };

  const confermaFirma = async () => {
    if (!otpTarget || !otpState || !parentId) return;
    setFirmando(otpTarget);
    const r = await fetch(`/api/parent/primaria/pagella/firma?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ scrutinioId: otpTarget, studentId, code: otpCode, expiry: otpState.expiry, ticket: otpState.ticket }),
    });
    const d = await r.json();
    setFirmando(null);
    if (!r.ok) { setMsg(soloCatalogoDaCorpo(d, t('pagelleFirmaNonRiuscita'))); return; }
    setOtpState(null); setOtpCode(''); setOtpTarget(null);
    setMsg(t('pagelleFirmataMsg'));
    carica();
  };

  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard eyebrow={t('eyebrow')} title={t('pagelleTitolo')} className="mb-4" />

      {/* Banner conformità O.M. 3/2025 (DR PagelleScreen) */}
      <div className="mb-4 flex items-start gap-2.5 rounded-[16px] bg-kidville-green-soft px-4 py-3">
        <ShieldCheck size={18} className="mt-0.5 flex-shrink-0 text-kidville-green" />
        <p className="font-maven text-[12.5px] leading-snug text-kidville-green/80">
          {t.rich('pagelleBanner', { strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      </div>

      {loading ? (
        <p className="font-maven text-sm text-kidville-muted">{t('caricamento')}</p>
      ) : pagelle.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">{t('pagelleVuoto')}</p>
      ) : (
        <div className="space-y-3">
          {/* Lo stesso `<p>` porta i successi della firma e gli errori (firma, pagella che
              non si apre): il ruolo segue il tono, così un lettore di schermo annuncia
              subito un errore e con garbo un successo. */}
          {msg && <p role={msg.includes('✓') ? 'status' : 'alert'} className={`font-maven text-sm rounded-2xl px-4 py-2 ${msg.includes('✓') ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-error-soft text-kidville-error'}`}>{msg}</p>}

          {pagelle.map((p) => {
            const det = dettaglio[p.scrutinioId];
            return (
              <div key={p.scrutinioId} className="rounded-card border border-kidville-line bg-white shadow-sm overflow-hidden">
                <div className="flex items-center justify-between gap-2 px-4 py-3.5">
                  <div>
                    <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">{p.periodo}</p>
                    <p className="font-maven text-xs text-kidville-muted">{t('pagelleAnnoScolastico', { anno: p.anno })}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.firmato
                      ? <span className="font-maven text-xs text-kidville-success flex items-center gap-1"><Check size={11} /> {t('firmata')}</span>
                      : (
                        <Btn variant="primary" size="sm" onClick={() => avviaFirma(p.scrutinioId)}>
                          {t('pagelleFirma')}
                        </Btn>
                      )}
                    <Btn variant="ghost" size="sm" onClick={() => apriPDF(p.scrutinioId)}>
                      <Download size={12} /> {t('pagellePdf')}
                    </Btn>
                    {p.firmato && (
                      <button
                        onClick={() => caricaDettaglio(p.scrutinioId)}
                        className="font-maven text-xs text-kidville-muted underline"
                      >
                        {det !== undefined ? t('pagelleNascondi') : t('pagelleDettaglio')}
                      </button>
                    )}
                  </div>
                </div>

                {/* Dettaglio giudizi (solo dopo firma) */}
                {p.firmato && det && (
                  <div className="border-t border-kidville-line px-4 py-3 space-y-1.5">
                    {det.materie.map((m, i) => (
                      <div key={i} className="flex items-center justify-between gap-2">
                        <span className="font-maven text-sm text-kidville-ink">{m.nome}</span>
                        <span className="font-maven text-sm font-semibold text-kidville-green">{m.giudizio ?? '—'}</span>
                      </div>
                    ))}
                    {det.comportamento && (
                      <p className="font-maven text-xs text-kidville-muted mt-2">{t('pagelleComportamento', { value: det.comportamento })}</p>
                    )}
                    {det.giudizioGlobale && (
                      <p className="font-maven text-xs text-kidville-muted italic mt-1">{det.giudizioGlobale}</p>
                    )}
                  </div>
                )}

                {/* OTP firma inline */}
                {otpTarget === p.scrutinioId && otpState && (
                  <div className="border-t border-kidville-line px-4 py-3 space-y-2">
                    <p className="font-maven text-sm text-kidville-muted">{t('otpIstruzione')}</p>
                    {otpState.devCode && (
                      <p className="font-maven text-xs text-kidville-warn">{t('devLabel')} <b>{otpState.devCode}</b></p>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text" value={otpCode} onChange={(e) => setOtpCode(e.target.value)}
                        placeholder="000000"
                        className="font-maven rounded-full border border-kidville-line px-3 py-1.5 text-sm w-28 text-center tracking-widest"
                      />
                      <Btn
                        variant="primary"
                        size="sm"
                        onClick={confermaFirma}
                        disabled={firmando === p.scrutinioId || !otpCode}
                      >
                        {firmando === p.scrutinioId ? t('firmando') : t('conferma')}
                      </Btn>
                      <button onClick={() => { setOtpTarget(null); setOtpState(null); setOtpCode(''); }}
                        className="font-maven text-xs text-kidville-muted">{t('annulla')}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {certificati.length > 0 && (
        <div className="mt-6">
          <h2 className="font-barlow text-lg font-black text-kidville-green uppercase tracking-wide mb-3 flex items-center gap-2">
            <Award size={18} /> {t('pagelleCertificatoTitolo')}
          </h2>
          {msgCertificati && (
            <p role="alert" className="mb-3 font-maven text-sm rounded-2xl px-4 py-2 bg-kidville-error-soft text-kidville-error">{msgCertificati}</p>
          )}
          <div className="space-y-2">
            {certificati.map((c) => (
              <div key={c.id} className="rounded-card border border-kidville-line bg-white shadow-sm px-4 py-3.5 flex items-center justify-between">
                <div>
                  <p className="font-barlow text-base font-extrabold uppercase tracking-wide text-kidville-green">{t('pagelleClasseQuinta')}</p>
                  <p className="font-maven text-xs text-kidville-muted">{t('pagelleAnnoScolastico', { anno: c.anno })}</p>
                </div>
                {/* Il certificato è da SALVARE: sul web il collegamento resta com'è; nell'app
                    `suNativo` apre il foglio «Salva su File» con il file (NAT3c). */}
                {c.downloadUrl ? (
                  <a
                    href={c.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={suNativo(
                      'salva',
                      () => ({
                        sorgente: c.downloadUrl as string,
                        nomeFile: `certificato-competenze-${c.anno.replace(/\//g, '-')}.pdf`,
                        mime: 'application/pdf',
                        etichetta: 'certificato-competenze',
                      }),
                      (esito) => {
                        const avviso = avvisoDocumento(esito);
                        setMsgCertificati(
                          avviso === 'aggiorna'
                            ? ts('documentoAppDaAggiornare')
                            : avviso === 'riprova'
                              ? ts('documentoNonSalvato')
                              : '',
                        );
                      },
                    )}
                    className={btnClass('ghost', 'sm')}
                  >
                    <Download size={12} /> {t('pagelleScarica')}
                  </a>
                ) : (
                  <span className="font-maven text-xs text-kidville-muted">{t('pagelleInPreparazione')}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PagelleGenitorePage() {
  const t = useTranslations('parentPrimaria');
  return (
    <Suspense fallback={<div className="px-4 pt-5 pb-24 font-maven text-kidville-muted">{t('caricamento')}</div>}>
      <PagelleGenitore />
    </Suspense>
  );
}
