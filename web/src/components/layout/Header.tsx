import { useStore } from '../../store';
import './Header.css';

export function Header() {
    const { connectionStatus, role, sessionCode, receiverCount } = useStore();

    return (
        <header className="header">
            <div className="header-content">
                <div className="header-brand">
                    <div className="brand-icon">⚡</div>
                    <h1 className="brand-name">
                        Go<span className="gradient-text">Share</span>
                    </h1>
                </div>

                <div className="header-status">
                    {/* WebSocket Status */}
                    <div className="status-item">
                        <div className={`status-dot ${connectionStatus.websocket ? 'connected' : ''}`} />
                        <span className="status-label mono">
                            {connectionStatus.websocket ? 'WS' : 'Disconnected'}
                        </span>
                    </div>

                    {/* WebRTC Status */}
                    {role && (
                        <div className="status-item">
                            <div className={`status-dot ${connectionStatus.webrtc ? 'connected webrtc' : ''}`} />
                            <span className="status-label mono">
                                {connectionStatus.webrtc ? 'WebRTC' : 'Connecting...'}
                            </span>
                        </div>
                    )}

                    {/* Session Code */}
                    {sessionCode && (
                        <div className="status-item session-code">
                            <span className="status-label">Code:</span>
                            <span className="code-value mono">{sessionCode}</span>
                        </div>
                    )}

                    {/* Receiver Count */}
                    {role === 'sender' && receiverCount > 0 && (
                        <div className="status-item">
                            <span className="status-label">👥</span>
                            <span className="code-value">{receiverCount}</span>
                        </div>
                    )}
                </div>
            </div>

            {/* Decorative line */}
            <div className="header-line" />
        </header>
    );
}
