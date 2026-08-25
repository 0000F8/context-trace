export function LoadingState({ label }: { label: string }) {
  return (
    <div className="state state--loading" role="status">
      {label}…
    </div>
  );
}
