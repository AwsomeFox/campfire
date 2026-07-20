import { RouterProvider } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClientProvider } from '@tanstack/react-query';
import i18n from './i18n';
import { queryClient } from './lib/query';
import { AuthProvider } from './app/AuthProvider';
import { AuthStatusProvider } from './app/AuthStatusGate';
import { AnnounceProvider } from './components/Announcer';
import { router } from './app/router';

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <AuthStatusProvider>
          <AuthProvider>
            <AnnounceProvider>
              <RouterProvider router={router} />
            </AnnounceProvider>
          </AuthProvider>
        </AuthStatusProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
