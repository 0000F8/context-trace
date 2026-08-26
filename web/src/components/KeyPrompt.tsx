import { useState, type FormEvent } from 'react';
import './KeyPrompt.css';

interface KeyPromptProps {
  onSave: (key: string) => void;
  /** True when a previously saved key was the one that got rejected (vs. no key at all). */
  rejected: boolean;
}

export function KeyPrompt({ onSave, rejected }: KeyPromptProps) {
  const [value, setValue] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const key = value.trim();
    if (key) onSave(key);
  }

  return (
    <div className="key-prompt">
      <form className="key-prompt__card" onSubmit={handleSubmit}>
        <p className="key-prompt__title">This instance requires an API key.</p>
        {rejected && <p className="key-prompt__note">The saved key was rejected. Enter a valid key to continue.</p>}
        <input
          type="text"
          className="key-prompt__input mono"
          placeholder="ct_..."
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="API key"
        />
        <button type="submit" disabled={value.trim().length === 0}>
          Save
        </button>
      </form>
    </div>
  );
}
