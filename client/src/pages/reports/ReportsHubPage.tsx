import { Link } from 'react-router-dom';
import type { Me } from '@/lib/types';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@/components/ui/primitives';

interface ReportLink {
  title: string;
  description: string;
  to: string;
}

const SECTIONS: { heading: string; reports: ReportLink[] }[] = [
  {
    heading: 'Financial statements',
    reports: [
      {
        title: 'Profit & loss',
        description: 'Income, cost of goods sold, and expenses over a date range.',
        to: '/reports/profit-and-loss',
      },
      {
        title: 'Balance sheet',
        description: 'Assets, liabilities, and equity as of a date.',
        to: '/reports/balance-sheet',
      },
      {
        title: 'Trial balance',
        description: 'Debit and credit balances for every account as of a date.',
        to: '/reports/trial-balance',
      },
    ],
  },
  {
    heading: 'Ledger',
    reports: [
      {
        title: 'General ledger',
        description: 'Every posted line by account, with running balances.',
        to: '/reports/general-ledger',
      },
      {
        title: 'Journal',
        description: 'All journal entries in posting order with their lines.',
        to: '/reports/journal',
      },
    ],
  },
  {
    heading: 'Administration',
    reports: [
      {
        title: 'Audit log',
        description: 'Tamper-evident record of every change, with chain verification.',
        to: '/reports/audit-log',
      },
    ],
  },
];

export function ReportsHubPage({ me }: { me: Me }) {
  return (
    <div>
      <PageHeader
        title="Reports"
        description={`Financial statements and ledgers for ${
          me.company?.displayName ?? 'your company'
        }. Every report reads the same posted journal entries.`}
      />
      <div className="space-y-8">
        {SECTIONS.map((section) => (
          <section key={section.heading} aria-labelledby={`section-${section.heading}`}>
            <h2
              id={`section-${section.heading}`}
              className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {section.heading}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {section.reports.map((report) => (
                <Card key={report.to} className="transition-colors hover:border-primary/50">
                  <CardHeader>
                    <CardTitle>
                      <Link to={report.to} className="hover:underline">
                        {report.title}
                      </Link>
                    </CardTitle>
                    <CardDescription>{report.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Link to={report.to} className="text-sm text-primary underline">
                      Open report
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
