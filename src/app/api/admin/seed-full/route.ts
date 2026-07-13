import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { sealDangerous } from '@/lib/security/seal';
import { requireEnv } from '@/lib/security/require-env';
import { parseQuery } from '@/lib/validation/http';
import { withRoute } from '@/lib/logging/with-route';
import { logErrore } from '@/lib/logging/logger';

const querySchema = z.object({}); // nessun parametro in ingresso

const SCUOLA_ID = '11111111-1111-1111-1111-111111111111';

// 4 sezioni con i loro UUID reali dal database
const SECTIONS = [
    { id: '2c06371c-7b3d-45e2-a3e9-15fa8ec7ab02', name: 'Girasoli' },
    { id: '9750f689-5332-40ff-ba20-0ebde805f6d1', name: 'Margherite' },
    { id: '25e542d8-7d85-4fe9-ba9d-fe69b78f01ef', name: 'Tulipani' },
    { id: '507b718c-2ac9-42bf-9e9b-d9cb50f50bc9', name: 'Coccinelle' },
];

// Nomi realistici italiani
const NOMI_M = ['Marco', 'Lorenzo', 'Federico', 'Davide', 'Tommaso', 'Andrea', 'Gabriele', 'Mattia', 'Filippo', 'Edoardo', 'Riccardo', 'Pietro', 'Niccolò', 'Diego', 'Simone', 'Jacopo', 'Cristian', 'Samuele', 'Giovanni', 'Enrico', 'Carlo', 'Fabio', 'Valerio', 'Daniele'];
const NOMI_F = ['Giulia', 'Francesca', 'Arianna', 'Chiara', 'Martina', 'Sara', 'Valentina', 'Elisa', 'Alice', 'Elena', 'Beatrice', 'Viola', 'Ginevra', 'Camilla', 'Ludovica', 'Matilde', 'Anna', 'Greta', 'Bianca', 'Noemi', 'Clara', 'Diana', 'Eva', 'Irene'];
const COGNOMI = ['Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci', 'Marino', 'Greco', 'Bruno', 'Gallo', 'Conti', 'De Luca', 'Mancini', 'Costa', 'Giordano', 'Rizzo', 'Lombardi', 'Moretti', 'Barbieri', 'Fontana', 'Santoro', 'Mariani', 'Rinaldi', 'Caruso', 'Ferrara', 'Galli', 'Martini', 'Leone', 'Longo', 'Gentile', 'Martinelli', 'Vitale', 'Villa', 'Marchetti', 'Cattaneo', 'Sala', 'Farina', 'Pellegrini'];
const NOMI_INSEGNANTI_F = ['Maria', 'Paola', 'Silvia', 'Laura', 'Claudia', 'Roberta', 'Barbara', 'Monica'];
const NOMI_INSEGNANTI_M = ['Giuseppe', 'Roberto', 'Antonio', 'Stefano'];

function randomDate(yearMin: number, yearMax: number) {
    const y = yearMin + Math.floor(Math.random() * (yearMax - yearMin + 1));
    const m = 1 + Math.floor(Math.random() * 12);
    const d = 1 + Math.floor(Math.random() * 28);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function randomPhone() {
    return `3${['3', '4', '8', '9'][Math.floor(Math.random() * 4)]}${Math.floor(1000000 + Math.random() * 9000000)}`;
}

function generateCF(cognome: string, nome: string, gender: string, data: string, idx: number) {
    const c = cognome.replace(/\s/g, '').substring(0, 3).toUpperCase().padEnd(3, 'X');
    const n = nome.substring(0, 3).toUpperCase().padEnd(3, 'X');
    const [y, m, d] = data.split('-');
    return `${c}${n}${y.slice(2)}${['A', 'B', 'C', 'D', 'E', 'H', 'L', 'M', 'P', 'R', 'S', 'T'][parseInt(m) - 1]}${gender === 'F' ? parseInt(d) + 40 : d}H501${String.fromCharCode(65 + (idx % 26))}`;
}

const PROVINCE = ['RM', 'MI', 'NA', 'TO', 'FI', 'BO', 'GE', 'PA', 'BA', 'CT'];
const CITTA = ['Roma', 'Milano', 'Napoli', 'Torino', 'Firenze', 'Bologna', 'Genova', 'Palermo', 'Bari', 'Catania'];

export const POST = withRoute('admin/seed-full:POST', async (request: Request) => {
    const sealed = await sealDangerous(request);
    if (sealed) return sealed;
    const missingEnv = requireEnv('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY');
    if (missingEnv) return missingEnv;
    const q = parseQuery(request, querySchema);
    if ('response' in q) return q.response;
    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL as string,
        process.env.SUPABASE_SERVICE_ROLE_KEY as string
    );
    const results = { students: 0, parents: 0, teachers: 0, links: 0, errors: [] as string[] };

    try {
        // La pulizia deve essere fatta tramite /api/admin/wipe prima di chiamare questo
        let globalIdx = 0;

        for (const section of SECTIONS) {
            // ===== 10 ALUNNI per sezione =====
            for (let i = 0; i < 10; i++) {
                // Piccolo delay per evitare TypeError: fetch failed
                await new Promise(resolve => setTimeout(resolve, 100));
                globalIdx++;
                const isFemale = i % 2 === 0;
                const nome = isFemale ? NOMI_F[globalIdx % NOMI_F.length] : NOMI_M[globalIdx % NOMI_M.length];
                const cognome = COGNOMI[globalIdx % COGNOMI.length];
                const gender = isFemale ? 'F' : 'M';
                const dataNascita = randomDate(2019, 2022);
                const provIdx = globalIdx % PROVINCE.length;

                const studentData = {
                    scuola_id: SCUOLA_ID,
                    nome,
                    cognome,
                    data_nascita: dataNascita,
                    gender,
                    codice_fiscale: generateCF(cognome, nome, gender, dataNascita, globalIdx),
                    classe_sezione: section.name,
                    section_id: section.id,
                    stato: 'iscritto',
                    birth_city: CITTA[provIdx],
                    birth_province: PROVINCE[provIdx],
                    birth_nation: 'Italia',
                    citizenship: 'Italiana',
                    residence_address: `Via ${COGNOMI[(globalIdx + 5) % COGNOMI.length]}, ${globalIdx * 3}`,
                    residence_city: CITTA[provIdx],
                    zip_code: `${10100 + globalIdx * 11}`,
                    is_bes_dsa: i === 7,
                    note_mediche: i === 3 ? 'Monitoraggio allergia lattosio' : i === 6 ? 'Intolleranza glutine certificata' : 'Nessuna nota medica rilevante',
                    allergies: i === 3 ? 'Lattosio' : i === 6 ? 'Glutine' : 'Nessuna allergia nota',
                    invoice_holder_type: 'mom',
                    invoice_holder_details: `Fatturazione intestata alla Madre`,
                    consenso_privacy: true
                };

                const { data: student, error: sErr } = await supabase
                    .from('alunni')
                    .insert(studentData)
                    .select('id')
                    .single();

                if (sErr) {
                    results.errors.push(`Student ${nome} ${cognome}: ${sErr.message}`);
                    continue;
                }
                results.students++;

                // ===== MADRE =====
                const motherName = NOMI_F[(globalIdx + 10) % NOMI_F.length];
                const motherBirth = randomDate(1980, 1995);
                const motherData = {
                    first_name: motherName,
                    last_name: cognome,
                    gender: 'F',
                    birth_date: motherBirth,
                    birth_city: CITTA[(provIdx + 1) % CITTA.length],
                    birth_province: PROVINCE[(provIdx + 1) % PROVINCE.length],
                    birth_nation: 'Italia',
                    citizenship: 'Italiana',
                    fiscal_code: generateCF(cognome, motherName, 'F', motherBirth, globalIdx + 100),
                    residence_address: `Via ${COGNOMI[(globalIdx + 5) % COGNOMI.length]}, ${globalIdx * 3}`,
                    residence_city: CITTA[provIdx],
                    zip_code: `${10100 + globalIdx * 11}`,
                    emails: [`${motherName.toLowerCase()}.${cognome.toLowerCase().replace(/\s/g, '')}@example.it`],
                    phone_numbers: [randomPhone()],
                };

                const { data: mother } = await supabase
                    .from('parents')
                    .insert(motherData)
                    .select('id')
                    .single();

                if (mother) {
                    results.parents++;
                    await supabase.from('student_parents').insert({
                        student_id: student.id,
                        parent_id: mother.id,
                        relation_type: 'mother',
                        is_primary: true,
                    });
                    results.links++;
                }

                // ===== PADRE =====
                const fatherName = NOMI_M[(globalIdx + 10) % NOMI_M.length];
                const fatherBirth = randomDate(1978, 1993);
                const fatherData = {
                    first_name: fatherName,
                    last_name: cognome,
                    gender: 'M',
                    birth_date: fatherBirth,
                    birth_city: CITTA[(provIdx + 2) % CITTA.length],
                    birth_province: PROVINCE[(provIdx + 2) % PROVINCE.length],
                    birth_nation: 'Italia',
                    citizenship: 'Italiana',
                    fiscal_code: generateCF(cognome, fatherName, 'M', fatherBirth, globalIdx + 200),
                    residence_address: `Via ${COGNOMI[(globalIdx + 5) % COGNOMI.length]}, ${globalIdx * 3}`,
                    residence_city: CITTA[provIdx],
                    zip_code: `${10100 + globalIdx * 11}`,
                    emails: [`${fatherName.toLowerCase()}.${cognome.toLowerCase().replace(/\s/g, '')}@example.it`],
                    phone_numbers: [randomPhone()],
                };

                const { data: father } = await supabase
                    .from('parents')
                    .insert(fatherData)
                    .select('id')
                    .single();

                if (father) {
                    results.parents++;
                    await supabase.from('student_parents').insert({
                        student_id: student.id,
                        parent_id: father.id,
                        relation_type: 'father',
                        is_primary: false,
                    });
                    results.links++;
                }
            }

            // ===== 2 INSEGNANTI per sezione =====
            for (let t = 0; t < 2; t++) {
                const role = t === 0 ? 'educator' : 'coordinator';
                const isFemale = t === 0;
                const teacherName = isFemale
                    ? NOMI_INSEGNANTI_F[(SECTIONS.indexOf(section) * 2 + t) % NOMI_INSEGNANTI_F.length]
                    : NOMI_INSEGNANTI_M[(SECTIONS.indexOf(section) * 2 + t) % NOMI_INSEGNANTI_M.length];
                const teacherSurname = COGNOMI[(SECTIONS.indexOf(section) * 2 + t + 20) % COGNOMI.length];
                const teacherBirth = randomDate(1975, 1990);

                const teacherData = {
                    first_name: teacherName,
                    last_name: teacherSurname,
                    gender: isFemale ? 'F' : 'M',
                    birth_date: teacherBirth,
                    birth_city: CITTA[t % CITTA.length],
                    birth_province: PROVINCE[t % PROVINCE.length],
                    birth_nation: 'Italia',
                    citizenship: role, // Storing role here for current frontend filter
                    fiscal_code: generateCF(teacherSurname, teacherName, isFemale ? 'F' : 'M', teacherBirth, 500 + SECTIONS.indexOf(section) * 2 + t),
                    emails: [`${teacherName.toLowerCase()}.${teacherSurname.toLowerCase()}@kidville.it`],
                    phone_numbers: [randomPhone()],
                    residence_address: `Sede ${section.name}, Interno ${t + 1}`,
                    residence_city: 'Roma',
                    zip_code: '00100',
                };

                const { error: tErr } = await supabase.from('parents').insert(teacherData);
                if (!tErr) results.teachers++;
                else results.errors.push(`Teacher error: ${tErr.message}`);
            }
        }

        return NextResponse.json({
            success: true,
            ...results,
            summary: `Creati ${results.students} alunni, ${results.parents} genitori, ${results.teachers} insegnanti, ${results.links} collegamenti. Errori: ${results.errors.length}`
        });

    } catch (err) {
        logErrore({ operazione: 'admin/seed-full:POST', stato: 500 }, err);
        return NextResponse.json({
            success: false,
            error: err instanceof Error ? err.message : String(err),
            ...results
        }, { status: 500 });
    }
});
