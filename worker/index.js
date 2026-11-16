// claude-prime-api : fiches et commentaires des outils de outils.html, stockés dans R2.
//
// Lecture publique :
//   GET  /api/etat                 { ecriture, edition }
//   GET  /api/fiches               { fiches: { outilId: fiche } }
//   GET  /api/commentaires         { commentaires: { outilId: [commentaire] } }
// Édition, sous /edition/ (chemin protégé par Cloudflare Access, jeton vérifié ici) :
//   GET  /edition/outils.html      page outils.html servie depuis GitHub Pages, même origine que l'API
//   GET  /edition/api/moi          { email }
//   POST /edition/api/initialiser  crée les fiches absentes, n'écrase jamais
//   PUT  /edition/api/fiches/:id   { version, fiche } -> 409 si la version a changé
//   POST /edition/api/fiches/:id/commentaires  { texte }
//
// Objets R2 :
//   fiches/<outilId>.json                        une fiche par outil
//   commentaires/<outilId>/<date>-<uuid>.json    un objet par commentaire

const ID = /^o-[0-9a-f]{8}$/;
const CATEGORIES = ['Code et édition', 'Applications et interfaces', 'Contexte et intégrations', 'Tests et sécurité',
  'Déploiement', 'Espaces de travail', 'Prompts et design', 'Inspiration', 'Composants UI', 'Animations et effets', 'Assets'];
const SOURCES = ['Dépôt', 'Image'];
const TYPES_PERSO = ['texte', 'nombre', 'booleen', 'date', 'liste', 'url'];
const CHAMPS_FICHE = ['nom', 'url', 'description', 'acces', 'categorie', 'source',
  'dateVerification', 'mentionVerification', 'champsPerso'];
const LIMITES = {
  nom: 120, url: 500, description: 600, acces: 300, mentionVerification: 200,
  nomChamp: 40, texteChamp: 500, elementListe: 100, elementsListe: 30, champsPerso: 20, commentaire: 1000,
};
const MAX_COMMENTAIRES_OUTIL = 100;
// Offre gratuite : 1 000 appels aux services Cloudflare par requête. GET /api/commentaires lit chaque objet.
const MAX_COMMENTAIRES_TOTAL = 900;
const JSON_R2 = { contentType: 'application/json; charset=utf-8' };

class ErreurHttp extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
const refus = (message) => new ErreurHttp(400, message);

// ---------- Validation ----------

const estDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function estUrl(v) {
  if (typeof v !== 'string' || v.length > LIMITES.url || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && Boolean(u.hostname);
  } catch { return false; }
}

function chaine(v, champ, max, obligatoire) {
  if (typeof v !== 'string') throw refus(`${champ} : texte attendu`);
  const t = v.trim();
  if (obligatoire && !t) throw refus(`${champ} : obligatoire`);
  if (t.length > max) throw refus(`${champ} : ${max} caractères maximum`);
  return t;
}

const estObjet = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validerPerso(liste) {
  if (!Array.isArray(liste)) throw refus('champsPerso : liste attendue');
  if (liste.length > LIMITES.champsPerso) throw refus(`champsPerso : ${LIMITES.champsPerso} champs maximum`);
  const noms = new Set();
  return liste.map((c, i) => {
    const ou = `champsPerso[${i}]`;
    if (!estObjet(c)) throw refus(`${ou} : objet attendu`);
    for (const k of Object.keys(c)) if (!['nom', 'type', 'valeur'].includes(k)) throw refus(`${ou} : champ inconnu ${k}`);
    const nom = chaine(c.nom, `${ou}.nom`, LIMITES.nomChamp, true);
    if (noms.has(nom.toLowerCase())) throw refus(`${ou}.nom : « ${nom} » existe déjà`);
    noms.add(nom.toLowerCase());
    if (!TYPES_PERSO.includes(c.type)) throw refus(`${ou}.type : ${TYPES_PERSO.join(', ')}`);
    let valeur = c.valeur;
    switch (c.type) {
      case 'texte': valeur = chaine(valeur, `${ou}.valeur`, LIMITES.texteChamp, false); break;
      case 'nombre': if (typeof valeur !== 'number' || !Number.isFinite(valeur)) throw refus(`${ou}.valeur : nombre attendu`); break;
      case 'booleen': if (typeof valeur !== 'boolean') throw refus(`${ou}.valeur : true ou false attendu`); break;
      case 'date': if (!estDate(valeur)) throw refus(`${ou}.valeur : date AAAA-MM-JJ attendue`); break;
      case 'url': if (!estUrl(valeur)) throw refus(`${ou}.valeur : adresse http ou https attendue`); break;
      case 'liste':
        if (!Array.isArray(valeur)) throw refus(`${ou}.valeur : liste attendue`);
        if (valeur.length > LIMITES.elementsListe) throw refus(`${ou}.valeur : ${LIMITES.elementsListe} éléments maximum`);
        valeur = valeur.map((x, j) => chaine(x, `${ou}.valeur[${j}]`, LIMITES.elementListe, true));
        break;
    }
    return { nom, type: c.type, valeur };
  });
}

export function validerFiche(e) {
  if (!estObjet(e)) throw refus('fiche : objet attendu');
  for (const k of Object.keys(e)) if (!CHAMPS_FICHE.includes(k)) throw refus(`Champ inconnu : ${k}`);
  for (const k of CHAMPS_FICHE) if (!(k in e)) throw refus(`Champ manquant : ${k}`);
  if (!estUrl(e.url)) throw refus(`url : adresse http ou https valide attendue (${LIMITES.url} caractères maximum)`);
  if (!CATEGORIES.includes(e.categorie)) throw refus('categorie : valeur inconnue');
  if (!SOURCES.includes(e.source)) throw refus('source : Dépôt ou Image');
  if (e.dateVerification !== null && !estDate(e.dateVerification)) throw refus('dateVerification : date AAAA-MM-JJ ou null');
  return {
    nom: chaine(e.nom, 'nom', LIMITES.nom, true),
    url: e.url,
    description: chaine(e.description, 'description', LIMITES.description, true),
    acces: chaine(e.acces, 'acces', LIMITES.acces, true),
    categorie: e.categorie,
    source: e.source,
    dateVerification: e.dateVerification,
    mentionVerification: chaine(e.mentionVerification, 'mentionVerification', LIMITES.mentionVerification, false),
    champsPerso: validerPerso(e.champsPerso),
  };
}

// Les adresses e-mail restent dans R2 pour l'historique, jamais dans les réponses publiques.
const fichePublique = ({ modifiePar, ...f }) => f;
const commentairePublic = ({ auteur, ...c }) => c;

// ---------- Authentification Cloudflare Access ----------

function configAccess(env) {
  const domaine = String(env.ACCESS_TEAM_DOMAIN || '').trim().replace(/^https:\/\//, '').replace(/\/+$/, '');
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domaine) || !/^[A-Za-z0-9]{16,128}$/.test(aud)) return null;
  return { domaine, aud };
}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')),
  (c) => c.charCodeAt(0));
const json64 = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

let cacheCles = { domaine: '', cles: [], lu: 0 };
async function clesAccess(domaine, forcer) {
  if (!forcer && cacheCles.domaine === domaine && Date.now() - cacheCles.lu < 3600_000) return cacheCles.cles;
  const r = await fetch(`https://${domaine}/cdn-cgi/access/certs`);
  if (!r.ok) throw new ErreurHttp(503, 'Clés Cloudflare Access indisponibles');
  const j = await r.json();
  cacheCles = { domaine, cles: Array.isArray(j.keys) ? j.keys : [], lu: Date.now() };
  return cacheCles.cles;
}

async function verifierAcces(req, config) {
  const nonAutorise = (detail) => new ErreurHttp(401, `Accès non autorisé : ${detail}`);
  const jeton = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!jeton) throw nonAutorise('connexion Cloudflare Access requise');
  const parties = jeton.split('.');
  if (parties.length !== 3) throw nonAutorise('jeton mal formé');
  let entete, charge;
  try { entete = json64(parties[0]); charge = json64(parties[1]); } catch { throw nonAutorise('jeton illisible'); }
  if (entete.alg !== 'RS256' || typeof entete.kid !== 'string') throw nonAutorise('algorithme refusé');
  let jwk = (await clesAccess(config.domaine)).find((k) => k.kid === entete.kid);
  if (!jwk) jwk = (await clesAccess(config.domaine, true)).find((k) => k.kid === entete.kid);
  if (!jwk || jwk.kty !== 'RSA') throw nonAutorise('clé de signature inconnue');
  const cle = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  let signatureValide = false;
  try {
    signatureValide = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cle, b64url(parties[2]),
      new TextEncoder().encode(`${parties[0]}.${parties[1]}`));
  } catch { signatureValide = false; }
  if (!signatureValide) throw nonAutorise('signature invalide');
  const maintenant = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(charge.aud) ? charge.aud : [charge.aud];
  if (charge.iss !== `https://${config.domaine}`) throw nonAutorise('émetteur inattendu');
  if (!aud.includes(config.aud)) throw nonAutorise('jeton destiné à une autre application');
  if (typeof charge.exp !== 'number' || charge.exp <= maintenant) throw nonAutorise('jeton expiré');
  if (typeof charge.nbf === 'number' && charge.nbf > maintenant + 60) throw nonAutorise('jeton pas encore valide');
  return { email: typeof charge.email === 'string' ? charge.email : String(charge.sub || 'compte de service') };
}

// Écriture : protection configurée, jeton valide, même origine, corps JSON.
async function autoriserEcriture(req, env) {
  const config = configAccess(env);
  if (!config) throw new ErreurHttp(503, 'Modification désactivée : la protection Cloudflare Access n\'est pas configurée');
  const qui = await verifierAcces(req, config);
  const origine = req.headers.get('Origin');
  if (origine && origine !== new URL(req.url).origin) throw new ErreurHttp(403, 'Origine refusée');
  if (req.method !== 'GET' && !(req.headers.get('content-type') || '').startsWith('application/json')) {
    throw new ErreurHttp(415, 'Content-Type application/json attendu');
  }
  return qui;
}

async function lireCorps(req, max) {
  const texte = await req.text();
  if (new TextEncoder().encode(texte).length > max) throw new ErreurHttp(413, `Requête trop grande (${max} octets maximum)`);
  try { return JSON.parse(texte); } catch { throw refus('JSON invalide'); }
}

// ---------- R2 ----------

async function listerCles(env, prefix) {
  const cles = [];
  let cursor;
  do {
    const liste = await env.OUTILS.list({ prefix, cursor });
    cles.push(...liste.objects.map((o) => o.key));
    cursor = liste.truncated ? liste.cursor : undefined;
  } while (cursor);
  return cles.sort();
}

async function lireJson(env, cle) {
  const objet = await env.OUTILS.get(cle);
  return objet ? objet.json() : null;
}

const cleFiche = (id) => `fiches/${id}.json`;
const creerSiAbsent = { onlyIf: new Headers({ 'If-None-Match': '*' }) };

async function lireFiches(env) {
  const cles = await listerCles(env, 'fiches/');
  const fiches = {};
  (await Promise.all(cles.map((c) => lireJson(env, c)))).forEach((f) => { if (f) fiches[f.outilId] = fichePublique(f); });
  return fiches;
}

async function lireCommentaires(env) {
  const cles = await listerCles(env, 'commentaires/');
  const parOutil = {};
  (await Promise.all(cles.map((c) => lireJson(env, c)))).forEach((c) => {
    if (c) (parOutil[c.outilId] ||= []).push(commentairePublic(c));
  });
  return parOutil;
}

async function initialiser(env, corps, qui) {
  if (!estObjet(corps) || !Array.isArray(corps.fiches)) throw refus('fiches : liste attendue');
  if (corps.fiches.length > 200) throw refus('200 fiches maximum par initialisation');
  const resultat = { creees: [], existantes: [], erreurs: [] };
  for (const entree of corps.fiches) {
    const id = estObjet(entree) ? entree.outilId : undefined;
    if (typeof id !== 'string' || !ID.test(id)) { resultat.erreurs.push({ outilId: String(id), erreur: 'outilId invalide' }); continue; }
    let fiche;
    try {
      const { outilId, ...champs } = entree;
      fiche = validerFiche(champs);
    } catch (e) { resultat.erreurs.push({ outilId: id, erreur: e.message }); continue; }
    // Double protection contre l'écrasement : test d'existence, puis écriture conditionnelle.
    if (await env.OUTILS.head(cleFiche(id))) { resultat.existantes.push(id); continue; }
    const maintenant = new Date().toISOString();
    const nouvelle = { outilId: id, version: 1, ...fiche, creeLe: maintenant, modifieLe: maintenant, modifiePar: qui.email };
    const ecrit = await env.OUTILS.put(cleFiche(id), JSON.stringify(nouvelle), { ...creerSiAbsent, httpMetadata: JSON_R2 });
    if (ecrit) resultat.creees.push(fichePublique(nouvelle)); else resultat.existantes.push(id);
  }
  return resultat;
}

async function modifierFiche(env, id, corps, qui) {
  if (!estObjet(corps)) throw refus('Objet { version, fiche } attendu');
  for (const k of Object.keys(corps)) if (!['version', 'fiche'].includes(k)) throw refus(`Champ inconnu : ${k}`);
  if (!Number.isInteger(corps.version) || corps.version < 1) throw refus('version : entier positif attendu');
  const fiche = validerFiche(corps.fiche);
  const objet = await env.OUTILS.get(cleFiche(id));
  if (!objet) throw new ErreurHttp(404, 'Fiche inconnue');
  const actuelle = await objet.json();
  const conflit = (a) => new ErreurHttp(409,
    `Conflit : la fiche est passée à la version ${a.version} depuis votre lecture (version ${corps.version}). Rien n'a été écrasé.`,
    { actuelle: fichePublique(a) });
  if (actuelle.version !== corps.version) throw conflit(actuelle);
  const nouvelle = {
    outilId: id, version: actuelle.version + 1, ...fiche,
    creeLe: actuelle.creeLe, modifieLe: new Date().toISOString(), modifiePar: qui.email,
  };
  const ecrit = await env.OUTILS.put(cleFiche(id), JSON.stringify(nouvelle),
    { onlyIf: { etagMatches: objet.etag }, httpMetadata: JSON_R2 });
  if (!ecrit) throw conflit((await lireJson(env, cleFiche(id))) || actuelle);
  return fichePublique(nouvelle);
}

async function commenter(env, id, corps, qui) {
  if (!estObjet(corps)) throw refus('Objet { texte } attendu');
  for (const k of Object.keys(corps)) if (k !== 'texte') throw refus(`Champ inconnu : ${k}`);
  const texte = chaine(corps.texte, 'texte', LIMITES.commentaire, true);
  if (!(await env.OUTILS.head(cleFiche(id)))) throw new ErreurHttp(404, 'Fiche inconnue');
  if ((await listerCles(env, `commentaires/${id}/`)).length >= MAX_COMMENTAIRES_OUTIL) {
    throw new ErreurHttp(429, `Limite de ${MAX_COMMENTAIRES_OUTIL} commentaires atteinte pour cet outil`);
  }
  if ((await listerCles(env, 'commentaires/')).length >= MAX_COMMENTAIRES_TOTAL) {
    throw new ErreurHttp(429, `Limite de ${MAX_COMMENTAIRES_TOTAL} commentaires atteinte pour l'annuaire`);
  }
  const date = new Date().toISOString();
  const commentaire = { commentaireId: crypto.randomUUID(), outilId: id, texte, date, auteur: qui.email };
  await env.OUTILS.put(`commentaires/${id}/${date}-${commentaire.commentaireId}.json`, JSON.stringify(commentaire),
    { ...creerSiAbsent, httpMetadata: JSON_R2 });
  return commentairePublic(commentaire);
}

// ---------- Page d'édition ----------

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; "
  + "img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function servirEdition(env, chemin) {
  const source = String(env.PAGE_SOURCE || '').replace(/\/?$/, '/');
  if (!/^https:\/\//.test(source)) throw new ErreurHttp(404, 'PAGE_SOURCE non configurée');
  const fichier = chemin.slice('/edition/'.length) || 'outils.html';
  if (fichier !== 'outils.html') return Response.redirect(new URL(fichier, source).href, 302);
  const r = await fetch(new URL('outils.html', source).href, { cf: { cacheTtl: 60 } });
  if (!r.ok) throw new ErreurHttp(502, `Page source indisponible (HTTP ${r.status})`);
  return new Response(r.body, {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin',
    },
  });
}

// ---------- Routeur ----------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const chemin = url.pathname;
    const publique = chemin.startsWith('/api/');
    const cors = publique ? {
      'Access-Control-Allow-Origin': env.ORIGINE_PUBLIQUE || 'https://scap-mehdi.github.io',
      'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Vary': 'Origin',
    } : {};
    const repondre = (donnees, status = 200) => new Response(JSON.stringify(donnees), {
      status, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });

    try {
      if (publique) {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
        if (req.method !== 'GET') throw new ErreurHttp(405, 'Lecture seule : utilisez /edition/api/ pour modifier');
        if (chemin === '/api/etat') return repondre({ ecriture: Boolean(configAccess(env)), edition: '/edition/outils.html' });
        if (chemin === '/api/fiches') return repondre({ fiches: await lireFiches(env) });
        if (chemin === '/api/commentaires') return repondre({ commentaires: await lireCommentaires(env) });
        throw new ErreurHttp(404, 'Route inconnue');
      }

      if (chemin.startsWith('/edition/api/')) {
        const qui = await autoriserEcriture(req, env);
        const route = chemin.slice('/edition/api/'.length);
        if (route === 'moi' && req.method === 'GET') return repondre({ email: qui.email });
        if (route === 'initialiser' && req.method === 'POST') return repondre(await initialiser(env, await lireCorps(req, 300_000), qui));
        const m = route.match(/^fiches\/([^/]+)(\/commentaires)?$/);
        if (m) {
          if (!ID.test(m[1])) throw refus('outilId invalide');
          if (!m[2] && req.method === 'PUT') return repondre({ fiche: await modifierFiche(env, m[1], await lireCorps(req, 20_000), qui) });
          if (m[2] && req.method === 'POST') return repondre({ commentaire: await commenter(env, m[1], await lireCorps(req, 5_000), qui) }, 201);
        }
        throw new ErreurHttp(404, 'Route inconnue');
      }

      if (chemin.startsWith('/edition/') && req.method === 'GET') return await servirEdition(env, chemin);
      if (chemin === '/edition') return Response.redirect(new URL('/edition/outils.html', url).href, 302);
      throw new ErreurHttp(404, 'Route inconnue');
    } catch (e) {
      if (!(e instanceof ErreurHttp)) console.error(e);
      return repondre({ erreur: e instanceof ErreurHttp ? e.message : 'Erreur interne', ...(e.extra || {}) }, e.status || 500);
    }
  },
};
