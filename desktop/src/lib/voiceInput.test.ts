import { describe, expect, it } from 'vitest';
import {
  appendVoiceTranscript,
  getVoiceRecognitionConstructor,
  isVoiceInputSupported,
} from './voiceInput';

describe('voice input helpers', () => {
  it('appends final transcripts into the same composer draft text', () => {
    expect(appendVoiceTranscript('', '  open the latest lesson  ')).toBe('open the latest lesson');
    expect(appendVoiceTranscript('Search lessons for', ' calculus ')).toBe('Search lessons for calculus');
    expect(appendVoiceTranscript('Use action. ', 'Then summarize')).toBe('Use action. Then summarize');
    expect(appendVoiceTranscript('Keep this', '   ')).toBe('Keep this');
  });

  it('detects browser speech recognition constructors without requiring them globally', () => {
    class FakeRecognition {}
    const win = {
      webkitSpeechRecognition: FakeRecognition,
    } as unknown as Window;

    expect(getVoiceRecognitionConstructor(win)).toBe(FakeRecognition);
    expect(isVoiceInputSupported(win)).toBe(true);
    expect(isVoiceInputSupported(undefined)).toBe(false);
  });
});
