import { ReactNode, HTMLAttributes } from 'react';
import './Card.css';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
    variant?: 'default' | 'elevated' | 'glow';
    padding?: 'sm' | 'md' | 'lg';
    children: ReactNode;
}

export function Card({
    variant = 'default',
    padding = 'md',
    children,
    className = '',
    ...props
}: CardProps) {
    const classes = [
        'card',
        `card-${variant}`,
        `card-padding-${padding}`,
        className,
    ]
        .filter(Boolean)
        .join(' ');

    return (
        <div className={classes} {...props}>
            <div className="card-content">{children}</div>
        </div>
    );
}
