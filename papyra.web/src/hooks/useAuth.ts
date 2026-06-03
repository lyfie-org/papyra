import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getMe, login, logout, setup, verifyTwoFactor, register, resetPassword } from '../api/auth';
import type { LoginRequest, RegisterRequest, ResetPasswordRequest, SetupRequest } from '../types';

export const AUTH_KEY = ['auth', 'me'] as const;

export function useAuth() {
  return useQuery({
    queryKey: AUTH_KEY,
    queryFn:  getMe,
    retry:    false,
    staleTime: 2 * 60 * 1000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: LoginRequest) => login(req),
    onSuccess: (data) => {
      // If no 2FA challenge, session is established — refresh auth state.
      if (!data.requiresTwoFactor) {
        qc.invalidateQueries({ queryKey: AUTH_KEY });
      }
    },
  });
}

export function useVerifyTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ mfaToken, code }: { mfaToken: string; code: string }) =>
      verifyTwoFactor(mfaToken, code),
    onSuccess: () => qc.invalidateQueries({ queryKey: AUTH_KEY }),
  });
}

export function useSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: SetupRequest) => setup(req),
    onSuccess:  () => qc.invalidateQueries({ queryKey: AUTH_KEY }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      qc.setQueryData(AUTH_KEY, { isAuthenticated: false, isInitialized: true });
      qc.invalidateQueries({ queryKey: AUTH_KEY });
    },
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: RegisterRequest) => register(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: AUTH_KEY }),
  });
}

export function useResetPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ResetPasswordRequest) => resetPassword(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: AUTH_KEY }),
  });
}
