import { useEffect, useRef } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import WorkspaceLayout from './layout/WorkspaceLayout';
import NotesPage from './pages/NotesPage';
import NoteEditorPage from './pages/NoteEditorPage';
import TodoPage from './pages/TodoPage';
import CategoriesPage from './pages/CategoriesPage';
import CollectionsPage from './pages/CollectionsPage';
import ArchivePage from './pages/ArchivePage';
import VaultPage from './pages/VaultPage';
import TokenPage from './pages/TokenPage';
import TrashPage from './pages/TrashPage';
import SettingsPage from './pages/SettingsPage';
import SharedWithMePage from './pages/SharedWithMePage';
import SharedNotePage from './pages/SharedNotePage';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import { useAuth } from './hooks/useAuth';
import { clearSessionData } from './lib/session';
import { FocusProvider } from './hooks/FocusProvider';
import './App.css';
import InboxPage from './pages/InboxPage';

// Gate the workspace behind a live session. The /me probe decides where an
// unauthenticated visitor lands: /setup before any admin exists, else /login.
function RequireAuth() {
  const { state } = useAuth();
  const queryClient = useQueryClient();
  const wasAuthed = useRef(false);

  // A session can end without anyone pressing Sign out — it expires, or an admin
  // deletes the account, and the next request 401s. That drops us here with the
  // previous user's notes still sitting in the caches, so treat it exactly like
  // an explicit sign-out.
  useEffect(() => {
    if (state === 'authed') { wasAuthed.current = true; return; }
    if (state === 'login' && wasAuthed.current) {
      wasAuthed.current = false;
      void clearSessionData(queryClient);
    }
  }, [state, queryClient]);

  if (state === 'loading') return <div className="app-bootstrap">Loading…</div>;
  if (state === 'setup') return <Navigate to="/setup" replace />;
  if (state === 'login') return <Navigate to="/login" replace />;
  if (state === 'error') return <div className="app-bootstrap">Couldn’t reach the server.</div>;
  return (
    <FocusProvider>
      <WorkspaceLayout />
    </FocusProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      {/* One-time emailed links. Outside the auth guard: whoever follows a
          reset link is by definition unable to sign in. */}
      <Route path="/reset-password" element={<TokenPage mode="reset" />} />
      <Route path="/accept-invite" element={<TokenPage mode="invite" />} />
      {/* Public tokenised share link — no session required. */}
      <Route path="/shared/:token" element={<SharedNotePage />} />
      <Route element={<RequireAuth />}>
        {/* The editor renders as a modal over the grid, so note/:id is a child of
            NotesPage (which keeps the grid mounted behind it via <Outlet />). */}
        <Route path="/" element={<NotesPage />}>
          <Route path="note/:id" element={<NoteEditorPage />} />
        </Route>
        <Route path="todo" element={<TodoPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="collections" element={<CollectionsPage />} />
        <Route path="shared-with-me" element={<SharedWithMePage />} />
        <Route path="vault" element={<VaultPage />} />
        <Route path="archive" element={<ArchivePage />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
