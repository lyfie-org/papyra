import { QueryClient } from '@tanstack/react-query';

// Single app-wide client. SignalR drives freshness, so we lean on cache + explicit
// invalidation rather than aggressive refetch-on-focus polling.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});
