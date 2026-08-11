import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { NextResponse } from 'next/server'

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * LA PORTA CHE È STATA CHIUSA — `POST /api/admin/adults`, e la categoria di
 * difetto che l'aveva resa pericolosa.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * COSA C'ERA, misurato l'11 agosto 2026. Una rotta che dichiarava di creare un
 * account del personale e che, in ordine:
 *
 *  1. non era raggiungibile — l'unico chiamante era `AdultRegistryForm.tsx`, che
 *     nessuna pagina montava. Zero utenti, quindi zero segnalazioni: il modo più
 *     efficace che esista di tenere in casa una rotta rotta senza accorgersene;
 *  2. non funzionava — l'`upsert` su `utenti` scriveva ANCHE `first_name`,
 *     `last_name` e `role`, che su quella tabella sono
 *     `GENERATED ALWAYS AS (nome|cognome|ruolo) STORED`. Postgres risponde
 *     `428C9` («cannot insert a non-DEFAULT value into column»), la rotta
 *     rispondeva 500 — ma `inviteUserByEmail` era già passato, quindi ogni
 *     tentativo lasciava un account `auth.users` orfano, senza riga `utenti`;
 *  3. era pericolosa da riparare — `role` era uno `z.string()` libero e il gate
 *     `requireStaff` comprende la segreteria: chi avesse corretto solo il punto 2
 *     avrebbe consegnato alla segreteria la creazione di un account `admin`.
 *
 * ─── COSA MISURA QUESTO FILE, e perché non basta «l'ho cancellata» ────────────
 * Cancellare è un evento; questo file è la difesa che resta. Tre cose:
 *
 *  A. che il modulo della rotta esporti SOLO `GET` — se domani ricompare un
 *     `export const POST`, Next.js lo serve, e nessun altro test se ne accorge;
 *  B. che nessun componente torni a chiamare la rotta in POST (era il pezzo che
 *     rendeva il difetto invisibile: una scheda scollegata, un errore mai visto);
 *  C. che NESSUNA scrittura su `utenti`, in tutto `src/`, tocchi le tre colonne
 *     generate. Questo è il punto vero: il difetto non era «di quella rotta», era
 *     una categoria — e la prossima strada che crea un account del personale
 *     (l'approvazione di una pratica di `/anagrafica-personale`, per dirne una
 *     che si sta scrivendo in questi giorni) ha esattamente la stessa forma. Un
 *     lock sulla singola rotta cancellata sarebbe stato un lock su un file che
 *     non esiste più: verde per sempre e per il motivo sbagliato.
 *
 * Le colonne giuste, quando si scrive un utente, sono `nome` · `cognome` ·
 * `ruolo`. Le altre tre si LEGGONO (il `GET` qui accanto le seleziona, ed è
 * legittimo): sono la stessa cosa vista con un nome inglese.
 *
 * ⚠️ REPOSITORY PUBBLICO: nessun dato di persone vere in questo file.
 */

// ─────────────────────────────────────────────────────────────────────────────
// (A) IL MODULO DELLA ROTTA
//
// Il gate nega, così l'unico handler rimasto si può interrogare davvero senza
// toccare nulla; e `createAdminClient` ESPLODE di proposito — se un giorno una
// riga finisse prima del gate, questo test non risponderebbe 401 ma 500, che è
// il modo di accorgersene invece di leggere un verde.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
    requireStaff: vi.fn(async () => ({
        response: NextResponse.json({ error: 'Non autenticato: userId mancante' }, { status: 401 }),
    })),
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/supabase/server-client', () => ({
    createAdminClient: async () => {
        throw new Error('client costruito PRIMA del gate: non deve succedere')
    },
}))

import * as rottaAdults from '@/app/api/admin/adults/route'

/** Il namespace del modulo letto come mappa: `rottaAdults.POST` non compilerebbe — ed è il punto. */
const esportazioni = rottaAdults as unknown as Record<string, unknown>
const VERBI_HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

describe('`/api/admin/adults` — la creazione di un account non passa più di qui', () => {
    it('il modulo esporta SOLO il GET', () => {
        const serviti = VERBI_HTTP.filter((v) => typeof esportazioni[v] === 'function')
        expect(
            serviti,
            'Next.js serve QUALUNQUE verbo esportato da un `route.ts`. Se qui è ricomparso un ' +
                'POST (o un PUT travestito da POST), fermati e leggi il commento in testa a ' +
                '`src/app/api/admin/adults/route.ts`: quella rotta scriveva le colonne GENERATE ' +
                'di `utenti` (500 garantito) dopo aver già invitato l’account auth, e il suo ' +
                '`role` libero + `requireStaff` davano alla segreteria la creazione di un admin. ' +
                'Un account del personale si crea con `ensureStaffIdentity()` ' +
                '(`src/lib/auth/staff-identity.ts`), NON qui e nemmeno su `/api/admin/staff`, ' +
                'che l’11/08/2026 esporta solo `GET` e `PATCH` e non crea niente.',
        ).toEqual(['GET'])
    })

    it('il GET è vivo e resta dietro il gate (401 in anonimo)', async () => {
        // Controllo POSITIVO accanto a quello negativo: senza, il test qui sopra
        // resterebbe verde anche se qualcuno cancellasse il file intero.
        const get = esportazioni.GET as (r: Request) => Promise<Response>
        const res = await get(new Request('http://x/api/admin/adults'))
        expect(res.status).toBe(401)
        expect(h.requireStaff).toHaveBeenCalled()
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// (B) e (C) LE MISURE SUL SORGENTE
// ─────────────────────────────────────────────────────────────────────────────

const RADICE = process.cwd()
const SRC = path.join(RADICE, 'src')

function sorgenti(dir = SRC): string[] {
    const out: string[] = []
    for (const voce of fs.readdirSync(dir, { withFileTypes: true })) {
        const assoluto = path.join(dir, voce.name)
        if (voce.isDirectory()) { out.push(...sorgenti(assoluto)); continue }
        if (!/\.tsx?$/.test(voce.name)) continue
        out.push(path.relative(RADICE, assoluto).split(path.sep).join('/'))
    }
    return out
}

/** Fine della stringa aperta in `apertura` (apici singoli, doppi, backtick), escape compresi. */
function fineStringa(s: string, apertura: number): number {
    const q = s[apertura]
    for (let i = apertura + 1; i < s.length; i++) {
        if (s[i] === '\\') { i++; continue }
        if (s[i] === q) return i
    }
    return s.length - 1
}

/**
 * Commenti → spazi; stringhe e «a capo» INTATTI. Le stringhe servono (`from('utenti')` è
 * una stringa) e i ritorni a capo pure, perché il numero di riga riportato sia quello vero.
 *
 * I commenti spariscono per una ragione concreta: in questo repo un commento che CITA il
 * codice sbagliato è la norma — ce n'è uno lungo venti righe proprio in `admin/adults/route.ts`
 * — e un rilevatore che legge i commenti diventa rosso su ciò che spiega perché è stato tolto.
 */
function senzaCommenti(sorgente: string): string {
    let out = ''
    for (let i = 0; i < sorgente.length; i++) {
        const c = sorgente[i]
        const d = sorgente[i + 1]
        // `\/` dentro un'espressione regolare non apre un commento: si copia la coppia.
        if (c === '\\') { out += c + (d ?? ''); i++; continue }
        if (c === '"' || c === "'" || c === '`') {
            const fine = fineStringa(sorgente, i)
            out += sorgente.slice(i, fine + 1)
            i = fine
            continue
        }
        if (c === '/' && d === '/') {
            while (i < sorgente.length && sorgente[i] !== '\n') { out += ' '; i++ }
            out += '\n'
            continue
        }
        if (c === '/' && d === '*') {
            out += '  '
            i += 2
            while (i < sorgente.length && !(sorgente[i] === '*' && sorgente[i + 1] === '/')) {
                out += sorgente[i] === '\n' ? '\n' : ' '
                i++
            }
            out += '  '
            i++
            continue
        }
        out += c
    }
    return out
}

const riga = (testo: string, indice: number) => testo.slice(0, indice).split('\n').length

/** Indice della parentesi che chiude quella aperta in `aperta`. */
function fineParentesi(s: string, aperta: number): number {
    let d = 0
    for (let i = aperta; i < s.length; i++) {
        const c = s[i]
        if (c === '"' || c === "'" || c === '`') { i = fineStringa(s, i); continue }
        if (c === '(') d++
        else if (c === ')') { d--; if (d === 0) return i }
    }
    return s.length - 1
}

/** Indice della graffa che chiude quella aperta in `aperta`. */
function fineGraffa(s: string, aperta: number): number {
    let d = 0
    for (let i = aperta; i < s.length; i++) {
        const c = s[i]
        if (c === '"' || c === "'" || c === '`') { i = fineStringa(s, i); continue }
        if (c === '{') d++
        else if (c === '}') { d--; if (d === 0) return i }
    }
    return s.length - 1
}

/** Spezza su virgole di PRIMO livello: separa gli argomenti di una chiamata o le voci di un oggetto. */
function pezziDiPrimoLivello(s: string): string[] {
    const out: string[] = []
    let inizio = 0
    let d = 0
    for (let i = 0; i < s.length; i++) {
        const c = s[i]
        if (c === '"' || c === "'" || c === '`') { i = fineStringa(s, i); continue }
        if (c === '{' || c === '[' || c === '(') d++
        else if (c === '}' || c === ']' || c === ')') d--
        else if (c === ',' && d === 0) { out.push(s.slice(inizio, i)); inizio = i + 1 }
    }
    out.push(s.slice(inizio))
    return out.map((p) => p.trim()).filter(Boolean)
}

/**
 * Le CHIAVI scritte da un oggetto letterale — non i valori.
 *
 * La differenza non è pignoleria: `{ nome: first_name }` è LEGITTIMO (scrive la colonna
 * `nome` col valore di una variabile che si chiama `first_name`), mentre `{ first_name }`
 * è il difetto. Un rilevatore che cercasse la parola sarebbe rosso su entrambi, e un lock
 * rosso a torto è un lock che si impara a spegnere.
 */
function chiaviDiOggetto(letterale: string): string[] {
    const dentro = letterale.trim().replace(/^\{/, '').replace(/\}$/, '')
    return pezziDiPrimoLivello(dentro).map((pezzo) => {
        let d = 0
        let duePunti = -1
        for (let i = 0; i < pezzo.length; i++) {
            const c = pezzo[i]
            if (c === '"' || c === "'" || c === '`') { i = fineStringa(pezzo, i); continue }
            if (c === '{' || c === '[' || c === '(') d++
            else if (c === '}' || c === ']' || c === ')') d--
            else if (c === ':' && d === 0) { duePunti = i; break }
        }
        const chiave = (duePunti >= 0 ? pezzo.slice(0, duePunti) : pezzo).trim()
        return chiave.replace(/^['"`]/, '').replace(/['"`]$/, '')
    })
}

/** Le tre colonne di `utenti` che Postgres calcola da sé e rifiuta in scrittura. */
const GENERATE = ['first_name', 'last_name', 'role'] as const

/**
 * Le scritture su `utenti` che toccano una colonna generata, con la riga.
 *
 * ─── COSA VEDE ───────────────────────────────────────────────────────────────
 *  · `from('utenti')` seguito, nella STESSA catena, da `.insert(…)`/`.update(…)`/
 *    `.upsert(…)` — anche a capo, anche con `.select().single()` in coda;
 *  · l'oggetto scritto sul posto, l'array di oggetti, e l'oggetto passato PER NOME
 *    (`.upsert(utentiRecord)`) risolto nella dichiarazione dello stesso file;
 *  · le assegnazioni successive su quel nome (`patch.role = …`), che è il modo in cui
 *    `admin/staff:PATCH` costruisce il suo aggiornamento.
 *
 * ─── COSA NON VEDE, detto perché un lock che non dichiara i propri limiti si finge
 *     una dimostrazione ─────────────────────────────────────────────────────────
 *  · uno spread (`{ ...altro }`) che porti dentro le colonne da un oggetto costruito
 *    altrove: la parola non compare, e non c'è modo di saperlo senza i tipi;
 *  · una tabella raggiunta con un nome calcolato (`from(tabella)`);
 *  · l'SQL nelle migrazioni e nelle funzioni `SECURITY DEFINER`, che è un altro
 *    perimetro.
 * Resta una rete a maglie larghe sul percorso che ha già sbagliato una volta, non
 * una prova che non possa succedere altrove.
 */
function scrittureSuUtenti(sorgente: string): { riga: number; metodo: string; colonne: string[] }[] {
    const testo = senzaCommenti(sorgente)
    const trovate: { riga: number; metodo: string; colonne: string[] }[] = []
    const DA_UTENTI = /\.\s*from\s*\(\s*['"]utenti['"]\s*\)/g

    for (const m of testo.matchAll(DA_UTENTI)) {
        let i = (m.index ?? 0) + m[0].length
        // Si cammina la catena `.metodo(…)` finché ce n'è: `.upsert({…}).select().single()`.
        while (i < testo.length) {
            while (i < testo.length && /\s/.test(testo[i])) i++
            if (testo[i] !== '.') break
            i++
            while (i < testo.length && /\s/.test(testo[i])) i++
            const metodo = /^[A-Za-z_$][\w$]*/.exec(testo.slice(i))?.[0]
            if (!metodo) break
            i += metodo.length
            while (i < testo.length && /\s/.test(testo[i])) i++
            if (testo[i] !== '(') break
            const chiusa = fineParentesi(testo, i)

            if (metodo === 'insert' || metodo === 'update' || metodo === 'upsert') {
                const primoArgomento = pezziDiPrimoLivello(testo.slice(i + 1, chiusa))[0] ?? ''
                trovate.push({ riga: riga(testo, i), metodo, colonne: colonneScritte(primoArgomento, testo) })
            }
            i = chiusa + 1
        }
    }
    return trovate
}

/** Le sole che fanno rosso: una scrittura su `utenti` che nomina una colonna generata. */
const scrittureConColonneGenerate = (sorgente: string) =>
    scrittureSuUtenti(sorgente)
        .filter((s) => s.colonne.length > 0)
        .map(({ riga, colonne }) => ({ riga, colonne }))

function colonneScritte(argomento: string, fileIntero: string): string[] {
    const arg = argomento.trim()
    const letterali: string[] = []
    const chiavi = new Set<string>()

    if (arg.startsWith('{')) {
        letterali.push(arg)
    } else if (arg.startsWith('[')) {
        // `.insert([{…}, {…}])`: ogni riga dell'array è un oggetto a sé.
        for (const voce of pezziDiPrimoLivello(arg.slice(1, -1))) {
            if (voce.trim().startsWith('{')) letterali.push(voce.trim())
        }
    } else if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
        const dichiarazione = new RegExp(String.raw`\b(?:const|let|var)\s+${arg}\b[^=;]*=\s*\{`).exec(fileIntero)
        if (dichiarazione) {
            const apertura = dichiarazione.index + dichiarazione[0].length - 1
            letterali.push(fileIntero.slice(apertura, fineGraffa(fileIntero, apertura) + 1))
        }
        for (const colonna of GENERATE) {
            const assegnata = new RegExp(
                String.raw`\b${arg}\s*(?:\.\s*${colonna}\b|\[\s*['"]${colonna}['"]\s*\])\s*=[^=]`,
            )
            if (assegnata.test(fileIntero)) chiavi.add(colonna)
        }
    }

    for (const letterale of letterali) {
        for (const chiave of chiaviDiOggetto(letterale)) {
            if ((GENERATE as readonly string[]).includes(chiave)) chiavi.add(chiave)
        }
    }
    return [...chiavi]
}

describe('nessuna scrittura su `utenti` tocca le colonne GENERATE', () => {
    it('in tutto `src/`', () => {
        const colpevoli: string[] = []
        const scrittureViste: string[] = []
        for (const file of sorgenti()) {
            const sorgente = fs.readFileSync(path.join(RADICE, file), 'utf8')
            if (!sorgente.includes("'utenti'") && !sorgente.includes('"utenti"')) continue
            for (const s of scrittureSuUtenti(sorgente)) {
                scrittureViste.push(`${file}:${s.riga} (${s.metodo})`)
                if (s.colonne.length) colpevoli.push(`${file}:${s.riga} → ${s.colonne.join(', ')}`)
            }
        }

        // CONTROLLO POSITIVO, prima di quello negativo. Un rilevatore che non trova più
        // NESSUNA scrittura su `utenti` non è un repo pulito: è un rilevatore rotto — la
        // catena `.from('utenti').upsert(…)` esiste eccome (`admin/pre-inscriptions`,
        // `admin/staff`, `lib/auth/parent-identity`). Senza questa riga, il giorno in cui
        // il camminatore di catena smettesse di funzionare il lock resterebbe verde e non
        // guarderebbe più niente.
        expect(
            scrittureViste.length,
            'Il rilevatore non vede più NESSUNA scrittura su `utenti`: prima di credere al ' +
                'verde qui sotto, controlla che `scrittureSuUtenti` cammini ancora la catena.',
        ).toBeGreaterThanOrEqual(3)

        expect(
            colpevoli,
            'Scrittura su `utenti` che tocca una colonna GENERATA. Postgres rifiuta con `428C9` ' +
                '(«cannot insert a non-DEFAULT value into column»): la riga NON viene scritta, e ' +
                'se prima hai già invitato l’account auth resti con un utente senza profilo — è ' +
                'esattamente ciò che faceva `POST /api/admin/adults`, cancellata il 2026-08-11. ' +
                'Le colonne da scrivere sono `nome`, `cognome`, `ruolo`: `first_name`, ' +
                '`last_name` e `role` sono le stesse, calcolate da Postgres, e si leggono soltanto.',
        ).toEqual([])
    })

    it('nessun componente chiama `/api/admin/adults` in POST', () => {
        // Il difetto restava invisibile perché il chiamante era una scheda che nessuna
        // pagina montava. Se il chiamante torna prima della rotta, si ricomincia da lì.
        const chiamanti: string[] = []
        for (const file of sorgenti()) {
            if (file.startsWith('src/app/api/admin/adults/')) continue
            const testo = senzaCommenti(fs.readFileSync(path.join(RADICE, file), 'utf8'))
            let da = testo.indexOf('/api/admin/adults')
            while (da !== -1) {
                const finestra = testo.slice(Math.max(0, da - 200), da + 400)
                if (/method\s*:\s*['"]POST['"]/i.test(finestra)) chiamanti.push(`${file}:${riga(testo, da)}`)
                da = testo.indexOf('/api/admin/adults', da + 1)
            }
        }
        expect(
            chiamanti,
            'Qualcuno posta di nuovo su `/api/admin/adults`, che non ha un POST: risponderebbe ' +
                '405. Se serve creare un account del personale, la strada è `ensureStaffIdentity()` ' +
                'in `src/lib/auth/staff-identity.ts` — non `/api/admin/staff`, che legge e ' +
                'modifica account esistenti (`GET`+`PATCH`) e non ne crea nessuno.',
        ).toEqual([])
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// PROVA DI VALIDITÀ PERMANENTE DEL RILEVATORE
//
// Un lock verde perché non trova niente e un lock verde perché non guarda più
// niente, da fuori, sono identici. Qui sotto c'è il codice VERO che è stato
// tolto, ridotto all'osso: il giorno in cui il rilevatore smettesse di vederlo,
// è questo test a cadere — non il gate, sei mesi dopo, in produzione.
// ─────────────────────────────────────────────────────────────────────────────

describe('il rilevatore riconosce la forma vietata', () => {
    it('l’`upsert` cancellato l’11 agosto (oggetto sul posto, chiavi in chiaro)', () => {
        const src = `
      const { data, error } = await supabase
        .from('utenti')
        .upsert({
          id: userId,
          nome: first_name,
          cognome: last_name,
          first_name,
          last_name,
          ruolo: role || 'educator',
        })
        .select()
        .single();
    `
        expect(scrittureConColonneGenerate(src)).toEqual([{ riga: 4, colonne: ['first_name', 'last_name'] }])
    })

    it('l’oggetto passato per nome (`.upsert(record)`) e le assegnazioni successive', () => {
        const perNome = `
      const record = { id, email, nome, cognome, role: 'admin' };
      await supabase.from('utenti').upsert(record);
    `
        expect(scrittureConColonneGenerate(perNome)[0]?.colonne).toEqual(['role'])

        const assegnata = `
      const patch: Record<string, unknown> = {};
      patch.last_name = body.cognome;
      await supabase.from('utenti').update(patch).eq('id', id);
    `
        expect(scrittureConColonneGenerate(assegnata)[0]?.colonne).toEqual(['last_name'])
    })

    it('un `update` su un’ALTRA tabella con le stesse parole NON è un falso positivo', () => {
        const src = `
      await supabase.from('parents').update({ first_name, last_name }).eq('id', id);
    `
        expect(scrittureConColonneGenerate(src)).toEqual([])
    })

    it('leggere le colonne generate è legittimo: il `select` non è una scrittura', () => {
        const src = `
      await supabase.from('utenti').select('id, first_name, last_name, ruolo, role').eq('id', id);
    `
        expect(scrittureConColonneGenerate(src)).toEqual([])
    })

    it('`{ nome: first_name }` è la forma GIUSTA, e non va segnalata', () => {
        // Il caso che separa un lock utile da un lock che si spegne: la colonna è
        // `nome`, `first_name` è solo il nome della variabile che porta il valore.
        const src = `
      await supabase.from('utenti').insert({ nome: first_name, cognome: last_name, ruolo: 'genitore' });
    `
        expect(scrittureConColonneGenerate(src)).toEqual([])
    })

    it('un commento che CITA la scrittura sbagliata non è una scrittura sbagliata', () => {
        const src = `
      // Qui stava: .from('utenti').upsert({ first_name, last_name, role })
      /* e anche qui: .from('utenti').upsert({ role }) */
      await supabase.from('utenti').insert({ nome, cognome, ruolo });
    `
        expect(scrittureConColonneGenerate(src)).toEqual([])
    })
})
