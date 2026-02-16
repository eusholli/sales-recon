import { useState, useEffect, useCallback, useRef } from 'react';

export type EntityType = 'company' | 'person' | 'event';

interface UseOpenClawOptions {
    gatewayUrl?: string;
    entityType: EntityType;
    entityName: string;
    onReportUpdate?: (report: string) => void;
}

interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

interface UseOpenClawReturn {
    isConnected: boolean;
    messages: Message[];
    sendMessage: (content: string) => void;
    requestReport: () => void;
    updateReport: () => void;
    report: string | null;
    isLoading: boolean;
}

export function useOpenClaw({
    gatewayUrl = 'ws://ws-proxy.localhost', // Default to proxy via Traefik (port 80)
    entityType,
    entityName,
    onReportUpdate,
}: UseOpenClawOptions): UseOpenClawReturn {
    const [isConnected, setIsConnected] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [report, setReport] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const wsRef = useRef<WebSocket | null>(null);
    const pendingRef = useRef<'report' | null>(null);
    const currentResponseRef = useRef<string>('');

    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) return;

        // Connect primarily to the proxy, no token needed here
        const ws = new WebSocket(gatewayUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('[useOpenClaw] Connected to proxy');
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                console.log('[useOpenClaw] Received:', data);

                // 1. Connection confirmation
                if (data.type === 'connected') {
                    setIsConnected(true);
                    setMessages((prev) => [
                        ...prev,
                        { role: 'system', content: 'Connected to intelligence agent' },
                    ]);
                }

                // 2. Streaming chunk
                if (data.type === 'chunk') {
                    // Update ref for immediate access to full content
                    setMessages((prev) => {
                        const last = prev[prev.length - 1];
                        if (last?.role === 'assistant') {
                            currentResponseRef.current += data.content;
                            return [
                                ...prev.slice(0, -1),
                                { ...last, content: last.content + data.content },
                            ];
                        }
                        // New assistant message starting
                        currentResponseRef.current = data.content;
                        return [...prev, { role: 'assistant', content: data.content }];
                    });
                }

                // 3. Final message (stream complete)
                if (data.type === 'final') {
                    setIsLoading(false);

                    // Check if this was a report request
                    if (pendingRef.current === 'report') {
                        const finalContent = currentResponseRef.current;
                        setReport(finalContent);
                        onReportUpdate?.(finalContent);
                        pendingRef.current = null;

                        // Clear the specific report request flag, but we might want to keep the content in chat
                        console.log('[useOpenClaw] Report updated from stream');
                    }
                }

                // 4. Error
                if (data.type === 'error') {
                    setMessages((prev) => [
                        ...prev,
                        { role: 'system', content: `Error: ${data.message}` },
                    ]);
                    setIsLoading(false);
                }

            } catch (e) {
                console.error('[useOpenClaw] Parse error:', e);
            }
        };

        ws.onerror = (error) => {
            console.error('[useOpenClaw] WebSocket error:', error);
            // Don't modify state here to avoid potential loops if error persists
            // Just log it. The onclose will handle state cleanup.
        };

        ws.onclose = (event) => {
            console.log(`[useOpenClaw] Closed: ${event.code} - ${event.reason}`);
            setIsConnected(false);
            setMessages((prev) => [
                ...prev,
                { role: 'system', content: 'Connection closed.' },
            ]);
            wsRef.current = null;
        };
    }, [gatewayUrl, onReportUpdate]);

    const sendMessage = useCallback((message: string) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            // Optimistically update UI even if reconnecting
            setMessages((prev) => [...prev, { role: 'user', content: message }]);
            console.warn('[useOpenClaw] Cannot send, socket not open');
            return;
        }

        setMessages((prev) => [...prev, { role: 'user', content: message }]);
        setIsLoading(true);
        currentResponseRef.current = ''; // Reset for new turn

        const payload = {
            type: 'message',
            content: message,
            entityType,
            entityName
        };

        wsRef.current.send(JSON.stringify(payload));
    }, [entityType, entityName]);

    const requestReport = useCallback(() => {
        pendingRef.current = 'report';
        sendMessage(`Get the current intelligence report for ${entityType} "${entityName}"`);
    }, [sendMessage, entityType, entityName]);

    const updateReport = useCallback(() => {
        pendingRef.current = 'report';
        sendMessage(`Generate an updated intelligence report for ${entityType} "${entityName}"`);
    }, [sendMessage, entityType, entityName]);

    useEffect(() => {
        connect();
        return () => {
            // Only close if we are unmounting or gatewayUrl changes
            if (wsRef.current) {
                console.log('[useOpenClaw] Cleaning up socket');
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [connect]);

    return {
        isConnected,
        messages,
        sendMessage,
        requestReport,
        updateReport,
        report,
        isLoading,
    };
}
