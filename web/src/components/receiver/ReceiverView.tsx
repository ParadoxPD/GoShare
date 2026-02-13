import { useState, useRef } from 'react';
import { useStore } from '../../store';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Tabs, TabPanel } from '../shared/Tabs';
import { ProgressBar } from '../shared/ProgressBar';
import { MessagePanel } from '../shared/MessagePanel';
import { isValidSessionCode } from '../../lib/utils';
import { Html5Qrcode } from 'html5-qrcode';
import './ReceiverView.css';

interface ReceiverViewProps {
    p2p: {
        joinSession: (code: string) => void;
        sendTextMessage: (text: string) => void;
    };
}

export function ReceiverView({ p2p }: ReceiverViewProps) {
    const [code, setCode] = useState('');
    const [scanning, setScanning] = useState(false);
    const {
        sessionCode,
        currentTab,
        setCurrentTab,
        connectionStatus,
        addNotification,
    } = useStore();

    const qrScannerRef = useRef<Html5Qrcode | null>(null);
    const transfers = Array.from(useStore((state) => state.transfers.values()));

    const handleJoin = () => {
        if (isValidSessionCode(code)) {
            p2p.joinSession(code);
        } else {
            addNotification('Invalid code - must be 6 digits', 'error');
        }
    };

    const startScanning = async () => {
        try {
            const host = window.location.hostname;
            const isLocalDevHost = host === 'localhost' || host === '127.0.0.1';
            if (!window.isSecureContext && !isLocalDevHost) {
                addNotification('Camera requires HTTPS on this device. Open the app over HTTPS to scan QR.', 'error');
                return;
            }

            setScanning(true);
            const cameras = await Html5Qrcode.getCameras().catch(() => []);
            const preferredCamera = cameras.find(
                (camera) => /back|rear|environment/i.test(camera.label),
            ) || cameras[cameras.length - 1];

            const cameraStrategies: Array<string | MediaTrackConstraints> = [];
            if (preferredCamera) {
                cameraStrategies.push(preferredCamera.id);
            }
            cameraStrategies.push({ facingMode: { exact: 'environment' } });
            cameraStrategies.push({ facingMode: 'environment' });
            cameraStrategies.push({ facingMode: 'user' });

            let started = false;
            let lastError: unknown = null;

            for (const strategy of cameraStrategies) {
                const scanner = new Html5Qrcode('qr-reader');
                qrScannerRef.current = scanner;
                try {
                    await scanner.start(
                        strategy,
                        { fps: 10, qrbox: 250, aspectRatio: 1 },
                        (decodedText) => {
                            setCode(decodedText);
                            stopScanning();
                            addNotification('QR code scanned!', 'success');
                        },
                        () => {
                            // Error scanning frame - ignore
                        }
                    );
                    started = true;
                    break;
                } catch (error) {
                    lastError = error;
                    try {
                        await scanner.stop();
                    } catch {
                        // Ignore stop failures between fallback attempts
                    }
                    scanner.clear();
                    qrScannerRef.current = null;
                }
            }

            if (!started) {
                throw lastError || new Error('No compatible camera configuration found');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Camera access denied or not available';
            const normalized = message.toLowerCase();
            const hint = normalized.includes('notallowed') || normalized.includes('permission')
                ? 'Allow camera permission in browser settings, then retry.'
                : normalized.includes('notfound') || normalized.includes('no camera')
                    ? 'No camera was found on this device/browser.'
                    : 'Ensure camera is not in use by another app and try again.';

            addNotification(`Camera error: ${message}. ${hint}`, 'error');
            setScanning(false);
        }
    };

    const stopScanning = () => {
        if (qrScannerRef.current) {
            qrScannerRef.current.stop().catch(() => { });
            qrScannerRef.current.clear();
            qrScannerRef.current = null;
        }
        setScanning(false);
    };

    return (
        <div className="receiver-view">
            {!sessionCode ? (
                <div className="join-section">
                    <Card variant="glow" padding="lg" className="join-card">
                        <h2 className="section-title">Join Session</h2>
                        <p className="section-subtitle">
                            Enter the 6-digit code from the sender or scan their QR code
                        </p>

                        <div className="code-input-container">
                            <input
                                type="text"
                                className="code-input mono"
                                placeholder="000000"
                                maxLength={6}
                                value={code}
                                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                                onKeyPress={(e) => e.key === 'Enter' && handleJoin()}
                                autoFocus
                            />
                        </div>

                        <div className="join-actions">
                            <Button
                                variant="primary"
                                size="lg"
                                fullWidth
                                onClick={handleJoin}
                                disabled={!isValidSessionCode(code)}
                                icon="🔗"
                            >
                                Join Session
                            </Button>

                            {!scanning ? (
                                <Button
                                    variant="secondary"
                                    size="lg"
                                    fullWidth
                                    onClick={startScanning}
                                    icon="📷"
                                >
                                    Scan QR Code
                                </Button>
                            ) : (
                                <Button
                                    variant="danger"
                                    size="lg"
                                    fullWidth
                                    onClick={stopScanning}
                                    icon="✕"
                                >
                                    Stop Scanning
                                </Button>
                            )}
                        </div>

                        {scanning && (
                            <div className="qr-scanner">
                                <div id="qr-reader" />
                            </div>
                        )}
                    </Card>
                </div>
            ) : (
                <Card variant="elevated" padding="lg">
                    <div className="receiver-header">
                        <div>
                            <h2 className="section-title">Receiving Files</h2>
                            <p className="section-subtitle">
                                Connected to session <span className="code-badge mono">{sessionCode}</span>
                            </p>
                        </div>
                        {connectionStatus.webrtc ? (
                            <div className="connection-badge connected">
                                <span className="status-dot" />
                                <span>Connected</span>
                            </div>
                        ) : (
                            <div className="connection-badge connecting">
                                <span className="status-dot" />
                                <span>Connecting...</span>
                            </div>
                        )}
                    </div>

                    <Tabs
                        activeTab={currentTab}
                        onTabChange={(tab) => setCurrentTab(tab as 'files' | 'messages')}
                        tabs={[
                            { id: 'files', label: 'Files', icon: '📁', badge: transfers.length },
                            { id: 'messages', label: 'Messages', icon: '💬' },
                        ]}
                    />

                    {currentTab === 'files' ? (
                        <TabPanel>
                            {transfers.length === 0 ? (
                                <div className="no-transfers">
                                    <div className="empty-icon">📥</div>
                                    <p className="empty-text">No files received yet</p>
                                    <p className="empty-subtext">Files will appear here when sender starts transfer</p>
                                </div>
                            ) : (
                                <div className="transfers-list">
                                    {transfers.map((transfer) => (
                                        <ProgressBar
                                            key={transfer.id}
                                            fileName={transfer.name}
                                            progress={transfer.progress}
                                            speed={transfer.speed}
                                            totalSize={transfer.size}
                                            status={transfer.status}
                                            error={transfer.error}
                                        />
                                    ))}
                                </div>
                            )}
                        </TabPanel>
                    ) : (
                        <TabPanel>
                            <MessagePanel onSend={(text) => p2p.sendTextMessage(text)} />
                        </TabPanel>
                    )}
                </Card>
            )}
        </div>
    );
}
