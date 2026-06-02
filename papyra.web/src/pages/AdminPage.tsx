import './PlaceholderPage.css';

export default function AdminPage() {
  return (
    <div className="placeholder-page">
      <div className="placeholder-page__icon">🛠️</div>
      <h2 className="placeholder-page__title">Admin</h2>
      <p className="placeholder-page__body">
        Server stats, index management, and backend configuration will live here.
      </p>
    </div>
  );
}
