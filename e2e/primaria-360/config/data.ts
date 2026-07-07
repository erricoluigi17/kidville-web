// ID reali di TEST 1A (prod) usati dalle journey per le scritture via API.
import { SECTION_1A } from './accounts';

export const SECTION = SECTION_1A;

// Alunno1..10 (indice 1-based → id)
export const ALUNNI: Record<number, string> = {
  1: 'b5ed40dc-9195-45bc-bbb7-59e4ffb478f6',
  2: '85995f7f-75bc-433e-9f09-d4c04d88d48c',
  3: 'aaacb836-8d02-422d-88cb-ea99cf8e3c56',
  4: 'cb0d83cf-00d1-4dcc-91b0-85668fe392d6',
  5: '52380841-daaa-4ae3-876c-91954839390e',
  6: 'fcb67036-8846-463f-ba44-744d3183f324',
  7: 'cb4a3305-48a2-4107-8b40-998e776f93b9',
  8: 'b54c8ce9-a77e-4434-8689-db3ccb0b3746',
  9: 'cca20211-fefc-44df-8929-d5c44452c656',
  10: '2f2e5ab6-3c1c-476c-8490-f7582249b391',
};

export const MATERIE = {
  italiano: 'c730f585-9d45-43d7-93a2-73e3c7202b8e',
  matematica: 'fbd38536-c5e1-4547-acab-e27fc2d1da76',
  storia: '375242a7-ae9b-443d-af88-8c5684415ef9',
  geografia: 'de8d0b09-4852-4e29-b5e2-b21580ceb1a4',
  scienze: 'b90dc204-2619-49e4-a8c2-8043cdc6a6cc',
  inglese: '458f4be9-374e-4a56-8665-e13f8ae517d9',
  arte: '4d58e45b-dd4d-4313-b7da-74a18cdb5d00',
  musica: '664cdb12-bba9-47a8-a7b7-82337a07cf8e',
  edfisica: '7883729a-dc2c-48f3-9f3f-b498810afa18',
  tecnologia: 'b5bbfeb6-9076-4ce9-b9e1-71fc26f5e223',
  religione: '46acaa02-f077-4f6f-8f3d-62990e4bae17',
  edcivica: 'd89e03c4-0597-44cb-8b60-fddb2ec7ef02',
};

// Materia principale per ogni docente (indice 1-based) — coerente con le
// assegnazioni utenti_sezioni_materie del seed.
export const DOCENTE_MATERIA: Record<number, { nome: string; id: string }> = {
  1: { nome: 'Italiano', id: MATERIE.italiano },
  2: { nome: 'Matematica', id: MATERIE.matematica },
  3: { nome: 'Inglese', id: MATERIE.inglese },
  4: { nome: 'Arte e Immagine', id: MATERIE.arte },
  5: { nome: 'Religione/Alternativa', id: MATERIE.religione },
};
