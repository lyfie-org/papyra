import { Routes, Route, Navigate } from 'react-router-dom';
import WorkspaceLayout from './layout/WorkspaceLayout';
import NotesPage from './pages/NotesPage';
import NoteEditorPage from './pages/NoteEditorPage';
import TodoPage from './pages/TodoPage';
import CategoriesPage from './pages/CategoriesPage';
import ArchivePage from './pages/ArchivePage';
import TrashPage from './pages/TrashPage';
import SettingsPage from './pages/SettingsPage';
import LoginPage from './pages/LoginPage';
import SetupPage from './pages/SetupPage';
import { useAuth } from './hooks/useAuth';
import './App.css';

// Gate the workspace behind a live session. The /me probe decides where an
// unauthenticated visitor lands: /setup before any admin exists, else /login.
function RequireAuth() {
  const { state } = useAuth();
  if (state === 'loading') return <div className="app-bootstrap">Loading…</div>;
  if (state === 'setup') return <Navigate to="/setup" replace />;
  if (state === 'login') return <Navigate to="/login" replace />;
  if (state === 'error') return <div className="app-bootstrap">Couldn’t reach the server.</div>;
  return <WorkspaceLayout />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route element={<RequireAuth />}>
        {/* The editor renders as a modal over the grid, so note/:id is a child of
            NotesPage (which keeps the grid mounted behind it via <Outlet />). */}
        <Route path="/" element={<NotesPage />}>
          <Route path="note/:id" element={<NoteEditorPage />} />
        </Route>
        <Route path="todo" element={<TodoPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="archive" element={<ArchivePage />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
