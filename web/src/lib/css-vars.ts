import type { CSSProperties } from 'react';

/** CSSProperties plus CSS custom properties, for inline style objects that set `--foo` vars. */
export type CSSVarStyle = CSSProperties & Record<`--${string}`, string | number>;
