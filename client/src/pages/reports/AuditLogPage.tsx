import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge, ErrorNote, PageHeader, Spinner } from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

interface AuditEvent {
  seq: number;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorRole: string | null;
  reason: string | null;
  payload: unknown;
  correlationId: string | null;
  createdAt: string;
}
interface VerifyResult {
  ok: boolean;
  brokenAtSeq: number | null;
  length: number;
}

export function AuditLogPage({ me }: { me: Me }) {
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  const log = useQuery({
    queryKey: ['audit-log'],
    queryFn: () => api.get<{ items: AuditEvent[] }>('/api/v1/audit-log?limit=100'),
  });

  const verify = useMutation({
    mutationFn: () => api.get<VerifyResult>('/api/v1/audit-log/verify'),
    onSuccess: (data) => setVerifyResult(data),
  });

  const items = log.data?.items ?? [];

  return (
    <div>
      <Link to="/reports" className="mb-3 inline-block text-sm text-primary underline">
        &larr; All reports
      </Link>
      <PageHeader
        title="Audit log"
        description={`Tamper-evident change history for ${
          me.company?.displayName ?? 'your company'
        }. Showing the 100 most recent events.`}
        actions={
          <Button onClick={() => verify.mutate()} loading={verify.isPending} variant="outline">
            Verify chain
          </Button>
        }
      />

      {verify.error ? (
        <div className="mb-4">
          <ErrorNote error={verify.error} />
        </div>
      ) : null}
      {verifyResult ? (
        <div className="mb-4">
          {verifyResult.ok ? (
            <div
              role="status"
              className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
            >
              Chain intact, {verifyResult.length} events
            </div>
          ) : (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              Chain broken at sequence {verifyResult.brokenAtSeq ?? 'unknown'} of{' '}
              {verifyResult.length} events. The audit trail may have been tampered with.
            </div>
          )}
        </div>
      ) : null}

      {log.isLoading ? <Spinner label="Loading audit log" /> : null}
      {log.error ? <ErrorNote error={log.error} /> : null}

      {log.data ? (
        items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audit events recorded yet.</p>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH className="w-16">Seq</TH>
                <TH className="w-28">Timestamp</TH>
                <TH className="w-48">Action</TH>
                <TH>Entity</TH>
                <TH className="w-32">Actor role</TH>
                <TH>Reason</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((event) => (
                <TR key={event.seq}>
                  <TD className="font-mono tabular-nums">{event.seq}</TD>
                  <TD className="text-muted-foreground">{formatDate(event.createdAt)}</TD>
                  <TD>
                    <Badge tone="neutral">{event.action}</Badge>
                  </TD>
                  <TD>
                    <details>
                      <summary className="cursor-pointer select-none">
                        {event.entityType}
                        {event.entityId ? (
                          <span className="ml-1 font-mono text-xs text-muted-foreground">
                            {event.entityId}
                          </span>
                        ) : null}
                      </summary>
                      <pre className="mt-2 max-h-64 max-w-xl overflow-auto rounded-md bg-muted p-2 text-xs">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </details>
                  </TD>
                  <TD className="text-muted-foreground">{event.actorRole ?? '—'}</TD>
                  <TD className="text-muted-foreground">{event.reason ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )
      ) : null}
    </div>
  );
}
