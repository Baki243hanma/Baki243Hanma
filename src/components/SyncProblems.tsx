/**
 * Liste des opérations de synchronisation qui demandent une décision de l'utilisateur
 * (échec ou conflit). Aucune action n'est automatique : chaque choix est explicite.
 */
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useReady } from '../app/useReady';
import { useApp } from '../app/AppContext';
import { operationLabel, resolveOperation, type ResolutionAction } from '../db/repo';
import type { SyncOperation } from '../domain/types';
import { Badge, Button, Card } from './ui';
import { ConfirmDialog, useAsyncAction } from './Confirm';
import { useToast } from './Toast';
import { formatFC } from '../lib/money';

interface ProblemView {
  op: SyncOperation;
  entityName: string;
  serverProduct: { name: string; sale_price: number; quantity: number; version: number; purchase_price: number; alert_threshold: number; status: string; category: string | null } | null;
}

export function SyncProblems() {
  const { db } = useReady();
  const { online } = useApp();
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ op: SyncOperation; action: ResolutionAction } | null>(null);
  const { busy, run } = useAsyncAction();

  const problems = useLiveQuery(async (): Promise<ProblemView[]> => {
    const ops = await db.sync_operations.where('status').anyOf(['failed', 'conflict']).sortBy('seq');
    const views: ProblemView[] = [];
    for (const op of ops) {
      const product = await db.products.get(op.entity_id);
      const order = product ? null : await db.orders.get(op.entity_id);
      const entityName = product?.name ?? (order ? `Commande ${order.id.slice(0, 8).toUpperCase()}` : 'Élément');
      const snap = op.server_snapshot as { server_product?: ProblemView['serverProduct'] } | null;
      views.push({ op, entityName, serverProduct: snap?.server_product ?? null });
    }
    return views;
  }, [db], []);

  const waiting = useLiveQuery(() => db.sync_operations.where('status').equals('pending').count(), [db], 0);

  if (!problems || problems.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-sm text-slate-600">
        <p>Aucune opération bloquée.</p>
        {waiting > 0 && <p>{waiting} opération(s) en attente d’envoi. Elles partiront automatiquement dès que possible.</p>}
      </div>
    );
  }

  const confirmCopy = (action: ResolutionAction, op: SyncOperation): { title: string; message: string; label: string; tone: 'primary' | 'danger' } => {
    if (action === 'discard' && op.type === 'create_order') {
      return {
        title: 'Abandonner cette commande ?',
        tone: 'danger',
        label: 'Abandonner la commande',
        message:
          'La commande ne sera PAS envoyée au serveur. Elle restera visible dans l’historique avec la mention « non envoyée » et le stock de cet appareil sera rétabli. Cette action ne peut pas être annulée.',
      };
    }
    if (action === 'discard') {
      return {
        title: 'Abandonner ce mouvement de stock ?',
        tone: 'danger',
        label: 'Abandonner le mouvement',
        message: 'Le mouvement non envoyé sera retiré de cet appareil et le stock sera rétabli. Le serveur n’a rien enregistré.',
      };
    }
    if (action === 'use_server') {
      return {
        title: 'Prendre la version du serveur ?',
        tone: 'danger',
        label: 'Remplacer par la version serveur',
        message: 'Vos modifications de cet article, non envoyées, seront remplacées par la version enregistrée sur le serveur.',
      };
    }
    if (action === 'keep_local') {
      return {
        title: 'Garder votre version ?',
        tone: 'primary',
        label: 'Garder ma version',
        message: 'Votre version sera envoyée et remplacera celle du serveur à la prochaine synchronisation.',
      };
    }
    return { title: 'Réessayer ?', tone: 'primary', label: 'Réessayer', message: 'L’opération sera renvoyée au serveur.' };
  };

  async function execute() {
    if (!confirm) return;
    const { op, action } = confirm;
    const ok = await run(async () => {
      await resolveOperation(db, op.seq!, action);
    });
    setConfirm(null);
    if (ok) toast.show(action === 'retry' ? 'Opération remise en file d’envoi.' : 'Décision enregistrée.', 'success');
  }

  return (
    <div className="flex flex-col gap-3">
      {problems.map(({ op, entityName, serverProduct }) => {
        const isConflict = op.status === 'conflict';
        const canDiscard = op.type === 'create_order' || op.type === 'stock_movement';
        return (
          <Card key={op.op_id} className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={isConflict ? 'warning' : 'danger'}>{isConflict ? 'Conflit' : 'Échec'}</Badge>
              <p className="text-sm font-semibold text-slate-900">{operationLabel(op.type)}</p>
            </div>
            <p className="text-sm text-slate-700">
              <span className="font-semibold">{entityName}</span>
            </p>
            <p className="text-sm leading-relaxed text-slate-600">{op.last_error}</p>
            {isConflict && serverProduct && (
              <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">
                <p className="font-semibold">Version sur le serveur :</p>
                <p>
                  {serverProduct.name} · {formatFC(serverProduct.sale_price)} · stock serveur {serverProduct.quantity}
                </p>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Button variant="primary" block disabled={busy || !online} onClick={() => setConfirm({ op, action: 'retry' })}>
                {isConflict ? 'Réessayer la synchronisation' : 'Réessayer'}
              </Button>
              {isConflict && (
                <>
                  <Button variant="secondary" block disabled={busy} onClick={() => setConfirm({ op, action: 'keep_local' })}>
                    Garder ma version et l’envoyer
                  </Button>
                  <Button variant="secondary" block disabled={busy} onClick={() => setConfirm({ op, action: 'use_server' })}>
                    Prendre la version du serveur
                  </Button>
                </>
              )}
              {!isConflict && canDiscard && (
                <Button variant="ghost" block disabled={busy} onClick={() => setConfirm({ op, action: 'discard' })}>
                  Abandonner sur cet appareil
                </Button>
              )}
            </div>
          </Card>
        );
      })}
      {confirm && (
        <ConfirmDialog
          open
          busy={busy}
          title={confirmCopy(confirm.action, confirm.op).title}
          message={confirmCopy(confirm.action, confirm.op).message}
          confirmLabel={confirmCopy(confirm.action, confirm.op).label}
          tone={confirmCopy(confirm.action, confirm.op).tone}
          onConfirm={execute}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
