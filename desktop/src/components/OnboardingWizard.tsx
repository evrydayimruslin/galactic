// OnboardingWizard — 4-screen post-auth tutorial with hero layouts.
// Each screen highlights a corresponding sidebar section via the onHighlight callback.
// Sidebar remains interactive — clicking nav items dismisses the tutorial.

import { useState, useCallback } from 'react';

export type OnboardingHighlight = 'none' | 'tools' | 'chat-command' | 'agents';

interface OnboardingWizardProps {
  onComplete: (navigateTo?: 'chat' | 'tools') => void;
  onHighlight: (highlight: OnboardingHighlight) => void;
}

const SCREENS = ['welcome', 'apps', 'ways', 'build'] as const;
const GPU_SUPPORT_ENABLED = import.meta.env.VITE_UL_GPU_SUPPORT_ENABLED === 'true';

export default function OnboardingWizard({ onComplete, onHighlight }: OnboardingWizardProps) {
  const [step, setStep] = useState(0);

  const goTo = useCallback((n: number) => {
    setStep(n);
    const highlights: OnboardingHighlight[] = ['none', 'tools', 'chat-command', 'agents'];
    onHighlight(highlights[n] || 'none');
  }, [onHighlight]);

  const skip = useCallback(() => {
    onHighlight('none');
    onComplete();
  }, [onComplete, onHighlight]);

  return (
    <div className="absolute inset-0 z-40 bg-white flex flex-col">
      {/* Draggable title bar region */}
      <div className="h-7 flex-shrink-0" data-tauri-drag-region />

      {/* Scrollable content area */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 overflow-y-auto" style={{ marginTop: '-5%' }}>

        {/* ── Screen 1: Welcome ── */}
        {step === 0 && (
          <div className="text-center max-w-lg">
            <div className="w-14 h-14 bg-ul-text rounded-2xl mx-auto mb-7 flex items-center justify-center">
              <span className="text-white font-bold text-xl">U</span>
            </div>
            <h1 className="text-h1 text-ul-text">Welcome to Ultralight</h1>
            <p className="text-body-lg text-ul-text-secondary mt-4 leading-relaxed">
              An AI platform where every app works with chat — and anyone can build, share, and sell apps.
            </p>
          </div>
        )}

        {/* ── Screen 2: Featured Apps → highlights Tools ── */}
        {step === 1 && (
          <div className="text-center w-full max-w-2xl">
            <p className="text-caption text-emerald-600 tracking-widest uppercase mb-3">Pre-installed</p>
            <h1 className="text-h1 text-ul-text">Your apps are ready</h1>
            <p className="text-body-lg text-ul-text-secondary mt-3">
              Start using them in chat right away.
            </p>

            <div className="grid grid-cols-3 gap-5 mt-10">
              {[
                { emoji: '\u2709\uFE0F', name: 'Email Ops', desc: 'AI email assistant with approval workflows' },
                { emoji: '\uD83C\uDF93', name: 'Private Tutor', desc: 'AI quizzes that find your weak spots and teach you' },
                { emoji: '\uD83C\uDF73', name: 'Recipe Box', desc: 'Generate recipes from what\'s in your fridge' },
              ].map(app => (
                <div key={app.name} className="bg-ul-bg-raised rounded-2xl p-8 text-center">
                  <div className="text-5xl mb-4">{app.emoji}</div>
                  <div className="text-h3 text-ul-text">{app.name}</div>
                  <div className="text-small text-ul-text-muted mt-2 leading-relaxed">{app.desc}</div>
                </div>
              ))}
            </div>

            <p className="text-body text-ul-text-muted mt-6">
              + <span className="text-ul-text-secondary font-medium">Memory Wiki</span>,{' '}
              <span className="text-ul-text-secondary font-medium">Smart Budget</span>,{' '}
              <span className="text-ul-text-secondary font-medium">Reading List</span>{' '}
              and 15 more in Tools
            </p>
          </div>
        )}

        {/* ── Screen 3: Chat + Command → highlights both ── */}
        {step === 2 && (
          <div className="text-center w-full max-w-2xl">
            <p className="text-caption text-emerald-600 tracking-widest uppercase mb-3">How it works</p>
            <h1 className="text-h1 text-ul-text">Two ways to work</h1>
            <p className="text-body-lg text-ul-text-secondary mt-3">
              Use your apps through conversation or a live dashboard.
            </p>

            <div className="grid grid-cols-2 gap-6 mt-10 text-left">
              <div className="bg-ul-bg-raised rounded-2xl p-8">
                <div className="text-4xl mb-5">⚙️</div>
                <div className="text-h3 text-ul-text">Command</div>
                <div className="text-body text-ul-text-secondary mt-3 leading-relaxed">
                  Your app dashboard. Live widgets, approval queues, and activity from everything running in the background.
                </div>
              </div>
              <div className="bg-ul-bg-raised rounded-2xl p-8">
                <div className="text-4xl mb-5">💬</div>
                <div className="text-h3 text-ul-text">Chat</div>
                <div className="text-body text-ul-text-secondary mt-3 leading-relaxed">
                  Talk to AI with all your apps connected. Ask it to use any tool — quiz me, draft an email, track a recipe.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Screen 4: Build + Earn → highlights Tool Dealer + Tool Maker ── */}
        {step === 3 && (
          <div className="text-center w-full max-w-2xl">
            <p className="text-caption text-emerald-600 tracking-widest uppercase mb-3">For builders</p>
            <h1 className="text-h1 text-ul-text">Build and earn</h1>
            <p className="text-body-lg text-ul-text-secondary mt-3">
              Every app gets hosting, database, auth, and payments automatically. Just write the logic.
            </p>

            <div className="grid grid-cols-3 gap-5 mt-10 text-left">
              {[
                { emoji: '🔧', title: 'Tool Maker', subtitle: 'builds it for you', desc: 'Describe what you want — it builds, tests, and deploys your app in one conversation.' },
                { emoji: '🏫', title: 'Tool Dealer', subtitle: 'gets it listed', desc: 'Publish to the marketplace, set your price. Earn real payouts via Stripe.' },
                GPU_SUPPORT_ENABLED
                  ? { emoji: '⚡', title: 'GPU Runtimes', subtitle: 'when you need them', desc: 'Deploy compute-heavy functions on GPU infrastructure.' }
                  : { emoji: '📊', title: 'Live Dashboards', subtitle: 'included by default', desc: 'Give every app a focused interface for reviewing results and taking action.' },
              ].map((f, i) => (
                <div key={i} className="bg-ul-bg-raised rounded-2xl p-7">
                  <div className="text-3xl mb-4">{f.emoji}</div>
                  <div className="text-body font-semibold text-ul-text">{f.title}</div>
                  <div className="text-small text-ul-text-muted">{f.subtitle}</div>
                  <div className="text-small text-ul-text-secondary mt-3 leading-relaxed">{f.desc}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Fixed bottom nav: buttons + dots + skip ── */}
      <div className="flex-shrink-0 pb-8 pt-6 flex flex-col items-center gap-5">
        {/* Nav buttons */}
        <div className="flex gap-3">
          {step === 0 ? (
            <button onClick={() => goTo(1)} className="btn btn-primary btn-lg px-8">
              Get Started
            </button>
          ) : step < 3 ? (
            <>
              <button onClick={() => goTo(step - 1)} className="btn btn-secondary">Back</button>
              <button onClick={() => goTo(step + 1)} className="btn btn-primary">Next</button>
            </>
          ) : (
            <>
              <button
                onClick={() => { onHighlight('none'); onComplete('tools'); }}
                className="btn btn-secondary btn-lg px-6"
              >
                Explore Tools
              </button>
              <button
                onClick={() => { onHighlight('none'); onComplete('chat'); }}
                className="btn btn-primary btn-lg px-6"
              >
                Start chatting
              </button>
            </>
          )}
        </div>

        {/* Clickable dots */}
        <div className="flex gap-1.5">
          {SCREENS.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              className={`h-1.5 rounded-full transition-all duration-200 hover:opacity-70 ${
                i === step ? 'w-3 bg-ul-text' : 'w-1.5 bg-black/10'
              }`}
            />
          ))}
        </div>

        {/* Skip — hidden on last page */}
        {step < 3 && (
          <button
            onClick={skip}
            className="text-small text-ul-text-muted hover:text-ul-text-secondary transition-colors"
          >
            Skip tutorial
          </button>
        )}
      </div>
    </div>
  );
}
