// Tests de l'API : vrai simulateur R2 de Wrangler, jetons Access signés avec une clé de test.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { demarrer, appel, jeton, worker, autreCle, cleInconnue, ficheA, ficheB, sansId, PAGES } from './outils-test.mjs';

let t, J;
before(async () => { t = await demarrer(); J = await jeton(); });
after(async () => { await t.proxy.dispose(); });
beforeEach(async () => { await t.vider(); });

const init = (fiches, env = t.envOk) => appel(env, 'POST', '/edition/api/initialiser', { fiches }, { jeton: J });
const lire = async () => (await appel(t.envOk, 'GET', '/api/fiches')).donnees.fiches;
const modifier = (id, version, fiche) => appel(t.envOk, 'PUT', `/edition/api/fiches/${id}`, { version, fiche }, { jeton: J });
const commenter = (id, texte) => appel(t.envOk, 'POST', `/edition/api/fiches/${id}/commentaires`, { texte }, { jeton: J });

test('protection non configurée : lecture possible, toute écriture refusée (503)', async () => {
  const etat = await appel(t.envSans, 'GET', '/api/etat');
  assert.equal(etat.donnees.ecriture, false);
  for (const [m, c, corps] of [['GET', '/edition/api/moi'], ['POST', '/edition/api/initialiser', { fiches: [ficheA] }],
    ['PUT', '/edition/api/fiches/o-aaaaaaaa', { version: 1, fiche: sansId(ficheA) }],
    ['POST', '/edition/api/fiches/o-aaaaaaaa/commentaires', { texte: 'x' }]]) {
    const r = await appel(t.envSans, m, c, corps, { jeton: J });
    assert.equal(r.status, 503, `${m} ${c}`);
    assert.match(r.donnees.erreur, /Modification désactivée/);
  }
  assert.deepEqual(await t.cles(), []);
  assert.equal((await appel(t.envOk, 'GET', '/api/etat')).donnees.ecriture, true);
});

test('accès non autorisé : jetons absents, falsifiés ou hors application refusés', async () => {
  const maintenant = Math.floor(Date.now() / 1000);
  const cas = {
    'sans jeton': undefined,
    'autre clé, même kid': await jeton({}, autreCle),
    'clé inconnue': await jeton({}, cleInconnue),
    'autre application (aud)': await jeton({ charge: { aud: ['autre'] } }),
    'autre émetteur (iss)': await jeton({ charge: { iss: 'https://pirate.cloudflareaccess.com' } }),
    'expiré': await jeton({ charge: { exp: maintenant - 10 } }),
    'algorithme none': (await jeton()).replace(/^[^.]+/, Buffer.from('{"alg":"none","kid":"cle-test-1"}').toString('base64url')),
    'mal formé': 'abc.def',
  };
  for (const [nom, j] of Object.entries(cas)) {
    const r = await appel(t.envOk, 'POST', '/edition/api/initialiser', { fiches: [ficheA] }, { jeton: j });
    assert.equal(r.status, 401, nom);
    assert.match(r.donnees.erreur, /Accès non autorisé/, nom);
  }
  const etrangere = await appel(t.envOk, 'POST', '/edition/api/initialiser', { fiches: [ficheA] }, { jeton: J, origine: 'https://pirate.example' });
  assert.equal(etrangere.status, 403);
  const texte = await appel(t.envOk, 'POST', '/edition/api/initialiser', undefined, { jeton: J, type: 'text/plain', brut: JSON.stringify({ fiches: [ficheA] }) });
  assert.equal(texte.status, 415);
  const ecriturePublique = await appel(t.envOk, 'PUT', '/api/fiches', { fiches: [ficheA] });
  assert.equal(ecriturePublique.status, 405);
  assert.deepEqual(await t.cles(), [], 'aucun objet écrit');
  assert.equal((await appel(t.envOk, 'GET', '/edition/api/moi', undefined, { jeton: J })).donnees.email, 'formateur@example.org');
});

test('initialisation unique : crée les absentes, n\'écrase jamais', async () => {
  const r1 = await init([ficheA, ficheB]);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.donnees.creees.map((f) => [f.outilId, f.version]), [['o-aaaaaaaa', 1], ['o-bbbbbbbb', 1]]);
  assert.equal((await modifier('o-aaaaaaaa', 1, { ...sansId(ficheA), nom: 'A modifié' })).status, 200);
  const r2 = await init([ficheA, ficheB]);
  assert.deepEqual(r2.donnees.creees, []);
  assert.deepEqual(r2.donnees.existantes, ['o-aaaaaaaa', 'o-bbbbbbbb']);
  const fiches = await lire();
  assert.equal(fiches['o-aaaaaaaa'].nom, 'A modifié');
  assert.equal(fiches['o-aaaaaaaa'].version, 2);
  // Deux initialisations simultanées : une seule création.
  const ficheC = { ...ficheA, outilId: 'o-cccccccc', nom: 'C' };
  const [x, y] = await Promise.all([init([ficheC]), init([ficheC])]);
  assert.equal(x.donnees.creees.length + y.donnees.creees.length, 1);
  assert.equal((await lire())['o-cccccccc'].version, 1);
  const invalide = await init([{ ...ficheA, outilId: 'pas-un-id' }, { ...ficheB, outilId: 'o-dddddddd', url: 'ftp://x' }]);
  assert.equal(invalide.donnees.erreurs.length, 2);
  assert.equal((await lire())['o-dddddddd'], undefined);
});

test('modifier chaque champ, relire, types conservés', async () => {
  await init([ficheA]);
  const id = 'o-aaaaaaaa';
  let version = 1;
  let courante = sansId(ficheA);
  const etapes = [
    { nom: 'Nouveau nom' }, { url: 'http://nouvelle.example.org/chemin?x=1' }, { description: 'Nouvelle description' },
    { acces: 'Payant' }, { categorie: 'Assets' }, { source: 'Image' }, { dateVerification: '2026-11-16' },
    { dateVerification: null }, { mentionVerification: 'Vérifié en classe' },
    { champsPerso: [
      { nom: 'Licence', type: 'texte', valeur: 'MIT' }, { nom: 'Étoiles', type: 'nombre', valeur: 12.5 },
      { nom: 'Open source', type: 'booleen', valeur: true }, { nom: 'Testé le', type: 'date', valeur: '2026-11-16' },
      { nom: 'Plateformes', type: 'liste', valeur: ['macOS', 'Linux'] }, { nom: 'Documentation', type: 'url', valeur: 'https://docs.example.org' },
    ] },
    { champsPerso: [{ nom: 'Open source', type: 'booleen', valeur: false }, { nom: 'Étoiles', type: 'nombre', valeur: 0 }] },
  ];
  for (const modif of etapes) {
    courante = { ...courante, ...modif };
    const r = await modifier(id, version, courante);
    assert.equal(r.status, 200, JSON.stringify(modif));
    version += 1;
    const relue = (await lire())[id];
    assert.equal(relue.version, version);
    for (const [k, v] of Object.entries(courante)) assert.deepEqual(relue[k], v, k);
  }
  const relue = (await lire())[id];
  assert.equal(typeof relue.champsPerso[0].valeur, 'boolean');
  assert.equal(typeof relue.champsPerso[1].valeur, 'number');
  assert.equal(relue.dateVerification, null);
  assert.equal(relue.outilId, id);
});

test('commenter A sans toucher B, ni la fiche A', async () => {
  await init([ficheA, ficheB]);
  const avantA = await t.brut('fiches/o-aaaaaaaa.json');
  const avantB = await t.brut('fiches/o-bbbbbbbb.json');
  assert.equal((await commenter('o-aaaaaaaa', 'Premier')).status, 201);
  assert.equal((await commenter('o-aaaaaaaa', 'Second')).status, 201);
  assert.equal((await t.brut('fiches/o-aaaaaaaa.json')).etag, avantA.etag);
  assert.equal((await t.brut('fiches/o-bbbbbbbb.json')).etag, avantB.etag);
  const c = (await appel(t.envOk, 'GET', '/api/commentaires')).donnees.commentaires;
  assert.deepEqual(c['o-aaaaaaaa'].map((x) => x.texte), ['Premier', 'Second']);
  assert.equal(c['o-bbbbbbbb'], undefined);
  assert.equal((await t.cles()).filter((k) => k.startsWith('commentaires/o-aaaaaaaa/')).length, 2, 'un objet par commentaire');
  // 10 commentaires simultanés : aucun perdu.
  await Promise.all(Array.from({ length: 10 }, (_, i) => commenter('o-bbbbbbbb', `B${i}`)));
  assert.equal((await appel(t.envOk, 'GET', '/api/commentaires')).donnees.commentaires['o-bbbbbbbb'].length, 10);
});

test('changer l\'URL de A sans perdre ses commentaires', async () => {
  await init([ficheA]);
  await commenter('o-aaaaaaaa', 'Gardé');
  assert.equal((await modifier('o-aaaaaaaa', 1, { ...sansId(ficheA), url: 'https://nouvelle-adresse.example.org/' })).status, 200);
  assert.equal((await lire())['o-aaaaaaaa'].url, 'https://nouvelle-adresse.example.org/');
  assert.deepEqual((await appel(t.envOk, 'GET', '/api/commentaires')).donnees.commentaires['o-aaaaaaaa'].map((c) => c.texte), ['Gardé']);
});

test('conflit de version : signalé, rien n\'est écrasé', async () => {
  await init([ficheA]);
  const premier = await modifier('o-aaaaaaaa', 1, { ...sansId(ficheA), nom: 'Premier' });
  const second = await modifier('o-aaaaaaaa', 1, { ...sansId(ficheA), nom: 'Second' });
  assert.equal(premier.status, 200);
  assert.equal(second.status, 409);
  assert.match(second.donnees.erreur, /Conflit/);
  assert.equal(second.donnees.actuelle.nom, 'Premier');
  assert.equal(second.donnees.actuelle.version, 2);
  assert.equal((await lire())['o-aaaaaaaa'].nom, 'Premier');
  // Modifications simultanées sur la même version : une seule réussit.
  const res = await Promise.all(['X', 'Y', 'Z'].map((n) => modifier('o-aaaaaaaa', 2, { ...sansId(ficheA), nom: n })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal((await lire())['o-aaaaaaaa'].version, 3);
});

test('envois invalides refusés, fiche intacte', async () => {
  await init([ficheA]);
  const base = sansId(ficheA);
  const perso = (c) => ({ ...base, champsPerso: [c] });
  const invalides = {
    'url javascript:': { ...base, url: 'javascript:alert(1)' }, 'url ftp': { ...base, url: 'ftp://a.example.org' },
    'url sans hôte': { ...base, url: 'https://' }, 'url avec espace': { ...base, url: 'https://a.example.org/a b' },
    'url trop longue': { ...base, url: `https://a.example.org/${'x'.repeat(500)}` },
    'nom vide': { ...base, nom: '  ' }, 'nom trop long': { ...base, nom: 'x'.repeat(121) }, 'nom nombre': { ...base, nom: 42 },
    'description trop longue': { ...base, description: 'x'.repeat(601) }, 'accès trop long': { ...base, acces: 'x'.repeat(301) },
    'catégorie inconnue': { ...base, categorie: 'Divers' }, 'source inconnue': { ...base, source: 'Autre' },
    'date impossible': { ...base, dateVerification: '2026-02-30' }, 'date au format français': { ...base, dateVerification: '18/09/2026' },
    'mention trop longue': { ...base, mentionVerification: 'x'.repeat(201) },
    'booléen en texte': perso({ nom: 'b', type: 'booleen', valeur: 'true' }), 'nombre en texte': perso({ nom: 'n', type: 'nombre', valeur: '3' }),
    'date perso invalide': perso({ nom: 'd', type: 'date', valeur: '2026-13-01' }), 'liste en texte': perso({ nom: 'l', type: 'liste', valeur: 'a,b' }),
    'liste trop longue': perso({ nom: 'l', type: 'liste', valeur: Array(31).fill('a') }),
    'lien perso javascript:': perso({ nom: 'u', type: 'url', valeur: 'javascript:alert(1)' }),
    'type inconnu': perso({ nom: 'c', type: 'couleur', valeur: 'rouge' }),
    'noms en double': { ...base, champsPerso: [{ nom: 'X', type: 'texte', valeur: '' }, { nom: 'x', type: 'texte', valeur: '' }] },
    '21 champs': { ...base, champsPerso: Array.from({ length: 21 }, (_, i) => ({ nom: `c${i}`, type: 'texte', valeur: '' })) },
    'champ inconnu': { ...base, prix: 10 }, 'champ manquant': (({ acces, ...r }) => r)(base),
  };
  for (const [nom, fiche] of Object.entries(invalides)) {
    const r = await modifier('o-aaaaaaaa', 1, fiche);
    assert.equal(r.status, 400, nom);
  }
  assert.equal((await modifier('o-aaaaaaaa', '1', base)).status, 400, 'version en texte');
  assert.equal((await modifier('o-aaaaaaaa', 0, base)).status, 400, 'version 0');
  assert.equal((await modifier('abc', 1, base)).status, 400, 'identifiant mal formé');
  assert.equal((await modifier('o-00000000', 1, base)).status, 404, 'fiche inconnue');
  assert.equal((await appel(t.envOk, 'PUT', '/edition/api/fiches/o-aaaaaaaa', undefined, { jeton: J, brut: '{pas du json' })).status, 400);
  assert.equal((await appel(t.envOk, 'PUT', '/edition/api/fiches/o-aaaaaaaa', { version: 1, fiche: { ...base, description: 'x'.repeat(30000) } }, { jeton: J })).status, 413);
  assert.equal((await commenter('o-aaaaaaaa', '   ')).status, 400, 'commentaire vide');
  assert.equal((await commenter('o-aaaaaaaa', 'x'.repeat(1001))).status, 400, 'commentaire trop long');
  assert.equal((await commenter('o-00000000', 'x')).status, 404, 'commentaire sur outil inconnu');
  const relue = (await lire())['o-aaaaaaaa'];
  assert.equal(relue.version, 1);
  assert.deepEqual(sansId(relue).nom, base.nom);
  assert.deepEqual((await t.cles()), ['fiches/o-aaaaaaaa.json']);
});

test('réponses publiques sans adresse e-mail, page d\'édition servie avec CSP', async () => {
  await init([ficheA]);
  await commenter('o-aaaaaaaa', 'Bonjour');
  const fiches = await appel(t.envOk, 'GET', '/api/fiches');
  assert.equal(fiches.headers.get('access-control-allow-origin'), 'https://scap-mehdi.github.io');
  assert.equal('modifiePar' in fiches.donnees.fiches['o-aaaaaaaa'], false);
  assert.equal('auteur' in (await appel(t.envOk, 'GET', '/api/commentaires')).donnees.commentaires['o-aaaaaaaa'][0], false);
  assert.equal((await t.brut('fiches/o-aaaaaaaa.json')).json.modifiePar, 'formateur@example.org');
  const page = await worker.fetch(new Request('https://api.test/edition/outils.html'), t.envOk);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await page.text(), /data-outil-id="o-[0-9a-f]{8}"/);
  const accueil = await worker.fetch(new Request('https://api.test/edition/index.html'), t.envOk);
  assert.equal(accueil.status, 302);
  assert.equal(accueil.headers.get('location'), `${PAGES}index.html`);
});
