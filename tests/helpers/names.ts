let counter = 0;

/** Nom de base IndexedDB unique par test (évite les collisions entre tests). */
export function uniqueDbName(prefix = 'test'): string {
  counter += 1;
  return `shopflow-test-${prefix}-${Date.now().toString(36)}-${counter}`;
}
