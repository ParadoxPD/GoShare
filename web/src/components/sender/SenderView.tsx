import { useRef, useEffect } from 'react';
import { useStore } from '../../store';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Tabs, TabPanel } from '../shared/Tabs';
import { FileList } from '../shared/FileList';
import { ProgressBar } from '../shared/ProgressBar';
import { MessagePanel } from '../shared/MessagePanel';
import QRCode from 'qrcode';
import './SenderView.css';

interface SenderViewProps {
    p2p: {
        createSession: () => void;
        sendFiles: () => void;
        sendTextMessage: (text: string) => void;
    };
}

export function SenderView({ p2p }: SenderViewProps) {
    const {
        sessionCode,
        receiverCount,
        selectedFiles,
        addFile,
        removeFile,
        setCurrentTab,
        currentTab,
        connectionStatus,
    } = useStore();

    const qrCanvasRef = useRef<HTMLCanvasElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const transfers = Array.from(useStore((state) => state.transfers.values()));

    // Create session on mount
    useEffect(() => {
        if (!sessionCode) {
            p2p.createSession();
        }
    }, [sessionCode, p2p]);

    // Generate QR code
    useEffect(() => {
        if (sessionCode && qrCanvasRef.current) {
            QRCode.toCanvas(qrCanvasRef.current, sessionCode, {
                width: 200,
                margin: 2,
                color: {
                    dark: '#00d4ff',
                    light: '#0a0e1a',
                },
            });
        }
    }, [sessionCode]);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        files.forEach((file) => addFile(file));
    };

    const canSend = selectedFiles.length > 0 && connectionStatus.webrtc;

    return (
        <div className="sender-view">
            <div className="sender-grid">
                {/* Session Info */}
                <Card variant="glow" padding="lg">
                    <div className="session-container">
                        <h2 className="section-title">Session Code</h2>

                        <div className="qr-section">
                            <canvas ref={qrCanvasRef} className="qr-canvas" />
                            {sessionCode ? (
                                <div className="session-code mono">{sessionCode}</div>
                            ) : (
                                <div className="session-code loading">------</div>
                            )}
                        </div>

                        <div className="session-status">
                            {receiverCount === 0 ? (
                                <div className="status-waiting">
                                    <span className="status-icon animate-pulse">⏳</span>
                                    <span>Waiting for receivers...</span>
                                </div>
                            ) : (
                                <div className="status-connected">
                                    <span className="status-icon">👥</span>
                                    <span>
                                        {receiverCount} receiver{receiverCount > 1 ? 's' : ''} connected
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                </Card>

                {/* Main Content */}
                <Card variant="elevated" padding="lg">
                    <Tabs
                        activeTab={currentTab}
                        onTabChange={(tab) => setCurrentTab(tab as 'files' | 'messages')}
                        tabs={[
                            { id: 'files', label: 'Files', icon: '📁', badge: selectedFiles.length },
                            { id: 'messages', label: 'Messages', icon: '💬' },
                        ]}
                    />

                    {currentTab === 'files' ? (
                        <TabPanel>
                            <div className="files-section">
                                <div className="file-selector">
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        multiple
                                        onChange={handleFileSelect}
                                        className="file-input"
                                        id="file-input"
                                    />
                                    <label htmlFor="file-input" className="file-input-label">
                                        <span className="file-input-icon">📎</span>
                                        <span>Choose files or drag & drop</span>
                                    </label>
                                </div>

                                {selectedFiles.length > 0 && (
                                    <>
                                        <h3 className="subsection-title">
                                            Selected Files ({selectedFiles.length})
                                        </h3>
                                        <FileList files={selectedFiles} onRemove={removeFile} variant="sender" />

                                        <Button
                                            variant="primary"
                                            size="lg"
                                            fullWidth
                                            onClick={p2p.sendFiles}
                                            disabled={!canSend}
                                            icon="🚀"
                                        >
                                            {!connectionStatus.webrtc
                                                ? 'Waiting for connection...'
                                                : `Send ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`}
                                        </Button>
                                    </>
                                )}

                                {transfers.length > 0 && (
                                    <>
                                        <h3 className="subsection-title">Active Transfers</h3>
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
                                    </>
                                )}
                            </div>
                        </TabPanel>
                    ) : (
                        <TabPanel>
                            <MessagePanel onSend={(text) => p2p.sendTextMessage(text)} />
                        </TabPanel>
                    )}
                </Card>
            </div>
        </div>
    );
}
