import { useEffect, useState, type FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../app/AppContext';
import { useReady } from '../app/useReady';
import { Banner, Button, Card, Field, PageHeader, Sheet, TextInput, Badge } from '../components/ui';
import { IconLogout, IconSync } from '../components/icons';
import { ConfirmDialog, useAsyncAction } from '../components/Confirm';
import { SyncProblems } from '../components/SyncProblems';
import { useToast } from '../components/Toast';
import { formatDateTime } from '../lib/dates';
import { formatInt } from '../lib/money';

const APP_VERSION = '0.1.0';

export function SettingsPage() {
  const { db, shop } = useReady();
  const app = useApp();
  const toast = useToast();

  const [nameOpen, setNameOpen] = useState(false);
  const [name, setName] = useState(shop.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const nameAction = useAsyncAction();
  const logoutAction = useAsyncAction();

  const counts = useLiveQuery(
    async () => ({
      products: await db.products.count(),
      orders: await db.orders.count(),
      pending: await db.sync_operations.where('status').anyOf(['pending', 'syncing', 'failed', 'conflict']).count(),
    }),
    [db],
    { products: 0, orders: 0, pending: 0 },
  );

  useEffect(() => {
    let active = true;
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (storage?.persisted) {
      void storage.persisted().then((v) => active && setPersisted(v));
    }
    return () => {
      active = false;
    };
  }, []);

  async function requestPersistence() {
    try {
      const granted = await navigator.storage?.persist?.();
      setPersisted(Boolean(granted));
      toast.show(granted ? 'Stockage protégé demandé avec succès.' : 'Le navigateur n’a pas accordé le stockage protégé.', granted ? 'success' : 'info');
    } catch {
      toast.show('Demande impossible sur cet appareil.', 'error');
    }
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setNameError(null);
    const clean = name.trim();
    if (clean.length === 0 || clean.length > 120) {
      setNameError('Le nom doit contenir entre 1 et 120 caractères.');
      return;
    }
    await nameAction.run(async () => {
      await app.renameShop(clean);
      toast.show('Nom de la boutique enregistré.', 'success');
      setNameOpen(false);
    }, setNameError);
  }

  async function logout() {
    await logoutAction.run(async () => {
      await app.signOut();
      setLogoutOpen(false);
    });
  }

  const lastSync = app.sync.lastReport;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Paramètres" subtitle="Votre boutique, votre compte et la synchronisation." />

      <Card as="section" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Boutique</h2>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-slate-500">Nom affiché sur l’application</p>
            <p className="truncate text-lg font-bold text-slate-900">{shop.name}</p>
          </div>
          <Button variant="secondary" size="md" onClick={() => { setName(shop.name); setNameOpen(true); }}>
            Modifier
          </Button>
        </div>
      </Card>

      <Card as="section" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Compte</h2>
        {app.mode === 'remote' ? (
          <>
            <p className="text-sm text-slate-700">
              Connecté avec <span className="font-semibold text-slate-900">{app.auth.email ?? 'votre compte'}</span>.
            </p>
            <Button variant="secondary" block onClick={() => setLogoutOpen(true)}>
              <IconLogout size={18} /> Se déconnecter
            </Button>
            <p className="text-xs leading-relaxed text-slate-500">
              La déconnexion ne supprime pas les données de cet appareil. Pour les retrouver, reconnectez-vous avec le même compte.
            </p>
          </>
        ) : (
          <Banner tone="warning" title="Mode local (sans compte)">
            Les données restent sur cet appareil uniquement. Aucune sauvegarde distante n’est active. Configurez Supabase pour créer des comptes et sauvegarder vos données (voir le README).
          </Banner>
        )}
      </Card>

      <Card as="section" className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Synchronisation</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-slate-500">Connexion</dt>
            <dd className="font-semibold text-slate-900">{app.online ? 'Internet disponible' : 'Hors ligne'}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Dernière synchro réussie</dt>
            <dd className="font-semibold text-slate-900">{app.lastSyncAt ? formatDateTime(app.lastSyncAt) : 'Jamais'}</dd>
          </div>
          <div>
            <dt className="text-slate-500">En attente d’envoi</dt>
            <dd className="font-semibold text-slate-900">{formatInt(counts?.pending ?? 0)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Mode</dt>
            <dd className="font-semibold text-slate-900">{app.mode === 'remote' ? 'Serveur (Supabase)' : 'Local uniquement'}</dd>
          </div>
        </dl>
        {lastSync && <p className="text-sm text-slate-700">{lastSync.message}</p>}
        <Button
          block
          variant="secondary"
          onClick={() => app.syncNow()}
          disabled={app.mode === 'local' || !app.online || app.sync.running}
        >
          <IconSync size={18} className={app.sync.running ? 'animate-spin' : ''} />
          {app.sync.running ? 'Synchronisation en cours…' : 'Synchroniser maintenant'}
        </Button>
        {app.mode === 'local' && <p className="text-xs text-slate-500">La synchronisation est indisponible en mode local.</p>}
        <p className="text-xs leading-relaxed text-slate-500">
          Une synchronisation a lieu à l’ouverture de l’application, au retour au premier plan et au retour de la connexion. Sur iPhone, l’application ne synchronise pas quand elle est fermée ou en arrière-plan.
        </p>
      </Card>

      <section aria-labelledby="problems-title" className="flex flex-col gap-3">
        <h2 id="problems-title" className="text-sm font-semibold uppercase tracking-wide text-slate-500">Opérations à traiter</h2>
        <SyncProblems />
      </section>

      <Card as="section" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Données de cet appareil</h2>
        <p className="text-sm text-slate-700">
          {formatInt(counts?.products ?? 0)} article(s) et {formatInt(counts?.orders ?? 0)} commande(s) enregistrés sur cet appareil.
        </p>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Stockage protégé :</span>
          {persisted === null ? <Badge>Inconnu</Badge> : persisted ? <Badge tone="success">Oui</Badge> : <Badge tone="warning">Non</Badge>}
        </div>
        {persisted === false && (
          <Button variant="secondary" size="md" onClick={() => void requestPersistence()}>
            Demander un stockage protégé
          </Button>
        )}
        <p className="text-xs leading-relaxed text-slate-500">
          Ne supprimez pas les données du navigateur ou de l’application avant d’avoir synchronisé : les opérations non envoyées seraient perdues. Les sauvegardes du téléphone ne remplacent pas la synchronisation.
        </p>
      </Card>

      <Card as="section" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Changer d’appareil ou récupérer vos données</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-slate-700">
          <li>Sur l’ancien appareil, ouvrez Paramètres et lancez une synchronisation. Vérifiez qu’aucune opération n’est en attente.</li>
          <li>Sur le nouvel appareil, ouvrez ShopFlow RDC et connectez-vous avec le même email et le même mot de passe.</li>
          <li>Vos articles, commandes et mouvements de stock sont téléchargés automatiquement. Attendez le message « Synchronisation réussie ».</li>
        </ol>
      </Card>

      <Card as="section" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Aide rapide</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-slate-700">
          <li>Créez vos articles une seule fois dans l’onglet Articles.</li>
          <li>Pour vendre, touchez « Nouvelle commande » en bas, ajoutez les articles, choisissez le paiement, puis confirmez.</li>
          <li>Une erreur de stock insuffisant bloque la vente : rien n’est enregistré à moitié.</li>
          <li>Une commande annulée reste dans l’historique et le stock est rétabli.</li>
          <li>La marge brute n’inclut pas le loyer, le transport ni les salaires.</li>
        </ul>
      </Card>

      <p className="pb-2 text-center text-xs text-slate-400">ShopFlow RDC · version {APP_VERSION}</p>

      <Sheet
        open={nameOpen}
        onClose={() => setNameOpen(false)}
        title="Nom de la boutique"
        footer={
          <Button type="submit" form="shop-name-form" block disabled={nameAction.busy}>
            {nameAction.busy ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        }
      >
        <form id="shop-name-form" className="flex flex-col gap-4" onSubmit={saveName} noValidate>
          <Field label="Nom de la boutique" required error={nameError ?? undefined}>
            {(id, desc) => <TextInput id={id} aria-describedby={desc} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} error={!!nameError} />}
          </Field>
        </form>
      </Sheet>

      <ConfirmDialog
        open={logoutOpen}
        busy={logoutAction.busy}
        title="Se déconnecter ?"
        tone="warning"
        confirmLabel="Se déconnecter"
        message={
          <>
            <p>Vos données restent sur cet appareil.</p>
            {(counts?.pending ?? 0) > 0 && (
              <p className="mt-3 font-semibold text-amber-900">
                {counts?.pending} opération(s) ne sont pas encore envoyées au serveur. Elles resteront sur cet appareil et seront envoyées à la prochaine connexion avec ce compte. Connectez-vous à Internet et synchronisez avant de vous déconnecter si possible.
              </p>
            )}
          </>
        }
        onConfirm={logout}
        onCancel={() => setLogoutOpen(false)}
      />
      {logoutAction.error && <Banner tone="danger">{logoutAction.error}</Banner>}
    </div>
  );
}
