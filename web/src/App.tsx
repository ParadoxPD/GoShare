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
  const { role } = useStore();
  const [isReady, setIsReady] = useState(false);
  const p2p = useP2PIntegration();

  useWakeLock();

  // ✅ No more fetching encryption key!
  useEffect(() => {
    setIsReady(true);
  }, []);

  if (!isReady) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>Initializing...</p>
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
