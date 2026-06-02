import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import HomePage from './pages/HomePage';
import SettingsPage from './pages/SettingsPage';
import AdminPage from './pages/AdminPage';
import ProfilePage from './pages/ProfilePage';
import CategoriesPage from './pages/CategoriesPage';
import TodoPage from './pages/TodoPage';
import ArchivePage from './pages/ArchivePage';
import TrashPage from './pages/TrashPage';
import './App.css';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<HomePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="categories" element={<CategoriesPage />} />
          <Route path="todo" element={<TodoPage />} />
          <Route path="archive" element={<ArchivePage />} />
          <Route path="trash" element={<TrashPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
