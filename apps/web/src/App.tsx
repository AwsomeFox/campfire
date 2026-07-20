import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from './app/AuthProvider';
import { AuthStatusProvider } from './app/AuthStatusGate';
import { AnnounceProvider } from './components/Announcer';
import { router } from './app/router';

export default function App() {
  return (
    <AuthStatusProvider>
      <AuthProvider>
        <AnnounceProvider>
          <RouterProvider router={router} />
        </AnnounceProvider>
      </AuthProvider>
    </AuthStatusProvider>
  );
}
