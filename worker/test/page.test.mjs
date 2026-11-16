// Tests de outils.html dans jsdom, branché sur le vrai Worker et le simulateur R2.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { demarrer, appel, jeton, worker, HTML, sansId } from './outils-test.mjs';

let t, J;
before(async () => { t = await demarrer(); J = await jeton(); });
after(async () => { await t.proxy.dispose(); });
beforeEach(async () => { await t.vider(); });

const EDITION = 'https://api.test/edition/outils.html';
const PAGES = 'https://scap-mehdi.github.io/claude-prime/outils.html';
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// Le jeton est ajouté comme le ferait Cloudflare Access devant le Worker.
async function ouvrir(url = EDITION, { env = t.envOk, avecJeton = true } = {}) {
  const dom = new JSDOM(HTML, {
    url, runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = async (entree, options = {}) => {
        const cible = new URL(entree, url);
        if (cible.origin !== 'https://api.test') throw new TypeError('réseau bloqué dans le test');
        const headers = new Headers(options.headers || {});
        headers.set('Origin', new URL(url).origin);
        if (avecJeton) headers.set('Cf-Access-Jwt-Assertion', J);
        return worker.fetch(new Request(cible, { method: options.method || 'GET', headers, body: options.body }), env);
      };
    },
  });
  const w = dom.window;
  for (let i = 0; i < 100 && !w.document.querySelector('#edition-info').textContent; i++) await attendre(20);
  await attendre(30);
  return w;
}
const carte = (w, id) => w.document.querySelector(`article[data-outil-id="${id}"]`);
const premierId = (w) => w.document.querySelector('article').dataset.outilId;
const cliquer = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const soumettre = async (w, form) => { form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await attendre(120); };
const definir = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
const libelle = (form, texte) => [...form.querySelectorAll('label')].find((l) => l.firstChild.textContent === texte).querySelector('input,textarea,select');
const texteCarte = (c) => ({ nom: c.querySelector('h2 a').textContent, url: c.querySelector('h2 a').href, desc: c.querySelector('p').textContent,
  acces: c.querySelector('.access').textContent, verif: c.querySelector('small').textContent, meta: c.querySelector('.meta').textContent });

test('GitHub Pages sans Worker : liste d\'origine, filtres intacts, modification désactivée', async () => {
  const w = await ouvrir(PAGES, { avecJeton: false });
  const d = w.document;
  assert.match(d.querySelector('#edition-info').textContent, /Lecture seule/);
  assert.equal(d.querySelector('#edition-info a').href, 'https://claude-prime-api.scap.workers.dev/edition/outils.html');
  assert.equal(d.querySelectorAll('article').length, 68);
  assert.ok([...d.querySelectorAll('.actions button')].every((b) => b.disabled));
  assert.equal(d.querySelectorAll('.actions button').length, 136);
  const filtrer = (sel, v) => { d.querySelector(sel).value = v; d.querySelector(sel).dispatchEvent(new w.Event('change')); return d.querySelector('#count').textContent; };
  assert.equal(filtrer('#source', 'Image'), '25 outils affichés sur 68');
  assert.equal(filtrer('#source', 'Dépôt'), '43 outils affichés sur 68');
  filtrer('#source', '');
  definir(w, d.querySelector('#search'), 'description');
  assert.equal(d.querySelector('#count').textContent, '0 outil affiché sur 68', 'les libellés de formulaire ne faussent pas la recherche');
  definir(w, d.querySelector('#search'), 'securite');
  assert.equal(d.querySelector('#count').textContent, '7 outils affichés sur 68');
  // Rendu identique à l'origine.
  const origine = new JSDOM(HTML).window.document;
  for (const c of d.querySelectorAll('article')) {
    assert.deepEqual(texteCarte(c), texteCarte(origine.querySelector(`article[data-outil-id="${c.dataset.outilId}"]`)));
  }
});

test('édition : initialisation automatique des 68 fiches, rendu inchangé, deuxième ouverture sans réécriture', async () => {
  const w = await ouvrir();
  assert.match(w.document.querySelector('#edition-info').textContent, /Connecté : formateur@example.org/);
  const cles = await t.cles();
  assert.equal(cles.length, 68);
  const origine = new JSDOM(HTML).window.document;
  for (const c of w.document.querySelectorAll('article')) {
    assert.deepEqual(texteCarte(c), texteCarte(origine.querySelector(`article[data-outil-id="${c.dataset.outilId}"]`)));
    assert.equal(c.querySelector('.actions button').disabled, false);
  }
  const etags = await Promise.all(cles.map(async (k) => (await t.brut(k)).etag));
  await ouvrir();
  assert.deepEqual(await Promise.all(cles.map(async (k) => (await t.brut(k)).etag)), etags, 'aucune fiche réécrite');
  const aider = (await appel(t.envOk, 'GET', '/api/fiches')).donnees.fiches[premierId(w)];
  assert.equal(aider.nom, 'Aider');
  assert.equal(aider.dateVerification, '2026-09-18');
  assert.equal(aider.mentionVerification, 'Vérification indiquée par le dépôt');
});

test('formulaire prérempli avec tous les champs, personnalisés compris', async () => {
  let w = await ouvrir();
  const id = premierId(w);
  const fiche = sansId((await appel(t.envOk, 'GET', '/api/fiches')).donnees.fiches[id]);
  delete fiche.version; delete fiche.creeLe; delete fiche.modifieLe;
  fiche.champsPerso = [
    { nom: 'Licence', type: 'texte', valeur: 'Apache-2.0' }, { nom: 'Étoiles', type: 'nombre', valeur: 42 },
    { nom: 'Open source', type: 'booleen', valeur: true }, { nom: 'Testé le', type: 'date', valeur: '2026-11-16' },
    { nom: 'Plateformes', type: 'liste', valeur: ['macOS', 'Linux'] }, { nom: 'Doc', type: 'url', valeur: 'https://aider.chat/docs/' },
  ];
  assert.equal((await appel(t.envOk, 'PUT', `/edition/api/fiches/${id}`, { version: 1, fiche }, { jeton: J })).status, 200);
  w = await ouvrir();
  const c = carte(w, id);
  assert.deepEqual([...c.querySelectorAll('.perso dd')].map((x) => x.textContent), ['Apache-2.0', '42', 'Oui', '16/11/2026', 'macOS, Linux', 'https://aider.chat/docs/']);
  cliquer(w, c.querySelector('.actions button'));
  const form = c.querySelector('.panneau form');
  assert.equal(libelle(form, 'Nom').value, 'Aider');
  assert.equal(libelle(form, 'Lien (http ou https)').value, 'https://github.com/Aider-AI/aider');
  assert.equal(libelle(form, 'Description').value, fiche.description);
  assert.equal(libelle(form, 'Accès et prix').value, fiche.acces);
  assert.equal(libelle(form, 'Catégorie').value, 'Code et édition');
  assert.equal(libelle(form, 'Source').value, 'Dépôt');
  assert.equal(libelle(form, 'Date de vérification').value, '2026-09-18');
  assert.equal(libelle(form, 'Mention de vérification').value, 'Vérification indiquée par le dépôt');
  const lignes = [...form.querySelectorAll('.perso-ligne')];
  assert.equal(lignes.length, 6);
  const valeurs = lignes.map((l) => { const [nom, type] = l.querySelectorAll('input,select'); const v = l.querySelector('span > *');
    return [nom.value, type.value, v.type === 'checkbox' ? v.checked : v.value]; });
  assert.deepEqual(valeurs, [['Licence', 'texte', 'Apache-2.0'], ['Étoiles', 'nombre', '42'], ['Open source', 'booleen', true],
    ['Testé le', 'date', '2026-11-16'], ['Plateformes', 'liste', 'macOS\nLinux'], ['Doc', 'url', 'https://aider.chat/docs/']]);
  assert.match(form.textContent, /Version 2/);
});

test('modifier par le formulaire, recharger, textes affichés sans HTML', async () => {
  let w = await ouvrir();
  const id = premierId(w);
  let c = carte(w, id);
  cliquer(w, c.querySelector('.actions button'));
  const form = c.querySelector('.panneau form');
  definir(w, libelle(form, 'Nom'), 'Aider <b>gras</b>');
  definir(w, libelle(form, 'Lien (http ou https)'), 'https://aider.chat/');
  definir(w, libelle(form, 'Description'), '<img src=x onerror="window.pirate=1">');
  definir(w, libelle(form, 'Accès et prix'), 'Gratuit');
  libelle(form, 'Catégorie').value = 'Assets';
  libelle(form, 'Source').value = 'Image';
  definir(w, libelle(form, 'Date de vérification'), '');
  definir(w, libelle(form, 'Mention de vérification'), 'Vérifié en classe');
  cliquer(w, [...form.querySelectorAll('button')].find((b) => b.textContent === 'Ajouter un champ'));
  cliquer(w, [...form.querySelectorAll('button')].find((b) => b.textContent === 'Ajouter un champ'));
  const [l1, l2] = form.querySelectorAll('.perso-ligne');
  definir(w, l1.querySelector('input'), 'Gratuit pour les élèves');
  l1.querySelector('select').value = 'booleen'; l1.querySelector('select').dispatchEvent(new w.Event('change'));
  l1.querySelector('input[type=checkbox]').checked = true;
  definir(w, l2.querySelector('input'), 'Systèmes');
  l2.querySelector('select').value = 'liste'; l2.querySelector('select').dispatchEvent(new w.Event('change'));
  definir(w, l2.querySelector('textarea'), 'macOS\n\n Linux \nWindows');
  await soumettre(w, form);
  assert.match(c.querySelector('.statut').textContent, /Fiche enregistrée \(version 2\)/);
  const enregistree = (await appel(t.envOk, 'GET', '/api/fiches')).donnees.fiches[id];
  assert.equal(enregistree.dateVerification, null);
  assert.deepEqual(enregistree.champsPerso, [{ nom: 'Gratuit pour les élèves', type: 'booleen', valeur: true },
    { nom: 'Systèmes', type: 'liste', valeur: ['macOS', 'Linux', 'Windows'] }]);
  w = await ouvrir();
  c = carte(w, id);
  assert.deepEqual(texteCarte(c), { nom: 'Aider <b>gras</b> ↗', url: 'https://aider.chat/', desc: '<img src=x onerror="window.pirate=1">',
    acces: 'Gratuit', verif: 'Vérifié en classe', meta: 'Assets · Image' });
  assert.equal(c.querySelector('img, b'), null, 'aucune balise injectée');
  assert.equal(w.pirate, undefined);
  assert.equal(c.dataset.category, 'Assets');
  const d = w.document;
  d.querySelector('#category').value = 'Assets'; d.querySelector('#category').dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelector('#count').textContent, '2 outils affichés sur 68');
  d.querySelector('#category').value = '';
  definir(w, d.querySelector('#search'), 'gratuit pour les eleves');
  assert.equal(d.querySelector('#count').textContent, '1 outil affiché sur 68', 'recherche dans les champs personnalisés');
});

test('commenter A par la page sans toucher B, puis changer l\'URL de A', async () => {
  let w = await ouvrir();
  const [a, b] = [...w.document.querySelectorAll('article')].map((x) => x.dataset.outilId);
  const ficheB = (await t.brut(`fiches/${b}.json`)).etag;
  const c = carte(w, a);
  cliquer(w, c.querySelectorAll('.actions button')[1]);
  definir(w, c.querySelector('.panneau textarea'), 'Très utile <script>alert(1)</script>');
  await soumettre(w, c.querySelector('.panneau form'));
  assert.match(c.querySelector('.statut').textContent, /Commentaire publié/);
  assert.equal(c.querySelector('.commentaires h3').textContent, 'Commentaires (1)');
  assert.equal(carte(w, b).querySelector('.commentaires').hidden, true);
  assert.equal((await t.brut(`fiches/${b}.json`)).etag, ficheB);
  cliquer(w, c.querySelector('.actions button'));
  definir(w, libelle(c.querySelector('.panneau form'), 'Lien (http ou https)'), 'https://aider.chat/nouvelle/');
  await soumettre(w, c.querySelector('.panneau form'));
  w = await ouvrir();
  const relue = carte(w, a);
  assert.equal(relue.querySelector('h2 a').href, 'https://aider.chat/nouvelle/');
  assert.equal(relue.querySelector('.commentaires li span').textContent, 'Très utile <script>alert(1)</script>');
  assert.equal(relue.querySelector('.commentaires script'), null);
});

test('conflit dans la page : signalé, rien n\'est écrasé, rechargement possible', async () => {
  const w1 = await ouvrir();
  const w2 = await ouvrir();
  const id = premierId(w1);
  const c1 = carte(w1, id), c2 = carte(w2, id);
  cliquer(w1, c1.querySelector('.actions button'));
  cliquer(w2, c2.querySelector('.actions button'));
  definir(w1, libelle(c1.querySelector('.panneau form'), 'Nom'), 'Version élève 1');
  definir(w2, libelle(c2.querySelector('.panneau form'), 'Nom'), 'Version élève 2');
  await soumettre(w1, c1.querySelector('.panneau form'));
  await soumettre(w2, c2.querySelector('.panneau form'));
  assert.match(c2.querySelector('.statut').textContent, /Conflit : la fiche est passée à la version 2/);
  assert.equal((await appel(t.envOk, 'GET', '/api/fiches')).donnees.fiches[id].nom, 'Version élève 1');
  assert.equal(libelle(c2.querySelector('.panneau form'), 'Nom').value, 'Version élève 2', 'saisie conservée à l\'écran');
  cliquer(w2, [...c2.querySelectorAll('.statut button')].find((x) => x.textContent === 'Recharger la fiche'));
  assert.equal(libelle(c2.querySelector('.panneau form'), 'Nom').value, 'Version élève 1');
  assert.match(c2.querySelector('.panneau form').textContent, /Version 2/);
});

test('protection non configurée ou accès refusé : modification désactivée dans la page', async () => {
  const sans = await ouvrir(EDITION, { env: t.envSans });
  assert.match(sans.document.querySelector('#edition-info').textContent, /Modification désactivée/);
  assert.ok([...sans.document.querySelectorAll('.actions button')].every((b) => b.disabled));
  const refuse = await ouvrir(EDITION, { avecJeton: false });
  assert.match(refuse.document.querySelector('#edition-info').textContent, /Accès non autorisé/);
  assert.ok([...refuse.document.querySelectorAll('.actions button')].every((b) => b.disabled));
  assert.deepEqual(await t.cles(), []);
});
