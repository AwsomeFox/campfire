import { RouterProvider } from 'react-router-dom';
import { AuthProvider } from './app/AuthProvider';
import { AuthStatusProvider } from './app/AuthStatusGate';
import { router } from './app/router';

export default function App() {
  return (
    <AuthStatusProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </AuthStatusProvider>
  );
}
