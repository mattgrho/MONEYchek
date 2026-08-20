import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';
import { can } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

interface BrandState {
  tokens: Record<string, string>;
  themeMode: 'light' | 'dark' | 'system';
  radius: string;
  brandVersion: number;
}

interface OnboardingState {
  brand: BrandState | null;
}

type ColorKey = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'sidebar';

const COLOR_FIELDS: { key: ColorKey; label: string; tokenKey: string; defaultHex: string }[] = [
  { key: 'primary', label: 'Primary', tokenKey: 'primary', defaultHex: '#1d4ed8' },
  { key: 'accent', label: 'Accent', tokenKey: 'accent', defaultHex: '#e0e7ff' },
  { key: 'success', label: 'Success', tokenKey: 'success', defaultHex: '#15803d' },
  { key: 'warning', label: 'Warning', tokenKey: 'warning', defaultHex: '#b45309' },
  { key: 'danger', label: 'Danger', tokenKey: 'destructive', defaultHex: '#b91c1c' },
  { key: 'sidebar', label: 'Sidebar', tokenKey: 'sidebar', defaultHex: '#0f172a' },
];

const RADII = ['0rem', '0.25rem', '0.5rem', '0.75rem', '1rem'];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Black or white, whichever reads better on the given hex background. */
function previewForeground(hex: string): string {
  if (!HEX_RE.test(hex)) return '#ffffff';
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.35 ? '#111111' : '#ffffff';
}

export function BrandSettingsPage({ me }: { me: Me }) {
  const state = useQuery({
    queryKey: ['onboarding-state'],
    queryFn: () => api.get<OnboardingState>('/api/v1/onboarding/state'),
  });

  if (state.isLoading) return <Spinner label="Loading brand settings" />;
  if (state.error) return <ErrorNote error={state.error} />;
  const brand = state.data?.brand;
  if (!brand) return <ErrorNote error={new Error('Brand settings not found')} />;

  return (
    <div>
      <PageHeader
        title="Brand & appearance"
        description={`Colors, theme and shape of ${me.company?.applicationName || me.company?.displayName || 'the application'}. Changes restyle the app for every member after save.`}
      />
      <BrandForm brand={brand} me={me} />
    </div>
  );
}

function BrandForm({ brand, me }: { brand: BrandState; me: Me }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const editable = can(me, 'brand.edit');

  const [colors, setColors] = useState<Record<ColorKey, string>>(
    () =>
      Object.fromEntries(COLOR_FIELDS.map((f) => [f.key, f.defaultHex])) as Record<
        ColorKey,
        string
      >,
  );
  const [dirty, setDirty] = useState<ColorKey[]>([]);
  const [themeMode, setThemeMode] = useState<BrandState['themeMode']>(brand.themeMode);
  const [radius, setRadius] = useState(brand.radius);
  const [warnings, setWarnings] = useState<string[]>([]);

  const setColor = (key: ColorKey, value: string) => {
    setColors((prev) => ({ ...prev, [key]: value }));
    setDirty((prev) => (prev.includes(key) ? prev : [...prev, key]));
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = { themeMode, radius };
      for (const key of dirty) {
        body[key] = colors[key];
      }
      return api.patch<{ ok: boolean; warnings: string[] }>('/api/v1/onboarding/brand', body);
    },
    onSuccess: (data) => {
      setWarnings(data.warnings);
      toast(
        'success',
        data.warnings.length > 0 ? 'Brand saved with contrast warnings' : 'Brand saved',
      );
      void qc.invalidateQueries({ queryKey: ['brand-bootstrap'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['onboarding-state'] });
    },
    onError: (err) => toast('error', err instanceof Error ? err.message : 'Save failed'),
  });

  const invalidDirty = dirty.filter((key) => !HEX_RE.test(colors[key]));

  const currentSwatches = COLOR_FIELDS.filter((f) => brand.tokens[f.tokenKey]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (invalidDirty.length > 0) {
            toast(
              'error',
              `Enter 6-digit hex colors (like #1d4ed8) for: ${invalidDirty.join(', ')}`,
            );
            return;
          }
          save.mutate();
        }}
        className="space-y-6"
      >
        {currentSwatches.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Current palette</CardTitle>
              <CardDescription>
                Colors currently in use (stored as HSL tokens, version {brand.brandVersion}).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-wrap gap-4">
                {currentSwatches.map((f) => (
                  <li key={f.key} className="flex items-center gap-2 text-sm">
                    <span
                      aria-hidden
                      className="inline-block h-6 w-6 rounded-md border border-border"
                      style={{ background: 'hsl(' + brand.tokens[f.tokenKey] + ')' }}
                    />
                    <span>{f.label}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Colors</CardTitle>
            <CardDescription>
              Pick new colors below; only the ones you change are saved. Readable text colors are
              derived automatically on the server.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {COLOR_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`brand-${f.key}-hex`}>{f.label}</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={`${f.label} color picker`}
                    disabled={!editable}
                    value={HEX_RE.test(colors[f.key]) ? colors[f.key] : f.defaultHex}
                    onChange={(e) => setColor(f.key, e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded-md border border-input bg-card p-1 disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <Input
                    id={`brand-${f.key}-hex`}
                    disabled={!editable}
                    value={colors[f.key]}
                    onChange={(e) => setColor(f.key, e.target.value)}
                    placeholder={f.defaultHex}
                    className="font-mono"
                    maxLength={7}
                  />
                </div>
                {dirty.includes(f.key) && !HEX_RE.test(colors[f.key]) ? (
                  <p className="text-xs text-destructive">Use a 6-digit hex like {f.defaultHex}</p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Theme & shape</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="brand-theme-mode">Theme mode</Label>
              <Select
                id="brand-theme-mode"
                disabled={!editable}
                value={themeMode}
                onChange={(e) => setThemeMode(e.target.value as BrandState['themeMode'])}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="brand-radius">Corner radius</Label>
              <Select
                id="brand-radius"
                disabled={!editable}
                value={radius}
                onChange={(e) => setRadius(e.target.value)}
              >
                {!RADII.includes(radius) ? <option value={radius}>{radius}</option> : null}
                {RADII.map((r) => (
                  <option key={r} value={r}>
                    {r === '0rem' ? 'Square (0rem)' : r}
                  </option>
                ))}
              </Select>
            </div>
          </CardContent>
        </Card>

        {warnings.length > 0 ? (
          <div
            role="alert"
            className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
          >
            <p className="font-medium">Contrast warnings from last save</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {save.error ? <ErrorNote error={save.error} /> : null}
        {editable ? (
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              Save brand
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Your role does not permit editing brand settings.
          </p>
        )}
      </form>

      <div>
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>A rough sketch using the colors picked on the left.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden border border-border" style={{ borderRadius: radius }}>
              <div
                className="px-3 py-2 text-sm font-semibold"
                style={{
                  background: HEX_RE.test(colors.sidebar) ? colors.sidebar : '#0f172a',
                  color: previewForeground(colors.sidebar),
                }}
              >
                {me.company?.applicationName || me.company?.displayName || 'Your app'}
              </div>
              <div className="space-y-3 bg-card p-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="px-3 py-1.5 text-sm font-medium"
                    style={{
                      background: HEX_RE.test(colors.primary) ? colors.primary : '#1d4ed8',
                      color: previewForeground(colors.primary),
                      borderRadius: radius,
                    }}
                  >
                    Primary action
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1.5 text-sm font-medium"
                    style={{
                      background: HEX_RE.test(colors.accent) ? colors.accent : '#e0e7ff',
                      color: previewForeground(colors.accent),
                      borderRadius: radius,
                    }}
                  >
                    Accent
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 text-xs font-medium">
                  {(['success', 'warning', 'danger'] as const).map((key) => (
                    <span
                      key={key}
                      className="inline-flex items-center px-2 py-0.5"
                      style={{
                        background: HEX_RE.test(colors[key])
                          ? colors[key]
                          : COLOR_FIELDS.find((f) => f.key === key)!.defaultHex,
                        color: previewForeground(colors[key]),
                        borderRadius: radius,
                      }}
                    >
                      {key === 'success' ? 'Paid' : key === 'warning' ? 'Overdue' : 'Void'}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Theme mode: {themeMode}. Actual foreground colors are computed server-side for
                  accessibility.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
