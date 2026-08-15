import { describe, it, expect } from 'vitest'
import {
  INSEGNANTE_FIELDS,
  CONSENSI_INSEGNANTI_FIELDS,
  CONSENSI_INSEGNANTI_VERSIONE,
  GRADI_OPTIONS,
  POSIZIONI_OPTIONS,
  POSIZIONI_AMMESSE,
  GRADO_DELLA_POSIZIONE,
  gradiDallePosizioni,
  comprendeInsegnamento,
  TITOLI_STUDIO,
  CANDIDATURA_LIMITI,
} from '@/lib/forms/insegnanti-template'
import { validateField } from '@/lib/forms/validate-fields'
import { campiVisibili, campoVisibile } from '@/lib/forms/conditional'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { EVENTI_NOTI, EVENTI_PERSISTITI } from '@/lib/logging/logger'
import { ESTENSIONI_ALLEGATO_PUBBLICO } from '@/lib/upload/allegati-pubblici'
import { LIMITE_UPLOAD_MB, limiteUploadByte } from '@/lib/upload/limite-piattaforma'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import schemaSnapshot from '../fixtures/candidature-schema-snapshot.json'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

/**
 * Il modulo pubblico di candidatura delle insegnanti (`/lavora-con-noi`).
 *
 * Questo file sorveglia le FONDAMENTA condivise — il template dei campi, i
 * consensi, il vocabolario dei log e i codici d'errore — cioè le tre cose che
 * route e interfaccia importeranno senza poterle ridiscutere.
 *
 * ── PERCHÉ C'È UNA FOTOGRAFIA DELLO SCHEMA, E NON UN ELENCO RIBATTUTO A MANO ──
 *
 * La prima versione di questo file confrontava gli id con un elenco copiato a mano
 * e derivava `db_mapping` dall'id stesso (`toBe(`candidature_insegnanti.${f.id}`)`):
 * una tautologia, verde qualunque cosa ci fosse scritto. Aggiungere una quarta
 * fascia d'età o rinominare un id avrebbe lasciato l'albero verde e ucciso il primo
 * invio vero con `PGRST204` o `22P02` — cioè esattamente la classe di difetto che
 * questa corsia dichiara di voler prevenire.
 *
 * Ora l'atteso viene da `__tests__/fixtures/candidature-schema-snapshot.json`,
 * scattato dal DB di produzione con `candidature-schema-fotografia.mjs` (stessa
 * forma dei fixture già in uso per migrazioni, RLS e FK di sede). Il lock gira
 * offline: in CI le credenziali di produzione non ci sono e non devono esserci.
 *
 * ── E DAL 2026-08-15 SI LEGGE ANCHE LA MIGRAZIONE ────────────────────────────
 *
 * L'elenco chiuso delle POSIZIONI è scritto in tre posti — il template (ciò che
 * si offre), la migrazione (ciò che si è scritto) e la fotografia (ciò che in
 * produzione è stato applicato) — e ognuno dei tre può restare indietro da solo.
 * Il blocco «l'elenco chiuso, letto dalla MIGRAZIONE» li confronta tutti e tre, e
 * la sua ragione d'essere è scritta lì: fino a quel giorno due documenti di
 * prodotto AFFERMAVANO che questo confronto esisteva, e non esisteva.
 */

const campo = (id: string) => INSEGNANTE_FIELDS.find((f) => f.id === id)

/** Le colonne vere della tabella, per nome. */
const COLONNE = new Map(schemaSnapshot.colonne.map((c) => [c.nome, c]))

/** Tutti i sorgenti `.ts`/`.tsx` sotto `src/`, per le prove che leggono il codice. */
function sorgentiSrc(dir = join(process.cwd(), 'src')): string[] {
  const fuori: string[] = []
  for (const voce of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, voce.name)
    if (voce.isDirectory()) fuori.push(...sorgentiSrc(p))
    else if (/\.tsx?$/.test(voce.name)) fuori.push(p)
  }
  return fuori
}

const COME_RIGENERARE =
  'Rigenera la fotografia: `node __tests__/fixtures/candidature-schema-fotografia.mjs --sql` → ' +
  'esegui la query sul DB di produzione (sola lettura) → ' +
  '`node __tests__/fixtures/candidature-schema-fotografia.mjs < risposta.json`.'

/** Il nome del `CHECK` di appartenenza delle posizioni, in migrazione e in tabella. */
const VINCOLO_POSIZIONI = 'candidature_insegnanti_posizioni_note'

/**
 * I letterali fra apici singoli del PRIMO `array[...]`/`ARRAY[...]` che compare
 * DOPO il nome del vincolo. Legge i due dialetti in cui l'elenco è scritto —
 * `array['x', 'y']::text[]` nel file di migrazione e `ARRAY['x'::text, 'y'::text]`
 * come Postgres lo ristampa nella fotografia — perché i cast stanno FUORI dagli
 * apici e non entrano nella cattura.
 *
 * Si parte dal nome del vincolo, quando c'è, e non dall'inizio del frammento:
 * il file di migrazione contiene un altro `array['altro']` prima — quello del
 * backfill — e leggere il primo array del file darebbe una lista di UN elemento,
 * cioè un confronto che fallisce per il motivo sbagliato.
 *
 * Quando il nome NON c'è si legge dall'inizio, ed è il caso della fotografia: là
 * il frammento È già la sola definizione del `CHECK`, che il nome non lo ripete.
 */
function elencoDelVincolo(sql: string): string[] {
  const inizio = sql.indexOf(VINCOLO_POSIZIONI)
  const frammento = inizio < 0 ? sql : sql.slice(inizio)
  const dentro = /\barray\s*\[([\s\S]*?)\]/i.exec(frammento)
  if (!dentro) return []
  return [...dentro[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/**
 * Il file di migrazione che dichiara per ULTIMO il `CHECK` di appartenenza delle
 * posizioni.
 *
 * Si cerca per nome del VINCOLO e non per nome del file: se un domani una seconda
 * migrazione allarga l'elenco (una fascia nuova, un mestiere nuovo), è quella che
 * va confrontata col template — un percorso ribattuto qui continuerebbe a leggere
 * la prima e resterebbe verde su una lista superata.
 */
function migrazioneDellePosizioni(): { nome: string; sql: string } | null {
  const dir = join(process.cwd(), 'supabase', 'migrations')
  const trovate = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((nome) => ({ nome, sql: readFileSync(join(dir, nome), 'utf8') }))
    .filter((f) => new RegExp(`add\\s+constraint\\s+${VINCOLO_POSIZIONI}`, 'i').test(f.sql))
  return trovate.length > 0 ? trovate[trovate.length - 1] : null
}

describe('template di candidatura insegnanti · il legame con lo schema vero', () => {
  it('la fotografia dello schema non è stata addomesticata a mano (sha256)', () => {
    // Senza questa prova basterebbe aggiungere una riga alla fotografia per far
    // tacere il lock su un id inventato: cioè per rimettere il difetto che il lock
    // esiste per impedire. Stesse chiavi e stesso ordine di `normalizza()` in
    // `__tests__/fixtures/candidature-schema-fotografia.mjs`.
    const atteso = createHash('sha256')
      .update(JSON.stringify({
        tabella: schemaSnapshot.tabella,
        colonne: schemaSnapshot.colonne,
        enum_school_type: schemaSnapshot.enum_school_type,
        check: schemaSnapshot.check,
      }))
      .digest('hex')
    expect(schemaSnapshot.sha256, `fotografia modificata a mano. ${COME_RIGENERARE}`).toBe(atteso)
  })

  it('la fotografia è piena e plausibile (se cade, il lock si sta autoingannando)', () => {
    // Un lock che gira su una fotografia vuota passa sempre: è il modo più
    // silenzioso di non controllare niente.
    expect(schemaSnapshot.tabella).toBe('candidature_insegnanti')
    expect(schemaSnapshot.colonne.length, 'fotografia troppo magra').toBeGreaterThan(15)
    expect(schemaSnapshot.enum_school_type.length).toBeGreaterThan(1)
    expect(schemaSnapshot.check.length).toBeGreaterThan(1)
  })

  it('la fotografia esiste accanto al generatore che la sa rifare', () => {
    // Una fotografia senza lo script che la rigenera è una fotografia che, alla
    // prima migrazione, nessuno saprà più aggiornare se non a mano — cioè falsando
    // lo sha256 qui sopra.
    const fixtures = readdirSync(join(process.cwd(), '__tests__', 'fixtures'))
    expect(fixtures).toContain('candidature-schema-fotografia.mjs')
    expect(fixtures).toContain('candidature-schema-snapshot.json')
    const generatore = readFileSync(
      join(process.cwd(), '__tests__', 'fixtures', 'candidature-schema-fotografia.mjs'), 'utf8',
    )
    expect(generatore, 'il generatore non legge più `information_schema`').toContain('information_schema.columns')
    expect(generatore, 'il generatore non legge più le etichette dell’enum').toContain('pg_enum')
  })

  it('ogni id del template è una COLONNA vera di `candidature_insegnanti`', () => {
    const ids = INSEGNANTE_FIELDS.map((f) => f.id)
    expect(new Set(ids).size, 'due campi con lo stesso id: il secondo sovrascriverebbe il primo').toBe(ids.length)
    // È il confronto che conta: un id inventato non fa rosso da nessun'altra parte,
    // PostgREST risponderebbe `PGRST204` sul primo invio vero.
    const inesistenti = ids.filter((id) => !COLONNE.has(id))
    expect(
      inesistenti,
      `campi che puntano a colonne che in produzione NON esistono. ${COME_RIGENERARE}`,
    ).toEqual([])

    for (const f of INSEGNANTE_FIELDS) {
      // L'atteso viene dalla FOTOGRAFIA, non dall'id del campo: derivarlo dall'id
      // renderebbe questa riga una tautologia (era il difetto della prima stesura).
      const colonna = COLONNE.get(f.id)!
      expect(f.db_mapping, `il campo ${f.id} non dichiara la colonna di destinazione`)
        .toBe(`${schemaSnapshot.tabella}.${colonna.nome}`)
    }
  })

  it('nessun campo del template punta a una colonna DI SERVIZIO che la route riempie da sé', () => {
    // `id`, `scuola_id`, `stato`, i timestamp e l'esito dell'istruttoria non sono
    // dati che si chiedono a chi si candida: se uno di questi comparisse fra i
    // campi del modulo, il modulo PUBBLICO permetterebbe di sceglierseli.
    const diServizio = new Set([
      'id', 'scuola_id', 'stato', 'consents_log', 'creata_il', 'aggiornata_il',
      'evasa_il', 'evasa_da', 'utente_id', 'motivo_rifiuto',
    ])
    const intrusi = INSEGNANTE_FIELDS.map((f) => f.id).filter((id) => diServizio.has(id))
    expect(intrusi, 'campi del modulo pubblico su colonne di servizio').toEqual([])
  })

  it('l’ordine dei campi è quello di COMPILAZIONE, non quello delle colonne', () => {
    // Detto qui perché la prima stesura di questo file dichiarava l'elenco
    // «misurato su `information_schema.columns`» e poi lo scriveva in un ordine che
    // NON era quello di `ordinal_position`. I due ordini sono diversi di proposito
    // — il modulo segue la conversazione, la tabella segue la storia delle
    // migrazioni — ma allora l'ordine del modulo non va spacciato per una misura
    // del database.
    const ordinali = INSEGNANTE_FIELDS.map((f) => COLONNE.get(f.id)!.posizione)
    const ordinate = [...ordinali].sort((a, b) => a - b)
    expect(
      ordinali,
      'se un giorno i due ordini coincidessero questa prova andrebbe tolta, non "aggiustata"',
    ).not.toEqual(ordinate)

    // ⚠️ LA COPPIA CHE MOSTRA LA DIVERGENZA È CAMBIATA IL 2026-08-15, E IL VERSO
    // SI È ROVESCIATO. Prima era `gradi`/`titolo_studio`: colonna 10 contro 11 in
    // tabella, e nel modulo `gradi` veniva dopo. Ora `gradi` non è più un campo del
    // modulo (la fascia si deriva dalle posizioni), quindi quella coppia non è più
    // esprimibile qui — l'invariante resta, cambia dove si misura.
    //
    // La coppia di oggi è `posizioni`/`titolo_studio`, ed è la stessa domanda vista
    // dai due lati: «che lavoro vengo a fare» PRIMA di «che titolo ho» nel modulo,
    // mentre in tabella `posizioni` è la colonna 24 — aggiunta in fondo dalla
    // migrazione del 2026-08-15 — e `titolo_studio` la 11. Un `alter table` non
    // riordina niente: è proprio il motivo per cui i due ordini non possono
    // coincidere per costruzione.
    expect(
      COLONNE.get('posizioni')!.posizione,
      `\`posizioni\` non è più in coda alla tabella. ${COME_RIGENERARE}`,
    ).toBeGreaterThan(COLONNE.get('titolo_studio')!.posizione)
    const idsModulo = INSEGNANTE_FIELDS.map((f) => f.id)
    expect(idsModulo.indexOf('posizioni')).toBeGreaterThanOrEqual(0)
    expect(idsModulo.indexOf('posizioni')).toBeLessThan(idsModulo.indexOf('titolo_studio'))
  })
})

describe('template di candidatura insegnanti · i campi', () => {
  it('NON chiede il codice fiscale: serve all’assunzione, non alla candidatura', () => {
    // Minimizzazione (art. 5 §1 lett. c GDPR). Il modulo è PUBBLICO e senza
    // login: un codice fiscale raccolto qui sarebbe un identificativo nazionale
    // in una tabella che chiunque può alimentare.
    const sospetti = INSEGNANTE_FIELDS.filter(
      (f) => /fiscal|codice_fiscale|\bcf\b/i.test(f.id) || /codice fiscale/i.test(f.label),
    )
    expect(sospetti.map((f) => f.id)).toEqual([])
  })

  it('nome, cognome ed email sono obbligatori; residenza e telefono no', () => {
    for (const id of ['nome', 'cognome', 'email']) {
      expect(campo(id)?.required, `${id} dovrebbe essere obbligatorio`).toBe(true)
    }
    for (const id of ['telefono', 'residence_city', 'residence_province', 'cv_path']) {
      expect(campo(id)?.required ?? false, `${id} dovrebbe essere facoltativo`).toBe(false)
    }
    expect(campo('email')?.type).toBe('email')
    expect(campo('telefono')?.type).toBe('phone')
    expect(campo('cv_path')?.type).toBe('file')
  })

  it('la provincia di residenza eredita il comportamento «provincia» dall’id', () => {
    // `isProvinceField` guarda il SUFFISSO `_province`: da lì arrivano gratis
    // l’auto-maiuscolo, lo snap su blur («Napoli» → «NA») e il controllo che la
    // sigla esista davvero. Chiamarlo `provincia_residenza` avrebbe spento tutto
    // in silenzio.
    expect(campo('residence_province')?.id).toMatch(/_province$/)
    expect(validateField(campo('residence_province')!, 'XY')).not.toBeNull()
    expect(validateField(campo('residence_province')!, 'NA')).toBeNull()
    expect(validateField(campo('residence_province')!, ''), 'è facoltativo').toBeNull()
  })

  it('gli anni di esperienza stanno fra 0 e 60, come il CHECK del database', () => {
    const anni = campo('anni_esperienza')!
    expect(anni.type).toBe('number')
    expect(anni.validation?.min).toBe(0)
    expect(anni.validation?.max).toBe(60)
    expect(validateField(anni, 61)).not.toBeNull()
    expect(validateField(anni, -1)).not.toBeNull()
    expect(validateField(anni, 0)).toBeNull()
    expect(validateField(anni, 60)).toBeNull()
  })

  it('la presentazione è una textarea con un tetto di 1000 caratteri', () => {
    const note = campo('note')!
    expect(note.type).toBe('textarea')
    expect(note.validation?.max_length).toBe(1000)
    expect(validateField(note, 'a'.repeat(1001))).not.toBeNull()
    expect(validateField(note, 'a'.repeat(1000))).toBeNull()
  })

  it('titolo di studio e disponibilità sono select chiuse', () => {
    const titolo = campo('titolo_studio')!
    expect(titolo.type).toBe('select')
    expect(titolo.options).toEqual(TITOLI_STUDIO)
    expect(validateField(titolo, 'inventato')).toBe('Selezione non valida')
    expect(validateField(titolo, TITOLI_STUDIO[0].value)).toBeNull()
    expect(campo('disponibilita')?.type).toBe('select')
    expect((campo('disponibilita')?.options ?? []).length).toBeGreaterThan(1)
  })

  it('l’elenco dei titoli comincia dalla LICENZA MEDIA, perché il campo è obbligatorio', () => {
    // Non è una voce in più: è la conseguenza dell'apertura del modulo alle
    // posizioni non docenti. `titolo_studio` è `required: true`, e prima del
    // 2026-08-15 l'elenco cominciava dal diploma — che per un'insegnante è il
    // minimo di legge e per una collaboratrice scolastica o per chi lavora in
    // cucina non lo è. Con quell'elenco l'unica risposta vera per loro era «Altro
    // titolo», cioè dichiarare il proprio titolo come un'eccezione.
    expect(campo('titolo_studio')?.required, 'se diventasse facoltativo questa prova cambia senso').toBe(true)
    const valori = TITOLI_STUDIO.map((t) => String(t.value))
    expect(valori, 'la licenza media è uscita dall’elenco: il modulo torna a chiedere ' +
      'a una collaboratrice di dichiararsi «Altro titolo»').toContain('licenza_media')
    // In TESTA, e l'ordine è l'informazione: l'elenco sale per livello di studio,
    // e un titolo più basso in fondo si legge come un ripensamento.
    expect(valori[0]).toBe('licenza_media')
    expect(validateField(campo('titolo_studio')!, 'licenza_media')).toBeNull()
    expect(new Set(valori).size, 'due titoli con lo stesso `value`').toBe(valori.length)
  })
})

describe('template di candidatura insegnanti · il CV allegato', () => {
  /*
   * PERCHÉ QUESTE QUATTRO RIGHE ESISTONO (rilievo della revisione del 2026-08-10).
   *
   * Il campo `cv_path` era l'unica metà del template che nessuno aveva MISURATO
   * dal lato che conta: lo Storage. Dichiarava `accept: '.pdf,.doc,.docx,.jpg,
   * .jpeg,.png'` e `max_size_mb: 5`, due numeri scritti a occhio, mentre in
   * produzione (misurato il 2026-08-10, `select id, file_size_limit,
   * allowed_mime_types from storage.buckets`):
   *
   *   · NON esiste nessun bucket per i curriculum — la sola strada pubblica di
   *     caricamento del repo scrive in `form_attachments`;
   *   · `form_attachments` ammette 5 tipi e NON comprende né `application/msword`
   *     né `…wordprocessingml.document`, e il gate applicativo gemello
   *     (`ESTENSIONI_ALLEGATO_PUBBLICO`) ammette `pdf jpg jpeg png webp heic`.
   *
   * Quindi il selettore di file OFFRIVA `.doc`/`.docx` — il formato in cui la
   * maggioranza dei curriculum viaggia — su un modulo PUBBLICO, e il server li
   * avrebbe respinti con un 415 DOPO che la persona aveva compilato tutto. È il
   * difetto «bucket più stretto del gate» per cui in questo repo esistono
   * `src/lib/allegati/mime.ts` e il lock `allegati-mime-dichiarati.test.ts`,
   * spostato di un campo. All'opposto `.heic` — il formato che produce l'iPhone,
   * ammesso sia dal gate sia dal bucket — non era offerto.
   */

  /** L'`accept` normalizzato: minuscolo, senza punto, senza spazi. */
  const estensioniOfferte = (): string[] =>
    (campo('cv_path')!.accept ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean)

  it('l’`accept` è ESATTAMENTE l’allowlist pubblica del repo, non una lista sua', () => {
    // Il confronto è con la FONTE, non con una stringa ribattuta qui: chi allarga
    // o stringe `ESTENSIONI_ALLEGATO_PUBBLICO` (e la migrazione del bucket, che il
    // lock `upload-pubblico-con-tetto` tiene allineata a quella costante) rende
    // rossa questa riga invece di lasciare divergere il selettore in silenzio.
    const offerte = estensioniOfferte()
    expect(new Set(offerte).size, 'estensione ripetuta nell’`accept`').toBe(offerte.length)
    expect(
      [...offerte].sort(),
      'il selettore del CV offre estensioni che il gate pubblico (`verificaAllegatoPubblico`) ' +
      'non accetta, o ne nasconde di accettate: chi compila sceglie un file e viene respinto ' +
      'DOPO, con un 415, su un modulo senza login e senza nessuno a cui chiedere.',
    ).toEqual([...ESTENSIONI_ALLEGATO_PUBBLICO].sort())
  })

  it('`.doc` e `.docx` NON si offrono, `.heic` sì (la regressione misurata)', () => {
    // Regressione mirata: il caso concreto, scritto per nome, così una riscrittura
    // dell'`accept` che ripristini il difetto non passi per una svista di elenco.
    const offerte = estensioniOfferte()
    expect(
      offerte.filter((e) => e === 'doc' || e === 'docx'),
      'nessun bucket né gate pubblico di questo repo accetta Word: offrirlo è una promessa ' +
      'che il server rompe. Se il Word deve entrare, si allarga PRIMA la lista del gate e la ' +
      '`allowed_mime_types` del bucket, con la migrazione.',
    ).toEqual([])
    expect(offerte, 'il formato che produce l’iPhone è ammesso dal gate: escluderlo qui ' +
      'respinge una foto del curriculum valida').toContain('heic')
  })

  it('il tetto del CV è una promessa che la PIATTAFORMA può mantenere', () => {
    // IL VINCOLO CHE DECIDE NON È IL BUCKET, ed è la misura che mancava. Il bucket
    // `form_attachments` sta a 8 MB (8388608, misurato), ma sopra il tetto di
    // Vercel la richiesta non arriva MAI alla route: `limiteUploadByte` taglia a
    // 4 MB (`@/lib/upload/limite-piattaforma`, dove il 413 è misurato dal vivo — 41
    // tentativi falliti in un giorno sul modulo pubblico). `max_size_mb: 5`
    // dichiarava quindi un tetto che nessuno poteva mantenere: il `Math.min` lo
    // riportava a 4 e il campo prometteva 5.
    //
    // Questa riga dice esattamente questo: il `Math.min` NON deve mordere. Se
    // qualcuno rialza `maxCvMb` sopra il tetto di piattaforma, diventa rossa.
    const mb = CANDIDATURA_LIMITI.maxCvMb
    expect(mb).toBeGreaterThan(0)
    expect(
      limiteUploadByte(mb),
      `il campo promette ${mb} MB ma la piattaforma ne lascia passare ${LIMITE_UPLOAD_MB}: ` +
      'sopra quel tetto la route non parte nemmeno e il 413 non è nostro (non risponde in JSON).',
    ).toBe(mb * 1024 * 1024)
    // …e il campo dichiara quel numero, non un secondo numero suo.
    expect(campo('cv_path')?.max_size_mb).toBe(mb)
  })

  it('il template PRESCRIVE alla route il bucket e il gate, come fa per le `posizioni`', () => {
    // Un commento è una prescrizione solo se qualcuno si accorge quando sparisce.
    // Qui la prescrizione è: nessun bucket nuovo (in produzione non ce n'è uno per
    // i curriculum) e nessun gate inventato — `form_attachments` +
    // `verificaAllegatoPubblico`, le due cose che già esistono.
    const sorgente = readFileSync(
      join(process.cwd(), 'src', 'lib', 'forms', 'insegnanti-template.ts'), 'utf8',
    )
    expect(sorgente, 'il template non prescrive più il bucket').toContain('form_attachments')
    expect(sorgente, 'il template non prescrive più il gate pubblico').toContain('verificaAllegatoPubblico')
  })
})

describe('template di candidatura insegnanti · le posizioni (multi-valore obbligatorio)', () => {
  /*
   * ── QUI FINO AL 2026-08-15 C'ERANO «I GRADI», ED È STATO UN CAMBIO DI DOMANDA ──
   *
   * Il modulo chiedeva «per quali FASCE ti proponi» (tre caselle obbligatorie) e
   * dava per scontato che chi compila sia un'insegnante. Con l'apertura a
   * collaboratrici, cuoche e segretarie quella domanda diventava insensata per
   * metà di chi la legge — una cuoca non ha una fascia d'età — e un campo
   * obbligatorio che non ti riguarda è un modulo che non si può inviare.
   *
   * Il campo `gradi` NON è stato reso facoltativo: è SPARITO. La fascia è dentro
   * la posizione («Insegnante — Nido (0-3)») e `gradi` si deriva sul server. Le
   * prove di questo blocco sono le stesse di prima, riscritte sul campo che c'è:
   * cambia il nome della colonna e cambia il codice d'errore dell'ultima rete
   * (`23514` del CHECK invece del `22P02` dell'enum), non cambia cosa si sorveglia.
   */

  const posizioni = () => campo('posizioni')!

  it('il campo `gradi` è USCITO dal modulo, mentre la colonna `gradi` è rimasta', () => {
    // Le due metà di questa riga vanno lette insieme, perché la seconda è la
    // ragione per cui la prima non è una perdita: la colonna resta popolata — è
    // ciò che `admin/candidature-insegnanti:PATCH` travasa in `utenti.gradi` — ma
    // il valore non arriva più da fuori. Cambia CHI la scrive.
    expect(campo('gradi'), 'il campo `gradi` è tornato nel modulo: la fascia si chiederebbe ' +
      'due volte, una come mestiere e una come fascia').toBeUndefined()
    expect(
      INSEGNANTE_FIELDS.filter((f) => String(f.db_mapping).endsWith('.gradi')).map((f) => f.id),
      'un campo del modulo punta di nuovo alla colonna `gradi`',
    ).toEqual([])
    expect(COLONNE.has('gradi'), `la colonna \`gradi\` non c’è più. ${COME_RIGENERARE}`).toBe(true)
  })

  it('sono una checkbox obbligatoria, e i `value` sono un elenco CHIUSO in tabella', () => {
    expect(posizioni().type).toBe('checkbox')
    expect(posizioni().required).toBe(true)
    expect(posizioni().options).toEqual(POSIZIONI_OPTIONS)

    // `POSIZIONI_AMMESSE` è ciò che la route dà in pasto allo `z.enum`: se
    // divergesse dalle opzioni mostrate, il modulo offrirebbe una casella che il
    // server rifiuta.
    expect(POSIZIONI_AMMESSE).toEqual(POSIZIONI_OPTIONS.map((o) => String(o.value)))
    expect(new Set(POSIZIONI_AMMESSE).size, 'due posizioni con lo stesso `value`').toBe(POSIZIONI_AMMESSE.length)
    expect(POSIZIONI_AMMESSE).toHaveLength(7)

    // ⚠️ E LA COLONNA NON È UN ENUM, di proposito: `text[]` con un `CHECK` di
    // appartenenza (fotografia: udt `_text`). L'elenco è di PRODOTTO e cambierà
    // più spesso dello schema, e un enum obbligherebbe a un `alter type` per ogni
    // voce. La garanzia è la stessa; cambia solo il codice del rifiuto — `23514`
    // invece di `22P02` — ed è il motivo per cui la lista va confrontata con la
    // migrazione, non con l'enum (blocco qui sotto).
    expect(COLONNE.get('posizioni')!.udt, `la colonna \`posizioni\` ha cambiato tipo. ${COME_RIGENERARE}`).toBe('_text')
  })

  it('le tre voci docenti si COSTRUISCONO da `GRADI_OPTIONS`, non si ribattono', () => {
    // Ribattere «Insegnante — Nido (0-3)» a mano avrebbe creato la seconda lista da
    // mantenere: una fascia aggiunta domani a `GRADI_OPTIONS` deve diventare una
    // posizione da sola, con la sua etichetta già scritta.
    const docenti = POSIZIONI_OPTIONS.filter((o) => String(o.value).startsWith('insegnante_'))
    expect(docenti, 'le posizioni docenti non sono più una per fascia').toHaveLength(GRADI_OPTIONS.length)

    for (const g of GRADI_OPTIONS) {
      const voce = POSIZIONI_OPTIONS.find((o) => o.value === `insegnante_${String(g.value)}`)
      expect(voce, `manca la posizione docente per la fascia ${g.value}`).toBeDefined()
      // Il trattino è un EM DASH (U+2014), non un trattino corto: è la stessa
      // stringa che il riepilogo di `/lavora-con-noi` e il cockpit di Segreteria
      // ristampano così com'è, e le tre etichette contengono già un trattino corto
      // dentro l'età («0-3»). Distinguerli qui è il modo di accorgersi di una
      // riscrittura che li confonde.
      expect(voce!.label).toBe(`Insegnante — ${g.label}`)
      expect(voce!.label, 'il separatore non è più un em dash').toContain('—')
      expect(voce!.label, `l’etichetta di ${voce!.value} non dichiara l’età`).toMatch(/\(\d+-\d+\)/)
      // La mappa che la route usa per derivare le fasce conosce la voce senza che
      // nessuno l'abbia scritta a parte.
      expect(GRADO_DELLA_POSIZIONE[`insegnante_${String(g.value)}`]).toBe(String(g.value))
    }
    expect(Object.keys(GRADO_DELLA_POSIZIONE)).toHaveLength(GRADI_OPTIONS.length)

    // I `value` delle fasce restano LE ETICHETTE DELL'ENUM, e la riga non si è
    // spostata per caso: `gradi` è ancora `school_type_enum[]` (fotografia: udt
    // `_school_type_enum`) e ora ci scrive la route, derivando da qui. Un `value`
    // fuori dall'enum non produrrebbe più un `22P02` sul valore mandato dal
    // client — che non esiste più — ma su un valore COSTRUITO dal server, cioè un
    // 500 su una candidatura valida.
    expect(COLONNE.get('gradi')!.udt, 'la colonna `gradi` non è più un array di enum').toBe('_school_type_enum')
    expect(
      GRADI_OPTIONS.map((o) => String(o.value)).sort(),
      `i valori delle fasce non coincidono con le etichette di \`school_type_enum\`. ${COME_RIGENERARE}`,
    ).toEqual([...schemaSnapshot.enum_school_type].sort())
  })

  it('«almeno una posizione» lo dicono il modulo E il database, e stavolta dicono la stessa cosa', () => {
    // Il modulo tiene: `eVuoto()` tratta una checkbox come vuota quando il valore
    // non è un array o è un array vuoto, e `required` fa il resto.
    expect(validateField(posizioni(), [])).toBe('Campo obbligatorio')
    expect(validateField(posizioni(), undefined)).toBe('Campo obbligatorio')
    expect(validateField(posizioni(), null)).toBe('Campo obbligatorio')
    expect(validateField(posizioni(), ['cuoca'])).toBeNull()
    expect(validateField(posizioni(), ['insegnante_nido', 'segreteria'])).toBeNull()

    // E IL DATABASE RIPETE LO STESSO CONFINE — cosa che con `gradi` non accadeva.
    // Il `CHECK` di `gradi` è `array_length(gradi, 1) >= 1`, e su un array vuoto
    // `array_length` vale NULL: un CHECK che vale NULL PASSA (misurato in
    // produzione il 2026-08-10). Quello di `posizioni` usa `cardinality()`, che su
    // un array vuoto vale `0`, e `0 >= 1` è FALSO.
    const almenoUna = schemaSnapshot.check.find((k) => k.nome === 'candidature_insegnanti_posizioni_almeno_una')
    expect(almenoUna, `il CHECK «almeno una posizione» non è in tabella. ${COME_RIGENERARE}`).toBeDefined()
    expect(almenoUna!.definizione).toContain('cardinality(posizioni) >= 1')
    expect(
      almenoUna!.definizione,
      'il vincolo è tornato ad `array_length`: su un array vuoto vale NULL e PASSA, ' +
      'quindi una candidatura senza nessuna posizione entrerebbe in silenzio',
    ).not.toContain('array_length')
    expect(COLONNE.get('posizioni')!.nullable, 'la colonna è NOT NULL: il default `{}` la riempie da sé').toBe(false)
    expect(COLONNE.get('posizioni')!.default).toBe("'{}'::text[]")

    // ⚠️ E IL `CHECK` DI `gradi` NON VA «CORRETTO», benché sia quello sbagliato dei
    // due: dal 2026-08-15 `gradi` VUOTO è un valore LEGITTIMO — è ciò che ha una
    // cuoca — e stringerlo a `cardinality` respingerebbe esattamente le candidature
    // che questo lavoro esiste per accogliere. Il presidio si è spostato di
    // colonna, non è stato tolto.
    const vincoloGradi = schemaSnapshot.check.find((k) => k.nome.includes('gradi'))
    expect(vincoloGradi, 'il CHECK sui gradi è sparito dalla fotografia').toBeDefined()
    expect(
      vincoloGradi!.definizione,
      'il CHECK di `gradi` è stato stretto: da oggi `gradi` vuoto è legittimo (una cuoca), ' +
      'e un vincolo che scatta davvero respingerebbe ogni candidatura non docente',
    ).toContain('array_length(gradi, 1) >= 1')
  })

  it('`validateField` NON controlla l’appartenenza sulla checkbox: filtra la route', () => {
    // Il controllo «Selezione non valida» in `validate-fields.ts` è scritto per
    // `select` e `radio`, non per `checkbox`: un valore inventato passa la
    // validazione del modulo e arriva all'INSERT, dove prende `23514` dal CHECK di
    // appartenenza. Questa riga è il motivo per cui il template PRESCRIVE alla
    // route di filtrare contro `POSIZIONI_AMMESSE`. Se un domani `validateField`
    // imparasse a controllare anche le checkbox, questa prova diventa rossa: è il
    // momento di togliere la prescrizione dal template, non di cancellare il test.
    expect(
      validateField(posizioni(), ['posizione_inventata']),
      'la checkbox ora controlla l’appartenenza: aggiorna il template',
    ).toBeNull()
    // Il confronto: sul `select` lo stesso valore inventato viene respinto.
    expect(validateField(campo('titolo_studio')!, 'inventato')).toBe('Selezione non valida')
    // …e l'ultima rete esiste davvero in tabella, cioè il `23514` non è un timore
    // scritto in un commento.
    expect(
      schemaSnapshot.check.map((k) => k.nome),
      `il CHECK di appartenenza non è in tabella. ${COME_RIGENERARE}`,
    ).toContain(VINCOLO_POSIZIONI)
  })

  it('il template PRESCRIVE alla route la difesa che il database dà solo come ultima rete', () => {
    // Un commento è una prescrizione solo se qualcuno si accorge quando sparisce.
    // La difesa è una: filtrare contro `POSIZIONI_AMMESSE` prima di scrivere,
    // perché il `23514` che arriva dall'INSERT diventa un 500 opaco davanti a chi
    // si candida. Chi riscrive quel commento deve riscrivere anche questa riga.
    const sorgente = readFileSync(
      join(process.cwd(), 'src', 'lib', 'forms', 'insegnanti-template.ts'), 'utf8',
    )
    // `[\s\S]` invece del flag `s`: il target di questo tsconfig è precedente a
    // es2018 e `dotAll` non è disponibile.
    expect(sorgente, 'il template non prescrive più il filtro contro POSIZIONI_AMMESSE')
      .toMatch(/POSIZIONI_AMMESSE[\s\S]{0,400}23514|23514[\s\S]{0,400}POSIZIONI_AMMESSE/)
    expect(sorgente, 'il template non nomina più il `cardinality` che rende vero «almeno una»')
      .toMatch(/cardinality\(posizioni\)/)
    expect(sorgente, 'il template non spiega più perché il CHECK di `gradi` non si stringe')
      .toMatch(/array_length/i)
  })
})

describe('template di candidatura insegnanti · l’elenco chiuso, letto dalla MIGRAZIONE', () => {
  /*
   * ⚠️ QUESTO BLOCCO CHIUDE UNA PROSA CHE DESCRIVEVA UN PRESIDIO INESISTENTE.
   *
   * Due documenti affermavano, testualmente, che questo file leggeva la migrazione:
   *   · `supabase/migrations/20260814225302_candidature_posizioni_cv.sql:55-60` —
   *     «Non è affidato alla buona volontà: `__tests__/lib/insegnanti-template.test.ts`
   *      LEGGE questo file e confronta le due liste. Divergere è un test rosso, non
   *      una scoperta in produzione.»
   *   · `src/lib/forms/insegnanti-template.ts:150-157` — «Per questo
   *     `__tests__/lib/insegnanti-template.test.ts` legge il file della migrazione e
   *     confronta le due liste: divergere non è una svista possibile, è un test rosso.»
   *
   * Fino al 2026-08-15 questo file non apriva nessuna migrazione. Le due liste
   * potevano divergere in silenzio, e — questo è il punto — erano proprio i due
   * documenti che promettevano il contrario a impedire a chiunque di andare a
   * controllare. In questo repo una prosa che descrive un presidio che non c'è è
   * peggio di nessuna prosa: toglie a chi legge la ragione di guardare.
   *
   * Il confronto è a TRE liste, perché i posti in cui l'elenco è scritto sono tre e
   * ognuno può restare indietro da solo: il template (ciò che si offre), la
   * migrazione (ciò che si è applicato) e la fotografia dello schema (ciò che in
   * produzione c'è davvero).
   */

  it('la migrazione che dichiara il CHECK esiste, e questo file la trova per NOME DEL VINCOLO', () => {
    // Si cerca il vincolo, non il file: una seconda migrazione che allarghi
    // l'elenco diventa automaticamente quella confrontata. Un percorso ribattuto
    // qui continuerebbe a leggere la prima, e resterebbe verde su una lista
    // superata — cioè il difetto che questo blocco esiste per chiudere, spostato
    // di un file.
    const migrazione = migrazioneDellePosizioni()
    expect(
      migrazione?.nome,
      `nessuna migrazione dichiara \`${VINCOLO_POSIZIONI}\`: o il vincolo è stato rinominato ` +
      '(e allora va rinominato anche qui), oppure il file è sparito e questo confronto sta ' +
      'girando a vuoto.',
    ).toBeDefined()
    // La lettura è arrivata a destinazione: un'estrazione vuota renderebbe il
    // confronto qui sotto un `[] === []`, cioè verde per il motivo peggiore.
    expect(
      elencoDelVincolo(migrazione!.sql).length,
      'il `CHECK` è stato trovato ma l’`array[...]` no: la forma del vincolo è cambiata e ' +
      'l’estrattore va aggiornato, non tolto.',
    ).toBeGreaterThan(1)
    // E il vincolo che stiamo leggendo per nome esiste anche in tabella: leggerlo
    // solo nel file direbbe che cosa è stato SCRITTO, non che cosa è stato applicato.
    expect(
      schemaSnapshot.check.map((k) => k.nome),
      `il vincolo non risulta applicato in produzione. ${COME_RIGENERARE}`,
    ).toContain(VINCOLO_POSIZIONI)
  })

  it('l’elenco del `CHECK` in migrazione è ESATTAMENTE `POSIZIONI_AMMESSE`', () => {
    const migrazione = migrazioneDellePosizioni()!
    expect(
      elencoDelVincolo(migrazione.sql).sort(),
      `le posizioni offerte dal modulo e quelle ammesse dal \`CHECK\` di ${migrazione.nome} ` +
      'non coincidono. Una voce che sta solo nel template prende `23514` dall’INSERT, cioè un ' +
      '500 opaco davanti a chi si candida; una che sta solo nel CHECK è una casella che nessuno ' +
      'può spuntare. Chi aggiunge una posizione la aggiunge in TRE posti: `POSIZIONI_OPTIONS`, ' +
      'una nuova migrazione che rifà questo CHECK, e — se è una fascia — `GRADI_OPTIONS` più ' +
      'l’enum `school_type_enum`.',
    ).toEqual([...POSIZIONI_AMMESSE].sort())
  })

  it('e in PRODUZIONE il vincolo porta la stessa lista (fotografia dello schema)', () => {
    // La terza lista, e non è ridondante: la migrazione dice che cosa è stato
    // scritto, questa dice che cosa è stato APPLICATO. In questo repo le due cose
    // hanno già divergito — `migrate.yml` è in attesa del baseline dello storico, e
    // le migrazioni si applicano a mano con `apply_migration`.
    const vincolo = schemaSnapshot.check.find((k) => k.nome === VINCOLO_POSIZIONI)!
    expect(
      elencoDelVincolo(vincolo.definizione).sort(),
      `il \`CHECK\` applicato in produzione ammette posizioni diverse da quelle del modulo. ${COME_RIGENERARE}`,
    ).toEqual([...POSIZIONI_AMMESSE].sort())
  })
})

describe('candidature · da posizione a fascia (`gradiDallePosizioni`)', () => {
  /** Le tre posizioni docenti, costruite come le costruisce il template. */
  const docenti = GRADI_OPTIONS.map((g) => `insegnante_${String(g.value)}`)
  const fasce = GRADI_OPTIONS.map((g) => String(g.value))

  it('una posizione docente porta la sua fascia, una per una', () => {
    for (const g of GRADI_OPTIONS) {
      expect(gradiDallePosizioni([`insegnante_${String(g.value)}`])).toEqual([String(g.value)])
    }
    expect(gradiDallePosizioni(docenti)).toEqual(fasce)
  })

  it('l’ordine è quello di `GRADI_OPTIONS`, non quello dei clic', () => {
    // Due candidature identiche devono produrre lo stesso array: `utenti.gradi` non
    // può dipendere dall'ordine in cui si sono spuntate le caselle — è la colonna
    // da cui poi si legge a quali sezioni una maestra può accedere.
    expect(gradiDallePosizioni([...docenti].reverse())).toEqual(fasce)
    expect(gradiDallePosizioni(['insegnante_primaria', 'insegnante_nido'])).toEqual(['nido', 'primaria'])
    // E senza doppioni, anche se la stessa posizione arrivasse due volte (il client
    // non lo fa; una `INSERT` scritta a mano sì).
    expect(gradiDallePosizioni(['insegnante_nido', 'insegnante_nido'])).toEqual(['nido'])
  })

  it('una candidatura NON docente ha zero fasce, ed è il caso VOLUTO', () => {
    // Non è un caso limite dimenticato: una cuoca non ha una fascia d'età. La
    // colonna `gradi` è `not null default '{}'` e il suo CHECK su un array vuoto
    // vale NULL, quindi il vuoto entra — e da oggi è la porta attraverso cui passa
    // una candidatura non docente, non più una crepa.
    expect(gradiDallePosizioni(['cuoca'])).toEqual([])
    expect(gradiDallePosizioni(['collaboratrice', 'cuoca', 'segreteria', 'altro'])).toEqual([])
    expect(gradiDallePosizioni([])).toEqual([])
  })

  it('ciò che non è un array vale ELENCO VUOTO, senza lanciare', () => {
    // Il parametro è `unknown` perché il valore arriva GREZZO da PostgREST — e da
    // un database senza quella colonna non arriva affatto. Su questa domanda «non
    // lo so» deve valere «nessuna fascia», non un'eccezione dentro il cockpit.
    for (const strano of [undefined, null, 'insegnante_nido', 42, {}, { 0: 'insegnante_nido' }, true]) {
      expect(gradiDallePosizioni(strano), `valore ${JSON.stringify(strano) ?? 'undefined'}`).toEqual([])
    }
  })

  it('una posizione fuori elenco NON produce una fascia: il `22P02` resta inesprimibile', () => {
    // È la ragione per cui `gradi` non arriva più dal client. Anche se una stringa
    // inventata scavalcasse lo `z.enum` della route, di qui non esce niente che
    // l'enum `school_type_enum` non conosca già.
    expect(gradiDallePosizioni(['insegnante_sostegno'])).toEqual([])
    expect(gradiDallePosizioni(['insegnante_'])).toEqual([])
    expect(gradiDallePosizioni(['nido'])).toEqual([])
    const derivate = new Set(gradiDallePosizioni([...POSIZIONI_AMMESSE, 'insegnante_sostegno', 'nido']))
    for (const d of derivate) {
      expect(schemaSnapshot.enum_school_type, `\`${d}\` non è un’etichetta di school_type_enum`).toContain(d)
    }
  })
})

describe('candidature · chi fa nascere un account (`comprendeInsegnamento`)', () => {
  /*
   * È il predicato da cui dipende l'unica conseguenza pesante di questo modulo:
   * `admin/candidature-insegnanti:PATCH` crea un account `educator` — che legge
   * l'anagrafica dei bambini — SOLO quando risponde `true`. Il verso dell'errore,
   * qui, non è simmetrico: un falso negativo è una segretaria che resta senza
   * account, un falso positivo è un accesso all'anagrafica dei minori dato a chi
   * si era proposto per la cucina.
   */

  it('basta UNA posizione docente in mezzo alle altre', () => {
    expect(comprendeInsegnamento(['cuoca', 'insegnante_infanzia', 'altro'])).toBe(true)
    for (const g of GRADI_OPTIONS) {
      expect(comprendeInsegnamento([`insegnante_${String(g.value)}`])).toBe(true)
    }
  })

  it('nessuna posizione NON docente lo fa scattare', () => {
    for (const p of ['collaboratrice', 'cuoca', 'segreteria', 'altro']) {
      expect(comprendeInsegnamento([p]), `\`${p}\` fa nascere un account educator`).toBe(false)
    }
    expect(comprendeInsegnamento(['collaboratrice', 'cuoca', 'segreteria', 'altro'])).toBe(false)
    expect(comprendeInsegnamento([])).toBe(false)
  })

  it('su «non lo so» risponde NO: undefined, null e ciò che non è un array', () => {
    // Il caso concreto: una riga letta da un database senza la colonna `posizioni`
    // (è lo stato del DB della CI, non migrato) arriva con `posizioni` undefined.
    // Lì la risposta giusta non è «nel dubbio creiamo l'account».
    for (const strano of [undefined, null, 'insegnante_nido', 42, {}, true]) {
      expect(comprendeInsegnamento(strano), `valore ${JSON.stringify(strano) ?? 'undefined'}`).toBe(false)
    }
  })

  it('coincide con «ha almeno una fascia», su TUTTE le combinazioni possibili', () => {
    /*
     * Le due domande sono poste in due posti diversi e con due funzioni diverse:
     * il cockpit chiede `comprendeInsegnamento(riga.posizioni)` per decidere se
     * creare l'account, la route pubblica scrive `docente: gradiDallePosizioni(
     * posizioni).length > 0` nel proprio log (`iscrizione/insegnanti/route.ts:1128`).
     * Sono la stessa domanda, e finché il prefisso docente e `GRADI_OPTIONS` si
     * corrispondono uno a uno danno la stessa risposta.
     *
     * Il giorno in cui una posizione col prefisso `insegnante_` non avesse una
     * fascia corrispondente, le due divergerebbero: si creerebbe un account
     * `educator` con `utenti.gradi` vuoto — cioè una maestra che accede al
     * registro e non vede nessuna sezione. Le 128 combinazioni delle sette
     * posizioni costano meno di un millisecondo e lo dicono per intero.
     */
    for (let maschera = 0; maschera < (1 << POSIZIONI_AMMESSE.length); maschera++) {
      const scelte = POSIZIONI_AMMESSE.filter((_, i) => (maschera & (1 << i)) !== 0)
      expect(
        comprendeInsegnamento(scelte),
        `divergono su [${scelte.join(', ')}]: una crea un account educator, l’altra gli lascia ` +
        '`utenti.gradi` vuoto',
      ).toBe(gradiDallePosizioni(scelte).length > 0)
    }
  })
})

describe('template di candidatura insegnanti · «Altro», e la casella che compare solo quando serve', () => {
  const altro = () => campo('posizione_altro')!

  it('è la PRIMA logica condizionale di questo modulo, e la condizione è quella', () => {
    expect(altro().type).toBe('text')
    expect(altro().condition).toEqual({ field_id: 'posizioni', operator: 'contains', value: 'altro' })
    // La condizione punta a un campo che esiste e a un valore che è davvero una
    // delle sue opzioni: un refuso («altri») lascerebbe la casella invisibile per
    // sempre, e il modulo non se ne accorgerebbe — semplicemente non chiederebbe
    // mai il mestiere a chi ha spuntato «Altro».
    const condizionati = INSEGNANTE_FIELDS.filter((f) => f.condition)
    expect(condizionati.map((f) => f.id), 'i campi condizionali sono cambiati').toEqual(['posizione_altro'])
    for (const f of condizionati) {
      const riferito = campo(f.condition!.field_id)
      expect(riferito, `${f.id} dipende da un campo che non esiste`).toBeDefined()
      expect(
        (riferito!.options ?? []).map((o) => String(o.value)),
        `${f.id} dipende da un valore che non è fra le opzioni di ${riferito!.id}`,
      ).toContain(String(f.condition!.value))
    }
  })

  it('compare solo quando «altro» è spuntato — e `contains` su un array confronta gli elementi', () => {
    expect(campoVisibile(altro(), { posizioni: ['altro'] })).toBe(true)
    expect(campoVisibile(altro(), { posizioni: ['insegnante_nido', 'altro'] })).toBe(true)
    expect(campoVisibile(altro(), { posizioni: ['cuoca'] })).toBe(false)
    expect(campoVisibile(altro(), { posizioni: [] })).toBe(false)
    expect(campoVisibile(altro(), {})).toBe(false)
    // ⚠️ Il ramo `contains` di `valutaCondizione` su un valore NON array cade sulla
    // sottostringa. Vale la pena scriverlo: se un domani il campo `posizioni`
    // diventasse un `select` a valore singolo, `'collaboratrice'` NON contiene
    // «altro», ma una voce chiamata `altro_personale` sì — e la casella
    // comparirebbe da sola.
    expect(campoVisibile(altro(), { posizioni: 'un altro qualsiasi' })).toBe(true)
  })

  it('`required: true` vuol dire «obbligatorio QUANDO è visibile»: chi valida filtra prima', () => {
    // Senza il filtro, `iscrizione/insegnanti:POST` rifiuterebbe con «Campo
    // obbligatorio» ogni candidatura che non ha spuntato «Altro» — cioè quasi
    // tutte. La riga qui sotto è la prova che il campo, da solo, dice davvero
    // «obbligatorio».
    expect(altro().required).toBe(true)
    expect(validateField(altro(), undefined)).toBe('Campo obbligatorio')
    expect(validateField(altro(), '')).toBe('Campo obbligatorio')

    // E la prova che il filtro toglie il problema invece di spostarlo: si valida
    // ciò che è VISIBILE, sul client e sul server, con la stessa funzione.
    const senzaAltro = campiVisibili(INSEGNANTE_FIELDS, { posizioni: ['cuoca'] }).map((f) => f.id)
    expect(senzaAltro).toContain('posizioni')
    expect(senzaAltro, 'la casella del mestiere è visibile a chi non ha spuntato «Altro»').not.toContain('posizione_altro')
    const conAltro = campiVisibili(INSEGNANTE_FIELDS, { posizioni: ['altro'] }).map((f) => f.id)
    expect(conAltro).toContain('posizione_altro')
    // Il resto del modulo non dipende da niente: nessun altro campo sparisce.
    expect(senzaAltro).toEqual(INSEGNANTE_FIELDS.map((f) => f.id).filter((id) => id !== 'posizione_altro'))
  })

  it('cento caratteri, e sono gli stessi del `CHECK` in tabella', () => {
    // Due tetti indipendenti per lo stesso campo divergono, e a divergere sarebbe
    // il confine fra un rifiuto sotto il campo e un `23514` che diventa un 500.
    expect(CANDIDATURA_LIMITI.maxPosizioneAltro).toBe(100)
    expect(altro().validation?.max_length).toBe(CANDIDATURA_LIMITI.maxPosizioneAltro)
    expect(validateField(altro(), 'a'.repeat(CANDIDATURA_LIMITI.maxPosizioneAltro))).toBeNull()
    expect(validateField(altro(), 'a'.repeat(CANDIDATURA_LIMITI.maxPosizioneAltro + 1))).not.toBeNull()
    expect(validateField(altro(), 'psicomotricista')).toBeNull()

    const lunghezza = schemaSnapshot.check.find((k) => k.nome === 'candidature_insegnanti_posizione_altro_lunghezza')
    expect(lunghezza, `il CHECK di lunghezza non è in tabella. ${COME_RIGENERARE}`).toBeDefined()
    expect(
      lunghezza!.definizione,
      `il tetto del modulo (${CANDIDATURA_LIMITI.maxPosizioneAltro}) non è più quello della tabella`,
    ).toContain(`<= ${CANDIDATURA_LIMITI.maxPosizioneAltro}`)
  })

  it('la coerenza fra la casella e il testo vale nei DUE versi, e il valore è lo stesso', () => {
    // Il CHECK è un'uguaglianza fra due predicati: «altro» spuntato senza testo è
    // una candidatura che non dice che lavoro cerca; testo senza «altro» spuntato è
    // un residuo di chi ha scritto e poi ha cambiato idea. Il modulo pulisce
    // (`pulisciNascosti`), ma il modulo è una delle due porte.
    const coerenza = schemaSnapshot.check.find((k) => k.nome === 'candidature_insegnanti_posizione_altro_coerente')
    expect(coerenza, `il CHECK di coerenza non è in tabella. ${COME_RIGENERARE}`).toBeDefined()
    expect(coerenza!.definizione).toContain('= ANY (posizioni)')
    expect(coerenza!.definizione).toContain('posizione_altro IS NOT NULL')
    // ⚠️ E IL LETTERALE DEL VINCOLO È LO STESSO DELLA CONDIZIONE DEL MODULO.
    // Rinominare l'opzione «altro» nel solo template — senza migrazione — darebbe
    // un modulo che mostra la casella e una tabella che rifiuta la riga con
    // `23514`: il rifiuto arriverebbe DOPO l'invio, su un modulo pubblico.
    const letterale = /'([^']*)'/.exec(coerenza!.definizione)?.[1]
    expect(letterale, 'il CHECK di coerenza non nomina più nessun valore').toBeDefined()
    expect(letterale).toBe(String(altro().condition!.value))
    expect(POSIZIONI_AMMESSE).toContain(letterale)
  })
})

describe('template di candidatura insegnanti · i consensi', () => {
  it('sono due blocchi `consent`: la presa visione, e la sola conservazione', () => {
    expect(CONSENSI_INSEGNANTI_FIELDS).toHaveLength(2)
    for (const c of CONSENSI_INSEGNANTI_FIELDS) expect(c.type).toBe('consent')
    const [informativa, conservazione] = CONSENSI_INSEGNANTI_FIELDS
    expect(informativa.id).toBe('presa_visione_informativa')
    expect(informativa.required).toBe(true)
    expect(informativa.link).toBe('/privacy')
    expect(conservazione.id).toBe('consenso_conservazione_candidatura')
    expect(conservazione.required ?? false, 'un consenso obbligatorio non è libero').toBe(false)
  })

  it('la conservazione dichiara i 24 mesi e la revocabilità nel testo che si archivia', () => {
    const conservazione = CONSENSI_INSEGNANTI_FIELDS[1]
    // Il file argomenta (art. 13 §2 lett. a) che il termine PROMESSO all'interessata
    // e il termine APPLICATO dal futuro cron non possono divergere.
    expect(conservazione.text).toContain(`${CANDIDATURA_LIMITI.mesiConservazione} mesi`)
    expect(conservazione.text).toMatch(/revocabil/i)

    /*
     * ⚠️ E il legame NON è retto solo dalla riga qui sopra (rilievo della revisione
     * del 2026-08-10, fondato: fino a quel momento il testo ribatteva il letterale
     * «per 24 mesi» mentre due documenti — PRD e questo commento — dichiaravano che
     * era interpolato). L'asserzione sul valore intercetta la divergenza, ma NON
     * distingue «interpolato» da «ribattuto uguale»: finché il numero sta scritto a
     * mano, il primo `mesiConservazione: 36` renderebbe rosso questo test invece di
     * cambiare il testo, e il testo del consenso resterebbe quello vecchio.
     * Perciò qui si guarda il SORGENTE, ed è l'unica riga che rende vera la frase.
     */
    const sorgenteTemplate = readFileSync(
      join(process.cwd(), 'src', 'lib', 'forms', 'insegnanti-template.ts'), 'utf8',
    )
    expect(
      sorgenteTemplate,
      'il testo del consenso non interpola più `CANDIDATURA_LIMITI.mesiConservazione`: ' +
        'il termine promesso all’interessata è tornato a essere un numero scritto a mano, ' +
        'cioè una seconda costante indipendente per lo stesso limite.',
    ).toContain('${CANDIDATURA_LIMITI.mesiConservazione} mesi')
    // Le righe di sola prosa si scartano: i commenti del file NOMINANO i 24 mesi
    // per spiegarli, e conterebbero come se il letterale fosse tornato.
    const codiceTemplate = sorgenteTemplate.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n')
    expect(
      codiceTemplate,
      'il numero dei mesi è di nuovo scritto a mano dentro il testo del consenso',
    ).not.toMatch(/per\s+\d+\s+mesi/)
  })

  it('il testo dei consensi ha una versione datata, da archiviare accanto alla risposta', () => {
    expect(CONSENSI_INSEGNANTI_VERSIONE).toBe('2026-08-10')
    expect(CONSENSI_INSEGNANTI_VERSIONE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('i limiti del modulo sono dichiarati in un posto solo', () => {
    expect(CANDIDATURA_LIMITI.maxCvMb).toBeGreaterThan(0)
    expect(CANDIDATURA_LIMITI.maxPresentazione).toBe(1000)
    expect(CANDIDATURA_LIMITI.mesiConservazione).toBe(24)
    // Il tetto del CV è quello dichiarato al campo: due numeri per lo stesso
    // limite finiscono per divergere.
    expect(campo('cv_path')?.max_size_mb).toBe(CANDIDATURA_LIMITI.maxCvMb)
  })
})

describe('candidature · vocabolario dei log e codici d’errore', () => {
  it('`candidatura` è un evento NOTO: la route può nominarlo senza aggiungere niente', () => {
    // Il vocabolario è chiuso (`EVENTI_NOTI`): senza questa riga il primo
    // `logEvento('candidatura', …)` della route sarebbe respinto dal lock
    // `eventi-log`, e chi la scrive si troverebbe a dover toccare il logger.
    expect(EVENTI_NOTI.has('candidatura')).toBe(true)
  })

  it('la PERSISTENZA di `candidatura` segue il battito, e arriva insieme alla route', () => {
    /*
     * Questa è la riga che tiene onesta la corsia, ed è nata da un rosso vero.
     *
     * `candidatura` era stato messo in `EVENTI_PERSISTITI` PRIMA che esistesse la
     * route: il lock `__tests__/architecture/eventi-log.test.ts` («ogni evento di
     * EVENTI_PERSISTITI ha almeno un percorso di SUCCESSO che logga») diventava
     * rosso, e restava rosso appeso a un altro agente. Un'allowlist che promette un
     * battito inesistente è la stessa bugia che quel lock esiste per impedire:
     * «nessun log» tornerebbe a non distinguere «non si candida nessuno» da «il
     * modulo non è mai partito».
     *
     * Quindi qui non si asserisce uno stato fisso ma un BICONDIZIONALE: l'evento sta
     * in `EVENTI_PERSISTITI` se e solo se nel sorgente esiste un ramo felice che lo
     * emette — in una qualunque delle DUE forme che il lock condiviso riconosce
     * (vedi la nota qui sotto). Finché la route non c'è, entrambi i lati sono falsi
     * e l'albero è verde; nel momento in cui la route aggiunge il battito senza
     * promuovere l'evento, questa riga diventa rossa e dice esattamente cosa fare.
     * È la promozione automatica che il commento nel logger da solo non poteva
     * garantire.
     *
     * NOTA per chi legge la revisione: spostare `candidatura` in
     * `DEROGHE_INFO_NON_PERSISTITI` NON era una via d'uscita. Quella mappa è
     * sorvegliata da «nessuna deroga è morta», che confronta le sue chiavi con gli
     * eventi che hanno davvero un `logEvento(evento, 'info')` nel sorgente: senza la
     * route, `candidatura` sarebbe finito fra le deroghe morte e il file sarebbe
     * rimasto rosso, solo su un'altra riga.
     */
    /*
     * ⚠️ IL BATTITO HA DUE FORME, NON UNA (rilievo della revisione del 2026-08-10).
     *
     * Fino a oggi questa riga riconosceva solo `logEvento(evento,'info',…)` col
     * livello letterale, mentre il lock condiviso — che è l'autorità in materia —
     * ne conta due (`__tests__/architecture/eventi-log.test.ts:352-355`):
     * `CON_INFO_LETTERALE` e `CON_INFO_DA_EXTERNAL_FETCH`, cioè
     * `externalFetch(…, { evento })`, che è l'UNICO battito di `email`, `push` e
     * `fattura` — nel repo non esiste (e non deve esistere) un
     * `logEvento('email','info',…)` scritto a mano.
     *
     * La conseguenza era concreta e nel verso peggiore: se la route farà partire
     * l'email di conferma della candidatura via `externalFetch({ evento:
     * 'candidatura' })` — la forma che AGENTS.md §3 IMPONE per i provider esterni —
     * il lock condiviso considererebbe l'evento coperto, la promozione in
     * `EVENTI_PERSISTITI` sarebbe corretta, e questa riga sarebbe diventata ROSSA
     * su un'implementazione giusta. Una seconda copia più stretta della stessa
     * regola è la trappola che questo repo si è già scritto in memoria: «una regola
     * valida per due strade deve vivere in un posto solo».
     *
     * Perché qui non si IMPORTA lo scanner condiviso: sta dentro un file di test
     * pieno di `describe`, e importarlo eseguirebbe quel lock una seconda volta.
     * Quindi si riconoscono le due forme con una lettura più GROSSOLANA (una
     * finestra dopo `externalFetch(`, invece dell'estrattore a parentesi bilanciate
     * del lock condiviso), e la grossolanità è deliberatamente orientata: SU QUESTO
     * ASSE può sbagliare solo RICONOSCENDO un battito, mai negandolo. L'errore verso
     * cui pende è quello che il lock condiviso poi respinge da sé — «evento
     * persistito senza percorso felice» — non un rosso su codice corretto.
     * L'asse delle VIRGOLETTE è invece allineato al lock e non "orientato": vedi la
     * nota sulle regex, poche righe più giù, che dice perché e cosa succede se una
     * route userà il doppio apice.
     *
     * Il valore che questa riga aggiunge al lock condiviso, e che resta: là
     * `candidatura` potrebbe scampare finendo in `DEROGHE_INFO_NON_PERSISTITI`;
     * qui no. Il successo di una candidatura si persiste, punto.
     */
    // Le righe di SOLA PROSA si scartano prima di cercare, esattamente come fa
    // `senzaProsa()` nel lock `eventi-log`: senza, il commento qui sopra e quello
    // in `logger.ts` — che la chiamata la NOMINANO per spiegarla — verrebbero
    // contati come se il battito ci fosse già.
    /*
     * ⚠️ SOLO L'APICE SINGOLO, come l'autorità in materia (secondo rilievo della
     * revisione del 2026-08-10, fondato e misurato). Il lock condiviso riconosce
     * unicamente l'apice singolo — `eventi-log.test.ts:40,48`
     * (`/logEvento\(\s*'([a-z_][a-z_0-9]*)'/`) e la riga 210
     * (`/evento:\s*'([a-z_][a-z_0-9]*)'/`) — e nel repo non c'è né `.prettierrc` né
     * una regola eslint `quotes`, quindi `logEvento("candidatura", "info", …)` è
     * scrivibile. Con la classe `['"]` questa riga avrebbe visto quel battito e
     * preteso la promozione in `EVENTI_PERSISTITI`, mentre il lock condiviso — che
     * non lo vede — sarebbe diventato rosso per «evento persistito senza percorso
     * felice»: due rossi simultanei e nessuno dei due risolvibile senza toccare un
     * test. Cioè esattamente il verso che la nota qui sopra dichiara di non avere.
     * Restringendo, le due letture coincidono in ogni caso: se un domani una route
     * scriverà il battito a doppio apice, entrambe non lo vedranno e l'albero
     * resterà verde e coerente — il modo di accorgersene è che `candidatura` non
     * arriva in `app_log`, e la correzione è UNA: riscrivere la chiamata con
     * l'apice singolo, che è la forma usata in tutto `src/`.
     */
    const LETTERALE = /logEvento\(\s*'candidatura'\s*,\s*'info'/
    const DA_EXTERNAL_FETCH = /externalFetch\s*\([\s\S]{0,600}?evento:\s*'candidatura'/
    const emette = sorgentiSrc().some((f) => {
      const codice = readFileSync(f, 'utf8').split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n')
      return LETTERALE.test(codice) || DA_EXTERNAL_FETCH.test(codice)
    })

    expect(
      EVENTI_PERSISTITI.has('candidatura'),
      emette
        ? 'il sorgente ha un ramo felice per `candidatura` — `logEvento(\'candidatura\', \'info\', …)` ' +
          'oppure `externalFetch(…, { evento: \'candidatura\' })` — ma l’evento NON è in ' +
          '`EVENTI_PERSISTITI`: il successo non arriva in `app_log`, e «nessun log» torna a ' +
          'significare insieme «non si candida nessuno» e «il modulo è rotto». Aggiungilo in ' +
          'src/lib/logging/logger.ts, nello STESSO commit della route. E NON spostarlo in ' +
          '`DEROGHE_INFO_NON_PERSISTITI`: il successo di una candidatura si persiste.'
        : 'nessun ramo felice emette ancora `candidatura`, quindi l’evento non può stare in ' +
          '`EVENTI_PERSISTITI`: il lock `eventi-log` diventerebbe rosso per un battito promesso ' +
          'e mai emesso. Promuovilo insieme alla route, non prima.',
    ).toBe(emette)
  })

  it('OGNI codice della candidatura è dichiarato e tradotto in entrambe le lingue', () => {
    /*
     * ⚠️ QUI C'ERA UN ELENCO DI SETTE NOMI RIBATTUTO A MANO, E I CODICI ERANO OTTO.
     * Misurato il 2026-08-15 sulle chiavi di `CODICI_ERRORE`: mancava
     * `CANDIDATURE_OPERAZIONE_NON_RIUSCITA`, cioè il 503 del COCKPIT di Segreteria
     * — l'unico codice della famiglia che nessuno stava controllando.
     *
     * È lo stesso difetto che la testata di questo file racconta per gli id dei
     * campi: un elenco scritto a mano verifica ciò che qualcuno si è ricordato di
     * scriverci, e un codice aggiunto DOPO non fa rosso da nessuna parte. Quando
     * accade, a schermo non arriva una frase ma la chiave grezza — cioè
     * `erroreCandidatureOperazioneNonRiuscita` davanti a chi sta lavorando.
     *
     * Perciò l'elenco si DERIVA dal catalogo. I nomi restano scritti sotto come
     * PAVIMENTO, non come elenco: servono a far diventare rossa una rinomina
     * silenziosa, che la derivazione da sola non vedrebbe.
     */
    const it = itShared as Record<string, string>
    const en = enShared as Record<string, string>
    const codici = Object.keys(CODICI_ERRORE).filter((k) => /^CANDIDATUR/.test(k))

    const attesi = [
      'CANDIDATURA_NON_INVIATA',
      'CANDIDATURA_GIA_INVIATA',
      'CANDIDATURE_NON_DISPONIBILI',
      'CANDIDATURA_NON_TROVATA',
      'CANDIDATURA_GIA_EVASA',
      'CANDIDATURA_EMAIL_GIA_STAFF',
      'CANDIDATURA_EMAIL_GIA_GENITORE',
      'CANDIDATURE_OPERAZIONE_NON_RIUSCITA',
    ]
    for (const codice of attesi) {
      expect(codici, `\`${codice}\` non è più dichiarato in CODICI_ERRORE: se è stato rinominato, ` +
        'rinominalo anche qui e in chi lo emette').toContain(codice)
    }

    const mancanti: string[] = []
    for (const codice of codici) {
      const chiave = (CODICI_ERRORE as Record<string, string>)[codice]
      if (!chiave) { mancanti.push(`${codice}: non dichiarato in CODICI_ERRORE`); continue }
      if (!it[chiave]?.trim()) mancanti.push(`${codice} → messages/it/shared.json:${chiave}`)
      if (!en[chiave]?.trim()) mancanti.push(`${codice} → messages/en/shared.json:${chiave}`)
    }
    expect(
      mancanti,
      'il modulo è PUBBLICO e si compila senza login: un codice senza frase arriva a schermo ' +
      'come chiave grezza, e in inglese non arriva affatto.',
    ).toEqual([])
  })
})
