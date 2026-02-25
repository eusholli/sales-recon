"use client";

import { useAuth, useUser, UserButton } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, Terminal, Loader2, AlertCircle } from "lucide-react";
import clsx from "clsx";

/* ── Typing indicator (three bouncing dots + optional status text) ── */
function TypingIndicator({ statusMessage }: { statusMessage?: string | null }) {
    return (
        <div className="flex flex-col max-w-[85%] self-start items-start">
            <div className="text-xs text-gray-500 mb-1 px-1 font-mono uppercase">Operator</div>
            <div className="rounded-lg px-4 py-3 shadow-md bg-gray-800 text-gray-200 rounded-bl-none border border-gray-700">
                {statusMessage ? (
                    <div className="flex items-center gap-2 text-sm">
                        <span className="typing-dot w-2 h-2 rounded-full bg-blue-400" style={{ animationDelay: "0ms" }} />
                        <span className="text-blue-300 font-mono text-xs">{statusMessage}</span>
                    </div>
                ) : (
                    <div className="flex items-center gap-1.5 h-5">
                        <span className="typing-dot w-2 h-2 rounded-full bg-gray-400" style={{ animationDelay: "0ms" }} />
                        <span className="typing-dot w-2 h-2 rounded-full bg-gray-400" style={{ animationDelay: "150ms" }} />
                        <span className="typing-dot w-2 h-2 rounded-full bg-gray-400" style={{ animationDelay: "300ms" }} />
                    </div>
                )}
            </div>
        </div>
    );
}

type Message = {
    role: "user" | "assistant" | "system";
    content: string;
    id: string;
};

export default function ChatInterface() {
    const { getToken } = useAuth();
    const { user } = useUser();
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isConnected, setIsConnected] = useState(false);
    const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, isWaitingForResponse]);

    // Connect to WebSocket
    useEffect(() => {
        let ws: WebSocket | null = null;
        let reconnectTimer: NodeJS.Timeout;

        const connect = async () => {
            try {
                const token = await getToken();
                if (!token) {
                    setError("Failed to get authentication token");
                    return;
                }

                // Use env var if set, otherwise fall back to deriving from current page URL
                const envWsUrl = process.env.NEXT_PUBLIC_WS_URL;
                let wsUrl: string;
                if (envWsUrl) {
                    wsUrl = `${envWsUrl}${envWsUrl.includes("?") ? "&" : "?"}token=${token}`;
                } else {
                    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
                    const host = window.location.hostname === "localhost"
                        ? "localhost:8080"
                        : window.location.host;
                    wsUrl = `${protocol}://${host}/?token=${token}`;
                }

                console.log("Connecting to:", wsUrl);
                ws = new WebSocket(wsUrl);

                ws.onopen = () => {
                    console.log("Connected to Chat Gateway");
                    setIsConnected(true);
                    setError(null);
                };

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);

                        // Load chat history from server on connect
                        if (data.type === "history") {
                            setMessages(data.messages.map((m: { role: string; content: string; timestamp?: number }) => ({
                                role: m.role as "user" | "assistant",
                                content: m.content,
                                id: String(m.timestamp || Date.now()),
                            })));
                        }

                        if (data.type === "chunk") {
                            setIsWaitingForResponse(false);
                            setStatusMessage(null);
                            setMessages((prev) => {
                                const lastMsg = prev[prev.length - 1];
                                if (lastMsg && lastMsg.role === "assistant") {
                                    return [
                                        ...prev.slice(0, -1),
                                        { ...lastMsg, content: lastMsg.content + data.content }
                                    ];
                                } else {
                                    return [...prev, { role: "assistant", content: data.content, id: Date.now().toString() }];
                                }
                            });
                        } else if (data.type === "status") {
                            setStatusMessage(data.content);
                        } else if (data.type === "thinking") {
                            // Show thinking as a dimmed inline message
                            setStatusMessage(null);
                            setMessages((prev) => {
                                const lastMsg = prev[prev.length - 1];
                                if (lastMsg && lastMsg.role === "system") {
                                    return [
                                        ...prev.slice(0, -1),
                                        { ...lastMsg, content: lastMsg.content + data.content }
                                    ];
                                } else {
                                    return [...prev, { role: "system", content: data.content, id: `thinking-${Date.now()}` }];
                                }
                            });
                        } else if (data.type === "tool") {
                            // Show tool invocation as a status message
                            const toolName = data.data?.name || data.data?.tool || "tool";
                            setStatusMessage(`Using ${toolName}…`);
                        } else if (data.type === "final") {
                            setIsWaitingForResponse(false);
                            setStatusMessage(null);
                        } else if (data.type === "user-message") {
                            setMessages((prev) => [
                                ...prev,
                                { role: "user", content: data.content, id: `broadcast-${Date.now()}` }
                            ]);
                            setIsWaitingForResponse(true);
                            setStatusMessage("Processing…");
                        } else if (data.type === "error") {
                            setError(data.message);
                            setIsWaitingForResponse(false);
                            setStatusMessage(null);
                        }
                    } catch (err) {
                        console.error("Failed to parse message:", err);
                    }
                };

                ws.onclose = () => {
                    console.log("Disconnected");
                    setIsConnected(false);
                    wsRef.current = null;
                    // Try to reconnect
                    reconnectTimer = setTimeout(connect, 3000);
                };

                ws.onerror = (err) => {
                    console.error("WebSocket Error:", err);
                    setError("Connection error");
                    ws?.close();
                };

                wsRef.current = ws;
            } catch (err) {
                console.error("Auth error:", err);
                setError("Authentication failed");
            }
        };

        connect();

        return () => {
            ws?.close();
            clearTimeout(reconnectTimer);
        };
    }, [getToken]);

    const handleSend = () => {
        if (!input.trim() || !wsRef.current || !isConnected) return;

        const userMsg: Message = { role: "user", content: input, id: Date.now().toString() };
        setMessages((prev) => [...prev, userMsg]);
        setIsWaitingForResponse(true);

        // Send to backend
        wsRef.current.send(JSON.stringify({
            type: "message",
            content: input
        }));

        setInput("");
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    return (
        <div className="flex flex-col h-screen max-w-4xl mx-auto bg-gray-900 text-gray-100 shadow-2xl border-x border-gray-800">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900/95 backdrop-blur z-10 sticky top-0">
                <div className="flex items-center gap-3">
                    <div className={clsx("w-3 h-3 rounded-full", isConnected ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse")} />
                    <div>
                        <h1 className="font-semibold text-white tracking-wide">OpenClaw Intelligence</h1>
                        <p className="text-xs text-gray-400 font-mono">
                            {isConnected ? "SYSTEM ONLINE" : "CONNECTING..."}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-400">
                        {user?.primaryEmailAddress?.emailAddress}
                    </span>
                    {/* UserButton for account management & logout */}
                    <UserButton />
                </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent">
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-gray-500 space-y-4 opacity-50">
                        <Terminal size={48} />
                        <p className="font-mono text-sm">Awaiting command input...</p>
                    </div>
                )}

                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={clsx(
                            "flex flex-col max-w-[85%]",
                            msg.role === "user" ? "self-end items-end" : "self-start items-start"
                        )}
                    >
                        <div className="text-xs text-gray-500 mb-1 px-1 font-mono uppercase">
                            {msg.role === "user" ? "You" : msg.role === "system" ? "Thinking" : "Operator"}
                        </div>
                        <div
                            className={clsx(
                                "rounded-lg px-4 py-3 shadow-md text-sm leading-relaxed",
                                msg.role === "user"
                                    ? "bg-blue-600 text-white rounded-br-none"
                                    : msg.role === "system"
                                        ? "bg-gray-800/50 text-gray-400 rounded-bl-none border border-gray-700/50 italic text-xs"
                                        : "bg-gray-800 text-gray-200 rounded-bl-none border border-gray-700"
                            )}
                        >
                            <div className="prose prose-invert prose-sm max-w-none break-words
                                prose-headings:text-gray-100 prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1
                                prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5
                                prose-blockquote:border-blue-500/50 prose-blockquote:text-gray-300
                                prose-a:text-blue-400 prose-a:underline prose-a:underline-offset-2
                                prose-strong:text-gray-100 prose-em:text-gray-200
                                prose-table:border-collapse prose-th:border prose-th:border-gray-700 prose-th:px-3 prose-th:py-1 prose-th:bg-gray-800
                                prose-td:border prose-td:border-gray-700 prose-td:px-3 prose-td:py-1
                                prose-hr:border-gray-700"
                            >
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        pre: ({ node, ...props }) => (
                                            <div className="bg-gray-950 rounded-lg p-3 my-2 overflow-x-auto border border-gray-700/60 text-[13px]" {...props as React.HTMLAttributes<HTMLDivElement>} />
                                        ),
                                        code: ({ node, className, children, ...props }) => {
                                            const isBlock = className?.startsWith("language-");
                                            if (isBlock) {
                                                return <code className={`${className ?? ""} font-mono text-[13px]`} {...props}>{children}</code>;
                                            }
                                            return <code className="bg-gray-700/50 rounded px-1.5 py-0.5 text-blue-200 font-mono text-xs" {...props}>{children}</code>;
                                        },
                                        a: ({ node, ...props }) => <a className="text-blue-400 hover:text-blue-300 underline underline-offset-2 transition-colors" target="_blank" rel="noopener noreferrer" {...props} />,
                                    }}
                                >
                                    {msg.content}
                                </ReactMarkdown>
                            </div>
                        </div>
                    </div>
                ))}

                {isWaitingForResponse && <TypingIndicator statusMessage={statusMessage} />}

                {error && (
                    <div className="flex items-center gap-2 p-3 bg-red-900/20 border border-red-900/50 rounded text-red-400 text-sm self-center">
                        <AlertCircle size={16} />
                        <span>{error}</span>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 bg-gray-900 border-t border-gray-800">
                <div className="relative flex items-end gap-2 bg-gray-800 border border-gray-700 rounded-xl p-2 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/50 transition-all shadow-lg">
                    <textarea
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Enter intelligence directive..."
                        className="w-full bg-transparent text-gray-100 placeholder-gray-500 text-sm px-3 py-2 focus:outline-none resize-none max-h-32 min-h-[44px] scrollbar-thin"
                        rows={1}
                        style={{ height: 'auto' }}
                        onInput={(e) => {
                            const target = e.target as HTMLTextAreaElement;
                            target.style.height = 'auto';
                            target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
                        }}
                    />
                    <button
                        onClick={handleSend}
                        disabled={!isConnected || !input.trim()}
                        className={clsx(
                            "p-2 rounded-lg transition-all mb-0.5",
                            !isConnected || !input.trim()
                                ? "bg-gray-700 text-gray-500 cursor-not-allowed"
                                : "bg-blue-600 text-white hover:bg-blue-500 hover:shadow-lg hover:shadow-blue-500/20 active:scale-95"
                        )}
                    >
                        {isConnected ? <Send size={18} /> : <Loader2 size={18} className="animate-spin" />}
                    </button>
                </div>
                <div className="text-center mt-2">
                    <p className="text-[10px] text-gray-600 font-mono">
                        SECURE CONNECTION • END-TO-END ENCRYPTED
                    </p>
                </div>
            </div>
        </div>
    );
}
