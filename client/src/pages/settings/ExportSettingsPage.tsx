import type { Me } from '@/lib/types';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@/components/ui/primitives';

/**
 * Owner data portability. The export itself streams from the server and is
 * audited; this page explains exactly what the file is and is not.
 */
export function ExportSettingsPage({ me: _me }: { me: Me }) {
  return (
    <div>
      <PageHeader
        title="Data export"
        description="Your company owns its data. Download everything at any time."
      />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Full company export</CardTitle>
          <CardDescription>
            One JSON file containing every table of this company&apos;s books — settings, chart of
            accounts, customers, vendors, every source transaction, every journal entry and line,
            allocations, banking data, reconciliations, and the audit log — with a manifest of row
            counts and per-table checksums. Attachment files are not included (their metadata is);
            download them from Documents. This is data portability, not a tested restorable backup:
            restoring into a new deployment is a documented, assisted procedure (see the README
            runbook).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <a
            href="/api/v1/exports/full"
            download
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Download full export (JSON)
          </a>
          <p className="mt-3 text-xs text-muted-foreground">
            Every export is recorded in the audit log with your name and the row counts.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
