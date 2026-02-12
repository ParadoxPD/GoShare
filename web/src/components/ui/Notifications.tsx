import { useEffect } from 'react';
import { useStore } from '../../store';
import './Notifications.css';

export function Notifications() {
    const { notifications, removeNotification } = useStore();

    return (
        <div className="notifications-container">
            {notifications.map((notification) => (
                <Notification
                    key={notification.id}
                    {...notification}
                    onDismiss={() => removeNotification(notification.id)}
                />
            ))}
        </div>
    );
}

interface NotificationProps {
    id: string;
    message: string;
    type: 'success' | 'error' | 'warning' | 'info';
    onDismiss: () => void;
}

function Notification({ id, message, type, onDismiss }: NotificationProps) {
    useEffect(() => {
        const timer = setTimeout(() => {
            onDismiss();
        }, 4000);

        return () => clearTimeout(timer);
    }, [id, onDismiss]);

    const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠',
        info: 'ℹ',
    };

    return (
        <div className={`notification notification-${type}`}>
            <div className="notification-icon">{icons[type]}</div>
            <div className="notification-message">{message}</div>
            <button className="notification-close" onClick={onDismiss}>
                ✕
            </button>
        </div>
    );
}
