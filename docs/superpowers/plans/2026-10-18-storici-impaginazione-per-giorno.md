# Storici: impaginazione per giorno — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stampe degli storici leggibili, con un giorno per titolo e una tabella al posto delle schede «Registrazione N»; l'attività e la nota di sezione del diario compaiono una volta sola invece che una per bambino.

**Architecture:** l'adattatore del diario accorpa in lettura le attività identiche della sezione in una riga di classe (`_ambito: 'classe'`) e trasforma la nota di sezione in una riga del giorno (`_nota_giorno`). Il motore PDF prepara le colonne (vuote tolte, inizio+fine uniti, costanti in testata) e disegna per ogni giorno un titolo, le note di sezione e una tabella `autoTable`. `raggruppaPerAlunno` resta invariato: le righe di classe finiscono già nel blocco comune.

**Tech Stack:** TypeScript, jsPDF 3 + jspdf-autotable 5, pdf-lib, vitest 4 (ambiente node per i PDF, `unpdf` per rileggerli).

Spec: `docs/superpowers/specs/2026-10-18-storici-impaginazione-per-giorno-design.md`.

**Scostamenti dalla spec decisi scrivendo il piano:**
- la nota di sezione non resta una colonna: diventa una riga `_nota_giorno` per giorno e testo, nell'adattatore e non solo nel PDF, così anche Excel e il dossier per alunno la vedono una volta (nel dossier va nel blocco comune);
- nel dossier per alunno la riga di classe mostra la partecipazione a soli conteggi: i nomi e le note individuali restano nelle schede dei singoli;
- l'autrice non sale per giorno: sale in testata quando è la stessa per tutta la sezione (regola delle costanti).

---

## File

| File | Responsabilità |
|---|---|
| `src/lib/storici/adattatori/scolastici-diario.ts` | accorpamento attività di classe, righe «nota del giorno», log |
| `src/lib/storici/impaginazione-pdf.ts` | `preparaColonne`, `titoloGiorno`, tabelle per giorno al posto di `schede()` |
| `__tests__/lib/storici-scolastici.test.ts` | adattatore diario: classe, per alunno, singolo |
| `__tests__/lib/storici-generazioni.test.ts` | il diario accorpato nel blocco comune |
| `__tests__/lib/storici-pdf-impaginazione.test.ts` | impaginazione: pagine, colonne, testata, giorni, aree sicure |
| `PRD REGISTRO ELETTRONICO.md` | voce datata 18/10 + stato prod delle voci 16/10 e 17/10 |

Comando dei test di questo lavoro:

```bash
npx vitest run __tests__/lib/storici-scolastici.test.ts __tests__/lib/storici-generazioni.test.ts __tests__/lib/storici-pdf-impaginazione.test.ts __tests__/lib/storici-render.test.ts __tests__/lib/storici-excel.test.ts
```

Si controlla sempre la riga `Test Files  N passed`: un file mai eseguito esce 0 lo stesso.

---

### Task 1: diario — attività di classe una volta sola e nota del giorno

**Files:**
- Modify: `src/lib/storici/adattatori/scolastici-diario.ts` (intero)
- Test: `__tests__/lib/storici-scolastici.test.ts` (dopo il test «pagina oltre le 1000 righe…», riga ~316)

- [ ] **Step 1: scrivere i test che falliscono**

```ts
  describe('attività e note di sezione del diario', () => {
    const C = 'alunno-c'
    const eventi = () => [A, B, C].map((id, i) => ({
      id: `att-${id}`, alunno_id: id, tipo_evento: 'attivita', orario_inizio: '2026-09-10T08:00:00Z', maestra_id: 'edu',
      nota_libera: 'Uscita in giardino', nota_bambino: id === C ? 'Ha guidato il gioco' : null,
      dettagli: { activities: [{ tipo: 'Pittura', descrizione: 'Colori a dita', ora_inizio: '10:00', ora_fine: '10:45', partecipazione: i === 0 ? 'Con entusiasmo' : 'Ha partecipato' }] },
    }))
    const tre = (db: SupabaseClient) => contesto(db, {
      alunni: [{ id: A, nome: 'Anna', cognome: 'Rossi', scuola_id: SEDE, section_id: CLASSE }, { id: B, nome: 'Bruno', cognome: 'Verdi', scuola_id: SEDE, section_id: CLASSE },
        { id: C, nome: 'Carla', cognome: 'Bianchi', scuola_id: SEDE, section_id: CLASSE }],
      appartenenze: [A, B, C].map(id => ({ alunno_id: id, scuola_id: SEDE, section_id: CLASSE, dal: '2020-01-01', al: null })),
    })
    const utenti = [{ id: 'edu', nome: 'Edu', cognome: 'Sintetica' }]

    it('in stampa di classe accorpa l’attività: una riga, partecipazione raggruppata, nota di sezione una volta', async () => {
      const s = await raccogliScolastico(tre(database({ eventi_diario: eventi(), utenti }).db), 'diario_attivita')
      expect(s?.righe).toEqual([
        expect.objectContaining({ _ambito: 'classe', _nota_giorno: true, data: '2026-09-10', tipo: 'Nota di sezione', dettaglio: 'Uscita in giardino', autore: 'Sintetica Edu' }),
        expect.objectContaining({ _ambito: 'classe', data: '2026-09-10', alunno: '', tipo: 'Pittura', dettaglio: 'Colori a dita', inizio: '10:00', fine: '10:45',
          valore: 'Ha partecipato: 2 bambini · Con entusiasmo: Rossi Anna', notaIndividuale: 'Bianchi Carla: Ha guidato il gioco', autore: 'Sintetica Edu' }),
      ])
      expect(s?.righe.some(r => r._alunno_id)).toBe(false)
      expect(s?.colonne.map(c => c.chiave)).not.toContain('notaSezione')
    })

    it('con un solo valore di partecipazione scrive «tutti» e senza valore il solo conteggio', async () => {
      const uguali = eventi().map(e => ({ ...e, nota_libera: null, nota_bambino: null, dettagli: { activities: [{ ...e.dettagli.activities[0], partecipazione: 'Ha partecipato' }] } }))
      const s = await raccogliScolastico(tre(database({ eventi_diario: uguali, utenti }).db), 'diario_attivita')
      expect(s?.righe.map(r => r.valore)).toEqual(['Ha partecipato: tutti i 3 bambini'])
      const senza = eventi().map(e => ({ ...e, nota_libera: null, dettagli: { activities: [{ ...e.dettagli.activities[0], partecipazione: null }] } }))
      const t = await raccogliScolastico(tre(database({ eventi_diario: senza, utenti }).db), 'diario_attivita')
      expect(t?.righe.map(r => r.valore)).toEqual(['3 bambini'])
    })

    it('nel dossier per alunno mette la descrizione nella riga di classe e ai singoli solo la propria partecipazione', async () => {
      const ctx = tre(database({ eventi_diario: eventi(), utenti }).db)
      ctx.richiesta.raggruppamento = 'alunno'
      const s = await raccogliScolastico(ctx, 'diario_attivita')
      const classe = s?.righe.filter(r => r._ambito === 'classe' && !r._nota_giorno)
      expect(classe).toEqual([expect.objectContaining({ dettaglio: 'Colori a dita', valore: 'Ha partecipato: 2 bambini · Con entusiasmo: 1 bambino', notaIndividuale: '' })])
      const singoli = s?.righe.filter(r => r._alunno_id) ?? []
      expect(singoli.map(r => [r._alunno_id, r.dettaglio, r.valore, r.notaIndividuale])).toEqual([
        [A, '', 'Con entusiasmo', ''], [B, '', 'Ha partecipato', ''], [C, '', 'Ha partecipato', 'Ha guidato il gioco'],
      ])
      expect(JSON.stringify(classe)).not.toContain('Rossi')
    })

    it('nella stampa di un solo alunno non accorpa e tiene la descrizione', async () => {
      const ctx = tre(database({ eventi_diario: eventi(), utenti }).db)
      ctx.richiesta.sectionId = undefined; ctx.richiesta.alunnoId = A
      ctx.alunni = ctx.alunni.filter(a => a.id === A)
      const s = await raccogliScolastico(ctx, 'diario_attivita')
      expect(s?.righe).toEqual([
        expect.objectContaining({ _nota_giorno: true, dettaglio: 'Uscita in giardino' }),
        expect.objectContaining({ _alunno_id: A, alunno: 'Rossi Anna', dettaglio: 'Colori a dita', valore: 'Con entusiasmo' }),
      ])
    })

    it('nelle note tiene le sole note individuali per bambino e la nota di sezione una volta per giorno', async () => {
      const s = await raccogliScolastico(tre(database({ eventi_diario: eventi(), utenti }).db), 'diario_note')
      expect(s?.righe.filter(r => r._nota_giorno)).toHaveLength(1)
      expect(s?.righe.filter(r => r._alunno_id).map(r => [r._alunno_id, r.notaIndividuale])).toEqual([[C, 'Ha guidato il gioco']])
    })
  })
```

- [ ] **Step 2: eseguirli e vederli fallire**

Run: `npx vitest run __tests__/lib/storici-scolastici.test.ts -t "attività e note di sezione"`
Expected: FAIL — oggi le righe sono una per bambino, con `notaSezione` e senza `_nota_giorno`.

- [ ] **Step 3: implementazione** — `scolastici-diario.ts` diventa:

```ts
import { oraDiRoma } from '@/lib/presenze/orario'
import { logEvento } from '@/lib/logging/logger'
import { intervalloGiornoRoma } from '../retroattivita'
import type { CategoriaStorico } from '../catalogo'
import type { CellaStorico, ContestoStorico, SezioneStorico } from '../tipi'
import { ammesso, cella, elenco, giorno, idsAlunni, nome, nuovaSezione, oggetto, perIds, persone, testo } from './scolastici-comune'

const TIPI: Partial<Record<CategoriaStorico, string[]>> = {
  diario_pasti: ['pranzo', 'merenda'], diario_sonno: ['nanna', 'nanna_inizio', 'nanna_fine'],
  diario_bagno: ['bagno'], diario_attivita: ['attivita'], diario_umore: ['umore'],
}
const NOMI: Record<string, string> = { pranzo: 'Pranzo', merenda: 'Merenda', nanna: 'Sonno', nanna_inizio: 'Inizio sonno', nanna_fine: 'Fine sonno', bagno: 'Bagno e cambio', attivita: 'Attività', umore: 'Umore' }
const UMORI: Record<string, string> = { felice: 'Felice', sereno: 'Sereno', cosi_cosi: 'Così così', triste: 'Triste', agitato: 'Agitato' }

type RigaDiario = Record<string, CellaStorico>
interface Partecipante { id: string; valore: string; nota: string }
interface AttivitaDiClasse { riga: RigaDiario; partecipanti: Map<string, Partecipante>; autori: Set<string> }

const bambini = (n: number) => n === 1 ? '1 bambino' : `${n} bambini`

/** Il gruppo più numeroso a conteggio, gli altri per nome; nel dossier per alunno solo conteggi. */
function partecipazione(ctx: ContestoStorico, partecipanti: Partecipante[], conNomi: boolean): string {
  const gruppi = new Map<string, string[]>()
  for (const p of partecipanti) gruppi.set(p.valore, [...(gruppi.get(p.valore) ?? []), p.id])
  const ordinati = [...gruppi.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  if (ordinati.length === 1) {
    const [valore, ids] = ordinati[0]
    if (!valore) return bambini(ids.length)
    return `${valore}: ${ids.length === 1 ? (conNomi ? nome(ctx, ids[0]) : bambini(1)) : `tutti i ${bambini(ids.length)}`}`
  }
  return ordinati.map(([valore, ids], i) =>
    `${valore || 'Senza indicazione'}: ${i === 0 || !conNomi ? bambini(ids.length) : ids.map(id => nome(ctx, id)).join(', ')}`).join(' · ')
}

export async function diario(ctx: ContestoStorico, categoria: CategoriaStorico): Promise<SezioneStorico> {
  const s = nuovaSezione(categoria, { data: 'Data', alunno: 'Alunno', tipo: 'Voce', inizio: 'Inizio', fine: 'Fine',
    dettaglio: 'Dettaglio', valore: 'Valore registrato', notaIndividuale: 'Nota individuale', autore: 'Registrato da' })
  const inizio = intervalloGiornoRoma(ctx.richiesta.dal).startOfDay
  const fine = intervalloGiornoRoma(ctx.richiesta.al).endOfDay
  const righe = await perIds(ctx, 'eventi_diario', 'alunno_id', idsAlunni(ctx), q => q.gte('orario_inizio', inizio).lte('orario_inizio', fine))
  const autori = await persone(ctx, righe.map(r => testo(r.maestra_id)))
  righe.sort((a, b) => testo(a.orario_inizio).localeCompare(testo(b.orario_inizio)) || testo(a.id).localeCompare(testo(b.id)))
  // L'app delle educatrici salva attività e nota di sezione su ogni bambino: nella stampa di
  // classe si leggono una volta. La stampa di un solo alunno resta riga per riga.
  const diClasse = !ctx.richiesta.alunnoId
  const perAlunno = diClasse && ctx.richiesta.raggruppamento === 'alunno'
  const attivitaDiClasse = new Map<string, AttivitaDiClasse>()
  const noteDelGiorno = new Set<string>()
  let lette = 0
  const notaDiSezione = (data: string, nota: string, autore: string) => {
    const chiave = JSON.stringify([data, nota])
    if (!nota || noteDelGiorno.has(chiave)) return
    noteDelGiorno.add(chiave)
    s.righe.push({ _ambito: 'classe', _nota_giorno: true, data, alunno: '', tipo: 'Nota di sezione', inizio: null, fine: null,
      dettaglio: nota, valore: null, notaIndividuale: '', autore })
  }
  const attivita = (base: RigaDiario, voce: string, dettaglio: string, valore: CellaStorico, oraInizio: CellaStorico, oraFine: CellaStorico) => {
    const propria = { ...base, tipo: voce, dettaglio, valore, inizio: oraInizio, fine: oraFine }
    if (!diClasse) { s.righe.push(propria); return }
    lette++
    const chiave = JSON.stringify([base.data, voce, oraInizio, oraFine, dettaglio])
    let gruppo = attivitaDiClasse.get(chiave)
    if (!gruppo) {
      gruppo = { riga: { _ambito: 'classe', data: base.data, alunno: '', tipo: voce, inizio: oraInizio, fine: oraFine, dettaglio,
        valore: '', notaIndividuale: '', autore: '' }, partecipanti: new Map(), autori: new Set() }
      attivitaDiClasse.set(chiave, gruppo)
      s.righe.push(gruppo.riga)
    }
    const id = testo(base._alunno_id)
    if (!gruppo.partecipanti.has(id)) gruppo.partecipanti.set(id, { id, valore: testo(valore), nota: testo(base.notaIndividuale) })
    if (testo(base.autore)) gruppo.autori.add(testo(base.autore))
    if (perAlunno) s.righe.push({ ...propria, dettaglio: '' })
  }
  for (const r of righe) {
    const data = giorno(r.orario_inizio), id = testo(r.alunno_id), tipo = testo(r.tipo_evento)
    if (!ammesso(ctx, id, data) || (TIPI[categoria] && !TIPI[categoria]?.includes(tipo))) continue
    if (categoria === 'diario_routine' && !tipo.startsWith('routine:')) continue
    if (categoria === 'diario_note' && !testo(r.nota_bambino) && !testo(r.nota_libera)) continue
    const d = oggetto(r.dettagli)
    const base: RigaDiario = { _alunno_id: id, data, alunno: nome(ctx, id), tipo: NOMI[tipo] ?? (testo(d.nome) || tipo), inizio: oraDiRoma(testo(r.orario_inizio)),
      fine: oraDiRoma(testo(r.orario_fine)), dettaglio: null, valore: null,
      notaIndividuale: testo(r.nota_bambino), autore: autori.get(testo(r.maestra_id)) ?? '' }
    notaDiSezione(data, testo(r.nota_libera), testo(base.autore))
    if (categoria === 'diario_note' && !testo(r.nota_bambino)) continue
    if (tipo === 'attivita' && categoria !== 'diario_note') {
      for (const a of elenco(d.activities)) attivita(base, testo(a.tipo) || 'Attività', testo(a.descrizione), cella(a.partecipazione), testo(a.ora_inizio) || base.inizio, testo(a.ora_fine) || base.fine)
      if (!elenco(d.activities).length) attivita(base, testo(base.tipo), testo(d.descrizione), cella(d.partecipazione), base.inizio, base.fine)
    } else if (['pranzo', 'merenda'].includes(tipo)) {
      const corsi = oggetto(d.corsi)
      const porzioni = ['primo', 'secondo', 'contorno', 'frutta', 'pane', 'acqua', 'merenda'].map(k => `${k}: ${testo(corsi[k]) || testo(d[k])}`).filter(t => !t.endsWith(': '))
      s.righe.push({ ...base, dettaglio: porzioni.join('; ') || testo(d.menu) || testo(d.descrizione), valore: cella(d.quantita ?? d.valore ?? d.pasto) })
    } else if (tipo === 'bagno') {
      s.righe.push({ ...base, dettaglio: [d.tipo, d.consistenza, d.note].map(testo).filter(Boolean).join('; '), valore: cella(d.volte ?? d.quantita ?? d.count ?? d.valore),
        pipi: cella(d.pipi), cacca: cella(d.cacca), cambi: cella(d.cambi), vasino: cella(d.vasino) })
    } else if (tipo.startsWith('nanna')) {
      s.righe.push({ ...base, inizio: testo(d.orario_inizio) || null, fine: testo(d.orario_fine) || null, dettaglio: testo(d.qualita) || testo(d.note), valore: cella(d.durata) })
    } else if (tipo === 'umore') s.righe.push({ ...base, valore: UMORI[testo(d.umore)] ?? testo(d.umore) })
    else s.righe.push({ ...base, dettaglio: testo(d.nome) || testo(d.descrizione),
      valore: Array.isArray(d.valore) ? d.valore.map(cella).filter(v => v !== null).join(', ') : cella(d.valore) })
  }
  for (const g of attivitaDiClasse.values()) {
    const partecipanti = [...g.partecipanti.values()]
    g.riga.valore = partecipazione(ctx, partecipanti, !perAlunno)
    g.riga.notaIndividuale = perAlunno ? '' : partecipanti.filter(p => p.nota).map(p => `${nome(ctx, p.id)}: ${p.nota}`).join(' · ')
    g.riga.autore = [...g.autori].join(', ')
  }
  if (attivitaDiClasse.size) logEvento('registro', 'info', { operazione: 'storici/diario-accorpa', esito: 'attivita-di-classe', n: lette, gruppi: attivitaDiClasse.size })
  if (categoria === 'diario_bagno') s.colonne.push({ chiave: 'pipi', titolo: 'Pipì' }, { chiave: 'cacca', titolo: 'Cacca' }, { chiave: 'cambi', titolo: 'Cambi' }, { chiave: 'vasino', titolo: 'Vasino' })
  return s
}
```

Nota: nel ramo `diario_note` le righe con sola nota di sezione si fermano dopo `notaDiSezione`; quelle con nota individuale proseguono nei rami di tipo come oggi (l'attività cade nel ramo generico perché `categoria === 'diario_note'`).

- [ ] **Step 4: test verdi**

Run: `npx vitest run __tests__/lib/storici-scolastici.test.ts`
Expected: `Test Files  1 passed (1)`, tutti verdi (anche i vecchi test del diario: non usano `nota_libera` né attività).

- [ ] **Step 5: prova che i test mordono** — rimettere per un attimo `const diClasse = false` e rilanciare: i test «in stampa di classe…», «tutti…» e «dossier per alunno…» devono diventare rossi. Ripristinare.

- [ ] **Step 6: commit**

```bash
git add src/lib/storici/adattatori/scolastici-diario.ts __tests__/lib/storici-scolastici.test.ts
git commit -m "fix(storici): attività e nota di sezione del diario una volta sola"
```

### Task 2: il diario accorpato nel dossier per alunno

**Files:**
- Test: `__tests__/lib/storici-generazioni.test.ts` (dopo «non genera schede vuote…», riga ~132)

È un test di caratterizzazione: `raggruppaPerAlunno` non cambia, ma deve restare vero per il diario.

- [ ] **Step 1: test**

```ts
  it('porta attività e note di sezione del diario nel blocco comune e lascia ai bambini le loro righe', () => {
    const a = archivio(lavoro()), altro = 'altro-alunno'
    a.ctx.richiesta = { ...a.ctx.richiesta, alunnoId: undefined, sectionId: SEDE, raggruppamento: 'alunno' }
    a.ctx.alunni.push({ ...a.ctx.alunni[0], id: altro, nome: 'Altro' })
    const s = sezione('diario_attivita')
    s.righe = [{ _ambito: 'classe', _nota_giorno: true, data: '2026-09-10', dettaglio: 'Uscita in giardino' },
      { _ambito: 'classe', data: '2026-09-10', tipo: 'Pittura', dettaglio: 'Colori a dita', valore: 'Ha partecipato: 2 bambini' },
      { _alunno_id: ALUNNO, data: '2026-09-10', tipo: 'Pittura', dettaglio: '', valore: 'Ha partecipato' },
      { _alunno_id: altro, data: '2026-09-10', tipo: 'Pittura', dettaglio: '', valore: 'Ha partecipato' }]
    const risultato = raggruppaPerAlunno([s], a.ctx)
    expect(risultato.map(r => r.righe.length)).toEqual([2, 1, 1])
    expect(risultato[0].titolo).toContain('contenuti comuni di classe')
    expect(risultato.slice(1).flatMap(r => r.righe).every(r => r.dettaglio === '')).toBe(true)
  })
```

- [ ] **Step 2: eseguirlo** — `npx vitest run __tests__/lib/storici-generazioni.test.ts` → verde (caratterizza il comportamento esistente). Prova del morso: in `raggruppaPerAlunno` togliere `r._ambito !== 'classe' &&` dal filtro delle schede → il test diventa rosso (righe `[2, 3, 3]`). Ripristinare.

- [ ] **Step 3: commit**

```bash
git add __tests__/lib/storici-generazioni.test.ts
git commit -m "test(storici): il diario accorpato resta nel blocco comune del dossier"
```

### Task 3: impaginazione per giorno

**Files:**
- Modify: `src/lib/storici/impaginazione-pdf.ts` (intero, `render.ts` invariato)
- Test: `__tests__/lib/storici-pdf-impaginazione.test.ts`

- [ ] **Step 1: test** — nel file di test:

1. la fixture `presenze` varia i valori (altrimenti con le nuove regole le sue colonne costanti salirebbero in testata e il test dell'intestazione ripetuta non misurerebbe più niente):

```ts
  righe: Array.from({ length: 90 }, (_, i) => ({ c0: `Alunno sintetico ${i + 1}`, c1: i % 2 ? '2026-10-15' : '2026-10-16', c2: i % 3 ? 'Presente' : 'Assente',
    c3: i % 3 ? '08:30' : '', c4: i % 3 ? `16:0${i % 10}` : '', c5: i % 3 ? 'Attività regolare' : 'Giustificata' })),
```

2. un aiuto per le aree sicure, estratto dal test esistente «mantiene corpo almeno 10 pt…» (che poi lo chiama):

```ts
function nelleAreeSicure(pagine: Awaited<ReturnType<typeof leggi>>) {
  for (const p of pagine) {
    const orizzontale = p.width > p.height
    const { marchio, piede } = fasceVietate(297, 210)
    const sx = orizzontale ? marchio.sinistra + marchio.larghezza + 4 : CARTA.margineSx
    const dx = orizzontale ? piede.sinistra - 4 : CARTA.margineDx
    for (const item of p.items) {
      const footer = /^\d+ \/ \d+$/.test(item.str)
      const corpo = Math.hypot(item.transform[0], item.transform[1])
      if (!footer) expect(corpo).toBeGreaterThanOrEqual(10)
      expect(item.transform[4] / MM).toBeGreaterThanOrEqual(sx - .2)
      expect((item.transform[4] + item.width) / MM).toBeLessThanOrEqual(dx + .2)
      const y = (p.height - item.transform[5]) / MM
      if (footer) expect(y).toBeCloseTo(orizzontale ? 201 : CARTA.rigaServizio, 1)
      else expect(y).toBeLessThanOrEqual(orizzontale ? 195 : CARTA.contenutoFine)
    }
  }
}
```

3. il test «rende lezioni e diario come schede…» diventa «rende lezione e diario in tabella con testo integro e tutti i metadati»: stessi valori attesi, più `expect(tutto).not.toContain('Registrazione 1')`, `expect(tutto).toContain('Giovedì 15 ottobre 2026')`, e al posto della larghezza piena (`> 140 * MM`) la colonna argomento larga almeno 60 mm: `expect(Math.max(...corpo.map(i => i.width))).toBeGreaterThan(60 * MM)`. Si toglie l'asserzione «solo verticale» (una lezione con 12 colonne va in orizzontale).

4. tre test nuovi:

```ts
  const giorni = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']
  const materie = ['Italiano', 'Matematica', 'Storia', 'Inglese', 'Scienze']
  const registroDiClasse: SezioneStorico = { ...lezione, titolo: 'Registro di classe sintetico',
    righe: giorni.flatMap(data => materie.map((materia, i) => ({ _ambito: 'classe', data, alunno: '', classe: 'Terza A', ora: i + 1, materia, ambito: 'Classe',
      argomento: `Lettura e comprensione del brano di ${materia.toLowerCase()}, discussione guidata in classe.`, compiti: i % 2 ? 'Esercizi pag. 42 n. 1-5' : '',
      consegna: i % 2 ? '2026-10-19' : '', docente: 'Docente sintetico', tipoFirma: '', firmatoIl: '', allegati: '', richiedeFirma: false }))) }

  it('impagina il registro di classe per giorno: poche pagine, niente colonne vuote, valori comuni in testata', async () => {
    const { bytes } = await creaPdfStorico(base(registroDiClasse), db)
    const pagine = await leggi(bytes)
    const tutto = pagine.map(p => p.testo).join(' ')
    expect(pagine.length).toBeLessThanOrEqual(8)
    expect(tutto).not.toMatch(/Registrazione \d/)
    for (const titolo of ['Tipo firma', 'Firmato il', 'Alunno', 'Allegati']) expect(pagine.flatMap(p => p.items).some(i => i.str === titolo)).toBe(false)
    expect(tutto.match(/Classe: Terza A/g)).toHaveLength(1)
    for (const g of ['Lunedì 5 ottobre 2026', 'Venerdì 16 ottobre 2026']) expect(tutto).toContain(g)
    expect((tutto.match(/Lettura e comprensione del brano/g) ?? []).length).toBe(50)
    nelleAreeSicure(pagine)
    await salva('registro-di-classe-per-giorno.pdf', bytes)
  })

  it('stampa una volta per giorno la nota di sezione e fuori dalla tabella', async () => {
    const diario: SezioneStorico = { categoria: 'diario_attivita', titolo: 'Attività sintetiche', allegati: [], avvisi: [],
      colonne: Object.entries({ data: 'Data', alunno: 'Alunno', tipo: 'Voce', inizio: 'Inizio', fine: 'Fine', dettaglio: 'Dettaglio', valore: 'Valore registrato', notaIndividuale: 'Nota individuale', autore: 'Registrato da' }).map(([chiave, titolo]) => ({ chiave, titolo })),
      righe: giorni.flatMap(data => [
        { _ambito: 'classe', _nota_giorno: true, data, alunno: '', tipo: 'Nota di sezione', dettaglio: `Nota del ${data}`, autore: 'Educatrice sintetica' },
        ...['Pittura con le dita', 'Canzoni in cerchio'].map((tipo, i) => ({ _ambito: 'classe', data, alunno: '', tipo, inizio: i ? '11:00' : '10:00', fine: i ? '11:30' : '10:45',
          dettaglio: `${tipo}: colori e suoni`, valore: 'Ha partecipato: 15 bambini · Con entusiasmo: Alunno uno, Alunno due', notaIndividuale: '', autore: 'Educatrice sintetica' })),
      ]) }
    const { bytes } = await creaPdfStorico(base(diario), db)
    const pagine = await leggi(bytes)
    const tutto = pagine.map(p => p.testo).join(' ')
    for (const data of giorni) expect(tutto.split(`Nota del ${data}`)).toHaveLength(2)
    expect(tutto.match(/Registrato da: Educatrice sintetica/g)).toHaveLength(1)
    expect(pagine.flatMap(p => p.items).some(i => i.str === 'Orario')).toBe(true)
    expect((tutto.match(/Pittura con le dita: colori e suoni/g) ?? []).length).toBe(10)
    expect(pagine.length).toBeLessThanOrEqual(8)
    nelleAreeSicure(pagine)
    await salva('diario-attivita-per-giorno.pdf', bytes)
  })

  it('su un giorno che continua al foglio dopo ripete titolo del giorno e intestazione', async () => {
    const lungo: SezioneStorico = { ...registroDiClasse, righe: Array.from({ length: 40 }, (_, i) => ({ ...registroDiClasse.righe[i % 5], data: '2026-10-05', ora: i + 1, argomento: `${argomento.slice(0, 600)} ${i}` })) }
    const pagine = await leggi((await creaPdfStorico(base(lungo), db)).bytes)
    const continua = pagine.filter(p => p.testo.includes('Lunedì 5 ottobre 2026 (continua)'))
    expect(continua.length).toBeGreaterThan(0)
    for (const p of continua) for (const titolo of ['Ora', 'Materia', 'Argomento']) expect(p.items.some(i => i.str === titolo)).toBe(true)
    nelleAreeSicure(pagine)
  })
```

- [ ] **Step 2: eseguirli e vederli fallire**

Run: `npx vitest run __tests__/lib/storici-pdf-impaginazione.test.ts`
Expected: FAIL — oggi 34 pagine, «Registrazione 1», nota di sezione in ogni scheda.

- [ ] **Step 3: implementazione** — `impaginazione-pdf.ts` diventa (le prime tre funzioni restano identiche):

```ts
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { CARTA, fasceVietate } from '@/lib/carta/geometria'
import type { CellaStorico, ColonnaStorico, DocumentoStorico, SezioneStorico } from './tipi'

export const testoPdf = (v: unknown) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

/** Le date archiviate restano intatte; solo la loro rappresentazione è italiana. */
export function valorePdf(v: unknown): string { /* invariata */ }

/** La carta orizzontale ha logo e piede ai lati, non in testa e in fondo. */
export function areaPdf(orizzontale: boolean) { /* invariata */ }

type RigaStampa = Record<string, CellaStorico>
export interface ColonneStampa { colonne: ColonnaStorico[]; righe: RigaStampa[]; costanti: string[] }

/** Testo descrittivo: va a capo nella cella e non sale mai in testata. */
const CHIAVI_LUNGHE = /^(argomento|compiti|testo|nota|note|notaIndividuale|contenuto|corpo|descrizione|dettaglio|obiettivi|allegati)$/i
/** Colonne brevi a larghezza fissa, in mm: il resto del foglio va al testo. */
const LARGHEZZE: Record<string, number> = { _n: 10, ora: 12, orario: 26, consegna: 24 }
const VERDE: [number, number, number] = [27, 90, 65]
const NUMERO: ColonnaStorico = { chiave: '_n', titolo: 'N.' }

const estesa = (c: ColonnaStorico, righe: RigaStampa[]) => righe.some(r => { const v = valorePdf(r[c.chiave]); return v.length > 120 || /[\r\n]/.test(v) })
const lunga = (c: ColonnaStorico, righe: RigaStampa[]) => CHIAVI_LUNGHE.test(c.chiave) || estesa(c, righe)

/** Niente colonne vuote, inizio e fine in un orario solo, valori comuni a tutte le righe in testata. */
export function preparaColonne(colonne: ColonnaStorico[], righe: RigaStampa[], perGiorno = false): ColonneStampa {
  let cols = [...colonne], rows = righe
  if (cols.some(c => c.chiave === 'inizio') && cols.some(c => c.chiave === 'fine')) {
    rows = rows.map(r => ({ ...r, orario: [valorePdf(r.inizio), valorePdf(r.fine)].filter(Boolean).join('–') }))
    cols = cols.flatMap(c => c.chiave === 'inizio' ? [{ chiave: 'orario', titolo: 'Orario' }] : c.chiave === 'fine' ? [] : [c])
  }
  cols = cols.filter(c => rows.some(r => valorePdf(r[c.chiave]).trim() !== ''))
  const costanti: string[] = []
  if (rows.length >= 2) cols = cols.filter(c => {
    if ((perGiorno && c.chiave === 'data') || lunga(c, rows)) return true
    const primo = valorePdf(rows[0][c.chiave])
    if (rows.some(r => valorePdf(r[c.chiave]) !== primo)) return true
    costanti.push(`${testoPdf(c.titolo)}: ${primo}`)
    return false
  })
  return { colonne: cols, righe: rows, costanti }
}

const chiaveGiorno = (v: unknown) => { const s = testoPdf(v); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s }

/** «Lunedì 5 ottobre 2026»: il giorno si legge, non si decifra. */
export function titoloGiorno(data: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data)
  if (!m) return data ? valorePdf(data) : 'Senza data'
  const s = new Intl.DateTimeFormat('it-IT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    .format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))))
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Flusso dei contenuti: un titolo per giorno e tabelle a corpo fisso, nessun taglio. */
export class ImpaginazioneStoricoPdf {
  readonly doc = new jsPDF({ unit: 'mm', format: 'a4' })
  private y = 0
  private titolo = ''

  constructor(private documento: Pick<DocumentoStorico, 'scuolaNome' | 'dal' | 'al'>) {}

  private orizzontale(): boolean { return this.doc.internal.pageSize.getWidth() > this.doc.internal.pageSize.getHeight() }

  private testata(titolo: string, disegna = true): number {
    const area = areaPdf(this.orizzontale())
    const larghezza = area.dx - area.sx
    this.doc.setFont('helvetica', 'bold').setFontSize(15)
    const righe = this.doc.splitTextToSize(testoPdf(titolo), larghezza) as string[]
    if (disegna) this.doc.text(righe, area.sx, area.titoloY, { lineHeightFactor: 1.2 })
    const y = area.titoloY + righe.length * 6.35
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    const contesto = this.doc.splitTextToSize(`${this.documento.scuolaNome} · ${valorePdf(this.documento.dal)} / ${valorePdf(this.documento.al)}`, larghezza) as string[]
    if (disegna) this.doc.text(contesto, area.sx, y, { lineHeightFactor: 1.2 })
    return y + contesto.length * 4.24 + 5
  }

  nuovaPagina(titolo: string, prima = false) {
    if (!prima) this.doc.addPage('a4', 'portrait')
    this.titolo = titolo
    this.y = this.testata(titolo)
  }

  /** Foglio successivo con lo stesso orientamento e la stessa testata. */
  private continua() {
    this.doc.addPage('a4', this.orizzontale() ? 'landscape' : 'portrait')
    this.y = this.testata(this.titolo)
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
  }

  testo(valore: unknown, titolo?: string) {
    const area = areaPdf(this.orizzontale())
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    const righe = this.doc.splitTextToSize(valorePdf(valore) || '—', area.dx - area.sx) as string[]
    // L'etichetta e le prime righe del blocco restano sullo stesso foglio.
    if (this.y + (titolo ? 6 : 0) + Math.min(2, righe.length) * 5 > area.fondo) this.continua()
    if (titolo) {
      this.doc.setFont('helvetica', 'bold').setFontSize(10)
      const etichetta = this.doc.splitTextToSize(testoPdf(titolo), area.dx - area.sx) as string[]
      for (const riga of etichetta) {
        if (this.y + 5 > area.fondo) this.continua()
        this.doc.text(riga, area.sx, this.y)
        this.y += 5
      }
    }
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    for (const riga of righe) {
      if (this.y + 5 > area.fondo) {
        this.continua()
        if (titolo) {
          this.doc.setFont('helvetica', 'bold').setFontSize(10)
          this.doc.text(`${titolo} (continua)`, area.sx, this.y)
          this.y += 6
          this.doc.setFont('helvetica', 'normal').setFontSize(10)
        }
      }
      this.doc.text(riga, area.sx, this.y)
      this.y += 5
    }
    this.y += 3
  }

  /** Apre la sezione; i valori uguali su tutte le righe si leggono una volta sotto il titolo. */
  private apriSezione(titolo: string, costanti: string[], orizzontale: boolean) {
    this.doc.addPage('a4', orizzontale ? 'landscape' : 'portrait')
    this.titolo = titolo
    this.y = this.testata(titolo)
    if (!costanti.length) return
    const area = areaPdf(orizzontale)
    this.doc.setFont('helvetica', 'normal').setFontSize(10)
    const righe = this.doc.splitTextToSize(costanti.join(' · '), area.dx - area.sx) as string[]
    this.doc.text(righe, area.sx, this.y, { lineHeightFactor: 1.2 })
    this.y += righe.length * 4.24 + 3
  }

  private titoloDelGiorno(etichetta: string) {
    const area = areaPdf(this.orizzontale())
    // Titolo, intestazione e almeno una riga sullo stesso foglio.
    if (this.y + 25 > area.fondo) this.continua()
    this.doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...VERDE)
    this.doc.text(etichetta, area.sx, this.y)
    this.doc.setTextColor(0).setFont('helvetica', 'normal').setFontSize(10)
    this.y += 6
  }

  private tabella(colonne: ColonnaStorico[], righe: RigaStampa[], giorno = '') {
    const orizzontale = this.orizzontale()
    const area = areaPdf(orizzontale)
    if (this.y + 18 > area.fondo) {
      this.continua()
      if (giorno) this.titoloDelGiorno(`${giorno} (continua)`)
    }
    const titolo = this.titolo
    const primaPagina = this.doc.getCurrentPageInfo().pageNumber
    autoTable(this.doc, {
      startY: this.y,
      head: [colonne.map(c => testoPdf(c.titolo))],
      body: righe.map(r => colonne.map(c => valorePdf(r[c.chiave]))),
      margin: { left: area.sx, right: (orizzontale ? 297 : 210) - area.dx, top: this.testata(titolo, false) + (giorno ? 6 : 0), bottom: area.altezza - area.fondo },
      styles: { fontSize: 10, cellPadding: 1.8, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: VERDE, fontSize: 10 },
      columnStyles: Object.fromEntries(colonne.flatMap((c, i) => LARGHEZZE[c.chiave] ? [[i, { cellWidth: LARGHEZZE[c.chiave] }]] : [])),
      showHead: 'everyPage',
      // Una riga lunga continua sul foglio dopo: nessun testo tagliato.
      rowPageBreak: 'auto',
      willDrawPage: () => {
        if (this.doc.getCurrentPageInfo().pageNumber === primaPagina) return
        const y = this.testata(titolo)
        if (!giorno) return
        this.doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...VERDE)
        this.doc.text(`${giorno} (continua)`, area.sx, y)
        this.doc.setTextColor(0).setFont('helvetica', 'normal').setFontSize(10)
      },
    })
    const fine = (this.doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY
    this.y = (fine ?? this.y) + 6
  }

  /** Un titolo per giorno, la nota di sezione una volta, poi la tabella delle registrazioni. */
  private perGiorno(titolo: string, colonne: ColonnaStorico[], righe: RigaStampa[], costanti: string[] = []) {
    const note = righe.filter(r => r._nota_giorno === true)
    const pronte = preparaColonne(colonne, righe.filter(r => r._nota_giorno !== true), true)
    const tabella = pronte.colonne.filter(c => c.chiave !== 'data')
    this.apriSezione(titolo, [...costanti, ...pronte.costanti], tabella.length > 5)
    if (!note.length && !pronte.colonne.some(c => c.chiave === 'data')) {
      if (tabella.length) this.tabella(tabella, pronte.righe)
      return
    }
    const giorni = new Map<string, { note: RigaStampa[]; righe: RigaStampa[] }>()
    const gruppo = (data: unknown) => {
      const chiave = chiaveGiorno(data)
      const g = giorni.get(chiave) ?? { note: [], righe: [] }
      giorni.set(chiave, g)
      return g
    }
    for (const r of righe) gruppo(r.data)
    for (const n of note) gruppo(n.data).note.push(n)
    for (const r of pronte.righe) gruppo(r.data).righe.push(r)
    for (const [giorno, g] of giorni) {
      const etichetta = titoloGiorno(giorno)
      this.titoloDelGiorno(etichetta)
      for (const n of g.note) this.testo(n.dettaglio, 'Nota di sezione')
      if (g.righe.length && tabella.length) this.tabella(tabella, g.righe, etichetta)
    }
  }

  sezione(sezione: SezioneStorico) {
    if (!sezione.righe.length || !sezione.colonne.length) {
      this.nuovaPagina(sezione.titolo)
      this.testo(sezione.allegati.length || sezione.generati?.length
        ? 'Nessuna registrazione tabellare; gli allegati sono inclusi nella raccolta, con eventuali avvertenze di completezza nell’indice.'
        : 'Nessuna registrazione disponibile nel periodo scelto.')
      return
    }
    const narrativa = sezione.categoria.startsWith('diario_') || sezione.colonne.some(c => /^(argomento|compiti)$/.test(c.chiave)) || sezione.categoria === 'primaria_note'
    if (narrativa) { this.perGiorno(sezione.titolo, sezione.colonne, sezione.righe); return }
    const pronte = preparaColonne(sezione.colonne, sezione.righe)
    const estese = pronte.colonne.filter(c => estesa(c, pronte.righe))
    const compatte = pronte.colonne.filter(c => !estese.includes(c))
    const tabella = compatte.slice(0, 7)
    const dettagli = [...compatte.slice(7), ...estese]
    if (!tabella.length) { this.perGiorno(sezione.titolo, pronte.colonne, pronte.righe, pronte.costanti); return }
    const righe = dettagli.length ? pronte.righe.map((r, i) => ({ ...r, _n: String(i + 1) })) : pronte.righe
    this.apriSezione(sezione.titolo, pronte.costanti, true)
    this.tabella([...(dettagli.length ? [NUMERO] : []), ...tabella], righe)
    if (dettagli.length) this.perGiorno(`${sezione.titolo} · Dettagli delle registrazioni`, [NUMERO, tabella[0], ...dettagli], righe)
  }
}
```

- [ ] **Step 4: test verdi** — comando del lavoro (sopra). Expected: 5 file, tutti verdi.

- [ ] **Step 5: prova del morso** — rimettere `if (rows.length >= 2)` a `if (rows.length >= 99999)` in `preparaColonne`: «Classe: Terza A» e «Registrato da» devono diventare rossi. Ripristinare.

- [ ] **Step 6: controllo a occhio** — `STORICI_PDF_VISIVO_DIR=<scratchpad>/visivo npx vitest run __tests__/lib/storici-pdf-impaginazione.test.ts`, poi `pdftoppm -r 60 -png` sulle prime pagine dei PDF salvati e lettura delle immagini: giorni leggibili, colonne non schiacciate, niente sovrapposizioni con marchio e piede.

- [ ] **Step 7: commit**

```bash
git add src/lib/storici/impaginazione-pdf.ts __tests__/lib/storici-pdf-impaginazione.test.ts
git commit -m "fix(storici): stampe impaginate per giorno in tabella, senza colonne vuote"
```

### Task 4: PRD, gate, rilascio

- [ ] **Step 1: PRD** — in testa a `PRD REGISTRO ELETTRONICO.md` una voce «🖨️ Changelog — Stampe degli storici per giorno, attività di sezione una volta sola — 2026-10-18 (branch `fix/storici-impaginazione-per-giorno`)» con stato, cosa cambia (diario, impaginazione), numeri prima/dopo e collaudo; nelle voci del 17/10 e del 16/10 la riga **Stato** diventa «✅ in produzione dal 18/10/2026 — PR #237 (`b5243a31`)».
- [ ] **Step 2: gate** — `npx eslint . --max-warnings 0`, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`, `npx vitest run`, `NODE_OPTIONS=--max-old-space-size=8192 npm run build`. Tutti verdi, con l'uscita letta e non dedotta.
- [ ] **Step 3: commit PRD**, push del branch, PR verso `main`, CI tutta verde (E2E compresi), merge a mano, verifica del deploy su Vercel, pulizia dei branch (locale e remoto).
