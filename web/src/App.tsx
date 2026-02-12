import { useEffect, useState } from 'react';
import { useStore } from './store';
import { useP2PIntegration } from './hooks/useP2PIntegration';
import { useWakeLock } from './hooks/useWakeLock';
import { Header } from './components/layout/Header';
import { LandingView } from './components/layout/LandingView';
import { SenderView } from './components/sender/SenderView';
import { ReceiverView } from './components/receiver/ReceiverView';
import { Notifications } from './components/ui/Notifications';
import './styles/globals.css';
import './App.css';

export function App() {
  const { role, encryptionKey, setEncryptionKey } = useStore();
  const [isLoading, setIsLoading] = useState(true);
  const p2p = useP2PIntegration();

  // Mobile optimization - prevent screen from sleeping
  useWakeLock();

  // Load encryption key from server
  useEffect(() => {
    fetch('/config')
      .then((res) => res.json())
      .then((config) => {
        setEncryptionKey(config.key);
        setIsLoading(false);
      })
      .catch((error) => {
        console.error('Failed to load config:', error);
        // Fallback to a default key (NOT RECOMMENDED for production)
        setEncryptionKey('default-key-change-me');
        setIsLoading(false);
      });
  }, [setEncryptionKey]);

  if (isLoading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>Initializing secure connection...</p>
      </div>
    );
  }

  if (!encryptionKey) {
    return (
      <div className="app-error">
        <h2>Configuration Error</h2>
        <p>Failed to load encryption configuration.</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Header />

      <main className="app-content">
        {!role && <LandingView />}
        {role === 'sender' && <SenderView p2p={p2p} />}
        {role === 'receiver' && <ReceiverView p2p={p2p} />}
      </main>

      <Notifications />
    </div>
  );
}
