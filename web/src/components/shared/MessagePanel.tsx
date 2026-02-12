import { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store';
import { Button } from '../ui/Button';
import { copyToClipboard } from '../../lib/utils';
import './MessagePanel.css';

interface MessagePanelProps {
    onSend: (text: string) => void;
}

export function MessagePanel({ onSend }: MessagePanelProps) {
    const [text, setText] = useState('');
    const messages = useStore((state) => state.messages);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSend = () => {
        if (text.trim()) {
            onSend(text.trim());
            setText('');
        }
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleCopy = async (message: string) => {
        const success = await copyToClipboard(message);
        if (success) {
            useStore.getState().addNotification('Message copied!', 'success');
        }
    };

    return (
        <div className="message-panel">
            <div className="message-history">
                {messages.length === 0 ? (
                    <div className="messages-empty">
                        <div className="empty-icon">💬</div>
                        <p className="empty-text">No messages yet</p>
                        <p className="empty-subtext">Send an encrypted message to get started</p>
                    </div>
                ) : (
                    <>
                        {messages.map((message) => (
                            <div
                                key={message.id}
                                className={`message ${message.sent ? 'message-sent' : 'message-received'}`}
                            >
                                <div className="message-header">
                                    <span className="message-sender mono">{message.senderName}</span>
                                    <span className="message-time text-secondary">
                                        {new Date(message.timestamp).toLocaleTimeString()}
                                    </span>
                                </div>
                                <div className="message-content">{message.text}</div>
                                {!message.sent && (
                                    <div className="message-actions">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => handleCopy(message.text)}
                                            icon="📋"
                                        >
                                            Copy
                                        </Button>
                                    </div>
                                )}
                            </div>
                        ))}
                        <div ref={messagesEndRef} />
                    </>
                )}
            </div>

            <div className="message-input-container">
                <div className="input-wrapper">
                    <textarea
                        className="message-input"
                        placeholder="Type your message... (Press Enter to send, Shift+Enter for new line)"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyPress={handleKeyPress}
                        rows={1}
                        maxLength={100000}
                    />
                    <div className="input-meta">
                        <span className="char-count mono text-secondary">
                            {text.length.toLocaleString()} / 100,000
                        </span>
                        <div className="input-actions">
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={async () => {
                                    const clipText = await navigator.clipboard.readText();
                                    setText(clipText);
                                }}
                                icon="📋"
                            >
                                Paste
                            </Button>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={handleSend}
                                disabled={!text.trim()}
                                icon="📤"
                            >
                                Send
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
