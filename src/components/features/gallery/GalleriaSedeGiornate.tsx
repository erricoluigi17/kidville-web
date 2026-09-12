'use client';

import { useMemo, useState } from 'react';
import { useLocale } from 'next-intl';
import { dataCivile, formattaIstante } from '@/i18n/config';
import { conIniziale } from '@/lib/i18n/date';
import { MediaGrid, type MediaItem, type Student } from '@/components/features/gallery/MediaGrid';

/* ════════════════════════════════════════════════════════════════════════════
 * LE FOTO DI UN PLESSO, DIVISE PER GIORNATA.
 *
 * ─── PERCHÉ UN MODULO E NON DUE `map` DENTRO LA PAGINA ──────────────────────
 * Perché il raggruppamento è l'unico pezzo di questa schermata che può SBAGLIARE
 * in silenzio: una foto sotto l'intestazione del giorno prima non è un errore,
 * è una schermata che si legge benissimo e dice una cosa falsa. Qui è una
 * funzione pura, quindi si prova senza montare niente — e la prova sta in
 * `__tests__/pages/galleria-sede-pagina.test.tsx`.
 *
 * ─── ⚠️ IL GIORNO È QUELLO ITALIANO, NON QUELLO DI GREENWICH ────────────────
 * `created_at.slice(0, 10)` è la forma ovvia e sbagliata: taglia l'ISO, che è in
 * UTC. Una foto scattata all'una di notte del 6 settembre a Giugliano vale
 * `2026-09-05T23:00:00Z`, e quel taglio la mette sotto «5 settembre». Fra le
 * 00:00 e le 02:00 italiane server e utente stanno in due giorni diversi: è la
 * stessa radice per cui un incasso vero è sparito da un KPI il 2026-08-01 alle
 * 01:08 (vedi `dataCivile` in `src/i18n/config.ts`, che è la funzione da usare).
 *
 * ⚠️ E IL FILTRO PER DATA DELLA ROTTA RAGIONA IN UTC (`?date=YYYY-MM-DD` diventa
 * `…T00:00:00.000Z` … `…T23:59:59.999Z` in `src/app/api/gallery/route.ts`).
 * Quindi filtrando un giorno si possono vedere DUE intestazioni: quella del
 * giorno chiesto e le due ore di coda che in Italia appartengono al giorno dopo.
 * È voluto e non si nasconde: l'intestazione dice la verità su QUANDO la foto è
 * stata scattata, che è ciò che la segreteria deve poter riferire a una
 * famiglia. Il contrario — un'intestazione allineata al filtro — sarebbe una
 * data sbagliata scritta grande.
 *
 * ─── I NOMI DEI BAMBINI RESTANO A SCHERMO ───────────────────────────────────
 * `alunni_taggati` arriva dalla rotta già ristretto al plesso
 * (`alunniTaggatiDellaSede`): qui non si aggiunge nessun dato, si dispone. E non
 * si logga niente da questo file — sono anagrafiche di minori, e la redazione è
 * a lista bianca. Il conteggio per il log lo calcola `contaTagSenzaNome`, che è
 * una funzione pura: a scrivere la riga è la PAGINA, che sa qual è la rotta.
 *
 * ⚠️ `alunni_taggati` NON È IN CORRISPONDENZA 1:1 CON `tag_students`, e darlo per
 * scontato costerebbe la stessa cosa che è già costata il 2026-09-02. La rotta
 * dichiara due casi in cui l'elenco dei NOMI è più corto di quello degli UUID:
 *   · un tag che punta a un bambino di un ALTRO plesso non torna indietro (per
 *     progetto: `alunniTaggatiDellaSede` filtra `.in('scuola_id', plessi)` e
 *     lascia un `warn` `vista-sede-tag-fuori-sede`);
 *   · se l'anagrafica non è leggibile — sul DB E2E della CI `alunni.scuola_id`
 *     può non esistere (`42703`) — le foto escono lo stesso con
 *     `alunni_taggati: []` e un `warn` `vista-sede-nomi-non-letti`.
 * In entrambi `[]` significa «di questi bambini non ho il nome», MAI «in questa
 * foto non c'è nessun bambino». `MediaGrid` però le due cose le renderebbe
 * identiche: il pannello dei taggati esiste solo `if (students.length > 0)`, e
 * dentro fa `students.find(id)` con un `if (!student) return null` che scarta in
 * SILENZIO. Elenco vuoto ⇒ nessun pannello; elenco parziale ⇒ un pannello che
 * dichiara due bambini su tre — e le parziali sono peggio delle vuote, perché
 * nessuno le mette in dubbio.
 * Perciò ogni uuid taggato senza nome entra lo stesso in elenco, con un
 * SEGNAPOSTO: il conteggio a schermo torna, e l'uuid — che è pur sempre
 * l'identificativo di un minore — non compare mai.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Un bambino taggato, come lo manda `GET /api/gallery?scope=sede` (`alunni_taggati`). */
export interface AlunnoTaggato {
    id: string;
    /** Nome e cognome, già uniti dal server. Mai nei log. */
    nome: string;
    /** `alunni.classe_sezione`. `null` se il bambino non è agganciato a una sezione. */
    classe: string | null;
}

/** Una foto della vista di sede: quello che `MediaGrid` legge, più i taggati. */
export interface FotoSede extends MediaItem {
    alunni_taggati?: AlunnoTaggato[] | null;
    /**
     * Quando la foto e stata messa nel cestino. La manda `GET /api/gallery?scope=sede`
     * SOLO nel ramo `stato=cestino`: nella vista normale e assente, e deve restarlo —
     * una foto viva non ha una data di eliminazione, e un campo sempre presente
     * inviterebbe a leggerlo dove non significa niente.
     */
    eliminato_il?: string | null;
}

/** Le foto di una giornata, dalla più recente. */
export interface Giornata {
    /**
     * `YYYY-MM-DD` nel fuso dell'istituto (`Europe/Rome`), oppure `null` quando
     * `created_at` non è leggibile: una riga senza data non si butta via — si
     * mostra in fondo, sotto la sua intestazione, perché una foto che sparisce è
     * peggio di una foto senza giorno.
     */
    giorno: string | null;
    foto: FotoSede[];
}

/**
 * Il giorno CIVILE ITALIANO di un istante, o `null` se l'istante non si legge.
 *
 * La guardia su `Number.isNaN` non è difensivismo: `dataCivile` chiama
 * `Intl.DateTimeFormat.format`, che su una data non valida **lancia**
 * (`RangeError: Invalid time value`) invece di stampare «Invalid Date». Un
 * `created_at` malformato farebbe cadere l'intera schermata della segreteria.
 */
export function giornoCivileDi(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const istante = new Date(iso);
    if (Number.isNaN(istante.getTime())) return null;
    return dataCivile(istante);
}

/** L'istante in millisecondi, o `null` se non si legge: serve all'ordinamento. */
function istanteDi(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? null : ms;
}

/**
 * Divide le foto per giornata italiana, dalla più recente.
 *
 * L'ordine NON si eredita dalla rotta. La rotta ordina già per `created_at`
 * discendente, ma appoggiarsi a quell'ordine significherebbe che il giorno in cui
 * qualcuno cambia l'`.order()` del server questa schermata mostra le giornate in
 * disordine **senza nessun errore**: un invariante che vale «per costruzione»
 * è un invariante che il giorno in cui la costruzione cambia non c'è più.
 *
 * Le righe senza data leggibile finiscono in un gruppo `giorno: null`, sempre in
 * coda.
 */
export function raggruppaPerGiornata(foto: readonly FotoSede[]): Giornata[] {
    const perGiorno = new Map<string, FotoSede[]>();
    const senzaData: FotoSede[] = [];

    for (const f of foto) {
        const giorno = giornoCivileDi(f.created_at);
        if (giorno === null) {
            senzaData.push(f);
            continue;
        }
        const gruppo = perGiorno.get(giorno);
        if (gruppo) gruppo.push(f);
        else perGiorno.set(giorno, [f]);
    }

    // `YYYY-MM-DD` si confronta come stringa: è il formato del database e
    // l'ordine lessicografico coincide con quello cronologico.
    const giornate: Giornata[] = [...perGiorno.entries()]
        .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
        .map(([giorno, righe]) => ({
            giorno,
            foto: [...righe].sort((x, y) => (istanteDi(y.created_at) ?? 0) - (istanteDi(x.created_at) ?? 0)),
        }));

    if (senzaData.length > 0) giornate.push({ giorno: null, foto: senzaData });
    return giornate;
}

/** Gli uuid taggati in una foto, scartando ciò che non è una stringa. */
function tagDi(f: FotoSede): string[] {
    return Array.isArray(f.tag_students) ? f.tag_students.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Il nome scrivibile di un bambino taggato, oppure `null` se non ce n'è uno.
 *
 * `null` anche per il nome VUOTO, e non è pignoleria: la rotta compone
 * `` `${nome ?? ''} ${cognome ?? ''}`.trim() ``, quindi un'anagrafica con
 * entrambi i campi nulli arriva qui come stringa vuota — non come campo
 * mancante. Senza questo controllo quel bambino uscirebbe con un chip vuoto (o
 * con un solo « — GIRASOLI ») e verrebbe contato fra quelli col nome: la
 * schermata direbbe di sapere una cosa che non sa, e il log tacerebbe.
 *
 * Le due funzioni qui sotto passano di qui entrambe, così «avere un nome» resta
 * UNA definizione sola: se divergessero, il conteggio del log e ciò che si vede
 * a schermo racconterebbero due storie diverse dello stesso dato.
 */
function nomeUtile(a: AlunnoTaggato | null | undefined): string | null {
    if (!a || typeof a.id !== 'string') return null;
    const nome = typeof a.nome === 'string' ? a.nome.trim() : '';
    return nome === '' ? null : nome;
}

/**
 * Quanti bambini taggati ci sono in queste foto, e di quanti manca il nome.
 *
 * Pura, e separata da `alunniDellaPagina`, perché serve a un'altra cosa: la
 * riga di log della pagina. Un elenco di nomi più corto di quello degli uuid è
 * un'ANOMALIA — o un tag fuori sede, o l'anagrafica illeggibile — e senza una
 * riga che lo dica resterebbe il solito silenzio: a schermo il segnaposto si
 * vede, ma nessuno di noi guarda lo schermo della segreteria.
 *
 * Restituisce solo NUMERI, ed è voluto: chi la chiama non deve nemmeno avere la
 * tentazione di scrivere un uuid di minore dentro un messaggio di log.
 */
export function contaTagSenzaNome(foto: readonly FotoSede[]): { taggati: number; senzaNome: number } {
    const conNome = new Set<string>();
    const taggati = new Set<string>();
    for (const f of foto) {
        for (const a of f.alunni_taggati ?? []) {
            if (nomeUtile(a) !== null) conNome.add(a.id);
        }
        for (const id of tagDi(f)) taggati.add(id);
    }
    let senzaNome = 0;
    for (const id of taggati) if (!conNome.has(id)) senzaNome += 1;
    return { taggati: taggati.size, senzaNome };
}

/**
 * I bambini taggati in un insieme di foto, senza doppioni.
 *
 * Serve alla prop `students` di `MediaGrid`, che nel visore mostra i nomi al
 * posto degli uuid. Senza `onUpdateTags` quel pannello è di sola LETTURA: la
 * segreteria vede chi è ritratto, non può ritaggare da qui (i tag restano alla
 * maestra che ha pubblicato la foto).
 *
 * ⚠️ La classe finisce dentro `nome` e non in `cognome`, e va detto: `MediaGrid`
 * rende `{student.nome} {student.cognome}`, e il server manda nome e cognome già
 * UNITI in un campo solo (`alunni_taggati[].nome`) — non c'è modo affidabile di
 * risepararli. Mettere la classe in `cognome` la farebbe leggere come parte del
 * cognome di un bambino; unita con un trattino si legge per quello che è.
 *
 * ⚠️ DUE PASSAGGI, E L'ORDINE CONTA. Prima i bambini di cui il server ha mandato
 * il nome, poi i tag rimasti senza: così un nome vero non può essere coperto da
 * un segnaposto. Il perché dei segnaposto sta in testa al file — in breve: senza,
 * una foto che tagga tre bambini e di cui il server sa un nome solo la si legge
 * come una foto con un bambino, senza nessun errore.
 *
 * `etichettaSenzaNome` arriva dalla pagina perché qui dentro non c'è nessun
 * catalogo (vedi `TestiGiornate`): l'uuid a schermo non ci va MAI, nemmeno come
 * ripiego.
 */
export function alunniDellaPagina(foto: readonly FotoSede[], etichettaSenzaNome: string): Student[] {
    const perId = new Map<string, Student>();
    for (const f of foto) {
        for (const a of f.alunni_taggati ?? []) {
            const nome = nomeUtile(a);
            if (nome === null || perId.has(a.id)) continue;
            perId.set(a.id, {
                id: a.id,
                nome: a.classe ? `${nome} — ${a.classe}` : nome,
                cognome: '',
            });
        }
    }
    for (const f of foto) {
        for (const id of tagDi(f)) {
            if (perId.has(id)) continue;
            perId.set(id, { id, nome: etichettaSenzaNome, cognome: '' });
        }
    }
    return [...perId.values()];
}

/** I testi che questo componente non può risolvere da sé (nessun catalogo qui dentro). */
export interface TestiGiornate {
    /** L'intestazione del gruppo delle righe senza una data leggibile. */
    senzaData: string;
    /** «3 foto»: è una FUNZIONE perché il plurale lo decide il catalogo in ICU. */
    conteggio: (n: number) => string;
    /**
     * Il segnaposto di un bambino taggato di cui la rotta non ha mandato il nome
     * (tag fuori sede, oppure anagrafica illeggibile — vedi in testa al file).
     * Al suo posto NON si scrive l'uuid: è l'identificativo di un minore.
     */
    taggatoSenzaNome: string;
}

interface Props {
    foto: readonly FotoSede[];
    testi: TestiGiornate;
    /**
     * L'eliminazione, quando chi guarda puo farla. Assente = nessun comando, ed e
     * cosi che il genitore non lo vede: il predicato vive in `MediaGrid`, qui si
     * inoltra e basta. **Rigetta** con un `Error` dal `.message` gia tradotto.
     */
    onDelete?: (id: string) => Promise<void>;
    /**
     * IL RIPRISTINO, E LA SUA PRESENZA DECIDE LA VISTA.
     *
     * Quando c'e, questo componente rende la griglia del CESTINO invece di
     * `MediaGrid`. Non e una scorciatoia: il cestino e una vista amministrativa,
     * non una galleria da sfogliare. Il visore di `MediaGrid` porta le frecce, la
     * navigazione con la tastiera, i tag, lo scarico e la condivisione — tutte cose
     * che su una foto eliminata non hanno senso o sono da evitare, e la prima
     * (scaricare una foto che si e deciso di rimuovere) sarebbe un difetto.
     * Qui servono tre cose sole: vedere cos'e, quanto le resta, e ripescarla.
     */
    onRipristina?: (id: string) => Promise<void>;
    /** I testi del cestino. Obbligatori quando `onRipristina` c'e. */
    testiCestino?: TestiCestino;
    /**
     * I giorni di custodia del cestino, dal chiamante.
     *
     * ⚠️ NON si importa `GIORNI_CESTINO_GALLERIA` da `@/lib/gallery/cestino`: quel
     * modulo importa `logEvento` da `@/lib/logging/logger`, che e il logger del
     * SERVER, e tirarlo dentro un componente client lo impacchetterebbe nel bundle
     * del browser. Il numero arriva quindi per prop da un punto solo del client, e
     * il lock `__tests__/architecture/cestino-giorni-un-numero-solo.test.ts` verifica
     * che quel punto e la costante vera non divergano.
     */
    giorniTotali?: number;
}

/** Le parole del cestino: il chiamante le prende dal catalogo, questo file non traduce. */
export interface TestiCestino {
    /** «Eliminata il {data}» — la data arriva gia formattata. */
    eliminataIl: (data: string) => string;
    /** «resta 1 giorno» / «resta N giorni» / «scade oggi»: il plurale lo fa il catalogo. */
    restanoGiorni: (n: number) => string;
    ripristina: string;
    ripristinaInCorso: string;
    /** L'anteprima non si puo mostrare (link scaduto o file gia rimosso). */
    anteprimaNonDisponibile: string;
}

/**
 * L'elenco delle giornate, ognuna con la sua intestazione e la sua griglia.
 *
 * Una `MediaGrid` PER GIORNATA e non una sola: il visore naviga con le frecce
 * dentro l'elenco che riceve, e una griglia unica farebbe scorrere il 5 settembre
 * dentro il 4 senza che l'intestazione lo dica.
 */
export function GalleriaSedeGiornate({ foto, testi, onDelete, onRipristina, testiCestino, giorniTotali = 30 }: Props) {
    const locale = useLocale();
    const giornate = useMemo(() => raggruppaPerGiornata(foto), [foto]);

    return (
        <div className="flex flex-col gap-8">
            {giornate.map((g) => {
                // `formattaIstante` e non `intlDateTime(...).format(...)`: la
                // seconda LANCIA su una data non valida (vedi `@/i18n/config`),
                // e una giornata malformata non può portarsi via la pagina.
                // Mezzogiorno: qualunque fuso, il giorno resta quello.
                const intestazione =
                    g.giorno === null
                        ? testi.senzaData
                        : conIniziale(
                              formattaIstante(`${g.giorno}T12:00:00Z`, locale, {
                                  weekday: 'long',
                                  day: 'numeric',
                                  month: 'long',
                                  year: 'numeric',
                              }),
                          );
                return (
                    <section key={g.giorno ?? 'senza-data'} aria-label={intestazione}>
                        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-kidville-line pb-2">
                            <h2 className="font-barlow text-[17px] font-extrabold uppercase tracking-[0.01em] text-kidville-green">
                                {intestazione}
                            </h2>
                            <span className="font-maven text-[12.5px] text-kidville-sub">
                                {testi.conteggio(g.foto.length)}
                            </span>
                        </div>
                        {/*
                          QUATTRO COLONNE, DICHIARATE. `MediaGrid` ha il default a 2 — il caso
                          stretto, quello del genitore su telefono — e qui il contenitore è la
                          pagina della segreteria, larga ~1088 px senza `max-w` restrittivo: a due
                          colonne le miniature misurerebbero ~530 px l'una. Fino al 2026-09-11 il
                          numero veniva da `sm:grid-cols-3`, cioè dal VIEWPORT, che di questo
                          contenitore non sa niente.
                        */}
                        {onRipristina && testiCestino ? (
                            <GrigliaCestino
                                foto={g.foto}
                                onRipristina={onRipristina}
                                testi={testiCestino}
                                locale={locale}
                                giorniTotali={giorniTotali}
                            />
                        ) : (
                            <MediaGrid
                                items={g.foto}
                                students={alunniDellaPagina(g.foto, testi.taggatoSenzaNome)}
                                colonne={4}
                                onDelete={onDelete}
                            />
                        )}
                    </section>
                );
            })}
        </div>
    );
}

/* ════════════════════════════════════════════════════════════════════════════
 * LA GRIGLIA DEL CESTINO — tre cose sole, e nessuna di piu
 *
 * Vedi la prop `onRipristina` sopra per il perche non si riusa `MediaGrid`. In una
 * riga: su una foto che si e deciso di rimuovere, «Scarica» e «Condividi» non sono
 * comandi mancanti, sono comandi da NON avere.
 *
 * Quello che serve qui e: capire QUALE foto e, sapere QUANTO le resta, e poterla
 * ripescare. L'anteprima resta piccola e non si apre: il cestino e una lista di
 * cose da decidere, non un album.
 * ══════════════════════════════════════════════════════════════════════════ */

function giorniRimanenti(eliminatoIl: string | null | undefined, giorniTotali: number): number | null {
    if (!eliminatoIl) return null
    const t = Date.parse(eliminatoIl)
    if (Number.isNaN(t)) return null
    // Si arrotonda per ECCESSO: a 29,2 giorni trascorsi resta «1 giorno», non «0».
    // Un «0» direbbe «scaduta» a una foto che la purga non ha ancora guardato, e chi
    // legge rinuncerebbe a ripristinarla credendo di essere in ritardo.
    const trascorsiMs = Date.now() - t
    const rimastiMs = giorniTotali * 24 * 60 * 60 * 1000 - trascorsiMs
    return Math.max(0, Math.ceil(rimastiMs / (24 * 60 * 60 * 1000)))
}

function GrigliaCestino({
    foto,
    onRipristina,
    testi,
    locale,
    giorniTotali,
}: {
    foto: readonly FotoSede[]
    onRipristina: (id: string) => Promise<void>
    testi: TestiCestino
    locale: string
    giorniTotali: number
}) {
    // Lo stato e PER FOTO e non globale: due membri della segreteria che ripristinano
    // due foto diverse non devono vedere lo spinner l'uno sull'altra, e un errore su
    // una non deve cancellare il messaggio dell'altra.
    const [inCorso, setInCorso] = useState<string | null>(null)
    const [errori, setErrori] = useState<Record<string, string>>({})

    async function ripristina(id: string): Promise<void> {
        if (inCorso !== null) return
        setInCorso(id)
        setErrori((p) => {
            const q = { ...p }
            delete q[id]
            return q
        })
        try {
            await onRipristina(id)
            // Riuscito: non si tocca niente qui. L'elenco lo ricarica il chiamante
            // dentro la risoluzione della propria `onRipristina` — questo componente
            // non sa che cosa sia «l'elenco», ed e la stessa divisione di
            // `DialogoEliminaMedia`.
        } catch (e) {
            // Il messaggio arriva GIA TRADOTTO dal chiamante (`messaggioErrore`): qui
            // non si traduce e non si inventa. Un catch che non mostra niente
            // lascerebbe il bottone fermo senza dire perche.
            setErrori((p) => ({ ...p, [id]: e instanceof Error && e.message ? e.message : testi.ripristina }))
        } finally {
            setInCorso(null)
        }
    }

    return (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {foto.map((f) => {
                const resta = giorniRimanenti(f.eliminato_il, giorniTotali)
                const quando =
                    f.eliminato_il != null
                        ? formattaIstante(f.eliminato_il, locale, {
                              day: 'numeric',
                              month: 'long',
                              hour: '2-digit',
                              minute: '2-digit',
                          })
                        : null
                const errore = errori[f.id]
                return (
                    <li
                        key={f.id}
                        className="flex flex-col overflow-hidden rounded-2xl border border-kidville-line bg-white"
                    >
                        {/*
                          `bg-kidville-ink` sotto l'anteprima e non un grigio: una foto
                          verticale in un riquadro quadrato lascia due fasce, e su fondo
                          scuro si leggono come cornice invece che come vuoto.
                          `object-contain` e non `cover`: qui si deve CAPIRE quale foto
                          e, e un ritaglio puo togliere proprio il soggetto.
                        */}
                        <div className="relative aspect-square w-full bg-kidville-ink">
                            {f.file_url ? (
                                // eslint-disable-next-line @next/next/no-img-element -- il link e firmato e scade: `next/image` lo cacherebbe oltre la firma
                                <img
                                    src={f.file_url}
                                    alt=""
                                    className="h-full w-full object-contain opacity-60"
                                />
                            ) : (
                                <span className="absolute inset-0 flex items-center justify-center px-2 text-center font-maven text-[11.5px] text-white/80">
                                    {testi.anteprimaNonDisponibile}
                                </span>
                            )}
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
                            {quando !== null && (
                                <span className="truncate font-maven text-[12px] text-kidville-sub" title={quando}>
                                    {testi.eliminataIl(quando)}
                                </span>
                            )}
                            {resta !== null && (
                                <span className="font-maven text-[12px] font-semibold text-kidville-green">
                                    {testi.restanoGiorni(resta)}
                                </span>
                            )}
                            {errore != null && (
                                <span role="alert" className="font-maven text-[11.5px] text-kidville-error">
                                    {errore}
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={() => void ripristina(f.id)}
                                // `aria-disabled` e non `disabled`: `disabled` durante una
                                // richiesta manda il fuoco su `<body>`, cioe in cima al
                                // documento — la ragione sta in testa a `@/components/ui/Btn`.
                                // Il doppio invio lo ferma la guardia in `ripristina`.
                                aria-disabled={inCorso !== null}
                                className="mt-1 rounded-pill bg-kidville-green px-3 py-1.5 font-maven text-[12.5px] font-semibold text-kidville-yellow aria-disabled:opacity-60"
                            >
                                {inCorso === f.id ? testi.ripristinaInCorso : testi.ripristina}
                            </button>
                        </div>
                    </li>
                )
            })}
        </ul>
    )
}
