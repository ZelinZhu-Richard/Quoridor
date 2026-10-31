import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RULESET,
  commandSchema,
  serverMessageSchema,
  type Command,
  type OnlineAction,
  type Snapshot,
} from '../shared/protocol';
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.message ?? 'Could not reach the game service. Try again.',
    );
  return data;
}
function wsUrl(path: string) {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api${path}`;
}
function loadPending(key: string): Command | null {
  try {
    const parsed = commandSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function savePending(key: string, command: Command | null) {
  try {
    if (command) sessionStorage.setItem(key, JSON.stringify(command));
    else sessionStorage.removeItem(key);
  } catch {
    /* Retry still works during this page lifetime. */
  }
}
export function useRoom(code: string | null, name: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [connected, setConnected] = useState(false);
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [replaced, setReplaced] = useState(false);
  const socket = useRef<WebSocket | null>(null),
    latest = useRef<Snapshot | null>(null),
    pendingRef = useRef<Command | null>(null);
  useEffect(() => {
    setSnapshot(null);
    latest.current = null;
    setConnected(false);
    setError('');
    setReplaced(false);
    if (!code) return;
    let disposed = false,
      stop = false,
      attempts = 0,
      retry: ReturnType<typeof setTimeout>,
      heartbeat: ReturnType<typeof setInterval>;
    const key = `linebreak.pending.${code}`;
    pendingRef.current = loadPending(key);
    setPending(!!pendingRef.current);
    const connect = async () => {
      try {
        await api('/session', { name });
        await api(`/rooms/${code}/join`);
        if (disposed) return;
        const ws = new WebSocket(wsUrl(`/rooms/${code}/ws`));
        socket.current = ws;
        let lastPong = Date.now();
        ws.onopen = () => {
          attempts = 0;
          setConnected(true);
          setError('');
          heartbeat = setInterval(() => {
            if (Date.now() - lastPong > 65000) ws.close();
            else if (ws.readyState === WebSocket.OPEN) ws.send('ping');
          }, 20000);
        };
        ws.onmessage = (event) => {
          if (event.data === 'pong') {
            lastPong = Date.now();
            return;
          }
          let parsed;
          try {
            parsed = serverMessageSchema.safeParse(JSON.parse(event.data));
          } catch {
            return;
          }
          if (!parsed.success) {
            setError('This version of Linebreak needs a refresh.');
            return;
          }
          const message = parsed.data;
          if (message.type === 'STATE') {
            latest.current = message.state;
            setSnapshot(message.state);
            const p = pendingRef.current;
            if (p) {
              if (p.roundId === message.state.roundId) ws.send(JSON.stringify(p));
              else {
                pendingRef.current = null;
                savePending(key, null);
                setPending(false);
              }
            }
          }
          if (message.type === 'ACK' && message.actionId === pendingRef.current?.actionId) {
            pendingRef.current = null;
            savePending(key, null);
            setPending(false);
          }
          if (message.type === 'ERROR') {
            setError(message.message);
            if (
              message.actionId === pendingRef.current?.actionId ||
              ['BAD_ACTION', 'BAD_MESSAGE', 'RATE_LIMITED'].includes(message.code)
            ) {
              pendingRef.current = null;
              savePending(key, null);
              setPending(false);
            }
          }
          if (message.type === 'REPLACED') {
            stop = true;
            setReplaced(true);
            setError('This seat is open in another tab. Close that tab and reload here to return.');
          }
        };
        ws.onclose = () => {
          clearInterval(heartbeat);
          setConnected(false);
          if (!disposed && !stop)
            retry = setTimeout(
              connect,
              Math.min(10000, 500 * 2 ** attempts++) + Math.random() * 300,
            );
        };
        ws.onerror = () => setError('Connection interrupted. Reconnecting…');
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : 'Unable to join.');
          if (!(e instanceof ApiError) || e.status === 429 || e.status >= 500)
            retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** attempts++));
        }
      }
    };
    void connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      socket.current?.close();
      socket.current = null;
    };
  }, [code, name]);
  const send = useCallback((action: OnlineAction) => {
    const state = latest.current,
      ws = socket.current;
    if (!state || !ws || ws.readyState !== WebSocket.OPEN || pendingRef.current) return;
    const command: Command = {
      actionId: crypto.randomUUID(),
      roundId: state.roundId,
      expectedVersion: state.version,
      action,
    };
    pendingRef.current = command;
    savePending(`linebreak.pending.${state.code}`, command);
    setPending(true);
    setError('');
    ws.send(JSON.stringify(command));
  }, []);
  return { snapshot, connected, pending, error, setError, send, replaced };
}
export function useMatchmaking(
  active: boolean,
  name: string,
  onMatch: (code: string) => void,
  onCancel: () => void,
) {
  const [status, setStatus] = useState('Connecting…'),
    [error, setError] = useState('');
  const socket = useRef<WebSocket | null>(null),
    cancelling = useRef(false);
  useEffect(() => {
    if (!active) return;
    let disposed = false,
      attempts = 0,
      done = false,
      retry: ReturnType<typeof setTimeout>,
      heartbeat: ReturnType<typeof setInterval>;
    cancelling.current = false;
    setError('');
    const connect = async () => {
      try {
        await api('/session', { name });
        if (disposed) return;
        const ws = new WebSocket(wsUrl('/matchmaking/ws'));
        socket.current = ws;
        let lastPong = Date.now();
        ws.onopen = () => {
          attempts = 0;
          setError('');
          ws.send(
            JSON.stringify(
              cancelling.current ? { type: 'CANCEL' } : { type: 'JOIN', ruleset: RULESET },
            ),
          );
          heartbeat = setInterval(() => {
            if (Date.now() - lastPong > 65000) ws.close();
            else if (ws.readyState === WebSocket.OPEN) ws.send('ping');
          }, 20000);
        };
        ws.onmessage = (event) => {
          if (event.data === 'pong') {
            lastPong = Date.now();
            return;
          }
          let result;
          try {
            result = serverMessageSchema.safeParse(JSON.parse(event.data));
          } catch {
            return;
          }
          if (!result.success) {
            setError('Please refresh to update Linebreak.');
            return;
          }
          const m = result.data;
          if (m.type === 'QUEUED') setStatus('Looking for your opponent');
          if (m.type === 'MATCHED') {
            done = true;
            onMatch(m.code);
          }
          if (m.type === 'CANCELLED') {
            done = true;
            onCancel();
          }
          if (m.type === 'ERROR') setError(m.message);
          if (m.type === 'REPLACED') {
            done = true;
            setError('Matchmaking is open in another tab.');
          }
        };
        ws.onclose = () => {
          clearInterval(heartbeat);
          if (!disposed && !done) {
            setStatus('Reconnecting…');
            retry = setTimeout(connect, Math.min(10000, 500 * 2 ** attempts++));
          }
        };
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : 'Could not connect.');
          retry = setTimeout(connect, 3000);
        }
      }
    };
    void connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      socket.current?.close();
      socket.current = null;
    };
  }, [active, name, onMatch, onCancel]);
  const cancel = () => {
    cancelling.current = true;
    setStatus('Cancelling…');
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify({ type: 'CANCEL' }));
  };
  return { status, error, cancel };
}
