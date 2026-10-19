import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server-client';
import { requireDocente } from '@/lib/auth/require-staff';
import { requireParentOfStudent } from '@/lib/auth/require-parent';
import { resolveScuoleAttive } from '@/lib/auth/scope';
import { risolviSezione } from '@/lib/sezioni/risoluzione';
import { restringiASedeRichiesta } from '@/lib/auth/sede-richiesta';
import { getGenitoriDiAlunni, getGenitoriDiAlunno } from '@/lib/anagrafiche/legami';
import { parseQuery } from '@/lib/validation/http';
import { zUuid, zDataYMD } from '@/lib/validation/common';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { withRoute } from '@/lib/logging/with-route';
import { logEvento } from '@/lib/logging/logger';
import { guastoLetturaAccessoria } from '@/lib/db/guasto';
import { oggiRoma, puoCorreggereStorico } from '@/lib/storici/retroattivita';
import { appartenenzeNelGiorno } from '@/lib/storici/alunni-giorno';
import { rispostaErroreStorico } from '@/lib/storici/http';
import { leggiTutte } from '@/lib/storici/db';

// Singolo alunno per id.
const getByIdQuerySchema = z.object({
    id: zUuid,
});

// Lista per sezione: nessun default hardcoded — senza sezione/classeSezione la risposta
// degrada a [] ('' non matcha alcuna classe); date→oggi calcolata nel codice;
// onlyPresent resta stringa confrontata con 'true' (semantica attuale preservata).
const getBySezioneQuerySchema = z.object({
    sezione: z.string().optional(),
    classeSezione: z.string().optional(),
    // L'identità VERA della classe. `sezione`/`classeSezione` restano per
    // retrocompatibilità (la shell nativa in circolazione manda ancora il nome,
    // e un URL salvato deve continuare a funzionare) — ma entrambe le strade
    // finiscono sullo stesso filtro per uuid: la vecchia non è solo affiancata,
    // è stata resa corretta.
    sectionId: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
    onlyPresent: z.string().optional(),
    date: zDataYMD.optional(),
    // La sede scelta nel SedeSelector (R70): finora non viaggiava mai, e con tre
    // plessi il nome-classe da solo non dice più di quale sede si parli.
    scuola_id: z.preprocess((v) => (v === '' ? undefined : v), zUuid.optional()),
});

// GET /api/diary/students?sezione=<classe>                    → lista classe (tutti)
// GET /api/diary/students?sezione=<classe>&onlyPresent=true   → solo presenti oggi
// GET /api/diary/students?classeSezione=3A&onlyPresent=true&date=2026-05-17
// GET /api/diary/students?id=uuid                             → singolo alunno
export const GET = withRoute('diary/students:GET', async (request: NextRequest) => {
    const supabase = await createAdminClient();
    const params = request.nextUrl.searchParams;

    if (params.get('id')) {
        const q = parseQuery(request, getByIdQuerySchema);
        if ('response' in q) return q.response;
        const alunnoId = q.data.id;

        // Il gate sta PRIMA della lettura — e prima non c'era affatto: `requireDocente`
        // era invocato solo DOPO il `return` di questo ramo, quindi bastava conoscere (o
        // indovinare) un uuid per ottenere `note_mediche` di un minore, la sua classe e
        // le email dei suoi genitori SENZA alcuna credenziale. Verificato in produzione
        // il 2026-07-30: rispondeva 200 a una richiesta anonima.
        //
        // Genitore  → legame genitore↔figlio (`legame_genitori_alunni` +
        //             `student_parents`).
        // Staff     → l'alunno deve essere nel proprio plesso, e per `educator` nelle
        //             proprie sezioni.
        // `cuoca`   → non è genitore e non ha sezioni assegnate: viene negata.
        //             Nessun ruolo resta scoperto.
        //
        // Le tre righe qui sopra le fa TUTTE `requireParentOfStudent`. Fino al
        // 2026-07-31 ne faceva una sola — il legame di famiglia — e questa route
        // era l'UNICA delle venti che ci aggiungeva `assertAlunnoInScope` a mano.
        // Ora che il presidio sta nel gate quel giro è stato tolto: non per
        // risparmiare due query, ma perché una difesa duplicata QUI insegna al
        // prossimo lettore che il gate da solo non basta — ed è esattamente la
        // convinzione che ha lasciato scoperte le altre diciannove.
        const auth = await requireParentOfStudent(request, alunnoId);
        if (auth.response) return auth.response;

        const { data: alunno, error } = await supabase
            .from('alunni')
            .select('id, nome, cognome, note_mediche, classe_sezione, consenso_privacy')
            .eq('id', alunnoId)
            .maybeSingle();

        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        if (!alunno) return NextResponse.json(null);

        // Recupera i genitori — unione runtime (`legame_genitori_alunni`) +
        // anagrafica (`student_parents` via ponte `parents.auth_user_id`): con la
        // sola runtime i bambini importati dal form pubblico risultavano senza
        // alcun genitore (nessun contatto per la maestra).
        const parentIds = await getGenitoriDiAlunno(supabase, alunno.id);

        let parents: { id: string; nome: string; cognome: string; email: string }[] = [];
        if (parentIds.length > 0) {
            const { data: utenti, error: errGenitori } = await supabase
                .from('utenti')
                .select('id, nome, cognome, email')
                .in('id', parentIds);
            // I contatti dei genitori arricchiscono la scheda, non la decidono: col ripiego la
            // scheda dell'alunno esce senza contatti, e la riga dice perché.
            if (errGenitori) {
                guastoLetturaAccessoria('diary', 'diary/students:GET', 'contatti-genitori-non-letti', errGenitori);
            }
            parents = utenti ?? [];
        }

        return NextResponse.json({
            ...alunno,
            parents
        });
    }

    // ── Modalità insegnante/staff (per sezione): gate ruolo + gate classe + isolamento per plesso. ──
    const auth = await requireDocente(request);
    if (auth.response) return auth.response;
    const admin = await createAdminClient();

    const q = parseQuery(request, getBySezioneQuerySchema);
    if ('response' in q) return q.response;
    // Supporta sia "sezione" che "classeSezione"; nessun default a un nome
    // reale: entrambi assenti → nessuna lettura → risposta [] (contratto storico:
    // la UI chiama questa route anche prima di aver risolto la classe).
    const sezione = q.data.sezione ?? q.data.classeSezione ?? '';
    if (!sezione && !q.data.sectionId) return NextResponse.json([]);
    const onlyPresent = q.data.onlyPresent === 'true';
    // Giorno civile ITALIANO, non UTC (rilievo T27): con `onlyPresent` un
    // giorno sbagliato mostra alla maestra la classe di ieri.
    const date = q.data.date ?? oggiFiscaleISO();

    // FILTRO di sede, che ora precede il gate perché la risoluzione nome→uuid ne
    // ha bisogno. `resolveScuoleAttive` (non `scuoleDiUtente`) perché il
    // SedeSelector deve contare: prima qui il cookie non veniva nemmeno letto.
    // Restringere le sedi non concede niente — il gate viene comunque prima di
    // qualunque lettura di dati di minori, due righe sotto.
    const attive = await resolveScuoleAttive(request, admin, auth.user);
    const sede = restringiASedeRichiesta(attive, q.data.scuola_id, {
        azione: 'diary/students:GET', utente: auth.user.id, ruolo: auth.user.role,
    });
    if (sede.response) return sede.response;
    const plessi = sede.plessi ?? [];
    if (plessi.length === 0) return NextResponse.json([]);

    // GATE prima di qualunque lettura. `requireDocente` verifica il RUOLO, non
    // la classe: senza `soloSezioniAssegnate` un educator poteva chiedere
    // qualunque nome di classe del proprio plesso e ricevere `note_mediche`,
    // nome e cognome dei bambini di una sezione non sua. Il modello (PRD §3/§12,
    // decisione del 2026-07-30) dice: educator → SOLO le sezioni assegnate.
    // Admin/coordinator/segreteria non sono toccati: vedono tutto il plesso.
    // Il gate e la risoluzione a uuid stanno insieme in `risolviSezione`: erano
    // due passi separati, e il secondo — il filtro — usava il NOME. Bastava che
    // `alunni.classe_sezione` differisse di uno spazio da `sections.name` perché
    // la classe si aprisse vuota, con 200 e senza un log.
    const storica = puoCorreggereStorico(auth.user) && date < oggiRoma();
    // Lo staff può aprire anche una sezione rimossa: l'appartenenza verificata
    // nella sede/giornata è la prova. I docenti mantengono il gate ordinario.
    const classe = storica && q.data.sectionId
        ? { sectionIds: [q.data.sectionId], response: undefined }
        : await risolviSezione(admin, auth.user, { sectionId: q.data.sectionId, nome: sezione }, plessi);
    if (classe.response) return classe.response;
    if (classe.sectionIds.length === 0) return NextResponse.json([]);

    let idsStorici: string[] | null = null;
    if (storica) {
        try { idsStorici = [...new Set((await appartenenzeNelGiorno(admin, { scuole: plessi, sectionIds: classe.sectionIds, giorno: date })).map(a => a.alunno_id))]; }
        catch (error) { logEvento('registro', 'error', { operazione: 'diary/students:GET', esito: 'appartenenze-non-lette' }, error); return rispostaErroreStorico(error, 'diary/students:GET'); }
        if (!idsStorici.length) return NextResponse.json([]);
    }
    // La lettura storica usa gli UUID del roster; la lettura ordinaria resta
    // agganciata alla sezione e alla sede attuali, come prima.
        // `allergeni` e `allergies` accanto a `note_mediche`: la home del docente
        // mostrava un riquadro intitolato «Allergie e note mediche» che di allergie
        // non sapeva niente — contava `note_mediche`, cioè la casella «Note Mediche
        // (BES, DSA, patologie)» del modulo d'iscrizione. Nessun nuovo livello di
        // esposizione: questa route consegna già la nota medica agli stessi occhi,
        // dietro lo stesso gate (`requireDocente` + sezioni assegnate).
    const colonneAlunni = 'id, nome, cognome, note_mediche, allergeni, allergies, classe_sezione, consenso_privacy';
        // Per UUID, non per nome. `.in` e non `.eq`: un admin multi-plesso che
        // chiede un nome omonimo ha legittimamente più di una sezione.
    const queryAlunni = idsStorici
        ? admin.from('alunni').select(colonneAlunni).in('id', idsStorici).in('scuola_id', plessi)
        : admin.from('alunni').select(colonneAlunni).in('section_id', classe.sectionIds).in('scuola_id', plessi);
    const { data: alunni, error } = await queryAlunni
        // Difesa in profondità: il gate impedisce di NOMINARE una sezione
        // altrui, questo filtro impedisce che ci finisca dentro un bambino la
        // cui `scuola_id` non combacia con quella della sua sezione.
        .in('scuola_id', plessi)
        .is('anonimizzato_il', null)
        .order('cognome');

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if ((!alunni || alunni.length === 0) && !idsStorici?.length) {
        return NextResponse.json([]);
    }

    const alunnoIds = (alunni ?? []).map(a => a.id);

    // Legami per questi alunni, in BLOCCO e dall'unione delle due sorgenti
    // (runtime + anagrafica): 3 query fisse come prima, mai una per alunno.
    const genitoriPerAlunno = await getGenitoriDiAlunni(supabase, alunnoIds);

    // Recupera tutti i genitori collegati
    const parentsMap: Record<string, { id: string; nome: string; cognome: string; email: string }[]> = {};
    const parentIds = [...new Set([...genitoriPerAlunno.values()].flat())];
    if (parentIds.length > 0) {
        const { data: utenti, error: errGenitori } = await supabase
            .from('utenti')
            .select('id, nome, cognome, email')
            .in('id', parentIds);
        // Come sopra: la classe esce comunque, senza i contatti dei genitori.
        if (errGenitori) {
            guastoLetturaAccessoria('diary', 'diary/students:GET', 'contatti-genitori-non-letti', errGenitori);
        }

        if (utenti) {
            const utentiMap = new Map(utenti.map(u => [u.id, u]));
            for (const [alunnoId, genitoreIds] of genitoriPerAlunno) {
                for (const genitoreId of genitoreIds) {
                    const parent = utentiMap.get(genitoreId);
                    if (!parent) continue;
                    if (!parentsMap[alunnoId]) {
                        parentsMap[alunnoId] = [];
                    }
                    parentsMap[alunnoId].push({
                        id: parent.id,
                        nome: parent.nome,
                        cognome: parent.cognome,
                        email: parent.email
                    });
                }
            }
        }
    }

    // Arricchisci gli alunni con i genitori
    let enrichedAlunni = (alunni ?? []).map(a => ({
        ...a,
        parents: parentsMap[a.id] ?? []
    }));
    if (idsStorici) {
        // Un trasferimento non autorizza la vecchia sede a leggere sanitari e
        // famiglia correnti. Il roster storico conserva soltanto l'identità.
        const mancanti = idsStorici.filter(id => !alunnoIds.includes(id));
        for (let i = 0; i < mancanti.length; i += 100) {
            try {
                const ex = await leggiTutte<{ id: string; nome: string; cognome: string }>((dal, al) => admin.from('alunni').select('id,nome,cognome').in('id', mancanti.slice(i, i + 100)).is('anonimizzato_il', null).order('id').range(dal, al), 'diario-identita-storiche');
                enrichedAlunni.push(...ex.map(a => ({ id: a.id, nome: a.nome, cognome: a.cognome, note_mediche: null, allergeni: null, allergies: null, classe_sezione: sezione, consenso_privacy: null, parents: [] })));
            } catch (err) { logEvento('registro', 'error', { operazione: 'diary/students:GET', esito: 'identita-storiche-non-lette' }, err); return rispostaErroreStorico(err, 'diary/students:GET'); }
        }
    }

    // Se richiesto, filtra solo gli alunni presenti quel giorno
    if (onlyPresent && enrichedAlunni.length > 0) {
        const { data: presenze, error: prezError } = await supabase
            .from('presenze')
            .select('alunno_id, stato')
            .eq('data', date)
            .in('scuola_id', plessi)
            .in('alunno_id', enrichedAlunni.map(a => a.id))
            .in('stato', ['presente', 'ritardo', 'uscita_anticipata']);

        if (prezError) {
            // `error` benché la risposta sia 200: il filtro `onlyPresent` NON viene applicato e la
            // lista torna con TUTTI gli alunni della classe. Il chiamante ha chiesto «solo i
            // presenti» e riceve anche gli assenti, senza saperlo — una risposta sbagliata è
            // peggio di un errore. L'errore si passa intero (non `.message`): code, details e hint
            // di PostgREST sono ciò che dice perché.
            logEvento('db', 'error', {
                operazione: 'diary/students:GET',
                esito: 'presenze-non-lette-filtro-non-applicato',
            }, prezError);
            return NextResponse.json(enrichedAlunni);
        }

        const presentIds = new Set((presenze ?? []).map(p => p.alunno_id));
        enrichedAlunni = enrichedAlunni.filter(a => presentIds.has(a.id));
    }

    return NextResponse.json(enrichedAlunni);
});
