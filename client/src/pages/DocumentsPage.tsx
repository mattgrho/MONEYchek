import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, apiUpload } from '@/lib/api';
import { LoadMoreButton, usePagedList } from '@/lib/paging';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
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

interface Attachment {
  id: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  kind: string;
  scanState: string;
  createdAt: string;
  links: { entityType: string; entityId: string }[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentsPage({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState('document');

  const attachments = usePagedList<Attachment, { storageAvailable: boolean }>(
    ['attachments'],
    '/api/v1/attachments',
  );

  const upload = useMutation({
    mutationFn: async () => {
      const file = fileRef.current?.files?.[0];
      if (!file) throw new Error('Choose a file first');
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', file);
      return apiUpload('/api/v1/attachments', form);
    },
    onSuccess: () => {
      toast('success', 'File uploaded');
      if (fileRef.current) fileRef.current.value = '';
      void qc.invalidateQueries({ queryKey: ['attachments'] });
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Upload failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/attachments/${id}`),
    onSuccess: () => {
      toast('success', 'File deleted');
      void qc.invalidateQueries({ queryKey: ['attachments'] });
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Delete failed'),
  });

  if (attachments.isLoading) return <Spinner label="Loading documents" />;
  const data = attachments.firstPage;
  const items = attachments.items;

  return (
    <div>
      <PageHeader
        title="Documents"
        description="Receipts, statements, and supporting files stored privately with the company books."
      />
      {data && !data.storageAvailable ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>File storage is not configured</CardTitle>
            <CardDescription>
              This deployment has no App Storage bucket yet (APP_STORAGE_BUCKET_ID). An
              administrator must provision one before files can be uploaded; nothing is stored on
              the ephemeral application filesystem in production.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {can(me, 'attachments.create') && data?.storageAvailable ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Upload a file</CardTitle>
            <CardDescription>
              PDF, PNG, JPEG, WebP, and CSV up to 10 MB. Files are checked against their declared
              type and served download-only until a malware-scanning pipeline is configured.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                upload.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="doc-file">File</Label>
                <input
                  id="doc-file"
                  ref={fileRef}
                  type="file"
                  required
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.csv"
                  className="block w-72 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="doc-kind">Kind</Label>
                <Select
                  id="doc-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                  className="w-44"
                >
                  <option value="document">Document</option>
                  <option value="receipt">Receipt</option>
                  <option value="statement">Bank statement</option>
                  <option value="brand_asset">Brand asset (logo)</option>
                  <option value="other">Other</option>
                </Select>
              </div>
              <Button type="submit" loading={upload.isPending}>
                Upload
              </Button>
            </form>
            {upload.error ? (
              <div className="mt-3">
                <ErrorNote error={upload.error} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {data && items.length === 0 ? (
        <EmptyState
          title="No documents yet"
          description="Uploaded receipts and statements appear here and can be linked to transactions."
        />
      ) : data ? (
        <Table>
          <THead>
            <TR>
              <TH>File</TH>
              <TH>Kind</TH>
              <TH>Size</TH>
              <TH>Uploaded</TH>
              <TH>Linked to</TH>
              <TH className="w-44">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {items.map((a) => (
              <TR key={a.id}>
                <TD className="font-medium">{a.originalFilename}</TD>
                <TD>
                  <Badge tone="info">{a.kind.replace('_', ' ')}</Badge>
                </TD>
                <TD className="text-muted-foreground">{formatBytes(a.byteSize)}</TD>
                <TD className="text-muted-foreground">{formatDate(a.createdAt)}</TD>
                <TD className="text-muted-foreground">
                  {a.links.length === 0 ? '—' : a.links.map((l) => l.entityType).join(', ')}
                </TD>
                <TD>
                  <div className="flex items-center gap-1">
                    <a
                      href={`/api/v1/attachments/${a.id}/download`}
                      download
                      className="inline-flex h-8 items-center rounded-md px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Download
                    </a>
                    {can(me, 'attachments.create') && a.links.length === 0 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => remove.mutate(a.id)}
                      >
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : null}
      <LoadMoreButton
        hasMore={attachments.hasMore}
        loading={attachments.isLoadingMore}
        onClick={attachments.loadMore}
      />
    </div>
  );
}
