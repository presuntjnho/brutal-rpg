export const ATTRIBUTES = {
  forca: "Força", agilidade: "Agilidade", vigor: "Vigor", inteligencia: "Inteligência", carisma: "Carisma"
};

export const ARCHETYPES = {
  corajoso: { label: "Herói / Corajoso", rank: 1, specialties: ["forca", "inteligencia"] },
  atleta: { label: "Atleta", rank: 2, specialties: ["forca", "agilidade"] },
  valentao: { label: "Valentona", rank: 3, specialties: ["forca", "vigor"] },
  esbelto: { label: "Esbelto", rank: 4, specialties: ["vigor"] },
  inocente: { label: "Inocente", rank: 5, specialties: [] },
  nerd: { label: "Nerd", rank: 6, specialties: ["inteligencia", "agilidade"] },
  relaxado: { label: "Relaxado / Maconheiro", rank: 7, specialties: [] },
  cetico: { label: "Cética", rank: 8, specialties: ["inteligencia"] },
  covarde: { label: "Covarde", rank: 1, specialties: ["vigor", "agilidade"] },
  alivio: { label: "Alívio Cômico", rank: 4, specialties: ["inteligencia"] },
  curioso: { label: "Curioso", rank: 3, specialties: ["inteligencia", "agilidade"] },
  santo: { label: "Santo", rank: 3, specialties: ["inteligencia", "agilidade"] },
  mentor: { label: "Mentor", rank: 5, specialties: ["inteligencia"] },
  estiloso: { label: "Estiloso", rank: 2, specialties: ["inteligencia", "agilidade"] },
  mauagouro: { label: "Mau Agouro", rank: 5, specialties: ["agilidade", "vigor"] }
};

export const SCENES = { livre: "Livre", suspense: "Suspense", encontro: "Encontro" };

export const ACTIONS = {
  risk: { label: "Superar risco" },
  fright: { label: "Teste de susto" },
  escape: { label: "Vazar Dali", attribute: "agilidade" },
  fight: { label: "Partir para Cima", attribute: "forca" },
  distract: { label: "Distrair", attribute: "inteligencia", required: 2 },
  help: { label: "Ajudar Alguém" }
};

export function resolveTest({ faces, difficulty = 4, required = 1, specialty = false, resource = "", action = "risk", scene, pool }) {
  const target = Math.max(1, difficulty - Number(specialty) - Number(resource === "difficulty"));
  const needed = Math.max(1, required - Number(resource === "complexity"));
  const passed = faces.filter(face => face >= target);
  const failures = faces.length - passed.length;
  const losses = action === "help" ? 0 : failures;
  const spent = action === "escape" ? passed.length : action === "help" && passed.length >= needed ? passed.length : 0;
  const remaining = pool - losses - spent;
  const disaster = losses > 0 && remaining === 0 && (action !== "escape" || passed.length === 0);
  return {
    target, needed, successes: passed.length, failures, remaining, disaster,
    success: passed.length >= needed && !disaster,
    destination: action === "fright" || scene === "encontro" ? "discard" : "sacrifice",
    escapeDice: action === "escape" ? passed.reduce((sum, face) => sum + (face === 6 ? 2 : 1), 0) : 0
  };
}
