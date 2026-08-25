import type { CSSVarStyle } from '../lib/css-vars';
import './ServiceChip.css';

export function ServiceChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="service-chip" style={{ '--chip-color': color } as CSSVarStyle}>
      <span className="service-chip__dot" />
      {name}
    </span>
  );
}
