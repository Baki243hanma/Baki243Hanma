import { Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './app/AppContext';
import { Banner, Button, Spinner } from './components/ui';
import { Shell } from './components/Shell';
import { ToastProvider } from './components/Toast';
import { LoginPage, OnboardingPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { ProductsPage } from './pages/Products';
import { ProductFormPage } from './pages/ProductForm';
import { ProductDetailPage } from './pages/ProductDetail';
import { NewOrderPage } from './pages/NewOrder';
import { OrdersPage, OrderDetailPage } from './pages/Orders';
import { SettingsPage } from './pages/Settings';

export default function App() {
  return (
    <AppProvider>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </AppProvider>
  );
}

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col items-center justify-center bg-slate-50 px-4">{children}</div>;
}

function Gate() {
  const app = useApp();

  if (app.auth.status === 'loading') {
    return (
      <FullScreen>
        <Spinner label="Démarrage de ShopFlow…" />
      </FullScreen>
    );
  }
  if (app.auth.status === 'signed_out') return <LoginPage />;
  if (app.dbError) {
    return (
      <FullScreen>
        <div className="w-full max-w-md">
          <Banner tone="danger" title="Stockage indisponible">
            {app.dbError}
          </Banner>
        </div>
      </FullScreen>
    );
  }
  if (!app.db) {
    return (
      <FullScreen>
        <Spinner label="Ouverture de la mémoire de l’appareil…" />
      </FullScreen>
    );
  }
  if (app.needsShopSetup) return <OnboardingPage />;
  if (!app.shop) {
    return (
      <FullScreen>
        <div className="flex w-full max-w-md flex-col gap-4">
          <Banner tone="warning" title="Configuration de la boutique en attente">
            {app.shopSetupError ?? 'Recherche de votre boutique…'}
          </Banner>
          <Button variant="secondary" block onClick={() => window.location.reload()}>
            Réessayer
          </Button>
        </div>
      </FullScreen>
    );
  }

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<DashboardPage />} />
        <Route path="articles" element={<ProductsPage />} />
        <Route path="articles/nouveau" element={<ProductFormPage mode="create" />} />
        <Route path="articles/:id" element={<ProductDetailPage />} />
        <Route path="articles/:id/modifier" element={<ProductFormPage mode="edit" />} />
        <Route path="commande" element={<NewOrderPage />} />
        <Route path="historique" element={<OrdersPage />} />
        <Route path="historique/:id" element={<OrderDetailPage />} />
        <Route path="parametres" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
