'use client';

import { Suspense, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Baby, RefreshCw } from 'lucide-react';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import {
  CompitiList,
  PERIODO_PREDEFINITO,
  dataDaDelPeriodo,
  type FinestraRegistro,
  type Lezione,
  type PeriodoCompiti,
} from '@/components/features/parent/LezioniCompitiSections';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { btnClass } from '@/components/ui/Btn';

/**
 * ⚠️ `finestraRegistro` È FACOLTATIVO QUI, e non perché la route possa
 * ometterlo — lo manda su ogni ramo. È facoltativo perché questo tipo descrive
 * un corpo che ARRIVA DALLA RETE: una risposta di un deploy più vecchio, o una
 * cache, non lo porta, e dichiararlo obbligatorio lo farebbe credere presente al
 * compilatore proprio dove non lo è. Assente vale «finestra letta per intero»,
 * che è il comportamento di sempre — non «troncata», perché un avviso che
 * compare per omissione è un avviso che si impara a ignorare.
 */
interface Data {
  schoolType: string | null;
  child: { nome: string; cognome: string } | null;
  lezioni: Lezione[];
  finestraRegistro?: FinestraRegistro;
}

/**
 * L'esito dell'ULTIMA lettura andata a termine, con la chiave della richiesta
 * che l'ha prodotta.
 *
 * Tenere la chiave dentro l'esito, invece di un `loading` booleano acceso a
 * mano, risolve due cose in una: il «sto caricando» diventa *derivato* (la
 * richiesta a schermo non è quella che ha risposto), e una risposta arrivata in
 * ritardo dopo un cambio di periodo non può più vincere sulla più recente.
 */
interface Esito { chiave: string; data: Data | null; errore: boolean }

function CompitiInner() {
  const t = useTranslations('parentServizi');
  const { parentId, studentId, ready } = useParentIdentity();
  const [esito, setEsito] = useState<Esito | null>(null);
  const [periodo, setPeriodo] = useState<PeriodoCompiti>(PERIODO_PREDEFINITO);
  // Bump del pulsante «Riprova»: cambia la chiave, quindi rifà la lettura anche
  // quando il periodo è rimasto lo stesso.
  const [tentativo, setTentativo] = useState(0);

  const chiave = `${periodo}#${tentativo}`;

  useEffect(() => {
    if (!ready || !parentId || !studentId) return;
    // La risposta di una richiesta superata non deve scrivere niente: senza
    // questa guardia, tornando da «90 giorni» a «14» l'ordine d'arrivo decide
    // che cosa resta a schermo.
    let vivo = true;
    void (async () => {
      try {
        const q = new URLSearchParams({ studentId, userId: parentId });
        // Il preimpostato parte SENZA `dataDa`: la finestra di 14 giorni la
        // decide la route, ed è esattamente la chiamata di prima di questo
        // filtro. Nessuna famiglia vede un comportamento diverso finché non
        // tocca il selettore.
        const dataDa = dataDaDelPeriodo(periodo);
        if (dataDa) q.set('dataDa', dataDa);
        const r = await fetch(`/api/parent/primaria?${q.toString()}`, { headers: { 'x-user-id': parentId } });
        const d = await r.json();
        if (!vivo) return;
        // Una lettura fallita NON è «nessun compito»: si segna come errore, e i
        // dati già letti restano (il nome del figlio in testata non sparisce
        // perché la rete ha singhiozzato).
        //
        // ⚠️ `d.data` E NON IL SOLO `d.success`. Una risposta `{success:true}`
        // senza corpo — un 200 che non porta niente, la forma che prende un
        // guasto a monte quando l'involucro risponde comunque — passava il
        // controllo e scriveva `data: undefined`: la bacheca rendeva lo stato
        // VUOTO, cioè «Nessun compito assegnato negli ultimi 14 giorni». È
        // esattamente la frase che questa pagina esiste per non far più dire a
        // un guasto, tornata da una porta di servizio.
        if (d?.success && d.data) setEsito({ chiave, data: d.data as Data, errore: false });
        else setEsito((prec) => ({ chiave, data: prec?.data ?? null, errore: true }));
      } catch {
        if (vivo) setEsito((prec) => ({ chiave, data: prec?.data ?? null, errore: true }));
      }
    })();
    return () => { vivo = false; };
  }, [ready, studentId, parentId, periodo, chiave]);

  const data = esito?.data ?? null;
  const caricamento = !ready || esito === null || esito.chiave !== chiave;

  // Lo spinner a tutta pagina resta solo per la PRIMA lettura: dopo, la testata
  // e i due selettori devono restare a schermo — un filtro che sparisce mentre
  // ricarica è un filtro che non si può correggere.
  if (caricamento && esito === null) {
    return <div className="px-4 pt-5 pb-24 font-maven text-kidville-muted flex items-center gap-2"><RefreshCw className="animate-spin" size={16} /> {t('caricamento')}</div>;
  }

  if (data && data.schoolType !== 'primaria') {
    return (
      <div className="px-4 pt-5 pb-24">
        <div className="rounded-card bg-white p-8 text-center shadow-sm">
          <Baby className="mx-auto mb-3 text-kidville-green" size={40} />
          <h2 className="font-barlow text-xl font-bold text-kidville-ink">{t('sezioneNonDisponibile')}</h2>
          <p className="font-maven text-sm text-kidville-muted mt-1 mb-4">{t('compitiSoloPrimaria')}</p>
          <Link href="/parent/diary" className={btnClass('primary', 'sm')}>{t('vaiAlDiario')}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard
        eyebrow={t('didatticaEyebrow')}
        title={t('compitiTitolo')}
        subtitle={data?.child ? <>{data.child.nome} {data.child.cognome}</> : undefined}
      />
      <div className="mt-5">
        <CompitiList
          lezioni={data?.lezioni ?? []}
          periodo={periodo}
          onPeriodo={setPeriodo}
          // ⚠️ SI PASSA SOLO QUANDO LE RIGHE A SCHERMO SONO QUELLE DI QUESTA
          // LETTURA. `data` sopravvive a una lettura fallita apposta (`prec?.data
          // ?? null`), e con essa sopravviverebbe il suo `finestraRegistro`:
          // l'avviso «di N lezioni ne sono state lette M» resterebbe a schermo
          // accanto al pannello d'errore, riferito a una finestra che non è più
          // quella della tendina. È la stessa ambiguità che `aria-busy` e
          // l'attenuazione chiudono per le righe — «quello che vedo è la
          // risposta al comando che vedo?» — e la risposta onesta, mentre la
          // lettura è in volo o è caduta, è tacere invece di affermare un
          // conteggio vecchio.
          finestra={caricamento || esito?.errore ? undefined : data?.finestraRegistro}
          caricamento={caricamento}
          // L'errore vale finché non è ripartita una lettura: appena la chiave
          // cambia, `caricamento` torna vero e il blocco d'errore lascia il
          // posto al segnale che qualcosa è in corso.
          //
          // QUALE segnale dipende da che cosa c'è già a schermo, e sono TRE
          // casi — il commento che stava qui ne raccontava uno solo, poi due:
          //  · PRIMA lettura fallita → non ci sono righe, quindi `StatoElenco`
          //    rende davvero il suo spinner (`role="status"`) al posto
          //    dell'errore;
          //  · RICARICAMENTO dopo «Riprova», con qualcosa già a schermo → i
          //    dati di prima restano apposta (`prec?.data ?? null`), quindi
          //    `mostrati > 0` e lo stato è `pronto`: nessuno spinner. Il segno
          //    di aver premuto «Riprova» sono l'`aria-busy` e l'attenuazione
          //    delle righe, che `CompitiList` accende con `caricamento` — ed è
          //    il motivo per cui quel `caricamento` va passato anche quando la
          //    bacheca non è vuota;
          //  · ERRORE con le righe di PRIMA ancora a schermo — il terzo caso,
          //    che questo commento non elencava e che nessun test copriva.
          //    Misurato il 2026-09-19: prima lettura riuscita, poi «90 giorni»
          //    e lettura fallita. `caricamento` è già tornato falso (la chiave
          //    ha risposto), quindi `errore` qui sotto è VERO: `decidiStatoElenco`
          //    mette `errore` davanti a tutto e si vede il pannello con
          //    «Riprova» — ma sotto restavano le righe dei 14 giorni a piena
          //    opacità, con `aria-busy="false"`, sotto una tendina già spostata
          //    su 90. Cioè l'elenco si spacciava per la risposta che non è mai
          //    arrivata. Per questo `CompitiList` attenua e dichiara
          //    `aria-busy` anche su `errore`, non solo su `caricamento`: la
          //    domanda a cui il genitore deve poter rispondere è la stessa nei
          //    due rami — «queste righe sono la risposta al comando che vedo?».
          errore={!caricamento && (esito?.errore ?? false)}
          onRiprova={() => setTentativo((n) => n + 1)}
        />
      </div>
    </div>
  );
}

function CompitiFallback() {
  const t = useTranslations('parentServizi');
  return <div className="px-4 pt-5 pb-24 font-maven text-kidville-muted">{t('caricamento')}</div>;
}

export default function ParentCompitiPage() {
  return (
    <Suspense fallback={<CompitiFallback />}>
      <CompitiInner />
    </Suspense>
  );
}
