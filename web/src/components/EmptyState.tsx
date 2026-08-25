import type { ReactNode } from 'react';

export function EmptyState({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      <p className="state__body">{body}</p>
    </div>
  );
}
