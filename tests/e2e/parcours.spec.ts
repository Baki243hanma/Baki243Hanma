/**
 * Parcours réels dans un navigateur (Chromium, viewport mobile 390 px).
 * Mode local (Supabase non configuré) : toutes les données restent dans IndexedDB de l'appareil.
 */
import { expect, type Page, test } from '@playwright/test';

const SHOP = 'Boutique Test';

async function openFresh(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bienvenue !' })).toBeVisible();
  await page.getByLabel('Nom de la boutique').fill(SHOP);
  await page.getByRole('button', { name: 'Commencer' }).click();
  await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible();
}

async function addProduct(page: Page, name: string, salePrice: string, quantity: string) {
  await page.goto('/articles/nouveau');
  await page.getByLabel(/Nom de l.article/).fill(name);
  await page.getByLabel(/Prix d.achat/).fill('2500');
  await page.getByLabel(/Prix de vente/).fill(salePrice);
  await page.getByLabel(/Quantité en stock/).fill(quantity);
  await page.getByRole('button', { name: 'Enregistrer l’article' }).click();
  await expect(page.getByRole('heading', { name: name }).or(page.getByText(name).first())).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'défilement horizontal inattendu').toBeLessThanOrEqual(0);
}

test.describe('navigation et mise en page mobile', () => {
  test('affiche les 5 onglets avec les bons libellés, sans défilement horizontal', async ({ page }) => {
    await openFresh(page);
    const nav = page.getByRole('navigation', { name: 'Navigation principale' });
    await expect(nav.getByText('Tableau de bord')).toBeVisible();
    await expect(nav.getByText('Articles')).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Nouvelle commande' })).toBeVisible();
    await expect(nav.getByText('Historique')).toBeVisible();
    await expect(nav.getByText('Paramètres')).toBeVisible();
    await noHorizontalOverflow(page);
  });

  test('reste utilisable à 320 px (écran étroit) sur toutes les pages principales', async ({ page }) => {
    await openFresh(page);
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of ['/', '/articles', '/commande', '/historique', '/parametres']) {
      await page.goto(path);
      await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible();
      await noHorizontalOverflow(page);
    }
  });
});

test.describe('états vides', () => {
  test('tableau de bord, articles et historique sans données affichent un message clair', async ({ page }) => {
    await openFresh(page);
    await expect(page.getByText('Aucun article pour l’instant')).toBeVisible();
    await page.goto('/articles');
    await expect(page.getByText('Aucun article pour l’instant')).toBeVisible();
    await page.goto('/historique');
    await expect(page.getByText('Aucune commande enregistrée')).toBeVisible();
  });

  test('une recherche sans résultat affiche un état vide dédié', async ({ page }) => {
    await openFresh(page);
    await addProduct(page, 'Huile de coco', '3000', '4');
    await page.goto('/articles');
    await page.getByRole('searchbox').or(page.getByPlaceholder(/Rechercher/)).first().fill('zzzz-introuvable');
    await expect(page.getByText('Aucun article ne correspond')).toBeVisible();
  });
});

/** Ouvre le récapitulatif puis valide la commande (une seule fois, sauf indication contraire). */
async function reviewAndConfirm(page: Page, clicks = 1) {
  await page.getByRole('button', { name: 'Vérifier et valider la commande' }).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: /^Confirmer · / });
  await expect(confirm).toBeVisible();
  if (clicks === 1) {
    await confirm.click();
  } else {
    // Clics synchrones dans le même tick : la garde anti-double validation doit empêcher le second envoi.
    await confirm.evaluate((button: HTMLButtonElement, n: number) => {
      for (let i = 0; i < n; i += 1) button.click();
    }, clicks);
  }
  await expect(page.getByRole('heading', { name: 'Commande enregistrée' })).toBeVisible();
}

test.describe('ventes, stock et sécurité de validation', () => {
  test('une commande déduit le stock, et une double validation ne crée qu’une seule commande', async ({ page }) => {
    await openFresh(page);
    await addProduct(page, 'Brume vanille', '5000', '10');

    await page.goto('/commande');
    await page.getByRole('button', { name: 'Ajouter Brume vanille au panier' }).click();
    await page.getByRole('button', { name: 'Augmenter' }).first().click(); // quantité 2
    await page.getByRole('button', { name: 'Espèces' }).click();

    // Deux clics très rapides sur « Confirmer » : une seule commande doit être enregistrée.
    await reviewAndConfirm(page, 2);

    await page.goto('/historique');
    await expect(page.locator('a[href^="/historique/"]')).toHaveCount(1);

    // Stock : 10 − 2 = 8 (et non 6 si la commande était enregistrée deux fois).
    await page.goto('/articles');
    await page.getByText('Brume vanille').first().click();
    await expect(page.getByText(/^8$/).first()).toBeVisible();
  });

  test('une annulation conserve la commande et restaure le stock', async ({ page }) => {
    await openFresh(page);
    await addProduct(page, 'Bague argent', '3000', '5');
    await page.goto('/commande');
    await page.getByRole('button', { name: 'Ajouter Bague argent au panier' }).click();
    await page.getByRole('button', { name: 'Mobile money' }).click();
    await reviewAndConfirm(page);

    await page.goto('/historique');
    await page.locator('a[href^="/historique/"]').first().click();
    await page.getByRole('button', { name: 'Annuler cette commande' }).click();
    await page.getByRole('radio', { name: 'Erreur de saisie' }).check();
    await page.getByRole('button', { name: 'Confirmer l’annulation' }).click();
    // Attendre la fin réelle de l’écriture (fenêtre fermée, badge « Annulée ») avant de recharger la page.
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText('Annulée', { exact: true })).toBeVisible();

    // Le stock est revenu à 5 ; la commande reste consultable (statut « Annulée »).
    await page.goto('/articles');
    await page.getByText('Bague argent').first().click();
    await expect(page.getByText('5', { exact: true })).toBeVisible();
    await expect(page.getByText('Annulation de vente', { exact: true })).toBeVisible();
  });
});

test.describe('hors ligne', () => {
  test('l’interface s’ouvre hors ligne et les données locales sont conservées', async ({ page, context }) => {
    await openFresh(page);
    await addProduct(page, 'Savon noir', '1500', '20');

    // Attend que le service worker contrôle la page (nécessaire pour l’ouverture hors ligne).
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible();
    await page.goto('/articles');
    await expect(page.getByText('Savon noir').first()).toBeVisible();

    // Une vente hors ligne est enregistrée sur l’appareil.
    await page.goto('/commande');
    await page.getByRole('button', { name: 'Ajouter Savon noir au panier' }).click();
    await page.getByRole('button', { name: 'Espèces' }).click();
    await reviewAndConfirm(page);

    await context.setOffline(false);
    await page.goto('/historique');
    await expect(page.locator('a[href^="/historique/"]')).toHaveCount(1);
  });
});
