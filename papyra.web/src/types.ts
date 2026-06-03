// ── Auth ─────────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'member' | 'viewer';

export interface User {
  username: string;
  name: string;
  email: string;
  role: UserRole;
  twoFactorEnabled?: boolean;
}

export interface AuthState {
  isAuthenticated: boolean;
  isInitialized: boolean;
  username?: string;
  name?: string;
  email?: string;
  role?: UserRole;
  twoFactorEnabled?: boolean;
  mustResetPassword?: boolean;
  /** Present when unauthenticated — lets the login page show/hide the register link */
  allowSelfRegistration?: boolean;
  /** Present when unauthenticated — lets the register page show verification state */
  requireEmailVerification?: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  requiresTwoFactor?: boolean;
  mfaToken?: string;
  // Present when 2FA not required — normal profile payload
  username?: string;
  name?: string;
  email?: string;
  role?: string;
}

export interface SetupRequest {
  username: string;
  name: string;
  email: string;
  password: string;
}

export interface RegisterRequest {
  username: string;
  password: string;
  name?: string;
  email?: string;
}

export interface ResetPasswordRequest {
  newPassword: string;
  confirmPassword: string;
}

// ── Notes ─────────────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  title: string;
  tags: string[];
  pinned: boolean;
  color: string;
  content: string;
  owner?: string;
  archived?: boolean;
  deleted?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Returned by GET /notes — content is omitted for bandwidth. */
export type NoteSummary = Omit<Note, 'content'>;

export interface SearchHit extends NoteSummary {
  snippet: string;
}

export interface CreateNoteRequest {
  title: string;
  tags?: string[];
  color?: string;
}

export interface UpdateNoteRequest {
  title?: string;
  tags?: string[];
  pinned?: boolean;
  color?: string;
  content?: string;
}

// ── User Settings ─────────────────────────────────────────────────────────────

export interface UserSettings {
  theme: string;
  viewMode: 'grid' | 'list';
  pinnedSharedNotes: string[];
}

export interface UpdateSettingsRequest {
  theme?: string;
  viewMode?: string;
  pinnedSharedNotes?: string[];
}

// ── User Stats ────────────────────────────────────────────────────────────────

export interface UserStats {
  active: number;
  archived: number;
  trash: number;
  wordCount: number;
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export interface AdminUser {
  username: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: string;
  twoFactorEnabled: boolean;
  mustResetPassword: boolean;
}

export interface AdminCreateUserRequest {
  username: string;
  password: string;
  name?: string;
  email?: string;
  role: UserRole;
}

export interface SmtpSettingsResponse {
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'ssl';
  username: string;
  fromAddress: string;
  fromName: string;
  hasPassword: boolean;
}

export interface SmtpSettingsRequest {
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'ssl';
  username?: string;
  password?: string;
  fromAddress: string;
  fromName?: string;
}

export interface GlobalSettings {
  allowSelfRegistration: boolean;
  requireEmailVerification: boolean;
  smtp?: SmtpSettingsResponse | null;
}

export interface RoleModel {
  name: string;
  maxNotesAllowed: number;
  allowFileUploads: boolean;
  attachmentSizeLimitMB: number;
}

// ── 2FA ───────────────────────────────────────────────────────────────────────

export interface TwoFactorSetup {
  secret: string;
  otpAuthUri: string;
}

// ── Sharing ───────────────────────────────────────────────────────────────────

export interface ShareRecord {
  shareId: string;
  noteId: string;
  ownerId: string;
  grantee?: string;
  permission: 'read' | 'write';
  expiresAt?: string;
  publicToken?: string;
  createdAt: string;
}

export interface CreateShareRequest {
  grantee: string;
  permission: 'read' | 'write';
  expiresAt?: string;
}

export interface PublicLinkRequest {
  expiresInDays: number;
}

export interface PublicLinkResponse {
  token: string;
  expiry: string;
  shareId: string;
}
