/**
 * Per-route error boundary. Feature pages are being written in parallel by other
 * devs and lazy-imported here; if a module is missing/broken this renders a
 * friendly placeholder instead of white-screening the whole app.
 */
import { Component, type ReactNode } from 'react';
import { Card } from '../components/ui';

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
          <Card className="text-center space-y-2">
            <p className="text-2xl">🚧</p>
            <p className="font-bold text-white">Screen under construction</p>
            <p className="text-sm text-slate-400">
              This part of Campfire isn&apos;t ready yet. Check back soon.
            </p>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}
