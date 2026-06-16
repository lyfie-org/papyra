import { Routes, Route } from 'react-router-dom';
import WorkspaceLayout from './layout/WorkspaceLayout';
import NotesPage from './pages/NotesPage';
import NoteEditorPage from './pages/NoteEditorPage';
import TodoPage from './pages/TodoPage';
import CategoriesPage from './pages/CategoriesPage';
import ProfilePage from './pages/ProfilePage';
import SettingsPage from './pages/SettingsPage';
import './App.css';

export default function App() {
  return (
    <Routes>
      <Route element={<WorkspaceLayout />}>
        <Route index element={<NotesPage />} />
        <Route path="note/:id" element={<NoteEditorPage />} />
        <Route path="todo" element={<TodoPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
