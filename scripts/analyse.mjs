// Analyse automatique des illustrations de cartes Pokémon.
// Tourne chaque nuit sur GitHub (voir .github/workflows/analyse.yml) et remplit le dossier data/.
//
// Variables d'environnement :
//   GEMINI_API_KEY      clé Google AI Studio (gratuite)            ← au moins une des deux clés
//   ANTHROPIC_API_KEY   clé Anthropic (payante, plus rapide)
//   AI_PROVIDER         "gemini" (défaut si la clé existe) ou "claude"
//   GEMINI_MODEL        modèle forcé (sinon choisi automatiquement : flash le plus récent)
//   CLAUDE_MODEL        défaut "claude-haiku-5-5"
//   MAX_REQUESTS        nombre max de requêtes IA par lancement (défaut 200)
//   TIME_LIMIT_MIN      durée max en minutes (défaut 300)
//   CARDS_PER_REQUEST   cartes analysées par requête (défaut 4)
//   ONLY_PRIORITY       "1" = ne jamais analyser les cartes non prioritaires
//   TCGDEX_BASE         défaut https://api.tcgdex.net/v2/fr

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = path.join(ROOT, 'data');
const SETS_DIR = path.join(DATA, 'sets');

const TCG = (process.env.TCGDEX_BASE || 'https://api.tcgdex.net/v2/fr').replace(/\/$/, '');
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const PROVIDER = process.env.AI_PROVIDER || (GEMINI_KEY ? 'gemini' : CLAUDE_KEY ? 'claude' : '');
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const MAX_REQUESTS = parseInt(process.env.MAX_REQUESTS || '200', 10);
const TIME_LIMIT = parseInt(process.env.TIME_LIMIT_MIN || '300', 10) * 60000;
const PER_REQUEST = Math.max(1, parseInt(process.env.CARDS_PER_REQUEST || '4', 10));
const ONLY_PRIORITY = process.env.ONLY_PRIORITY === '1';
const START = Date.now();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const timeLeft = () => TIME_LIMIT - (Date.now() - START);

// ---------------------------------------------------------------- fichiers
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, data, pretty = true) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, pretty ? 1 : 0) + '\n');
  await fs.rename(tmp, file);
}
const setFile = (id) => path.join(SETS_DIR, id.replace(/[^\w.-]/g, '_') + '.json');

// ---------------------------------------------------------------- TCGdex
async function tcg(url, tries = 0) {
  try {
    const r = await fetch(TCG + url);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    if (tries < 4) { await sleep(1500 * (tries + 1)); return tcg(url, tries + 1); }
    throw new Error('TCGdex ' + url + ' : ' + e.message);
  }
}
async function pool(items, n, fn) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const EPOQUES = {
  base: 'Wizards', gym: 'Wizards', neo: 'Wizards', lc: 'Wizards', si: 'Wizards', ecard: 'e-Card',
  ex: 'EX', pop: 'POP', dp: 'Diamant et Perle', pl: 'Platine', hgss: 'HeartGold SoulSilver',
  col: 'HeartGold SoulSilver', bw: 'Noir et Blanc', xy: 'XY', sm: 'Soleil et Lune',
  swsh: 'Épée et Bouclier', sv: 'Écarlate et Violet', me: 'Méga-Évolution'
};
const EXCLUDED_SERIES = /^(tcgp)$/; // Pokémon TCG Pocket : pas de cartes physiques

// Cartes « vitrine » à analyser en premier : illustrations pleines, secrètes, galeries…
const RARE_RX = /illustration|sp[ée]cial|secr|hyper|ultra|magnifique|chromatique|full|art\b|galerie|gallery|radieu|radiant|amazing|rainbow|arc-en-ciel|gold|dor[ée]e|shiny|brillant/i;
function priority(card, official) {
  if (/[ée]nergie|energy/i.test(card.category || '')) return 0;
  const num = parseInt(card.localId, 10);
  const secret = official && !isNaN(num) && num > official;
  const gallery = /^(TG|GG|SV|RC)\d/i.test(String(card.localId));
  if (secret || gallery || RARE_RX.test(card.rarity || '')) return 2;
  if (/dresseur|trainer/i.test(card.category || '')) return 0; // dresseurs classiques : pas décoratifs
  return 1;
}

function toRecord(d, set, serie) {
  const official = set.cardCount && set.cardCount.official;
  return {
    id: d.id,
    nom: d.name,
    numero: d.localId + (official ? '/' + official : ''),
    extension: set.id,
    serie: serie.id,
    epoque: EPOQUES[serie.id] || serie.name || serie.id,
    rarete: d.rarity || '',
    categorie: d.category || '',
    sous_categorie: d.trainerType || d.energyType || null,
    types: d.types || [],
    illustrateur: d.illustrator || null,
    image: d.image || null,
    pokedex: d.dexId || [],
    stade: d.stage || null,
    evolue_de: d.evolveFrom || null,
    priorite: priority(d, official),
    analyse: null
  };
}

// Récupère la liste des extensions et les fiches détaillées des cartes (sans IA).
async function syncMetadata(index) {
  log('Liste des extensions…');
  const list = await tcg('/sets');
  const known = new Map((index.extensions || []).map((e) => [e.id, e]));
  const out = [];
  for (const brief of list.slice().reverse()) { // les plus récentes d'abord
    if (timeLeft() < 10 * 60000) { log('Temps limite : synchronisation interrompue'); break; }
    const k = known.get(brief.id);
    const total = (brief.cardCount && brief.cardCount.total) || 0;
    const file = setFile(brief.id);
    const existing = await readJson(file, null);
    // déjà synchronisée et pas de nouvelles cartes : on garde
    if (k && existing && existing.cartes && existing.cartes.length >= total && !k.exclue) { out.push(k); continue; }
    if (k && k.exclue) { out.push(k); continue; }

    const set = await tcg('/sets/' + encodeURIComponent(brief.id));
    if (!set) continue;
    const serie = set.serie || { id: '', name: '' };
    const entry = {
      id: set.id, nom: set.name, serie: serie.id, epoque: EPOQUES[serie.id] || serie.name || '',
      date: set.releaseDate || null, cartes: 0, prioritaires: 0, analysees: 0
    };
    if (EXCLUDED_SERIES.test(serie.id)) { entry.exclue = true; out.push(entry); continue; }

    const old = new Map(((existing && existing.cartes) || []).map((c) => [c.id, c]));
    const briefs = (set.cards || []).filter((c) => c.image);
    log('Fiches de ' + set.name + ' (' + briefs.length + ' cartes)');
    const cards = await pool(briefs, 5, async (b) => {
      const prev = old.get(b.id);
      if (prev) return prev;
      const d = await tcg('/cards/' + encodeURIComponent(b.id));
      return d ? toRecord(d, set, serie) : null;
    });
    const data = {
      id: set.id, nom: set.name, serie: serie.id, epoque: entry.epoque, date: entry.date,
      cartes: cards.filter(Boolean)
    };
    await writeJson(file, data);
    out.push(entry);
  }
  // extensions connues qui ne sont plus listées : on les garde
  for (const e of index.extensions || []) if (!out.find((o) => o.id === e.id)) out.push(e);
  index.extensions = out;
  return index;
}

// ---------------------------------------------------------------- IA
const PROMPT = (cards) => `Tu analyses ${cards.length} cartes Pokémon (images jointes, dans l'ordre) pour composer de belles pages de classeur.
Pour chaque carte, décris l'ILLUSTRATION telle qu'on la voit sur la carte. Sois précis et cohérent : utilise exactement le vocabulaire imposé quand il y en a un.

Cartes, dans l'ordre :
${cards.map((c, i) => `${i + 1}. ${c.nom} — ${c.categorie}${c.sous_categorie ? ' (' + c.sous_categorie + ')' : ''} — ${c.rarete || 'rareté inconnue'}`).join('\n')}

Réponds UNIQUEMENT avec un tableau JSON de ${cards.length} objets, dans le même ordre, de cette forme :
{
 "part_illustration": "totale" (le dessin couvre toute la carte) | "majoritaire" (grand dessin, cadre réduit) | "cadre" (petite illustration dans un cadre classique),
 "bordure": "argent" | "jaune" | "noire" | "bleue" | "autre",
 "habillage": {"bandeau": null | "V" | "VMAX" | "VSTAR" | "ex" | "EX" | "GX" | "Turbo" | "autre", "logo": null | "promo" | "autre", "texte_charge": true si de gros blocs de texte couvrent l'illustration},
 "univers": "2 à 4 mots (bord de mer, forêt, maison, ville, montagne, espace…)",
 "lieu": "lieu précis en quelques mots",
 "interieur": true | false,
 "milieu": "ciel" | "montagne" | "prairie" | "forêt" | "jardin" | "ville" | "intérieur" | "rivage" | "surface de l'eau" | "sous-marin" | "grotte" | "désert" | "neige" | "volcan" | "espace" | "abstrait" | "fond uni",
 "profondeur": "ciel" | "en hauteur" | "sol" | "surface" | "sous l'eau" | "profondeurs" | "aucune",
 "zones": {"haut": "ce qu'on voit en haut", "milieu": "…", "bas": "…"},
 "bords": {"haut": "couleur", "bas": "couleur", "gauche": "couleur", "droite": "couleur"},
 "horizon": "haut" | "milieu" | "bas" | "aucun",
 "palette": {"dominante": "rouge" | "orange" | "jaune" | "vert" | "turquoise" | "bleu" | "violet" | "rose" | "marron" | "beige" | "gris" | "noir" | "blanc" | "multicolore", "secondaires": ["1 à 3 couleurs"], "temperature": "chaude" | "froide" | "neutre"},
 "luminosite": "clair" | "moyen" | "sombre",
 "saturation": "pastel" | "douce" | "vive",
 "lumiere": {"type": "douce" | "dorée" | "contre-jour" | "rayons" | "néon" | "nuit" | "feu" | "magique" | "plate", "direction": "haut" | "gauche" | "droite" | "face" | "arrière" | "diffuse"},
 "style": "peinture douce" | "aquarelle" | "peinture texturée" | "anime" | "dessin plat" | "3D" | "maquette ou crochet" | "photographique" | "crayon" | "pixel" | "autre",
 "rendu": "net" | "flou d'arrière-plan",
 "cadrage": "gros plan" | "plan moyen" | "plan large",
 "densite": "épurée" | "moyenne" | "chargée",
 "orientation": "gauche" | "droite" | "face" | "dos" (vers où regarde le sujet principal),
 "action": "1 à 3 mots (dort, nage, joue…)",
 "emotion": "1 à 2 mots",
 "moment": "jour" | "nuit" | "coucher de soleil" | "aube" | "indéfini",
 "meteo": null | "ensoleillé" | "nuageux" | "pluie" | "neige" | "orage" | "brume" | "vent",
 "saison": null | "printemps" | "été" | "automne" | "hiver",
 "personnages": [{"nom": "nom du personnage humain SEULEMENT si tu en es certain (sinon \\"inconnu\\")", "role": "dresseur | champion | professeur | habitant | autre"}],
 "histoire": null ou une phrase si l'illustration raconte clairement une scène qui pourrait se continuer sur d'autres cartes,
 "tags": ["6 à 10 mots-clés en français : éléments visibles, matières, ambiance"]
}`;

let geminiModel = process.env.GEMINI_MODEL || '';
const deadModels = new Set();
async function pickGeminiModel() {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': GEMINI_KEY } });
  if (!r.ok) throw new Error('Clé Gemini refusée (HTTP ' + r.status + ')');
  const j = await r.json();
  const models = (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''))
    .filter((m) => /^gemini/.test(m) && /flash/.test(m) && !/lite|tts|image|audio|live|embedding|exp/.test(m) && !deadModels.has(m));
  const ver = (m) => parseFloat((m.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  models.sort((a, b) => (/preview/.test(a) - /preview/.test(b)) || ver(b) - ver(a));
  if (!models.length) throw new Error('Aucun modèle Gemini flash disponible');
  return models[0];
}

class RateLimit extends Error {}
class Fatal extends Error {}

async function imageBytes(url) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url);
      if (r.ok) return Buffer.from(await r.arrayBuffer()).toString('base64');
    } catch {}
    await sleep(1000 * (t + 1));
  }
  throw new Error('image introuvable : ' + url);
}

async function callGemini(text, images) {
  if (!geminiModel) { geminiModel = await pickGeminiModel(); log('Modèle Gemini : ' + geminiModel); }
  const parts = [{ text }].concat(images.map((b) => ({ inline_data: { mime_type: 'image/png', data: b } })));
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(geminiModel) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 32768, temperature: 0.2 }
    })
  });
  const j = await r.json().catch(() => ({}));
  const msg = (j.error && j.error.message) || '';
  if (r.status === 429 || r.status === 503) throw new RateLimit(msg || 'HTTP ' + r.status);
  if (!r.ok && (r.status === 404 || /no longer available|not found|not supported|deprecated/i.test(msg))) {
    log('Modèle ' + geminiModel + ' indisponible, changement de modèle');
    deadModels.add(geminiModel); geminiModel = '';
    return callGemini(text, images);
  }
  if (r.status === 400 && /api key/i.test(msg)) throw new Fatal('Clé Gemini invalide');
  if (!r.ok) throw new Error(msg || 'HTTP ' + r.status);
  const cand = j.candidates && j.candidates[0];
  const out = ((cand && cand.content && cand.content.parts) || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
  if (!out) throw new Error('réponse vide (' + ((cand && cand.finishReason) || '?') + ')');
  return out;
}

async function callClaude(text, images) {
  const content = [{ type: 'text', text }].concat(images.map((b) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b } })));
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 8000, messages: [{ role: 'user', content }] })
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429 || r.status === 529) throw new RateLimit('limite Anthropic');
  if (r.status === 401) throw new Fatal('Clé Anthropic invalide');
  if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function extractJson(text) {
  text = String(text || '').replace(/```(?:json)?/gi, '');
  const s = text.search(/[\[{]/);
  if (s === -1) throw new Error('réponse illisible');
  const close = text[s] === '[' ? ']' : '}';
  const v = JSON.parse(text.slice(s, text.lastIndexOf(close) + 1));
  return Array.isArray(v) ? v : (v.cartes || v.cards || [v]);
}

let consecutiveRate = 0;
async function analyseBatch(cards) {
  const images = await Promise.all(cards.map((c) => imageBytes(c.image + '/low.png')));
  const text = PROMPT(cards);
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = PROVIDER === 'claude' ? await callClaude(text, images) : await callGemini(text, images);
      const arr = extractJson(raw);
      if (arr.length !== cards.length) throw new Error('nombre de réponses incorrect (' + arr.length + '/' + cards.length + ')');
      consecutiveRate = 0;
      return arr;
    } catch (e) {
      if (e instanceof Fatal) throw e;
      if (e instanceof RateLimit) {
        consecutiveRate++;
        // limite par minute : on attend ; si ça persiste, c'est le quota du jour
        if (consecutiveRate > 5 || /per day|daily|PerDay/i.test(e.message)) throw new Fatal('Quota du jour atteint : la suite au prochain lancement');
        const wait = 30000 * consecutiveRate;
        log('Limite de requêtes, pause ' + wait / 1000 + ' s');
        await sleep(wait);
        continue;
      }
      if (attempt < 2) { log('Erreur (' + e.message + '), nouvel essai'); await sleep(5000); continue; }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- dérivés
const PAIRES = [[311, 312], [380, 381], [29, 32], [313, 314], [335, 336], [337, 338], [106, 107], [538, 539],
  [249, 250], [382, 383], [643, 644], [716, 717], [791, 792], [888, 889], [1007, 1008], [150, 151], [483, 484], [127, 214]];
const pairOf = new Map();
PAIRES.forEach(([a, b]) => { pairOf.set(a, b); pairOf.set(b, a); });
const baseName = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[\s-]+(ex|gx|v|vmax|vstar|v-union|lv\.?x|break|prime|legende|☆|δ)$/i, '').replace(/^(.+?)\s+de\s+.+$/, '$1').trim();

function computeFamilies(allCards) {
  const dexByName = new Map(), parent = new Map();
  for (const c of allCards) if (c.pokedex && c.pokedex[0]) dexByName.set(baseName(c.nom), c.pokedex[0]);
  for (const c of allCards) {
    const d = c.pokedex && c.pokedex[0];
    if (d && c.evolue_de && !parent.has(d)) { const p = dexByName.get(baseName(c.evolue_de)); if (p && p !== d) parent.set(d, p); }
  }
  const root = (d) => { let k = 0; while (parent.has(d) && k++ < 5) d = parent.get(d); return d; };
  for (const c of allCards) {
    const d = c.pokedex && c.pokedex[0];
    c.famille = d ? root(d) : null;
    c.paire = d && pairOf.has(d) ? pairOf.get(d) : null;
  }
}

// Fichier compact lu par le site : uniquement les cartes analysées
function compact(c) {
  const a = c.analyse;
  return {
    id: c.id, nom: c.nom, numero: c.numero, ext: c.extension, epoque: c.epoque, rarete: c.rarete, cat: c.categorie,
    types: c.types, illus: c.illustrateur, image: c.image, dex: c.pokedex, famille: c.famille, paire: c.paire,
    part: a.part_illustration, bordure: a.bordure, habillage: a.habillage, univers: a.univers, lieu: a.lieu,
    interieur: a.interieur, milieu: a.milieu, profondeur: a.profondeur, zones: a.zones, bords: a.bords, horizon: a.horizon,
    palette: a.palette, luminosite: a.luminosite, saturation: a.saturation, lumiere: a.lumiere, style: a.style,
    rendu: a.rendu, cadrage: a.cadrage, densite: a.densite, orientation: a.orientation, action: a.action,
    emotion: a.emotion, moment: a.moment, meteo: a.meteo, saison: a.saison, personnages: a.personnages,
    histoire: a.histoire, tags: a.tags
  };
}

// ---------------------------------------------------------------- principal
async function main() {
  if (!PROVIDER) throw new Error('Aucune clé IA : ajoute GEMINI_API_KEY (ou ANTHROPIC_API_KEY) dans les Secrets du dépôt.');
  if (PROVIDER === 'gemini' && !GEMINI_KEY) throw new Error('GEMINI_API_KEY manquante');
  if (PROVIDER === 'claude' && !CLAUDE_KEY) throw new Error('ANTHROPIC_API_KEY manquante');

  const index = await readJson(path.join(DATA, 'index.json'), { extensions: [] });
  await syncMetadata(index);

  // Charge toutes les extensions
  const sets = new Map();
  for (const e of index.extensions) {
    if (e.exclue) continue;
    const d = await readJson(setFile(e.id), null);
    if (d) sets.set(e.id, d);
  }
  const order = index.extensions.filter((e) => !e.exclue).map((e) => e.id);

  // File d'attente : prioritaires d'abord (toutes extensions, plus récentes d'abord), puis le reste
  const queue = [];
  for (const level of ONLY_PRIORITY ? [2] : [2, 1]) {
    for (const id of order) {
      const d = sets.get(id);
      if (!d) continue;
      for (const c of d.cartes) if (!c.analyse && c.priorite === level && c.image) queue.push(c);
    }
  }
  log(queue.length + ' cartes en attente d\'analyse, ' + PROVIDER + ', max ' + MAX_REQUESTS + ' requêtes');

  let requests = 0, done = 0;
  const dirty = new Set();
  const flush = async () => {
    for (const id of dirty) await writeJson(setFile(id), sets.get(id));
    dirty.clear();
  };
  try {
    for (let i = 0; i < queue.length && requests < MAX_REQUESTS; i += PER_REQUEST) {
      if (timeLeft() < 3 * 60000) { log('Temps limite atteint'); break; }
      const batch = queue.slice(i, i + PER_REQUEST);
      requests++;
      let results;
      try { results = await analyseBatch(batch); }
      catch (e) {
        if (e instanceof Fatal) throw e;
        log('Lot ignoré (' + batch.map((c) => c.id).join(', ') + ') : ' + e.message);
        continue;
      }
      batch.forEach((c, k) => {
        c.analyse = Object.assign({}, results[k], { le: today(), modele: PROVIDER === 'claude' ? CLAUDE_MODEL : geminiModel });
        dirty.add(c.extension);
      });
      done += batch.length;
      if (requests % 10 === 0) { await flush(); log(done + ' cartes analysées (' + requests + ' requêtes)'); }
      if (PROVIDER === 'gemini') await sleep(7000); // offre gratuite : ~10 requêtes/minute
    }
  } catch (e) {
    log('Arrêt : ' + e.message);
  }
  await flush();

  // Dérivés + fichiers de synthèse
  const all = [...sets.values()].flatMap((d) => d.cartes);
  computeFamilies(all);
  for (const id of sets.keys()) await writeJson(setFile(id), sets.get(id));
  for (const e of index.extensions) {
    const d = sets.get(e.id);
    if (!d) continue;
    e.cartes = d.cartes.length;
    e.prioritaires = d.cartes.filter((c) => c.priorite === 2).length;
    e.analysees = d.cartes.filter((c) => c.analyse).length;
  }
  const analysed = all.filter((c) => c.analyse);
  index.maj = today();
  index.langue = 'fr';
  index.total = {
    extensions: sets.size,
    cartes: all.length,
    prioritaires: all.filter((c) => c.priorite === 2).length,
    prioritaires_analysees: all.filter((c) => c.priorite === 2 && c.analyse).length,
    analysees: analysed.length
  };
  await writeJson(path.join(DATA, 'index.json'), index);
  await writeJson(path.join(DATA, 'analysees.json'), { maj: today(), cartes: analysed.map(compact) }, false);
  log('Terminé : ' + done + ' cartes analysées ce lancement, ' + analysed.length + ' au total.');
}

main().catch((e) => { console.error('ERREUR : ' + e.message); process.exit(1); });
