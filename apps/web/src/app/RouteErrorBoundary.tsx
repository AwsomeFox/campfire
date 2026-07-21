/**
 * Per-route error boundary. Feature pages are being written in parallel by other
 * devs and lazy-imported here; if a module is missing/broken this renders a
 * friendly placeholder instead of white-screening the whole app.
 */
import { Component, type ReactNode } from 'react';
import { Card } from '../components/ui';
import { GameIcon } from '../components/GameIcon';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('Route failed to render', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="max-w-lg mx-auto mt-10 px-4">
          <Card className="text-center space-y-3">
            <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="hazard-sign" size={28} reserveSpace /></p>
            <p className="font-bold text-white">Something went wrong on this screen</p>
            <p className="text-sm text-slate-400">
              You can try reloading, or head back to your campaigns.
            </p>
            <div className="flex gap-2 justify-center pt-1">
              <button className="btn btn-secondary" onClick={() => window.location.reload()}>
                Reload
              </button>
              <a href="/" className="btn btn-primary">
                Back to campaigns
              </a>
            </div>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}
