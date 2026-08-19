import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

interface Role {
  id: string;
  key: string;
  name: string;
  description: string | null;
}
interface Member {
  membershipId: string;
  status: 'active' | 'removed';
  userId: string;
  email: string;
  name: string | null;
  roleId: string;
  roleKey: string;
  roleName: string;
  createdAt: string;
}
interface Invitation {
  id: string;
  email: string;
  roleId: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function UsersSettingsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ items: Role[] }>('/api/v1/roles'),
  });
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<{ items: Member[] }>('/api/v1/members'),
  });
  const invitations = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api.get<{ items: Invitation[] }>('/api/v1/invitations'),
    enabled: can(me, 'users.invite'),
  });

  const invite = useMutation({
    mutationFn: () => api.post<{ inviteUrl: string }>('/api/v1/invitations', { email, roleId }),
    onSuccess: (data) => {
      setInviteUrl(data.inviteUrl);
      void qc.invalidateQueries({ queryKey: ['invitations'] });
    },
  });

  const updateMember = useMutation({
    mutationFn: (input: { membershipId: string; roleId?: string; status?: 'active' | 'removed' }) =>
      api.patch(`/api/v1/members/${input.membershipId}`, {
        roleId: input.roleId,
        status: input.status,
      }),
    onSuccess: () => {
      toast('success', 'Member updated');
      void qc.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Update failed'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/invitations/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invitations'] }),
  });

  if (roles.isLoading || members.isLoading) return <Spinner label="Loading users" />;

  const roleItems = roles.data?.items ?? [];
  const activeMembers = (members.data?.items ?? []).filter((m) => m.status === 'active');
  const openInvitations = (invitations.data?.items ?? []).filter(
    (i) => !i.acceptedAt && !i.revokedAt,
  );

  return (
    <div>
      <PageHeader
        title="Users & roles"
        description="Least-privilege access to the company books. Authorization is enforced on the server for every action."
        actions={
          can(me, 'users.invite') ? (
            <Button
              onClick={() => {
                setInviteOpen(true);
                setInviteUrl(null);
                setEmail('');
                setRoleId(roleItems.find((r) => r.key === 'bookkeeper')?.id ?? '');
              }}
            >
              Invite user
            </Button>
          ) : undefined
        }
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>User</TH>
                <TH>Role</TH>
                <TH>Joined</TH>
                <TH className="w-40">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {activeMembers.map((m) => (
                <TR key={m.membershipId}>
                  <TD>
                    <div className="font-medium">{m.name ?? m.email}</div>
                    <div className="text-xs text-muted-foreground">{m.email}</div>
                  </TD>
                  <TD>
                    {can(me, 'users.administer') && m.userId !== me.user?.id ? (
                      <Select
                        aria-label={`Role for ${m.email}`}
                        value={m.roleId}
                        onChange={(e) =>
                          updateMember.mutate({
                            membershipId: m.membershipId,
                            roleId: e.target.value,
                          })
                        }
                        className="max-w-52"
                      >
                        {roleItems.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone="info">{m.roleName}</Badge>
                    )}
                  </TD>
                  <TD className="text-muted-foreground">{formatDate(m.createdAt)}</TD>
                  <TD>
                    {can(me, 'users.administer') && m.userId !== me.user?.id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() =>
                          updateMember.mutate({ membershipId: m.membershipId, status: 'removed' })
                        }
                      >
                        Remove
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">You</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {can(me, 'users.invite') ? (
        <Card>
          <CardHeader>
            <CardTitle>Open invitations</CardTitle>
          </CardHeader>
          <CardContent>
            {openInvitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open invitations.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Email</TH>
                    <TH>Expires</TH>
                    <TH className="w-32">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {openInvitations.map((i) => (
                    <TR key={i.id}>
                      <TD>{i.email}</TD>
                      <TD className="text-muted-foreground">{formatDate(i.expiresAt)}</TD>
                      <TD>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => revoke.mutate(i.id)}
                        >
                          Revoke
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Dialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="Invite a user"
        description="An invitation link is generated once; deliver it to the person yourself. It expires in 7 days and only works for the invited email address."
      >
        {inviteUrl ? (
          <div className="space-y-3">
            <p className="text-sm">
              Invitation created. Copy this link now — it is shown only once:
            </p>
            <Input readOnly value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
            <Button className="w-full" onClick={() => setInviteOpen(false)}>
              Done
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                id="invite-role"
                required
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
              >
                <option value="" disabled>
                  Select a role…
                </option>
                {roleItems.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </div>
            {invite.error ? <ErrorNote error={invite.error} /> : null}
            <Button type="submit" loading={invite.isPending} className="w-full">
              Create invitation
            </Button>
          </form>
        )}
      </Dialog>
    </div>
  );
}
