const RADIUS = 26;
const COLUMN_STEP = RADIUS * 1.5;
const ROW_STEP = RADIUS * Math.sqrt(3);
const WIDTH = 480;
const HEIGHT = 300;

function hexagon(centerX: number, centerY: number) {
  return Array.from({ length: 6 }, (_, corner) => {
    const angle = (Math.PI / 180) * (60 * corner);
    const x = centerX + RADIUS * Math.cos(angle);
    const y = centerY + RADIUS * Math.sin(angle);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

// Overdrawn past every edge so the grid never shows a cut cell once sliced.
const cells: string[] = [];
for (let column = -1; column * COLUMN_STEP < WIDTH + RADIUS; column++) {
  for (let row = -1; row * ROW_STEP < HEIGHT + RADIUS; row++) {
    const offset = column % 2 === 0 ? 0 : ROW_STEP / 2;
    cells.push(hexagon(column * COLUMN_STEP, row * ROW_STEP + offset));
  }
}

/** Decorative chapter watermark. Drawn, so it tints to whatever ground it lands on. */
export function Honeycomb({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      className={className}
    >
      {cells.map((points) => (
        <polygon
          key={points}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
        />
      ))}
    </svg>
  );
}
