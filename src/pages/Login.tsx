import { useState, type FormEvent } from 'react';
import { useApp } from '../app/AppContext';
import { Banner, Button, Card, Field, TextInput } from '../components/ui';
import { useAsyncAction } from '../components/Confirm';
import { useToast } from '../components/Toast';

const MIN_PASSWORD = 8;

function Brand() {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-700 text-xl font-extrabold text-white shadow-md" aria-hidden="true">
        SF
      </div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">ShopFlow RDC</h1>
        <p className="mt-1 text-sm text-slate-600">Vos ventes et votre stock, même sans Internet.</p>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { signIn, signUp, online } = useApp();
  const toast = useToast();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [shopName, setShopName] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; shopName?: string }>({});
  const [info, setInfo] = useState<string | null>(null);
  const { busy, error, run, setError } = useAsyncAction();

  function validate(): boolean {
    const next: typeof errors = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = 'Entrez une adresse email valide.';
    if (password.length < MIN_PASSWORD) next.password = `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`;
    if (mode === 'signup' && shopName.trim().length === 0) next.shopName = 'Donnez un nom à votre boutique.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setInfo(null);
    if (!validate()) return;
    if (!online) {
      setError('Connexion Internet nécessaire pour vous connecter ou créer un compte.');
      return;
    }
    await run(async () => {
      if (mode === 'signin') {
        await signIn(email, password);
        toast.show('Connexion réussie.', 'success');
      } else {
        const result = await signUp(email, password, shopName);
        if (result.needsEmailConfirmation) {
          setInfo('Compte créé. Ouvrez l’email de confirmation, puis revenez ici pour vous connecter.');
          setMode('signin');
        }
      }
    });
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-brand-50 to-slate-50 px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Brand />
        <Card className="flex flex-col gap-5 p-5">
          <div role="tablist" aria-label="Accès au compte" className="grid grid-cols-2 rounded-xl bg-slate-100 p-1">
            {(['signin', 'signup'] as const).map((m) => (
              <button
                key={m}
                role="tab"
                type="button"
                aria-selected={mode === m}
                onClick={() => {
                  setMode(m);
                  setErrors({});
                  setError(null);
                }}
                className={`min-h-11 rounded-lg text-sm font-semibold transition ${mode === m ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-600'}`}
              >
                {m === 'signin' ? 'Se connecter' : 'Créer un compte'}
              </button>
            ))}
          </div>

          {!online && (
            <Banner tone="info" title="Hors ligne">
              Connectez-vous à Internet pour vous connecter. Si vous étiez déjà connecté sur cet appareil, vos données restent disponibles.
            </Banner>
          )}
          {info && <Banner tone="success">{info}</Banner>}
          {error && <Banner tone="danger">{error}</Banner>}

          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            {mode === 'signup' && (
              <Field label="Nom de la boutique" required error={errors.shopName} hint="Exemple : Boutique Mama Grace">
                {(id, desc) => (
                  <TextInput id={id} aria-describedby={desc} value={shopName} onChange={(e) => setShopName(e.target.value)} maxLength={120} autoComplete="organization" error={!!errors.shopName} />
                )}
              </Field>
            )}
            <Field label="Adresse email" required error={errors.email}>
              {(id, desc) => (
                <TextInput id={id} aria-describedby={desc} type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={!!errors.email} />
              )}
            </Field>
            <Field label="Mot de passe" required error={errors.password} hint={mode === 'signup' ? `Au moins ${MIN_PASSWORD} caractères.` : undefined}>
              {(id, desc) => (
                <TextInput
                  id={id}
                  aria-describedby={desc}
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  error={!!errors.password}
                />
              )}
            </Field>
            <Button type="submit" block disabled={busy}>
              {busy ? 'Veuillez patienter…' : mode === 'signin' ? 'Se connecter' : 'Créer mon compte'}
            </Button>
          </form>
        </Card>
        <p className="text-center text-xs leading-relaxed text-slate-500">
          Chaque commerçant a son propre compte. Vos données ne sont visibles que par vous.
        </p>
      </div>
    </div>
  );
}

export function OnboardingPage() {
  const { completeShopSetup, shopSetupError, mode, signOut, auth } = useApp();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useAsyncAction();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (name.trim().length === 0) {
      setError('Donnez un nom à votre boutique.');
      return;
    }
    await run(async () => {
      await completeShopSetup(name);
    }, setError);
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-brand-50 to-slate-50 px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Brand />
        <Card className="flex flex-col gap-4 p-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Bienvenue !</h2>
            <p className="mt-1 text-sm text-slate-600">Commençons par le nom de votre boutique. Vous pourrez le modifier plus tard dans les réglages.</p>
          </div>
          {shopSetupError && <Banner tone="danger">{shopSetupError}</Banner>}
          {error && <Banner tone="danger">{error}</Banner>}
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <Field label="Nom de la boutique" required>
              {(id, desc) => (
                <TextInput id={id} aria-describedby={desc} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Ma boutique" autoFocus />
              )}
            </Field>
            <Button type="submit" block disabled={busy}>
              {busy ? 'Enregistrement…' : 'Commencer'}
            </Button>
          </form>
          {mode === 'remote' && auth.status === 'signed_in' && (
            <button type="button" className="text-sm font-semibold text-slate-600 underline" onClick={() => void signOut()}>
              Changer de compte
            </button>
          )}
        </Card>
      </div>
    </div>
  );
}
