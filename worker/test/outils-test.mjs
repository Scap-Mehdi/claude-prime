// Outils communs aux tests. Aucun secret réel : la clé RSA est générée à chaque lancement.
import { readFileSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker from '../index.js';

export { worker };
export const HTML = readFileSync(new URL('../../outils.html', import.meta.url), 'utf8');
export const DOMAINE = 'equipe-test.cloudflareaccess.com';
export const AUD = 'a1b2c3d4'.repeat(8);
export const PAGES = 'https://scap-mehdi.github.io/claude-prime/';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

async function paireRsa(kid) {
  const paire = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', paire.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { prive: paire.privateKey, jwk };
}
export const cle = await paireRsa('cle-test-1');
export const autreCle = await paireRsa('cle-test-1'); // même kid, autre clé : signature invalide
export const cleInconnue = await paireRsa('cle-inconnue');

export async function jeton(modifs = {}, paire = cle) {
  const maintenant = Math.floor(Date.now() / 1000);
  const entete = { alg: 'RS256', kid: paire.jwk.kid, typ: 'JWT', ...(modifs.entete || {}) };
  const charge = { aud: [AUD], email: 'formateur@example.org', iss: `https://${DOMAINE}`, iat: maintenant,
    nbf: maintenant, exp: maintenant + 600, sub: 'test', ...(modifs.charge || {}) };
  const signe = `${b64(entete)}.${b64(charge)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', paire.prive, new TextEncoder().encode(signe));
  return `${signe}.${Buffer.from(sig).toString('base64url')}`;
}

// Seules les clés Access de test et la page GitHub Pages sont simulées. Le reste passe par le vrai fetch.
const fetchReel = globalThis.fetch;
globalThis.fetch = async (entree, options) => {
  const url = typeof entree === 'string' ? entree : entree.url;
  if (url === `https://${DOMAINE}/cdn-cgi/access/certs`) return Response.json({ keys: [cle.jwk] });
  if (url === `${PAGES}outils.html`) return new Response(HTML, { headers: { 'content-type': 'text/html' } });
  return fetchReel(entree, options);
};

export async function demarrer() {
  const proxy = await getPlatformProxy({ configPath: new URL('../wrangler.jsonc', import.meta.url).pathname, persist: false });
  const base = { OUTILS: proxy.env.OUTILS, ORIGINE_PUBLIQUE: 'https://scap-mehdi.github.io', PAGE_SOURCE: PAGES };
  return {
    proxy,
    envOk: { ...base, ACCESS_TEAM_DOMAIN: DOMAINE, ACCESS_AUD: AUD },
    envSans: { ...base, ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' },
    async vider() {
      const l = await proxy.env.OUTILS.list();
      if (l.objects.length) await proxy.env.OUTILS.delete(l.objects.map((o) => o.key));
    },
    async cles() { return (await proxy.env.OUTILS.list()).objects.map((o) => o.key).sort(); },
    async brut(cleR2) { const o = await proxy.env.OUTILS.get(cleR2); return o ? { etag: o.etag, json: await o.json() } : null; },
  };
}

export const ORIGINE_API = 'https://api.test';
export async function appel(env, methode, chemin, corps, { jeton: j, origine = ORIGINE_API, type = 'application/json', brut } = {}) {
  const headers = new Headers();
  if (j) headers.set('Cf-Access-Jwt-Assertion', j);
  if (origine) headers.set('Origin', origine);
  if (corps !== undefined || brut !== undefined) headers.set('content-type', type);
  const r = await worker.fetch(new Request(ORIGINE_API + chemin, {
    method: methode, headers, body: brut !== undefined ? brut : corps !== undefined ? JSON.stringify(corps) : undefined,
  }), env);
  const texte = await r.text();
  let donnees = texte;
  try { donnees = JSON.parse(texte); } catch {}
  return { status: r.status, headers: r.headers, donnees };
}

export const ficheA = {
  outilId: 'o-aaaaaaaa', nom: 'Outil A', url: 'https://a.example.org/', description: 'Description A', acces: 'Gratuit',
  categorie: 'Code et édition', source: 'Dépôt', dateVerification: '2026-09-18',
  mentionVerification: 'Vérification indiquée par le dépôt', champsPerso: [],
};
export const ficheB = { ...ficheA, outilId: 'o-bbbbbbbb', nom: 'Outil B', url: 'https://b.example.org/',
  source: 'Image', dateVerification: null, mentionVerification: 'Transcrit depuis l\'image.' };
export const sansId = ({ outilId, ...f }) => f;
