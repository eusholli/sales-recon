'use client';

import { useState } from 'react';
import '../globals.css';

interface EntityCardProps {
    type: 'company' | 'event' | 'person';
    defaultName: string;
    subtitle: string;
    onGetIntelligence: (name: string) => void;
}

const icons: Record<string, string> = {
    company: '🏢',
    event: '📅',
    person: '👤',
};

export default function EntityCard({
    type,
    defaultName,
    subtitle,
    onGetIntelligence,
}: EntityCardProps) {
    const [name, setName] = useState(defaultName);
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(name);

    const handleNameClick = () => {
        setEditValue(name);
        setIsEditing(true);
    };

    const handleNameSave = () => {
        if (editValue.trim()) {
            setName(editValue.trim());
        }
        setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleNameSave();
        } else if (e.key === 'Escape') {
            setIsEditing(false);
        }
    };

    return (
        <div className="entityCard">
            <div className="cardHeader">
                <div className="cardIcon">{icons[type]}</div>
                <div className="cardInfo">
                    <div className="cardType">{type}</div>
                    {isEditing ? (
                        <input
                            type="text"
                            className="cardNameInput"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleNameSave}
                            onKeyDown={handleKeyDown}
                            autoFocus
                        />
                    ) : (
                        <div
                            className="cardName"
                            onClick={handleNameClick}
                            title="Click to edit"
                            style={{ cursor: 'pointer' }}
                        >
                            {name}
                        </div>
                    )}
                </div>
            </div>
            <div className="cardSubtitle">{subtitle}</div>
            <button
                className="cardButton"
                onClick={() => onGetIntelligence(name)}
            >
                Get Intelligence
            </button>
        </div>
    );
}
