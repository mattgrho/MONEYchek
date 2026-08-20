import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import type { Me } from '@/lib/types';
import { formatDate, todayISO, cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorNote,
  Label,
  Select,
  Spinner,
} from '@/components/ui/primitives';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';

/* ------------------------------------------------------------------ */
/* Local API types                                                     */
/* ------------------------------------------------------------------ */

interface OnboardingProfile {
  legalName?: string | null;
  displayName?: string | null;
  applicationName?: string | null;
  entityType?: string | null;
  industry?: string | null;
  phone?: string | null;
  supportEmail?: string | null;
  website?: string | null;
  timeZone?: string | null;
  legalFooter?: string | null;
  paymentInstructions?: string | null;
  fiscalYearStartMonth?: number | null;
  bookkeepingStartDate?: string | null;
  defaultTermsDays?: number | null;
}

interface OnboardingBrand {
  primary?: string | null;
  accent?: string | null;
  success?: string | null;
  warning?: string | null;
  danger?: string | null;
  sidebar?: string | null;
  themeMode?: string | null;
  radius?: string | null;
  applicationName?: string | null;
}

interface OnboardingState {
  step: string;
  completed: boolean;
  profile: OnboardingProfile | null;
  brand: OnboardingBrand | null;
  sales: unknown;
  purchasing: unknown;
  accountCount: number;
}

interface StepResult {
  ok: boolean;
  nextStep: string;
}

interface BrandStepResult extends StepResult {
  warnings: string[];
}

interface CoaTemplateAccount {
  number: string;
  name: string;
  category: string;
  detailType: string;
}

interface CoaTemplate {
  key: string;
  name: string;
  accounts: CoaTemplateAccount[];
}

/* ------------------------------------------------------------------ */
/* Step metadata                                                       */
/* ------------------------------------------------------------------ */

const STEPS = [
  { key: 'company', label: 'Company' },
  { key: 'brand', label: 'Brand' },
  { key: 'accounting', label: 'Accounting' },
  { key: 'chart', label: 'Chart of accounts' },
  { key: 'review', label: 'Review' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

function isStepKey(value: string): value is StepKey {
  return STEPS.some((s) => s.key === value);
}

function stepIndex(key: StepKey): number {
  return STEPS.findIndex((s) => s.key === key);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: 'sole_proprietorship', label: 'Sole proprietorship' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'llc', label: 'LLC' },
  { value: 's_corp', label: 'S corporation' },
  { value: 'c_corp', label: 'C corporation' },
  { value: 'nonprofit', label: 'Nonprofit' },
  { value: 'other', label: 'Other' },
];

const TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
];

const RADII = ['0rem', '0.25rem', '0.5rem', '0.75rem', '1rem'];

interface AccountingValues {
  fiscalYearStartMonth: number;
  bookkeepingStartDate: string;
  defaultTermsDays?: number;
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function StepIndicator({
  active,
  maxReached,
  onNavigate,
}: {
  active: StepKey;
  maxReached: number;
  onNavigate: (key: StepKey) => void;
}) {
  return (
    <nav aria-label="Setup progress" className="mb-8">
      <ol className="flex flex-wrap items-center justify-center gap-x-1 gap-y-2">
        {STEPS.map((s, i) => {
          const isActive = s.key === active;
          const isDone = i < maxReached && !isActive;
          const reachable = i <= maxReached;
          return (
            <li key={s.key} className="flex items-center">
              {i > 0 ? (
                <span aria-hidden className="mx-1 hidden h-px w-6 bg-border sm:block" />
              ) : null}
              <button
                type="button"
                aria-current={isActive ? 'step' : undefined}
                disabled={!reachable}
                onClick={() => onNavigate(s.key)}
                className={cn(
                  'flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'bg-primary text-primary-foreground font-medium'
                    : isDone
                      ? 'text-foreground hover:bg-muted'
                      : 'text-muted-foreground',
                  !reachable && 'cursor-not-allowed opacity-60',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex h-5 w-5 items-center justify-center rounded-full border text-xs tabular-nums',
                    isActive
                      ? 'border-primary-foreground/50'
                      : isDone
                        ? 'border-success bg-success/15 text-success'
                        : 'border-border',
                  )}
                >
                  {isDone ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
                </span>
                {s.label}
                {isDone ? <span className="sr-only">(completed)</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const valid = HEX_RE.test(value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          id={`${id}-picker`}
          aria-label={`${label} color picker`}
          value={valid ? value.toLowerCase() : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-md border border-input bg-card p-1"
        />
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#2563eb"
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step: company                                                       */
/* ------------------------------------------------------------------ */

function CompanyStep({
  profile,
  onSaved,
}: {
  profile: OnboardingProfile | null;
  onSaved: (nextStep: string) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [legalName, setLegalName] = useState(profile?.legalName ?? '');
  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [applicationName, setApplicationName] = useState(profile?.applicationName ?? '');
  const [entityType, setEntityType] = useState(profile?.entityType ?? '');
  const [industry, setIndustry] = useState(profile?.industry ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [supportEmail, setSupportEmail] = useState(profile?.supportEmail ?? '');
  const [website, setWebsite] = useState(profile?.website ?? '');
  const [timeZone, setTimeZone] = useState(profile?.timeZone ?? 'America/New_York');
  const [legalFooter, setLegalFooter] = useState(profile?.legalFooter ?? '');
  const [paymentInstructions, setPaymentInstructions] = useState(
    profile?.paymentInstructions ?? '',
  );

  const save = useMutation({
    mutationFn: () =>
      api.patch<StepResult>('/api/v1/onboarding/company', {
        legalName: legalName.trim(),
        displayName: displayName.trim(),
        applicationName: applicationName.trim() || undefined,
        entityType: entityType || undefined,
        industry: industry.trim() || undefined,
        phone: phone.trim() || undefined,
        supportEmail: supportEmail.trim() || undefined,
        website: website.trim() || undefined,
        timeZone: timeZone || undefined,
        legalFooter: legalFooter.trim() || undefined,
        paymentInstructions: paymentInstructions.trim() || undefined,
      }),
    onSuccess: (data) => {
      toast('success', 'Company profile saved');
      void qc.invalidateQueries({ queryKey: ['onboarding-state'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['brand-bootstrap'] });
      onSaved(data.nextStep);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Company profile</CardTitle>
        <CardDescription>
          Legal and contact details used on invoices and other documents.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ob-legal-name">Legal name</Label>
              <Input
                id="ob-legal-name"
                required
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-display-name">Display name</Label>
              <Input
                id="ob-display-name"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-app-name">Application name (optional)</Label>
              <Input
                id="ob-app-name"
                value={applicationName}
                onChange={(e) => setApplicationName(e.target.value)}
                placeholder="Shown in the app header"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-entity-type">Entity type (optional)</Label>
              <Select
                id="ob-entity-type"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
              >
                <option value="">Not specified</option>
                {ENTITY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-industry">Industry (optional)</Label>
              <Input
                id="ob-industry"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-timezone">Time zone</Label>
              <Select
                id="ob-timezone"
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
              >
                {TIME_ZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-phone">Phone (optional)</Label>
              <Input
                id="ob-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-support-email">Support email (optional)</Label>
              <Input
                id="ob-support-email"
                type="email"
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ob-website">Website (optional)</Label>
              <Input
                id="ob-website"
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://example.com"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ob-legal-footer">Legal footer (optional)</Label>
              <Textarea
                id="ob-legal-footer"
                value={legalFooter}
                onChange={(e) => setLegalFooter(e.target.value)}
                placeholder="Printed at the bottom of invoices and statements"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="ob-payment-instructions">Payment instructions (optional)</Label>
              <Textarea
                id="ob-payment-instructions"
                value={paymentInstructions}
                onChange={(e) => setPaymentInstructions(e.target.value)}
                placeholder="How customers should pay you"
              />
            </div>
          </div>
          {save.error ? <ErrorNote error={save.error} /> : null}
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              Save and continue
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Step: brand                                                         */
/* ------------------------------------------------------------------ */

const BRAND_COLOR_FIELDS: {
  key: keyof OnboardingBrand & string;
  label: string;
  fallback: string;
}[] = [
  { key: 'primary', label: 'Primary', fallback: '#2563eb' },
  { key: 'accent', label: 'Accent', fallback: '#e0e7ff' },
  { key: 'success', label: 'Success', fallback: '#16a34a' },
  { key: 'warning', label: 'Warning', fallback: '#d97706' },
  { key: 'danger', label: 'Danger', fallback: '#dc2626' },
  { key: 'sidebar', label: 'Sidebar', fallback: '#0f172a' },
];

function BrandStep({
  brand,
  onSaved,
}: {
  brand: OnboardingBrand | null;
  onSaved: (nextStep: string) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [colors, setColors] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of BRAND_COLOR_FIELDS) {
      const existing = brand?.[f.key];
      init[f.key] = typeof existing === 'string' && existing ? existing : f.fallback;
    }
    return init;
  });
  const [themeMode, setThemeMode] = useState(brand?.themeMode ?? 'system');
  const [radius, setRadius] = useState(brand?.radius ?? '0.5rem');
  const [warnings, setWarnings] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<BrandStepResult>('/api/v1/onboarding/brand', {
        primary: colors['primary'],
        accent: colors['accent'],
        success: colors['success'],
        warning: colors['warning'],
        danger: colors['danger'],
        sidebar: colors['sidebar'],
        themeMode,
        radius,
      }),
    onSuccess: (data) => {
      setWarnings(data.warnings ?? []);
      toast('success', 'Brand saved');
      void qc.invalidateQueries({ queryKey: ['onboarding-state'] });
      void qc.invalidateQueries({ queryKey: ['brand-bootstrap'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      if (!data.warnings || data.warnings.length === 0) {
        onSaved(data.nextStep);
      }
    },
  });

  const setColor = (key: string, value: string) => setColors((prev) => ({ ...prev, [key]: value }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Brand & appearance</CardTitle>
        <CardDescription>
          Colors and styling applied across the whole application. You can change these later in
          settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setWarnings([]);
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {BRAND_COLOR_FIELDS.map((f) => (
              <ColorField
                key={f.key}
                id={`ob-brand-${f.key}`}
                label={f.label}
                value={colors[f.key] ?? f.fallback}
                onChange={(v) => setColor(f.key, v)}
              />
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="ob-theme-mode">Theme mode</Label>
              <Select
                id="ob-theme-mode"
                value={themeMode}
                onChange={(e) => setThemeMode(e.target.value)}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="system">System</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-radius">Corner radius</Label>
              <Select id="ob-radius" value={radius} onChange={(e) => setRadius(e.target.value)}>
                {RADII.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {warnings.length > 0 ? (
            <div
              role="alert"
              className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
            >
              <p className="font-medium">Contrast warnings</p>
              <ul className="mt-1 list-disc pl-5">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <p className="mt-2">
                Your colors were saved. You can adjust them here, or continue anyway.
              </p>
            </div>
          ) : null}
          {save.error ? <ErrorNote error={save.error} /> : null}
          <div className="flex justify-end gap-2">
            {warnings.length > 0 ? (
              <Button type="button" variant="outline" onClick={() => onSaved('accounting')}>
                Continue anyway
              </Button>
            ) : null}
            <Button type="submit" loading={save.isPending}>
              Save and continue
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Step: accounting                                                    */
/* ------------------------------------------------------------------ */

function AccountingStep({
  me,
  profile,
  initial,
  onSaved,
}: {
  me: Me;
  profile: OnboardingProfile | null;
  initial: AccountingValues | null;
  onSaved: (values: AccountingValues, nextStep: string) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState<number>(
    initial?.fiscalYearStartMonth ??
      profile?.fiscalYearStartMonth ??
      me.company?.fiscalYearStartMonth ??
      1,
  );
  const [bookkeepingStartDate, setBookkeepingStartDate] = useState(
    initial?.bookkeepingStartDate ?? profile?.bookkeepingStartDate ?? todayISO(),
  );
  const [defaultTermsDays, setDefaultTermsDays] = useState(
    initial?.defaultTermsDays !== undefined
      ? String(initial.defaultTermsDays)
      : profile?.defaultTermsDays !== undefined && profile?.defaultTermsDays !== null
        ? String(profile.defaultTermsDays)
        : '',
  );

  const save = useMutation({
    mutationFn: () => {
      const terms = defaultTermsDays.trim();
      return api.patch<StepResult>('/api/v1/onboarding/accounting', {
        fiscalYearStartMonth,
        bookkeepingStartDate,
        homeCurrency: 'USD',
        defaultTermsDays: terms === '' ? undefined : Number(terms),
      });
    },
    onSuccess: (data) => {
      toast('success', 'Accounting settings saved');
      void qc.invalidateQueries({ queryKey: ['onboarding-state'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      const terms = defaultTermsDays.trim();
      onSaved(
        {
          fiscalYearStartMonth,
          bookkeepingStartDate,
          ...(terms === '' ? {} : { defaultTermsDays: Number(terms) }),
        },
        data.nextStep,
      );
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounting settings</CardTitle>
        <CardDescription>
          These control your fiscal calendar and the earliest date transactions can be recorded.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ob-fy-month">Fiscal year starts in</Label>
              <Select
                id="ob-fy-month"
                value={String(fiscalYearStartMonth)}
                onChange={(e) => setFiscalYearStartMonth(Number(e.target.value))}
              >
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={String(i + 1)}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-book-start">Bookkeeping start date</Label>
              <Input
                id="ob-book-start"
                type="date"
                required
                value={bookkeepingStartDate}
                onChange={(e) => setBookkeepingStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-home-currency">Home currency</Label>
              <Input
                id="ob-home-currency"
                value="USD"
                readOnly
                aria-describedby="ob-currency-note"
              />
              <p id="ob-currency-note" className="text-xs text-muted-foreground">
                USD is the only supported home currency for now.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-terms-days">Default payment terms, days (optional)</Label>
              <Input
                id="ob-terms-days"
                type="number"
                min={0}
                step={1}
                value={defaultTermsDays}
                onChange={(e) => setDefaultTermsDays(e.target.value)}
                placeholder="30"
              />
            </div>
          </div>
          {save.error ? <ErrorNote error={save.error} /> : null}
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              Save and continue
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Step: chart of accounts                                             */
/* ------------------------------------------------------------------ */

function ChartStep({ accountCount, onDoneStep }: { accountCount: number; onDoneStep: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const alreadyApplied = accountCount > 0;
  const [templateKey, setTemplateKey] = useState('');

  const templates = useQuery({
    queryKey: ['coa-templates'],
    queryFn: () => api.get<{ items: CoaTemplate[] }>('/api/v1/coa-templates'),
    enabled: !alreadyApplied,
  });

  const apply = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean }>('/api/v1/onboarding/chart-template', { templateKey }),
    onSuccess: () => {
      toast('success', 'Chart of accounts created');
      void qc.invalidateQueries({ queryKey: ['onboarding-state'] });
      onDoneStep();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'CHART_EXISTS') {
        toast('success', 'Chart of accounts already exists — continuing');
        void qc.invalidateQueries({ queryKey: ['onboarding-state'] });
        onDoneStep();
      }
    },
  });

  if (alreadyApplied) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Chart of accounts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">
            This step is already complete — your books have{' '}
            <span className="font-medium tabular-nums">{accountCount}</span> accounts. A chart
            template can only be applied once.
          </p>
          <div className="flex justify-end">
            <Button onClick={onDoneStep}>Continue</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (templates.isLoading) return <Spinner label="Loading chart templates" />;

  const items = templates.data?.items ?? [];
  const selected = items.find((t) => t.key === templateKey);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chart of accounts</CardTitle>
        <CardDescription>
          Pick a starting template for your books. Protected accounts such as Accounts Receivable
          are always created regardless of template.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {templates.error ? (
          <ErrorNote error={templates.error} />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              apply.mutate();
            }}
          >
            <fieldset>
              <legend className="sr-only">Chart of accounts template</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {items.map((t) => {
                  const isSelected = t.key === templateKey;
                  return (
                    <label
                      key={t.key}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-colors',
                        isSelected
                          ? 'border-primary bg-primary/5 ring-1 ring-primary'
                          : 'border-border hover:bg-muted/40',
                      )}
                    >
                      <input
                        type="radio"
                        name="ob-coa-template"
                        value={t.key}
                        checked={isSelected}
                        onChange={() => setTemplateKey(t.key)}
                        className="mt-1"
                      />
                      <span>
                        <span className="block font-medium">{t.name}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t.accounts.length} accounts
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {selected ? (
              <div>
                <h4 className="mb-2 text-sm font-medium">Accounts in “{selected.name}”</h4>
                <div className="max-h-72 overflow-y-auto rounded-lg">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Number</TH>
                        <TH>Name</TH>
                        <TH>Category</TH>
                        <TH>Detail type</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {selected.accounts.map((a) => (
                        <TR key={`${a.number}-${a.name}`}>
                          <TD className="font-mono tabular-nums">{a.number}</TD>
                          <TD>{a.name}</TD>
                          <TD className="text-muted-foreground">{a.category}</TD>
                          <TD className="text-muted-foreground">{a.detailType}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Select a template to preview its accounts.
              </p>
            )}

            {apply.error &&
            !(apply.error instanceof ApiError && apply.error.code === 'CHART_EXISTS') ? (
              <ErrorNote error={apply.error} />
            ) : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={!templateKey} loading={apply.isPending}>
                Apply template and continue
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Step: review                                                        */
/* ------------------------------------------------------------------ */

function ReviewStep({
  me,
  state,
  accounting,
  onDone,
}: {
  me: Me;
  state: OnboardingState;
  accounting: AccountingValues | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const complete = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/api/v1/onboarding/complete'),
    onSuccess: () => {
      toast('success', 'Setup complete — welcome to your books');
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['onboarding-state'] });
      onDone();
    },
  });

  const profile = state.profile;
  const companyName = profile?.displayName ?? profile?.legalName ?? me.company?.displayName ?? '—';
  const applicationName = profile?.applicationName ?? me.company?.applicationName ?? companyName;
  const fyMonth =
    accounting?.fiscalYearStartMonth ??
    profile?.fiscalYearStartMonth ??
    me.company?.fiscalYearStartMonth ??
    1;
  const fyMonthName = MONTH_NAMES[fyMonth - 1] ?? String(fyMonth);
  const bookStart = accounting?.bookkeepingStartDate ?? profile?.bookkeepingStartDate ?? null;

  const rows: { label: string; value: string }[] = [
    { label: 'Company name', value: companyName },
    { label: 'Application name', value: applicationName },
    { label: 'Fiscal year starts', value: fyMonthName },
    { label: 'Bookkeeping start date', value: bookStart ? formatDate(bookStart) : '—' },
    { label: 'Accounts created', value: String(state.accountCount) },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review & finish</CardTitle>
        <CardDescription>
          Confirm the essentials. You can go back to any earlier step before finishing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="divide-y divide-border">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-4 py-2 text-sm">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>
        {complete.error ? <ErrorNote error={complete.error} /> : null}
        <div className="flex justify-end">
          <Button loading={complete.isPending} onClick={() => complete.mutate()}>
            Finish setup
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function OnboardingPage({ me, onDone }: { me: Me; onDone: () => void }) {
  const stateQuery = useQuery({
    queryKey: ['onboarding-state'],
    queryFn: () => api.get<OnboardingState>('/api/v1/onboarding/state'),
  });

  const [active, setActive] = useState<StepKey | null>(null);
  // Highest step index the user has unlocked in this browsing session.
  const [localMax, setLocalMax] = useState(0);
  const [accounting, setAccounting] = useState<AccountingValues | null>(null);

  const serverStep = stateQuery.data?.step;
  useEffect(() => {
    if (active === null && serverStep !== undefined) {
      const resume: StepKey = isStepKey(serverStep) ? serverStep : 'company';
      setActive(resume);
      setLocalMax(stepIndex(resume));
    }
  }, [active, serverStep]);

  const completed = stateQuery.data?.completed ?? false;
  useEffect(() => {
    if (completed) onDone();
  }, [completed, onDone]);

  if (stateQuery.isLoading || !stateQuery.data || active === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <Spinner label="Loading setup" />
      </div>
    );
  }
  if (stateQuery.error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-md">
          <ErrorNote error={stateQuery.error} />
        </div>
      </div>
    );
  }

  const state = stateQuery.data;
  const maxReached = Math.max(localMax, isStepKey(state.step) ? stepIndex(state.step) : 0);

  const goTo = (key: StepKey) => {
    setActive(key);
    setLocalMax((prev) => Math.max(prev, stepIndex(key)));
  };

  const advance = (nextStep: string) => {
    goTo(isStepKey(nextStep) ? nextStep : 'review');
  };

  return (
    <div className="min-h-screen bg-background px-4 py-10 text-foreground">
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Set up your company books</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A few steps to get {me.company?.displayName ?? 'your company'} ready. Your progress is
            saved after each step, so you can come back any time.
          </p>
        </header>

        <StepIndicator active={active} maxReached={maxReached} onNavigate={goTo} />

        {active === 'company' ? (
          <CompanyStep key={`company-${state.step}`} profile={state.profile} onSaved={advance} />
        ) : null}
        {active === 'brand' ? (
          <BrandStep key={`brand-${state.step}`} brand={state.brand} onSaved={advance} />
        ) : null}
        {active === 'accounting' ? (
          <AccountingStep
            key={`accounting-${state.step}`}
            me={me}
            profile={state.profile}
            initial={accounting}
            onSaved={(values, nextStep) => {
              setAccounting(values);
              advance(nextStep);
            }}
          />
        ) : null}
        {active === 'chart' ? (
          <ChartStep
            key={`chart-${state.accountCount}`}
            accountCount={state.accountCount}
            onDoneStep={() => goTo('review')}
          />
        ) : null}
        {active === 'review' ? (
          <ReviewStep me={me} state={state} accounting={accounting} onDone={onDone} />
        ) : null}
      </div>
    </div>
  );
}
