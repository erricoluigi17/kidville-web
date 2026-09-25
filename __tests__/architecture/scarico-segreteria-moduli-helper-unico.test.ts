import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mascheraSorgente, riga } from '../fixtures/sorgente'

/**
 * LOCK (NAT3f) — i download della Segreteria su moduli ed export passano dall'helper unico.
 *
 * Le forme vietate sono quelle che nella WebView dell'app NON scaricano niente e NON
 * lanciano — cioè un bottone che sembra funzionare, senza una riga di log:
 *  · `XLSX.writeFile(…)` e `doc.save(…)` di jsPDF: dentro sono un'ancora `download` su un
 *    `blob:`, esattamente la forma che la WebView ignora;
 *  · un'ancora costruita a mano (`document.createElement('a')` + `.download = …`).
 *
 * Al loro posto: il Blob (o la route) va a `scaricaDocumento` / `apriDocumento` di
 * `src/lib/native/scarica.ts`, che sul web fa ciò che faceva l'ancora e nell'app apre il
 * foglio «Salva su File» o l'anteprima. I link `<a href>` che sul web devono restare link
 * (delibera `inline`, elenco classi, riquadro dei prestampati) intercettano il clic SOLO
 * nell'app: lo misurano i test di comportamento accanto a questo lock
 * (`scarico-compilazioni-graduatorie`, `scarico-export-segreteria`,
 * `PrestampatiSegreteria-scarico`, `admin-scarico-anagrafica-e-cumulativo`).
 *
 * Il sorgente si legge SENZA COMMENTI (`mascheraSorgente`): i commenti di questi file
 * nominano apposta `doc.save()` e `XLSX.writeFile` per spiegare perché non ci sono più, e un
 * lock che li contasse si romperebbe da solo — o, peggio, si immunizzerebbe.
 */

const FILE = [
  'src/components/features/admin/forms/submissions/SubmissionsTable.tsx',
  'src/components/features/admin/forms/submissions/SubmissionDetailSidebar.tsx',
  'src/components/features/admin/forms/submissions/scarica-compilazioni.ts',
  'src/components/features/admin/forms/rankings/RankingTable.tsx',
  'src/components/features/admin/iscrizioni/ElencoClassi.tsx',
  'src/components/features/avvisi/dettaglio/EsportaAdesioni.tsx',
  'src/app/(dashboard)/admin/students/page.tsx',
  'src/components/features/admin/ImportExportClient.tsx',
  'src/app/(dashboard)/admin/modulistica/page.tsx',
  'src/components/features/prestampati/PrestampatiSegreteria.tsx',
] as const

const VIETATE: { nome: string; rx: RegExp }[] = [
  { nome: 'XLSX.writeFile (ancora `download` interna di SheetJS)', rx: /\bwriteFile\s*\(/g },
  { nome: 'jsPDF .save() (ancora `download` interna di jsPDF)', rx: /\.save\s*\(/g },
  { nome: 'ancora costruita a mano', rx: /createElement\s*\(\s*['"`]a['"`]\s*\)/g },
  { nome: 'attributo `download` assegnato a mano', rx: /\.download\s*=/g },
]

/** L'helper unico, direttamente o attraverso il modulo delle compilazioni che lo usa. */
const IMPORT_HELPER = /from\s+['"](?:@\/lib\/native\/scarica|\.\/scarica-compilazioni)['"]/

function leggi(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
}

describe('Segreteria · moduli ed export — nessuna ancora a mano, tutto dall’helper', () => {
  it('i file sorvegliati esistono tutti (un percorso rinominato non deve spegnere il lock)', () => {
    const mancanti = FILE.filter((f) => !fs.existsSync(path.join(process.cwd(), f)))
    expect(mancanti).toEqual([])
  })

  it.each(FILE)('%s — nessuna forma che nella WebView non scarica', (rel) => {
    const src = leggi(rel)
    const { senzaCommenti } = mascheraSorgente(src)
    const trovate: string[] = []
    for (const { nome, rx } of VIETATE) {
      rx.lastIndex = 0
      for (let m = rx.exec(senzaCommenti); m; m = rx.exec(senzaCommenti)) {
        trovate.push(`${rel}:${riga(src, m.index)} — ${nome}`)
      }
    }
    expect(trovate, 'passare il Blob (o la route) a `scaricaDocumento` di src/lib/native/scarica.ts').toEqual([])
  })

  it.each(FILE)('%s — importa l’helper unico', (rel) => {
    const { senzaCommenti } = mascheraSorgente(leggi(rel))
    expect(IMPORT_HELPER.test(senzaCommenti)).toBe(true)
  })

  it('il lock vede davvero le forme vietate (prova su un sorgente scritto apposta)', () => {
    // Un lock che non può fallire non è un lock: qui si misura che le regex scattano sul
    // codice e NON sui commenti.
    const finto = [
      "// doc.save('commento.pdf') e XLSX.writeFile(wb, 'x') nei commenti non contano",
      "const a = document.createElement('a')",
      "a.download = 'x.csv'",
      "doc.save('vero.pdf')",
      "XLSX.writeFile(wb, 'vero.xlsx')",
    ].join('\n')
    const { senzaCommenti } = mascheraSorgente(finto)
    const colpi = VIETATE.map(({ rx }) => {
      rx.lastIndex = 0
      return (senzaCommenti.match(rx) ?? []).length
    })
    expect(colpi).toEqual([1, 1, 1, 1])
  })
})
