import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import './LandingView.css';

export function LandingView() {
    const setRole = useStore((state) => state.setRole);

    return (
        <div className="landing">
            <div className="landing-hero">
                <h1 className="hero-title">
                    Secure P2P
                    <br />
                    <span className="gradient-text">File Transfer</span>
                </h1>

                <p className="hero-subtitle">
                    End-to-end encrypted file sharing over WebRTC.
                    <br />
                    No servers, no limits, no tracking.
                </p>

                <div className="hero-features">
                    <div className="feature">
                        <span className="feature-icon">🔒</span>
                        <span className="feature-text">AES-256 Encryption</span>
                    </div>
                    <div className="feature">
                        <span className="feature-icon">⚡</span>
                        <span className="feature-text">Direct P2P Transfer</span>
                    </div>
                    <div className="feature">
                        <span className="feature-icon">🔄</span>
                        <span className="feature-text">Resume Capability</span>
                    </div>
                </div>
            </div>

            <div className="landing-actions">
                <Card variant="glow" padding="lg" className="action-card">
                    <div className="action-content">
                        <div className="action-icon">📤</div>
                        <h2>Send Files</h2>
                        <p>Share files securely with anyone, anywhere</p>
                        <Button
                            variant="primary"
                            size="lg"
                            fullWidth
                            onClick={() => setRole('sender')}
                        >
                            Start Sending
                        </Button>
                    </div>
                </Card>

                <Card variant="glow" padding="lg" className="action-card">
                    <div className="action-content">
                        <div className="action-icon">📥</div>
                        <h2>Receive Files</h2>
                        <p>Connect to a sender using their code</p>
                        <Button
                            variant="primary"
                            size="lg"
                            fullWidth
                            onClick={() => setRole('receiver')}
                        >
                            Start Receiving
                        </Button>
                    </div>
                </Card>
            </div>

            <div className="landing-tech">
                <p className="tech-label mono">Powered by</p>
                <div className="tech-stack">
                    <span className="tech-item">WebRTC</span>
                    <span className="tech-divider">•</span>
                    <span className="tech-item">AES-GCM</span>
                    <span className="tech-divider">•</span>
                    <span className="tech-item">IndexedDB</span>
                    <span className="tech-divider">•</span>
                    <span className="tech-item">SHA-256</span>
                </div>
            </div>
        </div>
    );
}
