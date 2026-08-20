import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate, todayISO } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorNote,
  Label,
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

type PeriodStatus = 'open' | 'soft_closed' | 'hard_closed';

interface Period {
  id: string;
  startDate: string;
  endDate: string;
  status: PeriodStatus;
  closedAt: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
}

const STATUS_LABEL: Record<PeriodStatus, string> = {
  open: 'Open',
  soft_closed: 'Soft closed',
  hard_closed: 'Hard closed',
};

const STATUS_TONE: Record<PeriodStatus, 'success' | 'warning' | 'danger'> = {
  open: 'success',
  soft_closed: 'warning',
  hard_closed: 'danger',
};

export function PeriodsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  // Close-books form state
  const [throughDate, setThroughDate] = useState(todayISO());
  const [mode, setMode] = useState<'soft_closed' | 'hard_closed'>('soft_closed');
  const [confirmCloseOpen, setConfirmCloseOpen] = useState(false);

  // Reopen dialog state
  const [reopenTarget, setReopenTarget] = useState<Period | null>(null);
  const [reopenReason, setReopenReason] = useState('');

  const periods = useQuery({
    queryKey: ['periods'],
    queryFn: () => api.get<{ items: Period[] }>('/api/v1/periods'),
  });

  const closeBooks = useMutation({
    mutationFn: () => api.post<{ closed: number }>('/api/v1/periods/close', { throughDate, mode }),
    onSuccess: (data) => {
      setConfirmCloseOpen(false);
      toast('success', data.closed === 1 ? '1 period closed' : `${data.closed} periods closed`);
      void qc.invalidateQueries({ queryKey: ['periods'] });
    },
  });

  const reopen = useMutation({
    mutationFn: (input: { periodId: string; reason: string }) =>
      api.post<{ ok: boolean }>(`/api/v1/periods/${input.periodId}/reopen`, {
        reason: input.reason,
      }),
    onSuccess: () => {
      setReopenTarget(null);
      setReopenReason('');
      toast('success', 'Period reopened');
      void qc.invalidateQueries({ queryKey: ['periods'] });
    },
  });

  if (periods.isLoading) return <Spinner label="Loading periods" />;

  const items = periods.data?.items ?? [];
  const canClose = can(me, 'periods.close');
  const canReopen = can(me, 'periods.reopen');

  return (
    <div>
      <PageHeader
        title="Fiscal periods"
        description="Lock finished months so the books you reported on cannot drift."
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>How closing works</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li>
              <Badge tone="success" className="mr-2">
                Open
              </Badge>
              Transactions post freely into the period.
            </li>
            <li>
              <Badge tone="warning" className="mr-2">
                Soft closed
              </Badge>
              Postings are blocked for most users; privileged users may still post into the period
              by supplying a reason, which is recorded in the audit log.
            </li>
            <li>
              <Badge tone="danger" className="mr-2">
                Hard closed
              </Badge>
              Nothing can post into the period. It must be reopened (with a reason) before any
              change is possible.
            </li>
          </ul>
          <p className="mt-3 text-sm text-muted-foreground">
            Closing the books locks every period through the date you choose. Any attempt to post,
            void, or reverse into a closed period is rejected by the server.
          </p>
        </CardContent>
      </Card>

      {canClose ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Close books</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-wrap items-end gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                setConfirmCloseOpen(true);
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="close-through-date">Through date</Label>
                <Input
                  id="close-through-date"
                  type="date"
                  required
                  value={throughDate}
                  onChange={(e) => setThroughDate(e.target.value)}
                  className="w-44"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="close-mode">Mode</Label>
                <Select
                  id="close-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as 'soft_closed' | 'hard_closed')}
                  className="w-96 max-w-full"
                >
                  <option value="soft_closed">
                    Soft close — privileged users can still post with a reason
                  </option>
                  <option value="hard_closed">Hard close — nothing can post</option>
                </Select>
              </div>
              <Button type="submit" disabled={!throughDate}>
                Close books…
              </Button>
            </form>
            <p className="mt-3 text-xs text-muted-foreground">
              Every period ending on or before the through date is closed. Periods that do not exist
              yet are created and closed in the same step.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Periods</CardTitle>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              title="No periods yet"
              description="Periods appear automatically as transactions post into new months. Closing the books also creates (and closes) every period through the date you choose."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Period</TH>
                  <TH>Status</TH>
                  <TH>Closed at</TH>
                  <TH>Reopen history</TH>
                  {canReopen ? <TH className="w-28">Actions</TH> : null}
                </TR>
              </THead>
              <TBody>
                {items.map((p) => (
                  <TR key={p.id}>
                    <TD className="whitespace-nowrap font-medium">
                      {formatDate(p.startDate)} – {formatDate(p.endDate)}
                    </TD>
                    <TD>
                      <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                    </TD>
                    <TD className="text-muted-foreground">
                      {p.status === 'open' ? '—' : formatDate(p.closedAt)}
                    </TD>
                    <TD className="text-muted-foreground">
                      {p.reopenedAt ? (
                        <div>
                          <div>Reopened {formatDate(p.reopenedAt)}</div>
                          {p.reopenReason ? (
                            <div className="text-xs">Reason: {p.reopenReason}</div>
                          ) : null}
                        </div>
                      ) : (
                        '—'
                      )}
                    </TD>
                    {canReopen ? (
                      <TD>
                        {p.status !== 'open' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setReopenTarget(p);
                              setReopenReason('');
                              reopen.reset();
                            }}
                          >
                            Reopen…
                          </Button>
                        ) : null}
                      </TD>
                    ) : null}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={confirmCloseOpen}
        onOpenChange={(open) => {
          setConfirmCloseOpen(open);
          if (!open) closeBooks.reset();
        }}
        title="Close the books?"
        description={
          mode === 'hard_closed'
            ? `Hard close every period through ${formatDate(throughDate)}. Nothing will be able to post into these periods until they are reopened with a reason.`
            : `Soft close every period through ${formatDate(throughDate)}. Postings will be blocked, but privileged users may still post with a recorded reason.`
        }
      >
        <div className="space-y-4">
          {closeBooks.error ? <ErrorNote error={closeBooks.error} /> : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setConfirmCloseOpen(false)}
              disabled={closeBooks.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={mode === 'hard_closed' ? 'destructive' : 'default'}
              loading={closeBooks.isPending}
              onClick={() => closeBooks.mutate()}
            >
              {mode === 'hard_closed' ? 'Hard close books' : 'Soft close books'}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={reopenTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReopenTarget(null);
            setReopenReason('');
            reopen.reset();
          }
        }}
        title="Reopen period"
        description={
          reopenTarget
            ? `Reopen ${formatDate(reopenTarget.startDate)} – ${formatDate(reopenTarget.endDate)} so transactions can post into it again. The reason is recorded in the audit log.`
            : undefined
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reopenTarget || !reopenReason.trim()) return;
            reopen.mutate({ periodId: reopenTarget.id, reason: reopenReason.trim() });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="reopen-reason">Reason (required)</Label>
            <Textarea
              id="reopen-reason"
              required
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="Why does this period need to be reopened?"
            />
          </div>
          {reopen.error ? <ErrorNote error={reopen.error} /> : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setReopenTarget(null);
                setReopenReason('');
                reopen.reset();
              }}
              disabled={reopen.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" loading={reopen.isPending} disabled={!reopenReason.trim()}>
              Reopen period
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
