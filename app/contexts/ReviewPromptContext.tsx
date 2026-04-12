import AsyncStorage from "@react-native-async-storage/async-storage";
let StoreReview: typeof import("expo-store-review") | null = null;
try {
  StoreReview = require("expo-store-review");
} catch {
  // Native module not available (e.g. Expo Go) — store review is disabled.
}
import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Message, useConnection } from "@/contexts/ConnectionContext";
import type { AIEvent } from "@/plugins/core/ai/types";
import { Linking, Platform } from "react-native";

const REVIEW_PROMPT_STORAGE_KEY = "@lunel_review_prompt";
const REVIEW_TRIGGER_PROBABILITY = 0.2;
const REVIEW_PROMPT_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 14;
const REVIEW_PROMPT_LIMIT = 3;
const IOS_APPLE_ID = "6759504065";
const IOS_WRITE_REVIEW_URL = `https://apps.apple.com/app/apple-store/id${IOS_APPLE_ID}?action=write-review`;

interface ReviewPromptStorage {
  promptCount: number;
  lastPromptedAt: number | null;
}

interface ReviewPromptContextType {
  showEditorReviewButton: boolean;
  requestEditorReview: () => Promise<void>;
}

const DEFAULT_REVIEW_PROMPT_STORAGE: ReviewPromptStorage = {
  promptCount: 0,
  lastPromptedAt: null,
};

const ReviewPromptContext = createContext<ReviewPromptContextType | undefined>(undefined);

function canOfferReviewPrompt(state: ReviewPromptStorage) {
  if (state.promptCount >= REVIEW_PROMPT_LIMIT) {
    return false;
  }

  if (state.lastPromptedAt == null) {
    return true;
  }

  return Date.now() - state.lastPromptedAt >= REVIEW_PROMPT_COOLDOWN_MS;
}

function getEventSessionId(event: AIEvent) {
  const properties = event.properties || {};
  const directSessionId = properties.sessionID ?? properties.sessionId;
  return typeof directSessionId === "string" && directSessionId.length > 0
    ? directSessionId
    : null;
}

function isStreamingEvent(event: AIEvent) {
  const status = event.properties?.status as Record<string, unknown> | string | undefined;
  const statusType = typeof status === "object" ? status?.type : status;
  const normalized = typeof statusType === "string" ? statusType.toLowerCase() : "";
  return normalized === "busy" || normalized === "running" || normalized === "working";
}

export function ReviewPromptProvider({ children }: { children: ReactNode }) {
  const { onDataEvent, status } = useConnection();
  const [isStoreReviewAvailable, setIsStoreReviewAvailable] = useState(false);
  const [isStorageReady, setIsStorageReady] = useState(false);
  const [selectedStreamingSessionId, setSelectedStreamingSessionId] = useState<string | null>(null);
  const [storageState, setStorageState] = useState<ReviewPromptStorage>(DEFAULT_REVIEW_PROMPT_STORAGE);
  const activeStreamingSessionIdsRef = useRef<Set<string>>(new Set());
  const selectedStreamingSessionIdRef = useRef<string | null>(null);
  const isStoreReviewAvailableRef = useRef(false);
  const isStorageReadyRef = useRef(false);
  const storageStateRef = useRef<ReviewPromptStorage>(DEFAULT_REVIEW_PROMPT_STORAGE);

  useEffect(() => {
    selectedStreamingSessionIdRef.current = selectedStreamingSessionId;
  }, [selectedStreamingSessionId]);

  useEffect(() => {
    isStoreReviewAvailableRef.current = isStoreReviewAvailable;
  }, [isStoreReviewAvailable]);

  useEffect(() => {
    isStorageReadyRef.current = isStorageReady;
  }, [isStorageReady]);

  useEffect(() => {
    storageStateRef.current = storageState;
  }, [storageState]);

  useEffect(() => {
    let isMounted = true;

    async function initialize() {
      try {
        const [savedState, hasAction] = await Promise.all([
          AsyncStorage.getItem(REVIEW_PROMPT_STORAGE_KEY),
          StoreReview?.hasAction().catch(() => false) ?? false,
        ]);

        if (!isMounted) {
          return;
        }

        if (savedState) {
          try {
            const parsed = JSON.parse(savedState) as Partial<ReviewPromptStorage>;
            const nextState = {
              promptCount: typeof parsed.promptCount === "number" ? parsed.promptCount : 0,
              lastPromptedAt: typeof parsed.lastPromptedAt === "number" ? parsed.lastPromptedAt : null,
            };
            storageStateRef.current = nextState;
            setStorageState(nextState);
          } catch {
            storageStateRef.current = DEFAULT_REVIEW_PROMPT_STORAGE;
            setStorageState(DEFAULT_REVIEW_PROMPT_STORAGE);
          }
        }

        setIsStoreReviewAvailable(Platform.OS === "ios" || hasAction);
      } finally {
        if (isMounted) {
          setIsStorageReady(true);
        }
      }
    }

    void initialize();

    return () => {
      isMounted = false;
    };
  }, []);

  const persistStorageState = useCallback(async (nextState: ReviewPromptStorage) => {
    storageStateRef.current = nextState;
    setStorageState(nextState);
    try {
      await AsyncStorage.setItem(REVIEW_PROMPT_STORAGE_KEY, JSON.stringify(nextState));
    } catch {
      // Ignore persistence failures; the prompt state still updates in memory.
    }
  }, []);

  const clearSelectedReviewPrompt = useCallback((sessionId?: string | null) => {
    setSelectedStreamingSessionId((current) => {
      if (sessionId && current !== sessionId) {
        return current;
      }
      return null;
    });
  }, []);

  const handleStreamingStart = useCallback((sessionId: string) => {
    const activeIds = activeStreamingSessionIdsRef.current;
    if (activeIds.has(sessionId)) {
      return;
    }

    activeIds.add(sessionId);

    if (!isStorageReadyRef.current || !isStoreReviewAvailableRef.current) {
      return;
    }

    if (selectedStreamingSessionIdRef.current) {
      return;
    }

    if (!canOfferReviewPrompt(storageStateRef.current)) {
      return;
    }

    if (Math.random() >= REVIEW_TRIGGER_PROBABILITY) {
      return;
    }

    setSelectedStreamingSessionId(sessionId);
  }, []);

  const handleStreamingStop = useCallback((sessionId: string | null) => {
    if (!sessionId) {
      return;
    }

    activeStreamingSessionIdsRef.current.delete(sessionId);
    clearSelectedReviewPrompt(sessionId);
  }, [clearSelectedReviewPrompt]);

  useEffect(() => {
    const unsubscribe = onDataEvent((message: Message) => {
      if (message.ns !== "ai" || message.action !== "event") {
        return;
      }

      const event = message.payload as unknown as AIEvent;
      const sessionId = getEventSessionId(event);

      if (event.type === "session.status" && sessionId) {
        if (isStreamingEvent(event)) {
          handleStreamingStart(sessionId);
        } else {
          handleStreamingStop(sessionId);
        }
        return;
      }

      if (event.type === "session.idle") {
        handleStreamingStop(sessionId);
      }
    });

    return unsubscribe;
  }, [clearSelectedReviewPrompt, handleStreamingStart, handleStreamingStop, onDataEvent]);

  useEffect(() => {
    if (status === "connected") {
      return;
    }

    activeStreamingSessionIdsRef.current.clear();
    setSelectedStreamingSessionId(null);
  }, [status]);

  const requestEditorReview = useCallback(async () => {
    if (!isStoreReviewAvailableRef.current) {
      return;
    }

    try {
      if (Platform.OS === "ios") {
        await Linking.openURL(IOS_WRITE_REVIEW_URL);
      } else {
        await StoreReview?.requestReview();
      }
      const nextState: ReviewPromptStorage = {
        promptCount: storageStateRef.current.promptCount + 1,
        lastPromptedAt: Date.now(),
      };
      await persistStorageState(nextState);
    } finally {
      clearSelectedReviewPrompt();
    }
  }, [clearSelectedReviewPrompt, persistStorageState]);

  const showEditorReviewButton = isStorageReady
    && isStoreReviewAvailable
    && selectedStreamingSessionId != null
    && activeStreamingSessionIdsRef.current.has(selectedStreamingSessionId);

  return (
    <ReviewPromptContext.Provider
      value={{
        showEditorReviewButton,
        requestEditorReview,
      }}
    >
      {children}
    </ReviewPromptContext.Provider>
  );
}

export function useReviewPrompt() {
  const context = useContext(ReviewPromptContext);
  if (!context) {
    throw new Error("useReviewPrompt must be used within a ReviewPromptProvider");
  }
  return context;
}
