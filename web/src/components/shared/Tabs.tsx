import { ReactNode } from 'react';
import './Tabs.css';

interface TabsProps {
    activeTab: string;
    onTabChange: (tab: string) => void;
    tabs: Array<{
        id: string;
        label: string;
        icon?: string;
        badge?: number;
    }>;
}

export function Tabs({ activeTab, onTabChange, tabs }: TabsProps) {
    return (
        <div className="tabs">
            {tabs.map((tab) => (
                <button
                    key={tab.id}
                    className={`tab ${activeTab === tab.id ? 'tab-active' : ''}`}
                    onClick={() => onTabChange(tab.id)}
                >
                    {tab.icon && <span className="tab-icon">{tab.icon}</span>}
                    <span className="tab-label">{tab.label}</span>
                    {tab.badge !== undefined && tab.badge > 0 && (
                        <span className="tab-badge">{tab.badge}</span>
                    )}
                </button>
            ))}
        </div>
    );
}

interface TabPanelProps {
    children: ReactNode;
    className?: string;
}

export function TabPanel({ children, className = '' }: TabPanelProps) {
    return (
        <div className={`tab-panel ${className}`}>
            {children}
        </div>
    );
}
