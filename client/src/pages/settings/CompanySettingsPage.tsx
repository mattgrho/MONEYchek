import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { formatDate, todayISO } from '@/lib/utils';
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
  PageHeader,
  Select,
  Spinner,
} from '@/components/ui/primitives';

interface CompanyProfile {
  legalName: string;
  displayName: string;
  applicationName: string | null;
  entityType: string | null;
  industry: string | null;
  phone: string | null;
  supportEmail: string | null;
  website: string | null;
  timeZone: string;
  legalFooter: string | null;
  paymentInstructions: string | null;
  fiscalYearStartMonth: number;
  bookkeepingStartDate: string | null;
  homeCurrency: string;
}

interface OnboardingState {
  profile: CompanyProfile | null;
}

const US_TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

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

export function CompanySettingsPage({ me }: { me: Me }) {
  const state = useQuery({
    queryKey: ['onboarding-state'],
    queryFn: () => api.get<OnboardingState>('/api/v1/onboarding/state'),
  });

  if (state.isLoading) return <Spinner label="Loading company settings" />;
  if (state.error) return <ErrorNote error={state.error} />;
  const profile = state.data?.profile;
  if (!profile) return <ErrorNote error={new Error('Company profile not found')} />;

  return (
    <div>
      <PageHeader
        title="Company"
        description="Identity, contact details and document text that appear across the application and on customer-facing documents."
      />
      <CompanyForm profile={profile} me={me} />
      <FiscalCard profile={profile} me={me} />
    </div>
  );
}

function CompanyForm({ profile, me }: { profile: CompanyProfile; me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const editable = can(me, 'company.edit');

  const [legalName, setLegalName] = useState(profile.legalName);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [applicationName, setApplicationName] = useState(profile.applicationName ?? '');
  const [entityType, setEntityType] = useState(profile.entityType ?? '');
  const [industry, setIndustry] = useState(profile.industry ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [supportEmail, setSupportEmail] = useState(profile.supportEmail ?? '');
  const [website, setWebsite] = useState(profile.website ?? '');
  const [timeZone, setTimeZone] = useState(profile.timeZone);
  const [legalFooter, setLegalFooter] = useState(profile.legalFooter ?? '');
  const [paymentInstructions, setPaymentInstructions] = useState(profile.paymentInstructions ?? '');

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ ok: boolean }>('/api/v1/onboarding/company', {
        legalName: legalName.trim(),
        displayName: displayName.trim(),
        applicationName: applicationName.trim() || null,
        entityType: entityType.trim() || null,
        industry: industry.trim() || null,
        phone: phone.trim() || null,
        supportEmail: supportEmail.trim() || null,
        website: website.trim() || null,
        timeZone,
        legalFooter: legalFooter.trim() || null,
        paymentInstructions: paymentInstructions.trim() || null,
      }),
    onSuccess: () => {
      toast('success', 'Company settings saved');
      void qc.invalidateQueries({ queryKey: ['onboarding-state'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['brand-bootstrap'] });
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Save failed'),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
      className="space-y-6"
    >
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>How the business is named legally and in the app.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="company-legal-name">Legal name</Label>
            <Input
              id="company-legal-name"
              required
              disabled={!editable}
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-display-name">Display name</Label>
            <Input
              id="company-display-name"
              required
              disabled={!editable}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-application-name">Application name</Label>
            <Input
              id="company-application-name"
              disabled={!editable}
              value={applicationName}
              onChange={(e) => setApplicationName(e.target.value)}
              aria-describedby="company-application-name-help"
            />
            <p id="company-application-name-help" className="text-xs text-muted-foreground">
              Shown in the header, browser tab and documents
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-entity-type">Entity type</Label>
            <Select
              id="company-entity-type"
              disabled={!editable}
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
            >
              <option value="">Not specified</option>
              <option value="sole_proprietorship">Sole proprietorship</option>
              <option value="partnership">Partnership</option>
              <option value="llc">LLC</option>
              <option value="s_corporation">S corporation</option>
              <option value="c_corporation">C corporation</option>
              <option value="nonprofit">Nonprofit</option>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="company-industry">Industry</Label>
            <Input
              id="company-industry"
              disabled={!editable}
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Contact</CardTitle>
          <CardDescription>Appears on invoices and customer communication.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="company-phone">Phone</Label>
            <Input
              id="company-phone"
              type="tel"
              disabled={!editable}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-support-email">Support email</Label>
            <Input
              id="company-support-email"
              type="email"
              disabled={!editable}
              value={supportEmail}
              onChange={(e) => setSupportEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-website">Website</Label>
            <Input
              id="company-website"
              disabled={!editable}
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Locale</CardTitle>
          <CardDescription>Time zone used for dating activity in the app.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-sm space-y-1.5">
            <Label htmlFor="company-time-zone">Time zone</Label>
            <Select
              id="company-time-zone"
              disabled={!editable}
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
            >
              {!US_TIME_ZONES.includes(timeZone) ? (
                <option value={timeZone}>{timeZone}</option>
              ) : null}
              {US_TIME_ZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace('_', ' ')}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            Standard text printed on invoices and other outbound documents.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="company-legal-footer">Legal footer</Label>
            <Textarea
              id="company-legal-footer"
              rows={3}
              disabled={!editable}
              value={legalFooter}
              onChange={(e) => setLegalFooter(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-payment-instructions">Payment instructions</Label>
            <Textarea
              id="company-payment-instructions"
              rows={3}
              disabled={!editable}
              value={paymentInstructions}
              onChange={(e) => setPaymentInstructions(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {save.error ? <ErrorNote error={save.error} /> : null}
      {editable ? (
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            Save company settings
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Your role does not permit editing company settings.
        </p>
      )}
    </form>
  );
}

function FiscalCard({ profile, me }: { profile: CompanyProfile; me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const editable = can(me, 'company.edit');

  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState(
    String(profile.fiscalYearStartMonth),
  );
  const [bookkeepingStartDate, setBookkeepingStartDate] = useState(
    profile.bookkeepingStartDate?.slice(0, 10) ?? todayISO(),
  );

  const currentMonth = me.company?.fiscalYearStartMonth ?? profile.fiscalYearStartMonth;
  const currency = me.company?.homeCurrency ?? 'USD';

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ ok: boolean }>('/api/v1/onboarding/accounting', {
        fiscalYearStartMonth: Number.parseInt(fiscalYearStartMonth, 10),
        bookkeepingStartDate,
        homeCurrency: 'USD',
      }),
    onSuccess: () => {
      toast('success', 'Accounting basics saved');
      void qc.invalidateQueries({ queryKey: ['onboarding-state'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['brand-bootstrap'] });
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Save failed'),
  });

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Accounting basics</CardTitle>
        <CardDescription>
          Currently: fiscal year starts in {MONTH_NAMES[currentMonth - 1] ?? 'January'}, home
          currency {currency}. These basics originate in onboarding and can be adjusted here; the
          home currency is fixed at USD.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="fiscal-year-start">Fiscal year start month</Label>
              <Select
                id="fiscal-year-start"
                disabled={!editable}
                value={fiscalYearStartMonth}
                onChange={(e) => setFiscalYearStartMonth(e.target.value)}
              >
                {MONTH_NAMES.map((name, i) => (
                  <option key={name} value={String(i + 1)}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bookkeeping-start">Bookkeeping start date</Label>
              <Input
                id="bookkeeping-start"
                type="date"
                required
                disabled={!editable}
                value={bookkeepingStartDate}
                onChange={(e) => setBookkeepingStartDate(e.target.value)}
              />
              {profile.bookkeepingStartDate ? (
                <p className="text-xs text-muted-foreground">
                  Currently {formatDate(profile.bookkeepingStartDate)}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="home-currency">Home currency</Label>
              <Input
                id="home-currency"
                value="USD"
                readOnly
                aria-describedby="home-currency-help"
              />
              <p id="home-currency-help" className="text-xs text-muted-foreground">
                Fixed at USD for this company.
              </p>
            </div>
          </div>
          {save.error ? <ErrorNote error={save.error} /> : null}
          {editable ? (
            <div className="flex justify-end">
              <Button type="submit" loading={save.isPending}>
                Save accounting basics
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
