import logo from '../assets/papyra_logo.png';
import ErrorPanel, { type ErrorAction } from './ErrorPanel';
import type { ErrorInfo } from '../lib/errorReport';
import './ErrorPanel.css';

/**
 * A whole-screen failure: the brand (so it reads as Papyra, not a dead page)
 * over an ErrorPanel. Links are plain hrefs — this may render above a router
 * that is itself what broke.
 */
export default function ErrorScreen({ info, actions, code }: { info: ErrorInfo; actions?: ErrorAction[]; code?: string }) {
  return (
    <div className="error-screen">
      <div>
        <a className="error-screen__brand" href="/">
          <img src={logo} alt="" aria-hidden="true" />
          Papyra
        </a>
        <ErrorPanel info={info} actions={actions} code={code} />
      </div>
    </div>
  );
}
