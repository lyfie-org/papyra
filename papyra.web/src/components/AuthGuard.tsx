import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

interface AuthGuardProps {
  requireRole?: 'admin' | 'member';
}

export default function AuthGuard({ requireRole }: AuthGuardProps) {
  const { data: auth, isLoading, isError } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="auth-guard__loading" aria-live="polite" aria-busy="true">
        <span className="auth-guard__spinner" aria-hidden="true" />
      </div>
    );
  }

  // Network error or unexpected failure — let the app try to load normally
  if (isError) return <Outlet />;

  if (!auth?.isInitialized) return <Navigate to="/setup" replace />;
  if (!auth?.isAuthenticated) return <Navigate to="/login" replace />;

  // Force-redirect to /reset-password until the user clears the flag.
  // Allow the reset-password path itself through so the form can render.
  if (auth.mustResetPassword && location.pathname !== '/reset-password') {
    return <Navigate to="/reset-password" replace />;
  }

  if (requireRole && auth.role !== requireRole) return <Navigate to="/" replace />;

  return <Outlet />;
}
