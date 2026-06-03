import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { verifyEmail } from '../api/auth';
import './VerifyEmailPage.css';

type Status = 'verifying' | 'success' | 'error';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [status,  setStatus]  = useState<Status>('verifying');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('Missing or invalid verification link.');
      return;
    }

    verifyEmail(token)
      .then(() => setStatus('success'))
      .catch((err: { response?: { data?: { error?: string } } }) => {
        setStatus('error');
        setMessage(err.response?.data?.error ?? 'The verification link is invalid or has expired.');
      });
  }, [token]);

  return (
    <div className="verify-email-page">
      <div className="verify-email-page__card">
        <header className="verify-email-page__header">
          <h1 className="verify-email-page__title">Papyra</h1>
        </header>

        {status === 'verifying' && (
          <div className="verify-email-page__body">
            <p className="verify-email-page__lead">Verifying your email…</p>
          </div>
        )}

        {status === 'success' && (
          <div className="verify-email-page__body">
            <p className="verify-email-page__lead verify-email-page__lead--success">
              Email verified successfully.
            </p>
            <p>Your account is now active. You can sign in below.</p>
            <Link to="/login" className="verify-email-page__btn">Sign in</Link>
          </div>
        )}

        {status === 'error' && (
          <div className="verify-email-page__body">
            <p className="verify-email-page__lead verify-email-page__lead--error">
              Verification failed
            </p>
            <p>{message}</p>
            <p>
              Need a new link?{' '}
              <Link to="/resend-verification" className="verify-email-page__link">
                Resend verification email
              </Link>
            </p>
            <Link to="/login" className="verify-email-page__btn verify-email-page__btn--outline">
              Back to sign in
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
