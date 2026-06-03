import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AuthGuard from './components/AuthGuard';
import AppLayout from './components/AppLayout';
import { UserSettingsProvider } from './context/UserSettingsContext';
import HomePage from './pages/HomePage';
import SettingsPage from './pages/SettingsPage';
import AdminPage from './pages/AdminPage';
import ProfilePage from './pages/ProfilePage';
import ArchivePage from './pages/ArchivePage';
import TrashPage from './pages/TrashPage';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import RegisterPage from './pages/RegisterPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResendVerificationPage from './pages/ResendVerificationPage';
import ResetPasswordTokenPage from './pages/ResetPasswordTokenPage';
import './App.css';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public auth routes */}
        <Route path="setup"                  element={<SetupPage />} />
        <Route path="login"                  element={<LoginPage />} />
        <Route path="register"               element={<RegisterPage />} />
        <Route path="verify-email"           element={<VerifyEmailPage />} />
        <Route path="forgot-password"        element={<ForgotPasswordPage />} />
        <Route path="resend-verification"    element={<ResendVerificationPage />} />
        <Route path="reset-password-token"   element={<ResetPasswordTokenPage />} />

        {/* Protected app — requires auth + server-synced settings */}
        <Route element={<AuthGuard />}>
          {/* Password reset — fullscreen, no AppLayout */}
          <Route path="reset-password" element={<ResetPasswordPage />} />

          <Route element={
            <UserSettingsProvider>
              <AppLayout />
            </UserSettingsProvider>
          }>
            <Route index element={<HomePage />} />
            <Route path="settings"   element={<SettingsPage />} />
            <Route path="profile"    element={<ProfilePage />} />
            <Route path="archive"    element={<ArchivePage />} />
            <Route path="trash"      element={<TrashPage />} />

            {/* Admin-only route */}
            <Route element={<AuthGuard requireRole="admin" />}>
              <Route path="admin" element={<AdminPage />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
