import { useApp } from './AppContext';
import type { ShopDatabase } from '../db/database';
import type { Shop } from './AppContext';

/** À utiliser dans les pages rendues uniquement lorsque la base et la boutique sont prêtes. */
export function useReady(): { db: ShopDatabase; shop: Shop } {
  const { db, shop } = useApp();
  if (!db || !shop) throw new Error('Application non prête : base locale ou boutique indisponible.');
  return { db, shop };
}
