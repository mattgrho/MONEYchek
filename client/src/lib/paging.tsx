import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

/**
 * Cursor-paginated list fetching. The server returns
 * `{ items: T[], nextCursor: string | null, ...extras }`; pages are
 * concatenated in order and `nextCursor` drives "Load more".
 */

interface PagedResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export function usePagedList<T, Extra = Record<string, never>>(
  queryKey: readonly unknown[],
  baseUrl: string,
  options?: { enabled?: boolean },
) {
  const query = useInfiniteQuery({
    queryKey,
    enabled: options?.enabled,
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const sep = baseUrl.includes('?') ? '&' : '?';
      const url = pageParam ? `${baseUrl}${sep}cursor=${encodeURIComponent(pageParam)}` : baseUrl;
      return api.get<PagedResponse<T> & Extra>(url);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items: T[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  return {
    items,
    /** Non-item fields (e.g. storageAvailable) come from the first page. */
    firstPage: query.data?.pages[0],
    isLoading: query.isLoading,
    error: query.error,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

export function LoadMoreButton({
  hasMore,
  loading,
  onClick,
}: {
  hasMore: boolean | undefined;
  loading: boolean;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="mt-4 flex justify-center">
      <Button variant="outline" onClick={onClick} loading={loading}>
        Load more
      </Button>
    </div>
  );
}
