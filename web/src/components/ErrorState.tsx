export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__body">{message}</p>
      {onRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  );
}
