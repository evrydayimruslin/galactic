import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type VoiceInputState = 'idle' | 'listening' | 'unsupported' | 'permission-denied' | 'error';

interface VoiceRecognitionAlternative {
  transcript: string;
}

interface VoiceRecognitionResult {
  isFinal: boolean;
  readonly [index: number]: VoiceRecognitionAlternative | undefined;
}

interface VoiceRecognitionResultList {
  length: number;
  readonly [index: number]: VoiceRecognitionResult | undefined;
}

interface VoiceRecognitionResultEvent {
  resultIndex: number;
  results: VoiceRecognitionResultList;
}

interface VoiceRecognitionErrorEvent {
  error?: string;
  message?: string;
}

interface VoiceRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: VoiceRecognitionResultEvent) => void) | null;
  onerror: ((event: VoiceRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type VoiceRecognitionConstructor = new () => VoiceRecognition;

type VoiceWindow = Window & {
  SpeechRecognition?: VoiceRecognitionConstructor;
  webkitSpeechRecognition?: VoiceRecognitionConstructor;
};

interface UseVoiceInputOptions {
  disabled?: boolean;
  lang?: string;
  onTranscript: (transcript: string) => void;
  onAfterTranscript?: () => void;
}

export interface VoiceInputController {
  supported: boolean;
  state: VoiceInputState;
  listening: boolean;
  interimTranscript: string;
  error: string | null;
  toggle: () => Promise<void>;
  stop: () => void;
}

export function getVoiceRecognitionConstructor(win: Window | undefined = typeof window === 'undefined' ? undefined : window): VoiceRecognitionConstructor | null {
  if (!win) return null;
  const voiceWindow = win as VoiceWindow;
  return voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition ?? null;
}

export function isVoiceInputSupported(win: Window | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  return !!getVoiceRecognitionConstructor(win);
}

export function appendVoiceTranscript(base: string, transcript: string): string {
  const clean = transcript.replace(/\s+/g, ' ').trim();
  if (!clean) return base;
  const prefix = base.trimEnd();
  if (!prefix) return clean;
  return /[\s\n]$/.test(base) ? `${base}${clean}` : `${prefix} ${clean}`;
}

function voiceErrorMessage(event: VoiceRecognitionErrorEvent): { state: VoiceInputState; message: string } {
  if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
    return {
      state: 'permission-denied',
      message: 'Microphone access was blocked.',
    };
  }
  if (event.error === 'no-speech') {
    return {
      state: 'idle',
      message: 'No speech was detected.',
    };
  }
  return {
    state: 'error',
    message: event.message || 'Voice input failed.',
  };
}

async function requestMicrophonePermission(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return true;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return true;
  } catch {
    return false;
  }
}

export function useVoiceInput({
  disabled = false,
  lang = 'en-US',
  onTranscript,
  onAfterTranscript,
}: UseVoiceInputOptions): VoiceInputController {
  const recognitionRef = useRef<VoiceRecognition | null>(null);
  const [state, setState] = useState<VoiceInputState>(() => (
    isVoiceInputSupported() ? 'idle' : 'unsupported'
  ));
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  useEffect(() => () => {
    recognitionRef.current?.abort();
  }, []);

  useEffect(() => {
    if (disabled) {
      stop();
    }
  }, [disabled, stop]);

  const start = useCallback(async () => {
    if (disabled) return;

    const Recognition = getVoiceRecognitionConstructor();
    if (!Recognition) {
      setState('unsupported');
      setError(null);
      return;
    }

    const allowed = await requestMicrophonePermission();
    if (!allowed) {
      setState('permission-denied');
      setError('Microphone access was blocked.');
      return;
    }

    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript ?? '';
        if (!transcript) continue;
        if (result?.isFinal) {
          finalText = appendVoiceTranscript(finalText, transcript);
        } else {
          interimText = appendVoiceTranscript(interimText, transcript);
        }
      }
      if (finalText) {
        onTranscript(finalText);
        onAfterTranscript?.();
      }
      setInterimTranscript(interimText);
    };
    recognition.onerror = (event) => {
      const next = voiceErrorMessage(event);
      setState(next.state);
      setError(next.message);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setInterimTranscript('');
      setState((current) => current === 'listening' ? 'idle' : current);
    };

    try {
      recognition.start();
      setError(null);
      setInterimTranscript('');
      setState('listening');
    } catch (err) {
      recognitionRef.current = null;
      setState('error');
      setError(err instanceof Error ? err.message : 'Voice input failed.');
    }
  }, [disabled, lang, onAfterTranscript, onTranscript]);

  const toggle = useCallback(async () => {
    if (state === 'listening') {
      stop();
      return;
    }
    await start();
  }, [start, state, stop]);

  return useMemo(() => ({
    supported: state !== 'unsupported',
    state,
    listening: state === 'listening',
    interimTranscript,
    error,
    toggle,
    stop,
  }), [error, interimTranscript, state, stop, toggle]);
}
