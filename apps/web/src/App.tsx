import { RouterProvider } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from './i18n';
import { AuthProvider } from './app/AuthProvider';
import { AuthStatusProvider } from './app/AuthStatusGate';
import { AnnounceProvider } from './components/Announcer';
import { router } from './app/router';

export default function App() {
  return (
    <I18nextProvider i18n={i18n}>
      <AuthStatusProvider>
        <AuthProvider>
          <AnnounceProvider>
            <RouterProvider router={router} />
          </AnnounceProvider>
        </AuthProvider>
      </AuthStatusProvider>
    </I18nextProvider>
  );
}
