import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// A category is a curated note tag. `count` is how many live notes carry the tag;
// `color` comes from the registry (null until the user picks one).
export interface Category {
  name: string;
  color: string | null;
  count: number;
}

export const CATEGORIES_KEY = ['categories'] as const;

async function fetchCategories(): Promise<Category[]> {
  const res = await fetch('/api/categories');
  if (!res.ok) throw new Error(`GET /api/categories failed: ${res.status}`);
  return res.json();
}

export function useCategories() {
  return useQuery({ queryKey: CATEGORIES_KEY, queryFn: fetchCategories });
}

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; color?: string | null }) => {
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`POST /api/categories failed: ${res.status}`);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });
}

export function useDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/categories/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`DELETE /api/categories failed: ${res.status}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });
}
