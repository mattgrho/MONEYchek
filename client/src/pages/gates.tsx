import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { SignIn } from '@clerk/clerk-react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import { useBrand } from '@/lib/brand';
import { useInvalidateMe } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorNote,
  Label,
} from '@/components/ui/primitives';

function GateFrame({ children }: { children: React.ReactNode }) {
  const brand = useBrand();
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-background px-4 py-10">
      <div className="mb-6 text-center">
        <p className="text-lg font-semibold">
          {brand.applicationName ?? brand.displayName ?? 'Set up your company books'}
        </p>
      </div>
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

/** Auth provider missing entirely (production misconfiguration or fresh dev). */
export function AuthNotConfiguredPage() {
  return (
    <GateFrame>
      <Card>
        <CardHeader>
          <CardTitle>Authentication is not configured</CardTitle>
          <CardDescription>
            This deployment has no sign-in provider yet, so nobody can use it. An administrator must
            either set AUTH_PROVIDER=local (built-in email and password accounts) or add the Clerk
            credentials (CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY) to the server environment and
            restart. There is no fallback login.
          </CardDescription>
        </CardHeader>
      </Card>
    </GateFrame>
  );
}

export function LoginPage({
  mode,
  bootstrapped,
}: {
  mode: 'clerk' | 'local' | 'test' | 'disabled';
  bootstrapped?: boolean;
}) {
  return (
    <GateFrame>
      {mode === 'clerk' ? (
        <div className="flex justify-center">
          <SignIn routing="hash" />
        </div>
      ) : mode === 'local' ? (
        <LocalLogin bootstrapped={bootstrapped ?? true} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              This environment uses the automated-test sign-in adapter; requests authenticate via
              test headers rather than a login screen.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </GateFrame>
  );
}

/**
 * First-party sign-in. Registration is closed: pre-bootstrap the configured
 * owner email may create the owner account; afterwards new accounts only
 * exist through invitation links (?token=... on this page).
 */
function LocalLogin({ bootstrapped }: { bootstrapped: boolean }) {
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get('token');
  const invalidateMe = useInvalidateMe();

  const [view, setView] = useState<'login' | 'register-owner' | 'register-invited'>(
    inviteToken ? 'register-invited' : 'login',
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const login = useMutation({
    mutationFn: () => api.post('/api/v1/auth/login', { email: email.trim(), password }),
    onSuccess: () => invalidateMe(),
  });
  const registerOwner = useMutation({
    mutationFn: () =>
      api.post('/api/v1/auth/register-owner', {
        email: email.trim(),
        password,
        name: name.trim(),
      }),
    onSuccess: () => invalidateMe(),
  });
  const registerInvited = useMutation({
    mutationFn: () =>
      api.post('/api/v1/auth/register-with-invitation', {
        token: inviteToken,
        password,
        name: name.trim(),
      }),
    onSuccess: () => invalidateMe(),
  });

  if (view === 'register-invited' && inviteToken) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Accept your invitation</CardTitle>
          <CardDescription>
            Create your account to join the company books. Your email is fixed by the invitation;
            choose a strong password (at least 10 characters).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              registerInvited.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="reg-name">Your name</Label>
              <Input
                id="reg-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-password">Password</Label>
              <Input
                id="reg-password"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {registerInvited.error ? <ErrorNote error={registerInvited.error} /> : null}
            <Button type="submit" loading={registerInvited.isPending} className="w-full">
              Create account and join
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setView('login')}
            >
              I already have an account — sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  if (view === 'register-owner') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Create the owner account</CardTitle>
          <CardDescription>
            Only the email configured as this deployment&apos;s bootstrap owner can create the first
            account. Everyone else joins later by invitation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              registerOwner.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="owner-name">Your name</Label>
              <Input
                id="owner-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="owner-email">Email (must match the configured owner email)</Label>
              <Input
                id="owner-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="owner-password">Password (at least 10 characters)</Label>
              <Input
                id="owner-password"
                type="password"
                required
                minLength={10}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {registerOwner.error ? <ErrorNote error={registerOwner.error} /> : null}
            <Button type="submit" loading={registerOwner.isPending} className="w-full">
              Create owner account
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setView('login')}
            >
              Back to sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the email and password for your account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {login.error ? <ErrorNote error={login.error} /> : null}
          <Button type="submit" loading={login.isPending} className="w-full">
            Sign in
          </Button>
          {!bootstrapped ? (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setView('register-owner')}
            >
              First time here? Create the owner account
            </Button>
          ) : null}
          {inviteToken ? (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => setView('register-invited')}
            >
              New here? Accept your invitation
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/** First-owner claim: server verifies the authorized bootstrap email. */
export function ClaimDeploymentPage() {
  const [companyName, setCompanyName] = useState('');
  const invalidateMe = useInvalidateMe();
  const mutation = useMutation({
    mutationFn: () => api.post('/api/v1/bootstrap', { companyName }),
    onSuccess: () => invalidateMe(),
  });
  return (
    <GateFrame>
      <Card>
        <CardHeader>
          <CardTitle>Set up your company books</CardTitle>
          <CardDescription>
            This deployment has not been claimed yet. If you are the authorized owner, name your
            company to create its books. Everything can be refined later in Settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (companyName.trim()) mutation.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="companyName">Company name</Label>
              <Input
                id="companyName"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="e.g. Riverbend Restoration LLC"
                maxLength={200}
                required
              />
            </div>
            {mutation.error ? <ErrorNote error={mutation.error} /> : null}
            <Button type="submit" loading={mutation.isPending} className="w-full">
              Claim this deployment
            </Button>
          </form>
        </CardContent>
      </Card>
    </GateFrame>
  );
}

/** Authenticated but not a member of this company. */
export function NoAccessPage() {
  return (
    <GateFrame>
      <Card>
        <CardHeader>
          <CardTitle>No access to this company</CardTitle>
          <CardDescription>
            Your account is signed in but is not a member of this company&apos;s books. Ask an
            administrator to invite you, then open the invitation link they send you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Already have an invitation link? Open it directly, or paste the token on the{' '}
            <Link className="text-primary underline" to="/accept-invitation">
              accept invitation
            </Link>{' '}
            page.
          </p>
        </CardContent>
      </Card>
    </GateFrame>
  );
}

export function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const invalidateMe = useInvalidateMe();
  const mutation = useMutation({
    mutationFn: () => api.post('/api/v1/invitations/accept', { token }),
    onSuccess: () => invalidateMe(),
  });
  const alreadyMember =
    mutation.error instanceof ApiError && mutation.error.code === 'ALREADY_MEMBER';
  return (
    <GateFrame>
      <Card>
        <CardHeader>
          <CardTitle>Accept invitation</CardTitle>
          <CardDescription>
            Join this company&apos;s books. The invitation must have been issued to the email
            address you signed in with.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) mutation.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="token">Invitation token</Label>
              <Input
                id="token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste the token from your invitation link"
                required
              />
            </div>
            {mutation.error && !alreadyMember ? <ErrorNote error={mutation.error} /> : null}
            {alreadyMember ? (
              <p className="text-sm text-success">
                You are already a member — you&apos;re all set.
              </p>
            ) : null}
            <Button type="submit" loading={mutation.isPending} className="w-full">
              Join company
            </Button>
          </form>
        </CardContent>
      </Card>
    </GateFrame>
  );
}
