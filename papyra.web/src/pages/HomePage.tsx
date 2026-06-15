import { useTheme } from '../hooks/useTheme';
import logo from '../assets/papyra_logo.png';
import './HomePage.css';

export default function HomePage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <main className="home-page">
      <img className="home-page__logo" src={logo} alt="" aria-hidden="true" />
      <h1>Papyra</h1>
      <p className="home-page__tagline">A calm, self-hosted home for your notes.</p>
      <button
        type="button"
        className="home-page__theme-toggle"
        onClick={toggleTheme}
        aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      >
        {theme === 'light' ? 'Dark mode' : 'Light mode'}
      </button>
    </main>
  );
}
