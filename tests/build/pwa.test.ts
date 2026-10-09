/**
 * Compilation réelle (vite build) puis vérifications PWA : manifeste, icônes, balises iOS,
 * service worker (placeholders remplacés, liste de précache présente sur le disque).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');

beforeAll(() => {
  // Vitest définit NODE_ENV=test : on force un build de production, comme sur Render.
  execSync('npx vite build', {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 170_000,
    env: { ...process.env, NODE_ENV: 'production' },
  });
}, 180_000);

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  // Signature PNG (8 octets) puis chunk IHDR : largeur et hauteur en big-endian aux octets 16 à 23.
  expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('compilation', () => {
  it('produit index.html et le bundle JavaScript', () => {
    expect(existsSync(join(DIST, 'index.html'))).toBe(true);
    const assets = readFileSync(join(DIST, 'index.html'), 'utf8');
    expect(assets).toMatch(/assets\/index-[^"]+\.js/);
  });
});

type Manifest = {
  name: string; short_name: string; start_url: string; display: string; lang: string; theme_color: string;
  icons: { src: string; sizes: string; purpose: string }[];
};
/* Les fichiers de dist/ sont lus DANS les tests : le bloc describe s'exécute avant beforeAll. */
const readManifest = () => JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf8')) as Manifest;

describe('manifeste PWA', () => {

  it('contient les champs requis pour l’installation', () => {
    const manifest = readManifest();
    expect(manifest.name).toBe('ShopFlow RDC');
    expect(manifest.short_name).toBe('ShopFlow');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.lang).toBe('fr');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('déclare des icônes 192, 512 et maskable existantes, aux bonnes dimensions', () => {
    const manifest = readManifest();
    const sizes = manifest.icons.map((i) => i.sizes).sort();
    expect(sizes).toEqual(['192x192', '512x512', '512x512']);
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      const file = join(DIST, icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const [w, h] = icon.sizes.split('x').map(Number);
      expect(pngSize(file)).toEqual({ width: w, height: h });
    }
    expect(pngSize(join(DIST, 'icons/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
  });
});

describe('balises iPhone / Safari', () => {
  it('déclare le manifeste, l’icône Apple et le mode application', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="ShopFlow"');
  });

  it('a une fenêtre d’affichage adaptée aux encoches (viewport-fit=cover) et la langue fr', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    expect(html).toContain('viewport-fit=cover');
    expect(html).toContain('<html lang="fr">');
  });
});

describe('service worker', () => {
  it('ne contient plus les marqueurs de build et la syntaxe est valide', () => {
    const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
    expect(sw).not.toContain('__SW_VERSION__');
    expect(sw).not.toContain('__PRECACHE_ASSETS__');
    // Compilation seule (la fonction n'est pas exécutée) : détecte une erreur de syntaxe.
    expect(() => new Function(sw)).not.toThrow();
  });

  it('précache uniquement des fichiers qui existent dans dist/', () => {
    const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
    const match = sw.match(/const PRECACHE_URLS = (\[.*?\]);/);
    expect(match).not.toBeNull();
    const urls = JSON.parse(match![1]) as string[];
    expect(urls).toContain('/index.html');
    expect(urls).toContain('/manifest.webmanifest');
    for (const url of urls) {
      const file = url === '/' ? join(DIST, 'index.html') : join(DIST, url);
      expect(existsSync(file), url).toBe(true);
    }
  });

  it('ne met jamais en cache les appels /api (la configuration reste réseau d’abord)', () => {
    const sw = readFileSync(join(DIST, 'sw.js'), 'utf8');
    expect(sw).toContain("if (url.pathname.startsWith('/api/')) return;");
    expect(sw).toContain("url.origin !== self.location.origin");
  });
});
