'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MessageCircle, BookOpen, Camera, CalendarX2, ClipboardList, GraduationCap, Hourglass, Info } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { withIdentity } from '@/lib/auth/current-user';
import { useParentIdentity, eMotivoNonPiuIscritto } from '@/lib/auth/use-parent-identity';
import { useChildSchoolType } from '@/lib/auth/use-child-school-type';
import { HeroCard } from '@/components/features/shell/HeroCard';
import { SospensioneBanner } from '@/components/features/parent/SospensioneBanner';
import { PagamentiSummary } from '@/components/features/parent/pagamenti/PagamentiSummary';
import { SectionHeader } from '@/components/features/parent/home/SectionHeader';
import { DiaryTodayCard } from '@/components/features/parent/home/DiaryTodayCard';
import { AvvisiPreview } from '@/components/features/parent/home/AvvisiPreview';
import { NewsPreview } from '@/components/features/parent/home/NewsPreview';
import { GalleryTodayCard } from '@/components/features/parent/home/GalleryTodayCard';
import { LockerTodayCard } from '@/components/features/parent/home/LockerTodayCard';
import { AgendaTodayCard } from '@/components/features/parent/home/AgendaTodayCard';
import { PresenzeTodayCard } from '@/components/features/parent/home/PresenzeTodayCard';

interface QuickAction {
  id: string;
  label: string;
  icon: typeof MessageCircle;
  href: string;
  bg: string;
  fg: string;
}

function ParentHomeContent() {
  const t = useTranslations('home');
  // Le due frasi della schermata di cortesia stanno in `parentServizi` e non in
  // `home`: sono un testo dell'AREA famiglia, non del riquadro di benvenuto.
  const tServizi = useTranslations('parentServizi');
  const { parentId, studentId, inAttesa, motivoAssenza, ready } = useParentIdentity();
  // `ready` NON si butta via: serve al ramo «figli non ancora visibili» qui sotto
  // e a `gradoIgnoto`, dove è il segno del PRIMO fotogramma — quello in cui
  // `studentId` è ancora `null` perché la risoluzione dell'identità è in volo.
  const { schoolType, ready: gradoLetto } = useChildSchoolType();
  const isPrimaria = schoolType === 'primaria';

  const [firstName, setFirstName] = useState('');
  const [nameResolved, setNameResolved] = useState(false);
  // La sezione del bambino viaggia fino alla card dell'armadietto, che senza non
  // può chiedere al server le soglie del materiale (e prima le aveva cablate).
  const [classeSezione, setClasseSezione] = useState('');

  useEffect(() => {
    if (!studentId) return;
    fetch(`/api/diary/students?id=${studentId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        setFirstName(d.nome ?? '');
        if (typeof d.classe_sezione === 'string') setClasseSezione(d.classe_sezione);
      })
      // AGENTS.md regola 6: un `catch` che non logga è un bug. Qui l'errore È
      // tollerabile — il nome serve al solo saluto dell'hero, e il `finally`
      // sblocca comunque lo skeleton — ma «tollerabile» va SCRITTO: senza questa
      // riga una home che saluta «Ciao!» invece che per nome non lascia nessuna
      // traccia, e un guasto di rete prende l'aspetto di una scelta di prodotto.
      //
      // ⚠️ `warn` E NON `info`, benché la regola dica `info`: il canale del client
      // non ha `info` — `EventoClient.livello` è `'warn' | 'error'` e la route
      // `/api/logs` rifiuta il resto (vedi `livelloEvento` in
      // `@/lib/logging/client`). `warn` è il livello più basso che esista qui, ed
      // è anche quello in cui la politica declassa da sola una fetch troncata
      // dalla WebView, che è il caso frequente.
      //
      // Solo `nomeErrore`: il `message` di una fetch fallita può portarsi dietro
      // l'URL, e in quell'URL c'è l'id di un minore.
      .catch((err: unknown) => {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `home-nome-figlio-non-letto: ${nomeErrore(err)}`,
          route: '/parent',
        });
      })
      .finally(() => setNameResolved(true));
  }, [studentId]);

  // ── «HO DEI FIGLI, MA NESSUNO È ANCORA VISIBILE» ────────────────────────────
  //
  // Dal 2026-09-05 l'app non mostra più i figli senza classe, ritirati o
  // archiviati. Per quattro account genitore in produzione quelli erano TUTTI i
  // figli: senza questo ramo la loro home sarebbe la home di chi non ha figli —
  // saluto neutro, riquadri vuoti, nessuna spiegazione e nessuna cosa da fare.
  //
  // La differenza fra le due situazioni la sa solo il server (`in_attesa`), ed è
  // il motivo per cui non basta guardare `studentId === null`: quello è vero anche
  // mentre la rete è giù, e mandare in segreteria chi è semplicemente offline
  // sarebbe peggio di non dire niente.
  //
  // ⚠️ IL RAMO STA DOPO TUTTI GLI HOOK, e non prima: `useEffect` e `useState` di
  // questo componente devono girare sempre nello stesso ordine.
  //
  // ── E NON È UNA SCHERMATA SOLA, PERCHÉ NON È UN CASO SOLO ──────────────────
  //
  // Misurato in produzione il 2026-09-06: dei 4 account senza figli visibili, 3
  // hanno l'unico figlio SENZA SEZIONE — «appena la classe è assegnata qui
  // compare tutto» è vera — e 1 ce l'ha ARCHIVIATO, e a quella famiglia la
  // stessa frase prometteva il completamento di un'iscrizione che non esiste e
  // una classe che non arriverà. Un quarto delle persone leggeva una cosa falsa
  // sull'unica schermata che la loro app mostra.
  //
  // La clessidra segue la frase e non il ramo: promette un'attesa, e dove non
  // c'è nessuna attesa da fare sarebbe la parte che continua a mentire dopo che
  // il testo ha smesso.
  if (ready && inAttesa) {
    const nonPiuIscritto = eMotivoNonPiuIscritto(motivoAssenza);
    const Icona = nonPiuIscritto ? Info : Hourglass;
    return (
      <div className="min-h-screen bg-kidville-cream px-4 pb-[100px] pt-5">
        <div className="rounded-[22px] bg-white px-5 py-8 text-center" style={{ boxShadow: '0 4px 12px -8px rgba(0,0,0,0.18)' }}>
          <span className="mx-auto flex h-[52px] w-[52px] items-center justify-center rounded-[18px] bg-kidville-yellow-soft text-kidville-yellow-dark">
            <Icona size={24} strokeWidth={1.9} aria-hidden="true" />
          </span>
          <h1 className="pt-4 font-barlow text-[19px] font-bold uppercase leading-[1.1] tracking-[0.02em] text-kidville-green">
            {nonPiuIscritto ? tServizi('nonPiuIscrittoTitolo') : tServizi('inAttesaTitolo')}
          </h1>
          {/* `sub` (#55615C, 6,46:1) e NON `muted` (#7B8582, 3,80:1 su bianco, sotto i
              4,5:1 di WCAG AA): a 13,5px questa frase è l'UNICA cosa che i quattro
              account senza figli visibili leggono nella loro app, e dice a chi
              rivolgersi. Il lock `__tests__/a11y/testo-muted-allowlist.test.ts` lo
              pretende — l'allowlist può solo accorciarsi, non crescere a due. */}
          <p className="pt-2 font-maven text-[13.5px] leading-[1.5] text-kidville-sub">
            {nonPiuIscritto ? tServizi('nonPiuIscrittoTesto') : tServizi('inAttesaTesto')}
          </p>
        </div>
      </div>
    );
  }

  // Skeleton finché il nome non è risolto (evita il flash del fallback).
  // Con studentId assente non si resta in caricamento: si mostra il saluto neutro.
  const nameLoading = !!studentId && !nameResolved;

  // ── «IL GRADO NON SI SA ANCORA», che non è «il grado è 0-6» ─────────────────
  //
  // `isPrimaria` da solo non distingue le due cose: `schoolType` vale `null`
  // tanto mentre la fetch di `useChildSchoolType` è in volo quanto per un
  // bambino di nido. Il segno che le separa è il `ready` che `useChildSchoolType`
  // ritorna accanto a `schoolType` (qui `gradoLetto`) — la home lo scartava con
  // una destrutturazione parziale.
  //
  // ⚠️ DUE CONDIZIONI, E NESSUNA DELLE DUE È ORNAMENTALE.
  //
  // `!ready` è il fotogramma 1 VERO, ed è la parte che mancava. `useParentIdentity`
  // inizializza `studentId` da `searchParams.get('id')` e lo risolve solo dentro
  // un `useEffect` che aspetta `/api/parent/students`: al mount `studentId` è
  // `null` ogni volta che si arriva su `/parent` senza `?id=`, cioè dalla tab
  // Home della bottom-nav (`BottomNav`, `mainTabs`, id `home`, href `/parent`
  // nudo) e a ogni avvio a freddo — non è un caso limite, è la strada larga. Col
  // solo `!!studentId` questa riga era falsa proprio nel fotogramma che doveva
  // coprire: la colonna in più veniva riservata un fotogramma TROPPO TARDI, e
  // per il 0-6 la riga faceva `4 → 5 → 4`, due assestamenti dove ne bastava zero.
  //
  // `!!studentId` è ciò che impedisce che la riserva diventi permanente:
  // `useChildSchoolType` esce dall'effetto PRIMA di `setReady(true)` quando manca
  // `studentId`, quindi per un account senza figli visibili `gradoLetto` resta
  // `false` per tutta la vita della pagina. Il `return` anticipato qui sopra
  // (`ready && inAttesa`) NON lo copre: `inAttesa` è
  // `figli.length === 0 && body.in_attesa === true` e resta `false` quando la
  // lettura dei figli fallisce, cioè offline a freddo — quell'account la home
  // intera la vede. È lo stesso motivo — e la stessa forma — di `nameLoading`.
  //
  // In `||` e non in `&&` perché i due casi sono consecutivi, non simultanei:
  // `!ready` copre prima che si sappia se un figlio c'è, `!!studentId` dopo.
  //
  // ⚠️ Dal 2026-09-19 `gradoLetto` può essere vero SENZA che la rete abbia
  // risposto: `useChildSchoolType` semina il grado dalla memoria del dispositivo
  // (`kv_grado_<figlio>`, una voce per figlio). Le due condizioni qui sopra non
  // cambiano — cambia quanto dura il fotogramma che coprono, e il conto sta
  // nella tabella più sotto.
  const gradoIgnoto = (!ready || !!studentId) && !gradoLetto;

  // Azioni rapide (DR QuickActions): solo navigazione verso pagine reali.
  // "Segnala assenza" porta alla pagina assenze (dove vive il submit reale).
  const wi = (href: string) => withIdentity(href, parentId, studentId);
  const quickActions: QuickAction[] = [
    {
      id: 'absence',
      label: t('azioneAssenza'),
      icon: CalendarX2,
      href: wi(isPrimaria ? '/parent/primaria/assenze' : '/parent/attendance'),
      bg: 'bg-kidville-error-soft',
      fg: 'text-kidville-error',
    },
    { id: 'chat', label: t('azioneChat'), icon: MessageCircle, href: wi('/parent/chat'), bg: 'bg-kidville-green-soft', fg: 'text-kidville-green' },
    { id: 'foto', label: t('azioneFoto'), icon: Camera, href: wi('/parent/gallery'), bg: 'bg-kidville-yellow-soft', fg: 'text-kidville-yellow-dark' },
    // Il diario giornaliero è solo nido/infanzia: per la primaria l'azione
    // diventa l'area Scuola (lezioni, compiti, voti), senza la parola "Diario".
    isPrimaria
      ? { id: 'scuola', label: t('azioneScuola'), icon: GraduationCap, href: wi('/parent/primaria'), bg: 'bg-kidville-success-soft', fg: 'text-kidville-success' }
      : { id: 'diario', label: t('azioneDiario'), icon: BookOpen, href: wi('/parent/diary'), bg: 'bg-kidville-success-soft', fg: 'text-kidville-success' },
    // ── «COMPITI», E SOLO PER LA PRIMARIA ──────────────────────────────────
    // Un bambino di nido o infanzia non ha compiti per casa: la scorciatoia
    // passa dallo STESSO `isPrimaria` che decide «Scuola primaria» invece di
    // «Diario di oggi», e non da un secondo meccanismo di grado — due criteri
    // che devono restare d'accordo sono un criterio che prima o poi non lo è.
    // L'ICONA è la stessa della voce di menu (`BottomNav`, id `compiti`):
    // `ClipboardList`. I TOKEN sono quelli canonici della funzione «compiti»
    // (`TINTA_FUNZIONE.compiti` = `#E6720A` = `--color-kidville-warn`), quindi
    // la coppia `warn-soft`/`warn`, la stessa dell'hub «Scuola».
    //
    // ⚠️ Il colore RESO qui non è però `#E6720A` ma `warn-strong` (`#A64F09`):
    // `globals.css:1121` ridipinge `.text-kidville-warn` — e ogni inchiostro di
    // stato sulle fasce chiare — con la variante «strong», perché `#E6720A` su
    // `warn-soft` sta sotto i 4,5:1 di WCAG AA. Nel menu la stessa tinta arriva
    // come stile INLINE (`style={{ color: it.tint }}`), che la regola CSS non
    // aggancia: lì resta `#E6720A`. La divergenza è deliberata: è il prezzo del
    // contrasto, non una svista da allineare.
    //
    // La voce «Note» usa la STESSA coppia Tailwind e subisce lo STESSO remap, ma
    // la sua divergenza non è la stessa: la sua tinta canonica è
    // `TINTA_FUNZIONE.note` = `#B5651D` (`kv-subj-storia`), non `#E6720A`. Quindi
    // «Compiti» va `#E6720A` → `#A64F09` e «Note» `#B5651D` → `#A64F09`: stessa
    // destinazione, due partenze.
    //
    // L'ETICHETTA sta in `home` e non in `parentPrimaria`: in home le cinque
    // scorciatoie sono scritte su DUE righe (`\n` + `whitespace-pre-line`, vedi
    // sotto), nell'hub la voce è una riga sola. Sono due testi con due
    // tipografie, non una stringa duplicata; il lock in
    // `__tests__/pages/parent-primaria-hub.test.tsx` pretende l'a-capo su tutte
    // e cinque, così la convenzione non dipende da chi se la ricorda.
    ...(isPrimaria
      ? [{
          id: 'compiti',
          label: t('azioneCompiti'),
          icon: ClipboardList,
          href: wi('/parent/compiti'),
          bg: 'bg-kidville-warn-soft',
          fg: 'text-kidville-warn',
        } as QuickAction]
      : []),
  ];

  // ── LE COLONNE DELLA RIGA, E CHI PAGA L'ASSESTAMENTO CHE RESTA ─────────────
  //
  // La griglia segue il NUMERO di scorciatoie: con le cinque della primaria una
  // riga da quattro manderebbe l'ultima a capo da sola. Entrambe le classi sono
  // scritte per esteso perché il generatore di Tailwind legge stringhe letterali
  // e una classe composta (`grid-cols-${n}`) non verrebbe mai emessa.
  //
  // `|| gradoIgnoto`: finché il grado non si sa, la quinta colonna è riservata e
  // resta vuota. Con `gradoIgnoto` scritto come sopra la riserva parte dal PRIMO
  // fotogramma; col solo `!!studentId` partiva dal secondo, e quel fotogramma in
  // più era un assestamento in più — per tutti e due i rami.
  //
  // ⚠️ L'ASSESTAMENTO CHE RESTA, E CHI LO PAGA. Contato per ramo, dal mount al
  // regime, e confrontato con lo stato PRECEDENTE di ciascun ramo e non solo con
  // l'ipotesi «cinque colonne fisse per tutti». Dal 2026-09-19
  // `useChildSchoolType` RICORDA il grado sul dispositivo (`kv_grado_<figlio>` in
  // `localStorage`, una voce per figlio), quindi le righe sono diventate due:
  //
  //                     prima apertura        aperture successive   prima della corsia
  //     primaria        5 → 5 → 5 (zero)      5 → 5 (zero)          4 fisso   (nessuno)
  //     nido/infanzia   5 → 5 → 4 (uno)       5 → 4 (uno)           4 fisso   (nessuno)
  //
  // L'ultima colonna è lo stato del ramo PRIMA di tutto questo lavoro, ed è lo
  // stesso per entrambi: su `HEAD` le scorciatoie erano QUATTRO (nessun
  // «Compiti») e la riga era il letterale `grid-cols-4`, invariante — zero
  // assestamenti di colonna, per la primaria come per il 0-6.
  //
  // ⚠️ Qui c'era «(prima della corsia: 4 → 5, uno)» sulla primaria, ed era FALSO:
  // quel `4 → 5` è lo stato INTERMEDIO di questa corsia — la quinta card già
  // aggiunta e la riserva non ancora scritta — non lo stato di partenza. Le due
  // righe usavano due basi diverse, e da lì nasceva una seconda frase falsa:
  // «l'assestamento è stato SPOSTATO dalla primaria al 0-6». Non è stato
  // spostato. Sul **0-6**, che è la maggioranza delle famiglie, ne abbiamo
  // INTRODOTTO uno dove non ce n'era nessuno — è il prezzo della scorciatoia
  // aggiunta per la primaria; sulla **primaria** ne abbiamo EVITATO uno che
  // sarebbe nato per causa nostra. Chi paga è il 0-6, e non in cambio di niente
  // che avesse prima.
  //
  // Le due colonne contano lo stesso numero di assestamenti, e il conto da solo
  // non dice la cosa che conta: a cambiare è QUANDO. Senza memoria il 0-6 si
  // assesta alla risposta di `/api/parent/primaria`, cioè dopo DUE giri di rete,
  // col dito già sullo schermo; con la memoria calda si assesta all'HYDRATION,
  // senza aver chiesto niente a nessuno. Il lampo resta, ma smette di aspettare
  // la rete.
  //
  // PERCHÉ NON ARRIVA A ZERO, detto invece che lasciato sperare: il primo render
  // lo fa il SERVER (il layout radice fa `await cookies()`, quindi ogni rotta è
  // dinamica) e il server non può leggere il `localStorage` di quel telefono —
  // seminare il grado durante il render sarebbe un mismatch di hydration. Per
  // togliere anche quel fotogramma il grado dovrebbe arrivare al server (un
  // cookie) o la riga non dovrebbe rendersi prima di saperlo: due lavori diversi
  // da questo, e nessuno dei due sta in questo file.
  //
  // Il verso, quando l'assestamento c'è, resta quello scelto: da cinque a quattro
  // le stesse quattro card si ALLARGANO nello spazio già riservato, nello stesso
  // ordine e senza che ne compaia una nuova; nell'altro verso *appare* un
  // bersaglio in mezzo a quelli che il dito stava già mirando, ed è quella la
  // forma che fa aprire la pagina sbagliata.
  //
  // ⚠️ «Diverso» non vuol dire «innocuo», e non va raccontato come tale: con
  // quattro card il centro della quarta passa da ~0,70 a ~0,875 della larghezza,
  // quindi un dito puntato sul vecchio centro atterra DENTRO la terza card.
  //
  // L'ALTRA alternativa — cinque colonne fisse per tutti — non è la stessa cosa:
  // lascerebbe al 0-6 un buco permanente in fondo alla riga a ogni apertura della
  // home, un difetto che dura per sempre al posto di uno che dura una fetch.
  const colonneAzioni = quickActions.length > 4 || gradoIgnoto ? 'grid-cols-5' : 'grid-cols-4';

  return (
    <div className="min-h-screen bg-kidville-cream pb-[100px]">

      {/* ── HERO (DR warm) — wordmark/campanella nella AppBar ───────── */}
      <div className="px-4 pt-5">
        <HeroCard
          title={firstName ? t('heroCiaoNome', { nome: firstName }) : t('heroCiao')}
          loading={nameLoading}
          subtitle={firstName ? t('heroSottotitolo') : undefined}
        />
      </div>

      {/* ── BANNER SOSPENSIONE (solo se la famiglia è sospesa) ─────── */}
      {parentId && <SospensioneBanner userId={parentId} className="px-4 pt-4" />}

      {/* ── QUICK ACTIONS ──────────────────────────── */}
      <div className={`grid ${colonneAzioni} gap-[9px] px-4 pt-4`}>
        {quickActions.map((a) => {
          const Icon = a.icon;
          return (
            <Link
              key={a.id}
              href={a.href}
              className="flex flex-col items-center gap-[7px] rounded-[18px] bg-white px-1 py-3 active:scale-95"
              style={{ boxShadow: '0 4px 12px -8px rgba(0,0,0,0.18)' }}
            >
              <span className={`flex h-[42px] w-[42px] items-center justify-center rounded-[14px] ${a.bg} ${a.fg}`}>
                <Icon size={21} strokeWidth={1.9} />
              </span>
              <span className="whitespace-pre-line text-center font-barlow text-[11.5px] font-bold uppercase leading-[1.05] tracking-[0.02em] text-kidville-green">
                {a.label}
              </span>
            </Link>
          );
        })}
      </div>

      {/* ── PRESENZE OGGI (badge "A scuola" reale) ── */}
      {parentId && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader
            eyebrow={t('eyebrowPresenze')}
            title={t('titoloOggiAScuola')}
            actionLabel={t('azioneStorico')}
            actionHref={wi(isPrimaria ? '/parent/primaria/assenze' : '/parent/attendance')}
          />
          <PresenzeTodayCard studentId={studentId} parentId={parentId} />
        </div>
      )}

      {/* ── RIEPILOGO PAGAMENTI ───────────────────── */}
      {parentId && (
        <div className="pt-4">
          <PagamentiSummary userId={parentId} href={wi('/parent/pagamenti')} />
        </div>
      )}

      {/* ── DIARIO OGGI (solo infanzia) ───────────── */}
      {!isPrimaria && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow={t('eyebrowDiario')} title={firstName ? t('diarioGiornataDi', { nome: firstName }) : t('diarioTitolo')} />
          <DiaryTodayCard studentId={studentId} href={wi('/parent/diary')} />
        </div>
      )}

      {/* ── AVVISI (top 2, sola lettura) ──────────── */}
      {parentId && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow={t('eyebrowComunicazioni')} title={t('titoloAvvisi')} actionLabel={t('azioneTutti')} actionHref={wi('/parent/avvisi')} />
          <AvvisiPreview parentId={parentId} studentId={studentId} />
        </div>
      )}

      {/* ── NEWS (top 3, sola lettura; si nasconde se vuoto) ── */}
      {parentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow={t('eyebrowComunicazioni')} title={t('titoloNews')} actionLabel={t('azioneTutte')} actionHref={wi('/parent/news')} />
          <NewsPreview parentId={parentId} studentId={studentId} />
        </div>
      )}

      {/* ── GALLERIA OGGI ─────────────────────────── */}
      {parentId && studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow={t('eyebrowGalleria')} title={t('titoloFotoDiOggi')} actionLabel={t('azioneTutte')} actionHref={wi('/parent/gallery')} />
          <GalleryTodayCard studentId={studentId} parentId={parentId} href={wi('/parent/gallery')} />
        </div>
      )}

      {/* ── ARMADIETTO · SCORTE (teaser DR) ───────── */}
      {studentId && (
        <div className="px-4 pt-5">
          <SectionHeader eyebrow={t('eyebrowArmadietto')} title={t('titoloScorte')} actionLabel={t('azioneGestisci')} actionHref={wi('/parent/locker')} />
          <LockerTodayCard studentId={studentId} classeSezione={classeSezione} />
        </div>
      )}

      {/* ── CALENDARIO · AGENDA (eventi_agenda M6) ── */}
      <div className="px-4 pt-5">
        <SectionHeader eyebrow={t('eyebrowCalendario')} title={t('titoloProssimiAppuntamenti')} />
        <AgendaTodayCard studentId={studentId} />
      </div>

      {/* ── NOTA / FOOTER ─────────────────────────── */}
      <p className="px-4 pt-6 text-center font-maven text-[11px] text-kidville-muted">
        {t('footerRetention')}
      </p>
    </div>
  );
}

export default function ParentHomePage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-[60vh] bg-kidville-cream">
        <div className="w-8 h-8 border-[3px] border-kidville-green/20 border-t-kidville-green rounded-full animate-spin" />
      </div>
    }>
      <ParentHomeContent />
    </Suspense>
  );
}
