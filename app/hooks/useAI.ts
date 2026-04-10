import { useCallback, useEffect, useRef } from 'react';
import { useConnection, Message } from '../contexts/ConnectionContext';
import type { AiBackend, AIEvent, AISession, AIMessage, AIAgent, AIProvider, ModelRef, PermissionResponse, AIFileAttachment, CodexPromptOptions, AIConfigDefaults } from '../plugins/core/ai/types';

export interface AIEvents {
  onEvent?: (event: AIEvent) => void;
}

export function useAI(events?: AIEvents) {
  const { sendControl, sendData, onDataEvent, status } = useConnection();
  const eventsRef = useRef(events);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  // Listen for AI events from data channel
  useEffect(() => {
    const unsubscribe = onDataEvent((message: Message) => {
      if (message.ns !== 'ai' || message.action !== 'event') return;
      if (eventsRef.current?.onEvent) {
        eventsRef.current.onEvent(message.payload as unknown as AIEvent);
      }
    });

    return unsubscribe;
  }, [onDataEvent]);

  const isConnected = status === 'connected';

  // Available backends
  const getBackends = useCallback(async (): Promise<AiBackend[]> => {
    const response = await sendControl('ai', 'backends');
    if (!response.ok) throw new Error(response.error?.message || 'Failed to get backends');
    return response.payload.backends as AiBackend[];
  }, [sendControl]);

  // Session management
  const createSession = useCallback(async (title?: string, backend: AiBackend = 'opencode'): Promise<AISession> => {
    const response = await sendControl('ai', 'createSession', { title, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to create session');
    return { ...(response.payload.session as AISession), backend };
  }, [sendControl]);

  const listSessions = useCallback(async (): Promise<AISession[]> => {
    // Use data channel — session lists can exceed the 64KB control channel limit
    const response = await sendData('ai', 'listSessions');
    if (!response.ok) throw new Error(response.error?.message || 'Failed to list sessions');
    return response.payload.sessions as AISession[];
  }, [sendData]);

  const getSession = useCallback(async (id: string, backend: AiBackend = 'opencode'): Promise<AISession> => {
    const response = await sendControl('ai', 'getSession', { id, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to get session');
    return response.payload.session as AISession;
  }, [sendControl]);

  const deleteSession = useCallback(async (id: string, backend: AiBackend = 'opencode'): Promise<boolean> => {
    const response = await sendControl('ai', 'deleteSession', { id, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to delete session');
    return response.payload.deleted !== false;
  }, [sendControl]);

  const getMessages = useCallback(async (sessionId: string, backend: AiBackend = 'opencode'): Promise<AIMessage[]> => {
    // Use data channel — message payloads can exceed the 64KB control channel limit
    const response = await sendData('ai', 'getMessages', { id: sessionId, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to get messages');
    return response.payload.messages as AIMessage[];
  }, [sendData]);

  // Prompting
  const sendPrompt = useCallback(async (
    sessionId: string,
    text: string,
    model?: ModelRef,
    agent?: string,
    backend: AiBackend = 'opencode',
    files?: AIFileAttachment[],
    codexOptions?: CodexPromptOptions,
  ): Promise<void> => {
    const response = await sendData('ai', 'prompt', { sessionId, text, model, agent, backend, files, codexOptions });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to send prompt');
  }, [sendData]);

  const abort = useCallback(async (sessionId: string, backend: AiBackend = 'opencode'): Promise<void> => {
    const response = await sendControl('ai', 'abort', { sessionId, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to abort');
  }, [sendControl]);

  // Configuration
  const getAgents = useCallback(async (backend: AiBackend = 'opencode'): Promise<AIAgent[]> => {
    const response = await sendControl('ai', 'agents', { backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to get agents');
    return response.payload.agents as AIAgent[];
  }, [sendControl]);

  const getCommands = useCallback(async (backend: AiBackend = 'opencode'): Promise<{ id: string; name: string; description?: string }[]> => {
    try {
      const response = await sendControl('ai', 'commands', { backend });
      if (!response.ok) return [];
      return (response.payload.commands as { id: string; name: string; description?: string }[]) || [];
    } catch {
      return [];
    }
  }, [sendControl]);

  const getProviders = useCallback(async (backend: AiBackend = 'opencode'): Promise<{ providers: AIProvider[]; defaults: Record<string, string>; configDefaults?: AIConfigDefaults }> => {
    const response = await sendControl('ai', 'providers', { backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to get providers');
    return {
      providers: response.payload.providers as AIProvider[],
      defaults: (response.payload.default as Record<string, string>) || {},
      configDefaults: response.payload.configDefaults as AIConfigDefaults | undefined,
    };
  }, [sendControl]);

  const setAuth = useCallback(async (providerId: string, key: string, backend: AiBackend = 'opencode'): Promise<void> => {
    const response = await sendControl('ai', 'setAuth', { providerId, key, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to set auth');
  }, [sendControl]);

  // Commands
  const runCommand = useCallback(async (sessionId: string, command: string, backend: AiBackend = 'opencode'): Promise<unknown> => {
    const response = await sendControl('ai', 'command', { sessionId, command, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to run command');
    return response.payload.result;
  }, [sendControl]);

  const revert = useCallback(async (sessionId: string, messageId: string, backend: AiBackend = 'opencode'): Promise<void> => {
    const response = await sendControl('ai', 'revert', { sessionId, messageId, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to revert');
  }, [sendControl]);

  const unrevert = useCallback(async (sessionId: string, backend: AiBackend = 'opencode'): Promise<void> => {
    const response = await sendControl('ai', 'unrevert', { sessionId, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to unrevert');
  }, [sendControl]);

  const share = useCallback(async (sessionId: string, backend: AiBackend = 'opencode'): Promise<{ url: string }> => {
    const response = await sendControl('ai', 'share', { sessionId, backend });
    if (!response.ok) throw new Error(response.error?.message || 'Failed to share');
    return response.payload.share as { url: string };
  }, [sendControl]);

  // Permissions
  const replyPermission = useCallback(async (sessionId: string, permissionId: string, response: PermissionResponse, backend: AiBackend = 'opencode'): Promise<void> => {
    const res = await sendControl('ai', 'permission', { sessionId, permissionId, response, backend });
    if (!res.ok) throw new Error(res.error?.message || 'Failed to reply permission');
  }, [sendControl]);

  const replyQuestion = useCallback(async (sessionId: string, questionId: string, answers: string[][], backend: AiBackend = 'opencode'): Promise<void> => {
    const res = await sendControl('ai', 'questionReply', { sessionId, questionId, answers, backend });
    if (!res.ok) throw new Error(res.error?.message || 'Failed to reply question');
  }, [sendControl]);

  const rejectQuestion = useCallback(async (sessionId: string, questionId: string, backend: AiBackend = 'opencode'): Promise<void> => {
    const res = await sendControl('ai', 'questionReject', { sessionId, questionId, backend });
    if (!res.ok) throw new Error(res.error?.message || 'Failed to reject question');
  }, [sendControl]);

  return {
    isConnected,
    getBackends,
    createSession,
    listSessions,
    getSession,
    deleteSession,
    getMessages,
    sendPrompt,
    abort,
    getAgents,
    getCommands,
    getProviders,
    setAuth,
    runCommand,
    revert,
    unrevert,
    share,
    replyPermission,
    replyQuestion,
    rejectQuestion,
  };
}
