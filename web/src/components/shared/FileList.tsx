import { formatBytes } from '../../lib/utils';
import { Button } from '../ui/Button';
import './FileList.css';

interface FileListProps {
    files: File[];
    onRemove?: (index: number) => void;
    variant?: 'sender' | 'receiver';
}

export function FileList({ files, onRemove, variant = 'sender' }: FileListProps) {
    if (files.length === 0) {
        return (
            <div className="file-list-empty">
                <div className="empty-icon">📁</div>
                <p className="empty-text">
                    {variant === 'sender' ? 'No files selected' : 'No files incoming'}
                </p>
            </div>
        );
    }

    return (
        <div className="file-list">
            {files.map((file, index) => (
                <FileItem
                    key={`${file.name}-${index}`}
                    file={file}
                    onRemove={onRemove ? () => onRemove(index) : undefined}
                />
            ))}
        </div>
    );
}

interface FileItemProps {
    file: File;
    onRemove?: () => void;
}

function FileItem({ file, onRemove }: FileItemProps) {
    const getFileIcon = (fileName: string) => {
        const ext = fileName.split('.').pop()?.toLowerCase();

        const iconMap: Record<string, string> = {
            // Images
            jpg: '🖼',
            jpeg: '🖼',
            png: '🖼',
            gif: '🖼',
            svg: '🖼',
            webp: '🖼',

            // Videos
            mp4: '🎥',
            mov: '🎥',
            avi: '🎥',
            mkv: '🎥',
            webm: '🎥',

            // Audio
            mp3: '🎵',
            wav: '🎵',
            flac: '🎵',
            m4a: '🎵',

            // Documents
            pdf: '📄',
            doc: '📝',
            docx: '📝',
            txt: '📝',
            md: '📝',

            // Spreadsheets
            xls: '📊',
            xlsx: '📊',
            csv: '📊',

            // Presentations
            ppt: '📽',
            pptx: '📽',

            // Archives
            zip: '📦',
            rar: '📦',
            '7z': '📦',
            tar: '📦',
            gz: '📦',

            // Code
            js: '💻',
            ts: '💻',
            jsx: '💻',
            tsx: '💻',
            py: '💻',
            java: '💻',
            cpp: '💻',
            c: '💻',
            html: '💻',
            css: '💻',
            json: '💻',
        };

        return iconMap[ext || ''] || '📄';
    };

    return (
        <div className="file-item">
            <div className="file-icon">{getFileIcon(file.name)}</div>
            <div className="file-details">
                <div className="file-name" title={file.name}>
                    {file.name}
                </div>
                <div className="file-size mono">{formatBytes(file.size)}</div>
            </div>
            {onRemove && (
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onRemove}
                    className="file-remove"
                >
                    ✕
                </Button>
            )}
        </div>
    );
}
