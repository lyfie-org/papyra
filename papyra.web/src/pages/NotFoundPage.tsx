import { useLocation, useNavigate } from 'react-router-dom';
import ErrorScreen from '../components/ErrorScreen';

// Any address no route claims. It used to render nothing at all — a blank page
// that looked like the app had crashed.
export default function NotFoundPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <ErrorScreen
      code="404 · Not found"
      info={{
        title: 'This page doesn’t exist',
        message: `Nothing lives at ${pathname}. The link may be mistyped, or the page moved.`,
      }}
      actions={[
        { label: 'Back to notes', onClick: () => navigate('/'), primary: true },
        ...(window.history.length > 1 ? [{ label: 'Go back', onClick: () => navigate(-1) }] : []),
      ]}
    />
  );
}
