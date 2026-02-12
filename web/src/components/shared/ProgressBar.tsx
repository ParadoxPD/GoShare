import { formatBytes, formatSpeed, estimateTimeRemaining } from '../../lib/utils';
import './ProgressBar.css';

interface ProgressBarProps {
    fileName: string;
    progress: number;
    speed?: number;
    totalSize: number;
    status: 'pending' | 'transferring' | 'complete' | 'error' | 'paused';
    error?: string;
}

export function ProgressBar({
    fileName,
    progress,
    speed = 0,
    totalSize,
    status,
    error,
}: ProgressBarProps) {
    const transferredBytes = (progress / 100) * totalSize;
    const eta = speed > 0 ? estimateTimeRemaining(totalSize, transferredBytes, speed) : null;

    const statusIcons = {
        pending: '⏳',
        transferring: '⚡',
        complete: '✓',
        error: '✕',
        paused: '⏸',
    };

    const statusColors = {
        pending: 'var(--text-tertiary)',
        transferring: 'var(--accent-primary)',
        complete: 'var(--accent-success)',
        error: 'var(--accent-error)',
        paused: 'var(--accent-warning)',
    };

    return (
        <div className={`progress-bar-container status-${status}`}>
            <div className="progress-header">
                <div className="progress-info">
                    <span className="progress-icon">{statusIcons[status]}</span>
                    <span className="progress-filename" title={fileName}>
                        {fileName}
                    </span>
                </div>
                <div className="progress-stats">
                    <span className="progress-percentage mono">{Math.round(progress)}%</span>
                </div>
            </div>

            <div className="progress-track">
                <div
                    className="progress-fill"
                    style={{
                        width: `${progress}%`,
                        background: status === 'complete' ? 'var(--gradient-success)' : 'var(--gradient-data)',
                    }}
                >
                    {status === 'transferring' && <div className="progress-shimmer" />}
                </div>
            </div>

            <div className="progress-footer">
                <div className="progress-size">
                    <span className="mono">
                        {formatBytes(transferredBytes)} / {formatBytes(totalSize)}
                    </span>
                </div>
                {status === 'transferring' && speed > 0 && (
                    <div className="progress-speed">
                        <span className="mono">{formatSpeed(speed)}</span>
                        {eta && <span className="progress-eta text-secondary"> • {eta}</span>}
                    </div>
                )}
                {status === 'error' && error && (
                    <div className="progress-error">
                        <span>{error}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
