import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { BrandBootstrap } from './types';

const FALLBACK: BrandBootstrap = {
  configured: false,
  displayName: null,
  applicationName: null,
  tokens: {},
  themeMode: 'system',
  radius: '0.5rem',
  brandVersion: 0,
};

const BrandContext = createContext<BrandBootstrap>(FALLBACK);

/**
 * Applies the deployment's brand (resolved server-side) to the document:
 * CSS variables, dark-mode class, and title. Pre-onboarding it shows neutral
 * copy — never the internal code name.
 */
export function BrandProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery({
    queryKey: ['brand-bootstrap'],
    queryFn: () => api.get<BrandBootstrap>('/api/public/brand-bootstrap'),
    staleTime: 60_000,
  });
  const brand = data ?? FALLBACK;

  useEffect(() => {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(brand.tokens)) {
      if (/^[a-z-]+$/.test(key)) root.style.setProperty(`--${key}`, value);
    }
    root.style.setProperty('--radius', brand.radius);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = brand.themeMode === 'dark' || (brand.themeMode === 'system' && prefersDark);
    root.classList.toggle('dark', dark);
    document.title = brand.applicationName ?? brand.displayName ?? 'Company Books';
  }, [brand]);

  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): BrandBootstrap {
  return useContext(BrandContext);
}
