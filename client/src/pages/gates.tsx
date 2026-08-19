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
            add the Clerk credentials (CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY) to the server
            environment and restart. There is no fallback login.
          </CardDescription>
        </CardHeader>
      </Card>
    </GateFrame>
  );
}

export function LoginPage({ mode }: { mode: 'clerk' | 'test' | 'disabled' }) {
  return (
    <GateFrame>
      {mode === 'clerk' ? (
        <div className="flex justify-center">
          <SignIn routing="hash" />
        </div>
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
