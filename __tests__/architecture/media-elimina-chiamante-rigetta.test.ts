import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LOCK — CHI PASSA `onDelete` A `MediaGrid` DEVE RIGETTARE SUL RIFIUTO.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── PERCHÉ ESISTE QUESTO LOCK ──────────────────────────────────────────────
 * `DialogoEliminaMedia` distingue tre esiti — 403 (confine di sede: il comando
 * sparisce), 404 (l'esito voluto è raggiunto: si chiude e si ricarica), 500/rete
 * (il comando resta, riprovare è il rimedio) — e li distingue LEGGENDO IL RIGETTO
 * di `onDelete`. Tutta quella macchina è irraggiungibile se il chiamante
 * *risolve* anche quando il server ha rifiutato.
 *
 * ⚠️ E `tsc` NON se ne accorge, che è il punto. Una funzione `async` che non
 * lancia mai soddisfa `(id: string) => Promise<void>` alla perfezione: il tipo
 * dice «restituisce una promise», non «rigetta quando il server rifiuta». Quindi
 * niente costringeva nessuno ad adeguare la pagina, e un chiamante che risolve su
 * un 403 era INDISTINGUIBILE da uno che ha eliminato per davvero — il visore si
 * chiudeva, `gallery-elimina-riuscita` finiva in `app_log`, e la foto restava.
 * Un contratto che nessuno misura non è un contratto: è un commento.
 *
 * ─── LE TRE COSE CHE SI MISURANO, E PERCHÉ PROPRIO QUELLE ───────────────────
 *  1. `throw` nel corpo del gestore — senza di lui il rifiuto del server non
 *     arriva al dialogo e viene dipinto come riuscita;
 *  2. nessun `confirm(` — il dialogo È la conferma. Un `confirm` nativo davanti
 *     sono due conferme in fila, e annullare quella nativa produce lo stesso
 *     falso «successo» del punto 1;
 *  3. nessun `alert(` — il rifiuto si mostra DENTRO il dialogo, con
 *     `role="alert"`, mentre la foto di cui si parla è ancora a schermo. Un
 *     `alert()` nativo blocca il thread (sta scritto in `MediaGrid`) e arriva su
 *     una schermata che non mostra più quella foto.
 *
 * Nessuna delle tre è sufficiente da sola: insieme sono la forma di un gestore
 * che onora il contratto dichiarato a `MediaGrid.tsx` (prop `onDelete`).
 *
 * ─── PERCHÉ UN'ALLOWLIST, E PERCHÉ È UNA PIETRA TOMBALE ─────────────────────
 * Il modello è `catch-muti-allowlist`: l'elenco può solo RIMPICCIOLIRSI, e il
 * confronto è per UGUAGLIANZA e non per inclusione. Se un file in elenco viene
 * bonificato, questo test diventa rosso e chiede di togliere la riga — altrimenti
 * l'esenzione sopravvive al debito e l'allowlist diventa decorazione, che è la
 * lezione già pagata in `abbassare_soglia_lock_e_decorazione`.
 */

const RADICE = process.cwd();
const SRC = path.join(RADICE, 'src');

/**
 * IL DEBITO NOTO, UNO SOLO, CON IL NOME DI CHI LO PAGA.
 *
 * 🔻 `src/app/(dashboard)/teacher/gallery/page.tsx` — `handleDeleteMedia` è già
 * `async`, quindi `tsc` è verde, ma:
 *   · apre un `confirm(t('galleryConfermaElimina'))` PRIMA del dialogo;
 *   · su `!res.ok` fa `alert(await messaggioErrore(...))` e RITORNA;
 *   · nel `catch` fa `alert(t('galleryErrReteEliminazione'))` e ritorna.
 * Cioè risolve sempre: il dialogo legge «riuscita» su un 403 e su un 500.
 *
 * La correzione, per chi possiede quel file (NON è di chi ha scritto il dialogo:
 * la pipeline di rilascio del 2026-09-12 l'ha assegnato a un'altra consegna):
 *
 *     const handleDeleteMedia = async (id: string) => {
 *         if (!teacherId) return;
 *         try {
 *             const res = await fetch(`/api/gallery?id=${id}&userId=${teacherId}`, { method: 'DELETE' });
 *             if (res.ok || res.status === 404) { await loadMedia(); return; }
 *             logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-delete-rifiutato',
 *                         route: '/teacher/gallery', stato: res.status });
 *             throw erroreElimina(await messaggioErrore(res, t('galleryErrEliminazione')), res.status);
 *         } catch (e) {
 *             if (statoDaRigetto(e) !== null) throw e;   // già tradotto e classificato
 *             logClient({ livello: 'error', evento: 'fetch', messaggio: 'gallery-delete-fallito',
 *                         route: '/teacher/gallery' });
 *             throw erroreElimina(t('galleryErrReteEliminazione'), null);
 *         }
 *     };
 *
 * (`erroreElimina` e `statoDaRigetto` si importano da
 * `@/components/features/gallery/DialogoEliminaMedia`.) Il 404 è trattato come
 * riuscita perché l'esito voluto È raggiunto — lo dice il contratto della prop.
 * Fatto questo, si TOGLIE la riga qui sotto e il tetto scende a 0.
 */
const ALLOWLIST: readonly string[] = [
    'src/app/(dashboard)/teacher/gallery/page.tsx',
];

/** Tetto monotono decrescente. Scende con l'allowlist, non sale mai. */
const TETTO_DEBITO = 1;

// ─── Lettura dei sorgenti ───────────────────────────────────────────────────

function fileSotto(dir: string, acc: string[] = []): string[] {
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const pieno = path.join(dir, voce.name);
        if (voce.isDirectory()) fileSotto(pieno, acc);
        else if (/\.tsx?$/.test(voce.name)) acc.push(pieno);
    }
    return acc;
}

/**
 * Commenti e stringhe via, con un mini-lexer e non con una regex.
 *
 * Serve a due cose insieme: (a) far combaciare le graffe, perché un commento con
 * una `{` spaiata manderebbe fuori sincrono il conteggio; (b) non contare un
 * `throw` NOMINATO in un commento né un `confirm(` dentro una stringa. Una regex
 * qui sarebbe sbagliata per un motivo molto concreto: i commenti di questo repo
 * sono in italiano e pieni di apostrofi (`l'unico`), che una regex sulle stringhe
 * prenderebbe per apici d'apertura.
 */
function senzaCommentiNeStringhe(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const d = src[i + 1];
        if (c === '/' && d === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && d === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const apice = c;
            i++;
            while (i < src.length) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === apice) { i++; break; }
                i++;
            }
            out += "''";
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

/** Il blocco `{ … }` che comincia alla prima graffa da `da`, graffe bilanciate. */
function bloccoDa(src: string, da: number): string | null {
    const apre = src.indexOf('{', da);
    if (apre === -1) return null;
    let livello = 0;
    for (let i = apre; i < src.length; i++) {
        if (src[i] === '{') livello++;
        else if (src[i] === '}') {
            livello--;
            if (livello === 0) return src.slice(apre, i + 1);
        }
    }
    return null;
}

/** Il corpo del gestore `nome`, dichiarato come `const … =>` o come `function`. */
function corpoDelGestore(src: string, nome: string): string | null {
    const fuga = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const re of [
        new RegExp(`const\\s+${fuga}\\s*(?::[^=]*)?=\\s*(?:async\\s*)?\\([^)]*\\)\\s*(?::[^=]*)?=>`),
        new RegExp(`(?:async\\s+)?function\\s+${fuga}\\s*\\(`),
    ]) {
        const m = re.exec(src);
        if (m) return bloccoDa(src, m.index + m[0].length);
    }
    return null;
}

/**
 * L'IDENTIFICATORE È UNA PROP INOLTRATA, non un gestore dichiarato qui?
 *
 * ─── PERCHÉ QUESTA DISTINZIONE ESISTE ───────────────────────────────────────
 * `GalleriaSedeGiornate` monta `MediaGrid` una volta per giornata e le passa
 * `onDelete={onDelete}`, dove `onDelete` è una **sua prop**: non è un chiamante, è
 * un tubo. Il contratto — rigettare con un `Error` dal messaggio già tradotto — lo
 * deve rispettare chi lo RIEMPIE, cioè `admin/gallery/page.tsx`, e quello il lock lo
 * misura già.
 *
 * Senza questa funzione il lock dichiarava «dichiarazione non trovata» e diventava
 * rosso su un file che non ha niente da dichiarare: un rosso che si spegne solo
 * mettendo in allowlist un caso legittimo, cioè logorando l'allowlist fino a
 * renderla rumore. E l'alternativa peggiore sarebbe stata accettare
 * `onDelete={qualcosa}` senza guardare: è precisamente ciò che questo lock rifiuta
 * di fare.
 *
 * ⚠️ CHE COSA IL CONTEGGIO CATTURA, E CHE COSA NO — misurato, non supposto.
 * Gli inoltri vengono contati, e il test in fondo pretende il numero ESATTO. Provato
 * con due mutazioni:
 *   · `eUnInoltro` che dice sempre NO → DUE test diventano rossi (il controllo
 *     positivo, perché il file torna «illeggibile», e il conteggio, che scende a zero).
 *     È il caso che conta: il riconoscitore che si rompe in silenzio.
 *   · `eUnInoltro` che dice sempre SÌ → il lock **resta verde**, e va detto invece di
 *     lasciarlo credere il contrario. Non è un buco: questa funzione è interpellata
 *     SOLO nel ramo `corpo === null`, cioè quando la dichiarazione non esiste e il
 *     gestore non sarebbe misurabile comunque. I chiamanti veri non passano da qui.
 */
function eUnInoltro(src: string, nome: string): boolean {
    const fuga = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `function Componente({ … nome … }: Props)` oppure `({ … nome = x … })`:
    // si guarda SOLO la lista di parametri destrutturati, non tutto il file, così un
    // `const nome = …` da qualche parte non si traveste da prop.
    for (const m of src.matchAll(/function\s+[A-Z][\w$]*\s*\(\s*\{([^}]*)\}/g)) {
        const parametri = m[1];
        if (new RegExp(`(^|[,\\s])${fuga}\\s*(?:[,=:]|$)`).test(parametri)) return true;
    }
    return false;
}

// ─── La popolazione: chi passa `onDelete` a `MediaGrid` ─────────────────────

interface Chiamante {
    relativo: string;
    gestore: string;
    corpo: string;
}

const chiamanti: Chiamante[] = [];
const illeggibili: string[] = [];
/** Gli inoltri riconosciuti: contati, perché un conto a zero è un lock che non vede. */
const inoltri: string[] = [];

for (const file of fileSotto(SRC)) {
    const grezzo = fs.readFileSync(file, 'utf8');
    if (!grezzo.includes('<MediaGrid')) continue;
    const pulito = senzaCommentiNeStringhe(grezzo);
    const relativo = path.relative(RADICE, file);
    // `onDelete={qualcosa}` — solo un identificatore: un gestore anonimo in linea
    // non si misura e non si legge, e per questo il lock lo RIFIUTA invece di
    // sorvolarci sopra (cfr. `silenzio_assente_vs_segnale_falso`).
    for (const m of pulito.matchAll(/onDelete=\{([^}]*)\}/g)) {
        const valore = m[1].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(valore)) {
            illeggibili.push(`${relativo}: onDelete={${valore}} non è un gestore con un nome`);
            continue;
        }
        const corpo = corpoDelGestore(pulito, valore);
        if (corpo === null) {
            // Prima di chiamarlo illeggibile: è un tubo? Vedi `eUnInoltro`.
            if (eUnInoltro(pulito, valore)) {
                inoltri.push(`${relativo}: \`${valore}\` è una prop inoltrata`);
                continue;
            }
            illeggibili.push(`${relativo}: dichiarazione di \`${valore}\` non trovata`);
            continue;
        }
        chiamanti.push({ relativo, gestore: valore, corpo });
    }
}

/** I tre difetti, per chiamante. Vuoto = conforme. */
function difetti(c: Chiamante): string[] {
    const out: string[] = [];
    if (!/\bthrow\b/.test(c.corpo)) out.push('non lancia MAI: un rifiuto del server viene letto come riuscita');
    if (/\bconfirm\s*\(/.test(c.corpo)) out.push('apre un `confirm()` nativo: due conferme in fila');
    if (/\balert\s*\(/.test(c.corpo)) out.push('mostra un `alert()` nativo invece del messaggio dentro il dialogo');
    return out;
}

describe('lock — il chiamante di `MediaGrid.onDelete` rigetta sul rifiuto', () => {
    it('il lock vede davvero qualcosa (se la popolazione è vuota non sta misurando niente)', () => {
        expect(
            illeggibili,
            'il lock non sa leggere questi chiamanti: dai un nome al gestore invece di passarlo in linea',
        ).toEqual([]);
        expect(
            chiamanti.length,
            'nessun chiamante di `onDelete` trovato: il lock è diventato cieco, non il repo virtuoso',
        ).toBeGreaterThan(0);
    });

    /**
     * GLI INOLTRI SI CONTANO, e il numero è UNO.
     *
     * Il commento di `eUnInoltro` promette che gli inoltri vengono contati: questa è
     * la riga che mantiene la promessa, perché un commento che dichiara una
     * protezione inesistente è peggio di nessun commento.
     *
     * Il numero esatto e non `>= 0`: se un domani `eUnInoltro` cominciasse a dire sì
     * a tutto — per un errore nella regex, o perché qualcuno la «semplifica» — i
     * chiamantiveri finirebbero nel secchio degli inoltri e il lock resterebbe verde
     * misurando il vuoto. Con il conto esatto, quel giorno questo test parla.
     *
     * Se aggiungi un componente che INOLTRA `onDelete` invece di dichiararlo, alza il
     * numero **e scrivi qui perché**: l'elenco degli inoltri è una lista di tubi, e
     * ogni tubo nuovo è un posto in più in cui il contratto non si vede.
     */
    it('gli inoltri riconosciuti sono esattamente quelli attesi (uno: `GalleriaSedeGiornate`)', () => {
        expect(
            inoltri.map((r) => r.split(':')[0]).sort(),
            `Gli inoltri di \`onDelete\` sono cambiati. Attesi: la sola ` +
                `\`GalleriaSedeGiornate\`, che monta una \`MediaGrid\` per giornata e inoltra la ` +
                `prop ricevuta dalla pagina. Trovati: ${inoltri.join(' | ') || '(nessuno)'}. ` +
                `Se ne hai aggiunto uno legittimo, aggiungilo qui con la sua ragione; se invece ` +
                `sono SPARITI, \`eUnInoltro\` ha smesso di riconoscerli e il lock sta per ` +
                `chiamare «illeggibile» un file che non ha niente da dichiarare.`,
        ).toEqual(['src/components/features/gallery/GalleriaSedeGiornate.tsx']);
    });

    it('nessun chiamante NUOVO risolve dove il server ha rifiutato', () => {
        const fuori = chiamanti
            .filter((c) => difetti(c).length > 0 && !ALLOWLIST.includes(c.relativo))
            .map((c) => `${c.relativo} (${c.gestore}): ${difetti(c).join(' · ')}`);
        expect(
            fuori,
            'un gestore che risolve su un 403 fa chiudere il visore e scrivere `gallery-elimina-riuscita` ' +
                'mentre la foto è ancora lì. Deve `throw erroreElimina(testoGiàTradotto, res.status)`.',
        ).toEqual([]);
    });

    it('l’allowlist è una pietra tombale: una voce bonificata si TOGLIE', () => {
        const noti = new Set(chiamanti.filter((c) => difetti(c).length > 0).map((c) => c.relativo));
        const guarite = ALLOWLIST.filter((f) => !noti.has(f));
        expect(
            guarite,
            'questi file ONORANO il contratto: togli la loro riga da `ALLOWLIST` e abbassa `TETTO_DEBITO`. ' +
                'Un’esenzione che sopravvive al debito trasforma il lock in decorazione.',
        ).toEqual([]);
    });

    it('il tetto del debito non sale', () => {
        expect(ALLOWLIST.length).toBeLessThanOrEqual(TETTO_DEBITO);
    });
});
