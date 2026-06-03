import client from './client';
import type {
  AuthState, LoginRequest, LoginResponse, SetupRequest,
  TwoFactorSetup, User, RegisterRequest, ResetPasswordRequest,
} from '../types';

export async function getMe(): Promise<AuthState> {
  const { data } = await client.get<AuthState>('/api/auth/me');
  return data;
}

export async function login(req: LoginRequest): Promise<LoginResponse> {
  const { data } = await client.post<LoginResponse>('/api/auth/login', req);
  return data;
}

export async function verifyTwoFactor(mfaToken: string, code: string): Promise<User> {
  const { data } = await client.post<User>('/api/auth/2fa/verify', { mfaToken, code });
  return data;
}

export async function setup(req: SetupRequest): Promise<User> {
  const { data } = await client.post<User>('/api/auth/setup', req);
  return data;
}

export async function logout(): Promise<void> {
  await client.post('/api/auth/logout');
}

export async function enable2fa(): Promise<TwoFactorSetup> {
  const { data } = await client.post<TwoFactorSetup>('/api/auth/2fa/enable');
  return data;
}

export async function confirm2fa(code: string): Promise<{ recoveryCodes: string[] }> {
  const { data } = await client.post<{ message: string; recoveryCodes: string[] }>('/api/auth/2fa/confirm', { code });
  return data;
}

export async function regenerateRecoveryCodes(code: string): Promise<{ recoveryCodes: string[] }> {
  const { data } = await client.post<{ recoveryCodes: string[] }>('/api/auth/2fa/regenerate-recovery-codes', { code });
  return data;
}

export async function disable2fa(code: string): Promise<void> {
  await client.post('/api/auth/2fa/disable', { code });
}

export async function register(req: RegisterRequest): Promise<User> {
  const { data } = await client.post<User>('/api/auth/register', req);
  return data;
}

export async function resetPassword(req: ResetPasswordRequest): Promise<void> {
  await client.post('/api/auth/reset-password', req);
}

export async function verifyEmail(token: string): Promise<User> {
  const { data } = await client.post<User>('/api/auth/verify-email', { token });
  return data;
}

export async function resendVerification(username: string): Promise<void> {
  await client.post('/api/auth/resend-verification', { username });
}

export async function forgotPassword(email: string): Promise<void> {
  await client.post('/api/auth/forgot-password', { email });
}

export async function resetPasswordToken(token: string, newPassword: string, confirmPassword: string): Promise<void> {
  await client.post('/api/auth/reset-password-token', { token, newPassword, confirmPassword });
}
